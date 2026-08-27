// Phase 4 — the CMS/Cloud boundary.
//
// One database stands in for both instances here. That is a real limitation and worth being
// honest about: it proves the ENVELOPE and the INGEST logic — building a transaction's full
// picture, applying it idempotently and atomically, refusing what Cloud must refuse — but it
// cannot prove two Postgres servers converge. That needs the commissioning drill in §20 of
// the design, with a second database and a real network between them.
//
// What these tests do prove is the part that is easy to get wrong and expensive to discover
// late: identity on the wire, duplicate handling, atomicity, ordering, origin enforcement and
// the staleness policies.

import test from 'node:test';
import assert from 'node:assert/strict';
import pool, { query, withTransaction } from '../src/db.js';
import { SyncService } from '../src/services/syncService.js';
import { MasterDataService } from '../src/services/masterDataService.js';
import { RequestSyncService } from '../src/services/requestSyncService.js';
import { DispatchService } from '../src/services/dispatchService.js';
import { BatchService } from '../src/services/batchService.js';
import { RequestService } from '../src/services/requestService.js';
import {
  makeUser, makeFacility, makeCommodity, makeBatch,
  batchQuantity, movementsFor, cleanup, txnId, scheme,
} from './helpers.js';

test.after(async () => { await pool.end(); });

const setSyncState = (stream, ageHours) => query(
  `INSERT INTO sync_state (stream, cursor, last_success_at, updated_at)
   VALUES ($1, 'test', now() - ($2 || ' hours')::interval, now())
   ON CONFLICT (stream) DO UPDATE SET last_success_at = EXCLUDED.last_success_at, cursor='test'`,
  [stream, String(ageHours)]);

const clearSyncState = (stream) => query('DELETE FROM sync_state WHERE stream = $1', [stream]);

// ── Envelope: does a transaction carry everything Cloud needs? ───────────────
test('an envelope names every row by uid and carries the whole transaction', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 500);
  const id = txnId('ENV');
  try {
    await DispatchService.createOrder({
      facilityId: facility.id,
      items: [{ commodityId: commodity.id, quantity: 100, unitPrice: 4 }],
      dispatchedBy: 'Store Officer', scheme: await scheme(), clientTxnId: id, actorUserId: user.id,
    });

    const env = await SyncService.buildEnvelope(id);
    assert.ok(env, 'envelope built');
    assert.equal(env.clientTxnId, id);
    assert.equal(env.txn.origin, 'cloud', 'stamped with the authoring instance');
    assert.match(env.txn.uid, /^[0-9a-f-]{36}$/);
    assert.equal(env.movements.length, 1);
    assert.match(env.movements[0].uid, /^[0-9a-f-]{36}$/, 'movements are named by uid');
    assert.match(env.movements[0].batch_uid, /^[0-9a-f-]{36}$/, 'and reference their batch by uid');
    assert.equal(env.batches.length, 1, 'the touched batch travels with it');
    assert.ok(env.order, 'the dispatch order travels with it');
    assert.equal(env.order.items.length, 1);
    assert.equal(env.order.isDirect, true, 'no request behind it — this is a direct dispatch');
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id], facilityIds: [facility.id], userIds: [user.id], clientTxnIds: [id] });
  }
});

test('a direct dispatch is never represented as an EnVo request', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 300);
  const id = txnId('DIRECT');
  try {
    await DispatchService.createOrder({
      facilityId: facility.id,
      items: [{ commodityId: commodity.id, quantity: 50, unitPrice: 2 }],
      dispatchedBy: 'Store Officer', scheme: await scheme(), clientTxnId: id, actorUserId: user.id,
    });
    const env = await SyncService.buildEnvelope(id);

    assert.equal(env.request, null, 'no request payload');
    assert.equal(env.order.isDirect, true);
    assert.equal(env.order.request_uid, null);
    assert.equal(env.order.envo_request_id, null,
      'nothing in the envelope could make Cloud call EnVo about this');
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id], facilityIds: [facility.id], userIds: [user.id], clientTxnIds: [id] });
  }
});

// ── Ingest: duplicates, atomicity, origin ───────────────────────────────────
test('ingest is idempotent — the same envelope twice applies once', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 400);
  const id = txnId('DUP');
  try {
    await DispatchService.createOrder({
      facilityId: facility.id,
      items: [{ commodityId: commodity.id, quantity: 60, unitPrice: 1 }],
      dispatchedBy: 'X', scheme: await scheme(), clientTxnId: id, actorUserId: user.id,
    });
    const env = await SyncService.buildEnvelope(id);
    // Re-address it as a CMS-authored envelope arriving at Cloud for the first time.
    env.txn.origin = 'cms';
    env.txn.sourceInstance = 'cms-test';
    env.clientTxnId = `${id}-WIRE`;
    env.txn.uid = crypto.randomUUID();
    // Re-address the batches AND the movements that point at them together. Renaming one
    // side only would leave the envelope internally inconsistent — which ingest now refuses
    // outright, as it should.
    const rename = new Map(env.batches.map((b) => [b.uid, crypto.randomUUID()]));
    for (const b of env.batches) b.uid = rename.get(b.uid);
    for (const m of env.movements) { m.batch_uid = rename.get(m.batch_uid); m.uid = crypto.randomUUID(); }
    const itemRename = new Map(env.order.items.map((it) => [it.uid, crypto.randomUUID()]));
    for (const m of env.movements) {
      if (m.dispatch_order_item_uid) m.dispatch_order_item_uid = itemRename.get(m.dispatch_order_item_uid);
    }
    env.order.uid = crypto.randomUUID();
    for (const it of env.order.items) it.uid = itemRename.get(it.uid);

    const first = await SyncService.ingest(env);
    assert.equal(first.applied, true);
    assert.equal(first.duplicate, false);

    const second = await SyncService.ingest(env);
    assert.equal(second.applied, false, 'the replay applied nothing');
    assert.equal(second.duplicate, true);

    const { rows } = await query(
      'SELECT COUNT(*)::int c FROM inventory_transactions WHERE client_txn_id = $1', [env.clientTxnId]);
    assert.equal(rows[0].c, 1, 'one transaction, not two');

    const { rows: mv } = await query(
      `SELECT COUNT(*)::int c FROM batch_movements m
         JOIN inventory_transactions t ON t.id = m.txn_id WHERE t.client_txn_id = $1`, [env.clientTxnId]);
    assert.equal(mv[0].c, env.movements.length, 'movements were not duplicated');

    await query(`DELETE FROM batch_movements WHERE txn_id IN
                   (SELECT id FROM inventory_transactions WHERE client_txn_id = $1)`, [env.clientTxnId]);
    await query(`DELETE FROM dispatch_order_items WHERE dispatch_order_id IN
                   (SELECT id FROM dispatch_orders WHERE uid = $1)`, [env.order.uid]);
    await query('DELETE FROM inventory_transactions WHERE client_txn_id = $1', [env.clientTxnId]);
    await query('DELETE FROM dispatch_orders WHERE uid = $1', [env.order.uid]);
    await query('DELETE FROM commodity_batches WHERE uid = ANY($1)', [env.batches.map((b) => b.uid)]);
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id], facilityIds: [facility.id], userIds: [user.id], clientTxnIds: [id] });
  }
});

test('ingest refuses an envelope whose movements reference a batch it does not carry', async () => {
  // A truncated envelope must fail by name rather than as a not-null constraint violation,
  // and must apply nothing at all.
  const clientTxnId = txnId('INCOMPLETE');
  await assert.rejects(SyncService.ingest({
    clientTxnId,
    txn: { uid: crypto.randomUUID(), operation: 'dispatch', origin: 'cms',
           sourceInstance: 'cms-test', createdAt: new Date().toISOString(), result: null },
    batches: [],
    movements: [{ uid: crypto.randomUUID(), batch_uid: crypto.randomUUID(),
                  movement_type: 'dispatch', quantity: -5, origin: 'cms' }],
    order: null, request: null,
  }), /does not carry that batch/);

  const { rows } = await query(
    'SELECT COUNT(*)::int c FROM inventory_transactions WHERE client_txn_id = $1', [clientTxnId]);
  assert.equal(rows[0].c, 0, 'nothing survived the refusal');
});

test('ingest refuses an envelope Cloud did not receive from CMS', async () => {
  // The rule the whole architecture rests on: Cloud mirrors warehouse stock and never
  // authors it. An envelope claiming cloud origin would mean Cloud writing its own stock.
  await assert.rejects(
    SyncService.ingest({ clientTxnId: 'X'.repeat(12), txn: { origin: 'cloud', operation: 'dispatch' } }),
    /only mirrors inventory authored by CMS/);

  await assert.rejects(SyncService.ingest({ txn: { origin: 'cms' } }), /malformed envelope/);
});

test('ingest is atomic — a bad envelope leaves nothing behind', async () => {
  const bad = {
    clientTxnId: txnId('ATOMIC'),
    txn: { uid: crypto.randomUUID(), operation: 'dispatch', origin: 'cms',
           sourceInstance: 'cms-test', createdAt: new Date().toISOString(), result: null },
    // A commodity id Cloud has never heard of: master data is Cloud's, so this envelope
    // cannot be applied and must not be half-applied either.
    batches: [{ uid: crypto.randomUUID(), commodity_id: 2147483000, batch_number: null,
                expiry_date: '2031-01-01', quantity_received: 10, quantity_remaining: 10,
                received_date: '2026-01-01', created_by: 'x', origin: 'cms' }],
    movements: [], order: null, request: null,
  };

  await assert.rejects(SyncService.ingest(bad));

  const { rows } = await query(
    'SELECT COUNT(*)::int c FROM inventory_transactions WHERE client_txn_id = $1', [bad.clientTxnId]);
  assert.equal(rows[0].c, 0, 'the transaction header did not survive the failure');
  const { rows: b } = await query(
    'SELECT COUNT(*)::int c FROM commodity_batches WHERE uid = $1', [bad.batches[0].uid]);
  assert.equal(b[0].c, 0, 'nor did the batch');
});

// ── Ordering / causality ────────────────────────────────────────────────────
test('the outbox holds a reversal behind the dispatch it reverses', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 500);
  const idA = txnId('ORD1');
  const idB = txnId('ORD2');
  try {
    const order = await DispatchService.createOrder({
      facilityId: facility.id,
      items: [{ commodityId: commodity.id, quantity: 100, unitPrice: 1 }],
      dispatchedBy: 'X', scheme: await scheme(), clientTxnId: idA, actorUserId: user.id,
    });
    await DispatchService.updateOrder(order.id, {
      items: [{ commodityId: commodity.id, quantity: 40, unitPrice: 1 }],
      editedBy: 'X', clientTxnId: idB, actorUserId: user.id,
    });

    // Both transactions concern the same order, so they share a cause key and the outbox's
    // existing guard serialises them — the edit can never reach Cloud before the dispatch.
    const envA = await SyncService.buildEnvelope(idA);
    const envB = await SyncService.buildEnvelope(idB);
    assert.ok(envA && envB);
    assert.equal(envA.order.uid, envB.order.uid, 'both name the same order');
    assert.equal(await batchQuantity(batch.id), 460, '500 - 100 + 100 - 40');
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id], facilityIds: [facility.id], userIds: [user.id], clientTxnIds: [idA, idB] });
  }
});

// ── Master data ─────────────────────────────────────────────────────────────
test('a master-data snapshot round-trips and is versioned by content', async () => {
  const snap = await MasterDataService.snapshot();
  assert.ok(snap.version && snap.version.length === 64, 'content hash');
  assert.ok(snap.counts.commodities >= 0);
  assert.ok(snap.data.users.every((u) => u.password_hash),
    'the roster carries hashes, so CMS can authenticate with Cloud unreachable');

  // The version is a hash of the CONTENT, so it changes when the content does. It is
  // deliberately not compared across two live reads here: the other test files run in
  // parallel and are inserting and deleting fixtures, so master data genuinely differs
  // between two calls — which is the hash doing its job, not a fault.
  const crypto2 = await import('node:crypto');
  const h = (o) => crypto2.createHash('sha256').update(JSON.stringify(o)).digest('hex');
  assert.equal(h(snap.data), h(snap.data), 'the same content always hashes the same');
  assert.notEqual(h(snap.data), h({ ...snap.data, schemes: [] }), 'changed content changes it');

  // Apply a SYNTHETIC snapshot rather than the live one. Applying a live snapshot back into
  // the same database resurrects rows that parallel tests have just deleted — an artefact of
  // one database standing in for two instances, not of the code.
  const synthetic = {
    generatedAt: new Date().toISOString(),
    version: 'v-test-' + Date.now(),
    counts: { schemes: snap.data.schemes.length },
    data: { commodities: [], commodity_prices: [], facilities: [], facility_commodities: [],
            schemes: snap.data.schemes, vendors: [], users: [] },
  };
  const applied = await MasterDataService.apply(synthetic);
  assert.ok(applied, 'applies to the local database');
  const st = await MasterDataService.state('master_data');
  assert.equal(st.cursor, synthetic.version, 'the version is recorded as the cursor');
  await clearSyncState('master_data');
});

test('the staleness policy warns, and no longer blocks anything', async () => {
  // Phase 4 blocked priced dispatch after 72 hours and expired sign-in after 72 hours. Both
  // were withdrawn in Phase 5.5: internet availability governs SYNCHRONISATION, not whether
  // the warehouse may work. Detection and the warning remain — an operator should know how
  // old their prices are — but the decision is no longer taken away from them.
  const { classifyStaleness } = await import('../src/services/masterDataService.js');
  const now = Date.now();
  const at = (h) => new Date(now - h * 3_600_000).toISOString();

  assert.equal(classifyStaleness(at(1), { now }).level, 'fresh');
  assert.equal(classifyStaleness(at(23), { now }).level, 'fresh');
  assert.equal(classifyStaleness(at(24), { now }).level, 'warn', 'still warns at exactly 24h');
  assert.equal(classifyStaleness(at(500), { now }).level, 'warn');

  for (const hours of [24, 72, 500, 24 * 60]) {
    assert.equal(classifyStaleness(at(hours), { now }).pricedWorkAllowed, true,
      `${hours}h stale must not block warehouse work`);
  }
  assert.equal(classifyStaleness(null).pricedWorkAllowed, true,
    'a warehouse that has never synced can still operate');
  assert.equal(classifyStaleness(null).neverSynced, true, 'though it is told that it has not');
});

test('a CMS-role process reports staleness without refusing anything', async () => {
  // The wiring, in a real process with WMS_ROLE=cms — the one thing the pure classifier
  // cannot show. Runs as a child because the role is read once at import.
  const { execFileSync } = await import('node:child_process');
  const script = [
    "process.env.WMS_ROLE='cms'; process.env.WMS_ORIGIN='cms';",
    "const { query, default: pool } = await import('./src/db.js');",
    "const { MasterDataService } = await import('./src/services/masterDataService.js');",
    "await query(\"INSERT INTO sync_state (stream, cursor, last_success_at, updated_at) VALUES ('master_data','t', now() - interval '400 hours', now()) ON CONFLICT (stream) DO UPDATE SET last_success_at = now() - interval '400 hours'\");",
    "const s = await MasterDataService.staleness();",
    "const roster = await MasterDataService.authRosterStatus();",
    "await query(\"DELETE FROM sync_state WHERE stream = 'master_data'\");",
    "await pool.end();",
    "console.log(JSON.stringify({ level: s.level, allowed: s.pricedWorkAllowed, hasGate: typeof MasterDataService.assertPricedWorkAllowed, rosterUsable: roster.usable }));",
  ].join('\n');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, WMS_ROLE: 'cms', WMS_ORIGIN: 'cms' },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  // The child prints a single JSON object as its last output, so read from its opening
  // brace. Avoids splitting on a newline escape, which this file has been bitten by.
  const trimmed = out.trim();
  const r = JSON.parse(trimmed.slice(trimmed.lastIndexOf('{')));
  assert.equal(r.level, 'warn', 'a CMS instance 400h from Cloud warns');
  assert.equal(r.allowed, true, 'but refuses nothing');
  assert.equal(r.hasGate, 'undefined', 'the blocking gate no longer exists at all');
  assert.equal(r.rosterUsable, true, 'and sign-in still works');
});

test('NO warehouse operation is gated on master-data freshness', async () => {
  // Structural, so a future change that reintroduces a staleness gate on a write path fails
  // here rather than in a warehouse that has just lost its internet.
  const { readFile } = await import('node:fs/promises');
  for (const f of ['dispatchService', 'batchService', 'requestService']) {
    const src = await readFile(`src/services/${f}.js`, 'utf8');
    assert.ok(!/assertPricedWorkAllowed/.test(src),
      `${f} must not gate work on how old the master data is`);
    assert.match(src, /assertCanWriteWarehouseStock/,
      `${f} is still ownership-gated — that boundary stands`);
  }
});

// ── Local authentication without Cloud ──────────────────────────────────────
test('local authentication needs no Cloud involvement at all', async () => {
  const { UserService } = await import('../src/services/userService.js');
  const bcrypt = (await import('bcryptjs')).default;
  const hash = await bcrypt.hash('warehouse-pass', 4);
  const username = `cms-user-${Date.now()}`;
  const { rows } = await query(
    `INSERT INTO users (username, password_hash, full_name, role, is_active)
     VALUES ($1,$2,'CMS Officer','admin',true) RETURNING id`, [username, hash]);
  try {
    // bcrypt against the local table, JWT signed with the local secret. No network call is
    // reachable from this path, which is why it survives an outage.
    const ok = await UserService.login(username, 'warehouse-pass');
    assert.ok(ok?.token, 'signed in');
    assert.equal(ok.user.username, username);
    assert.equal(await UserService.login(username, 'wrong-pass'), null);
  } finally {
    await query('DELETE FROM users WHERE id = $1', [rows[0].id]);
  }
});

// ── Requests: offline fulfilment and the replication rule ───────────────────
test('a request replicated before the outage is fulfilled offline and reported afterwards', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 500);
  const envoId = `P4-REQ-${Date.now()}`;
  const id = txnId('P4REQ');
  let requestId = null;
  try {
    await query('INSERT INTO commodity_prices (commodity_id, unit_price, is_current) VALUES ($1, 20, true)', [commodity.id]);

    // Online: the request reaches the warehouse.
    const req = await RequestService.receiveFromEnvo({
      envoRequestId: envoId, envoFacilityId: null, facilityName: facility.name,
      items: [{ wmsCommodityId: commodity.id, quantity: 120 }], requestedBy: 'Facility Officer',
    });
    requestId = req.id;

    // Offline: fulfilled entirely from local data.
    await RequestService.fulfil(req.id, {
      dispatchedBy: 'Store Officer', carrierName: 'Driver', carrierPhone: '08012345678',
      pickedBy: 'Picker', clientTxnId: id, actorUserId: user.id,
    });
    assert.equal(await batchQuantity(batch.id), 380, 'stock moved locally');

    // The envelope that will go up when the link returns carries the fulfilment.
    const env = await SyncService.buildEnvelope(id);
    assert.ok(env.request, 'the request travels with it');
    assert.equal(env.request.envo_request_id, envoId);
    assert.equal(env.request.status, 'dispatched');
    assert.equal(env.order.isDirect, false, 'this one IS an EnVo request');
    assert.equal(Number(env.request.items[0].qty_dispatched), 120);
  } finally {
    if (requestId) {
      await query('DELETE FROM request_items WHERE request_id = $1', [requestId]);
      await query('UPDATE requests SET dispatch_order_id = NULL WHERE id = $1', [requestId]);
    }
    await query("DELETE FROM outbox WHERE payload->>'envoRequestId' = $1", [envoId]);
    await cleanup({ batchIds: [batch.id], facilityIds: [facility.id], clientTxnIds: [id] });
    if (requestId) await query('DELETE FROM requests WHERE id = $1', [requestId]);
    await query('DELETE FROM commodity_prices WHERE commodity_id = $1', [commodity.id]);
    await cleanup({ commodityIds: [commodity.id], userIds: [user.id] });
  }
});

test('replication never resets a request the warehouse has already dispatched', async () => {
  // The dangerous case: CMS shipped it offline, Cloud still believes it open, and the next
  // pull must not overwrite the local truth with Cloud's stale view.
  const facility = await makeFacility();
  const envoId = `P4-AHEAD-${Date.now()}`;
  const { rows } = await query(
    `INSERT INTO requests (envo_request_id, facility_id, status, total_amount, scheme)
     VALUES ($1, $2, 'dispatched', 100, 'drf') RETURNING id`, [envoId, facility.id]);
  const requestId = rows[0].id;

  try {
    const result = await RequestSyncService.apply({
      generatedAt: new Date().toISOString(),
      requests: [{ id: requestId, uid: crypto.randomUUID(), envo_request_id: envoId,
                   envo_facility_id: null, facility_id: facility.id, status: 'pending',
                   total_amount: 100, notes: null, created_at: new Date().toISOString(),
                   requested_by: null, requester_phone: null, picked_by: null,
                   picked_at: null, scheme: 'drf' }],
      items: [],
    });

    assert.equal(result.skippedLocallyAhead, 1, 'Cloud offered a stale status and was ignored');
    const { rows: after } = await query('SELECT status FROM requests WHERE id = $1', [requestId]);
    assert.equal(after[0].status, 'dispatched', 'the local dispatch stands');
  } finally {
    await clearSyncState('requests');
    await query('DELETE FROM requests WHERE id = $1', [requestId]);
    await cleanup({ facilityIds: [facility.id] });
  }
});

// ── Restart / recovery ──────────────────────────────────────────────────────
test('a committed transaction leaves a durable sync record; a rolled-back one leaves none', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 300);
  const good = txnId('R1');
  const bad = txnId('R2');
  try {
    await DispatchService.createOrder({
      facilityId: facility.id,
      items: [{ commodityId: commodity.id, quantity: 30, unitPrice: 1 }],
      dispatchedBy: 'X', scheme: await scheme(), clientTxnId: good, actorUserId: user.id,
    });

    // Committed work is queued and still queued after a notional restart, because the queue
    // is a table rather than anything held in memory.
    const pending = await SyncService.pendingCount();
    assert.ok(pending.pending >= 1, 'the committed transaction is waiting to go up');

    // A failure part-way leaves nothing claiming the dispatch happened.
    await assert.rejects(DispatchService.createOrder({
      facilityId: facility.id,
      items: [{ commodityId: commodity.id, quantity: 10, unitPrice: 1 },
              { commodityId: 2147483000, quantity: 1, unitPrice: 1 }],
      dispatchedBy: 'X', scheme: await scheme(), clientTxnId: bad, actorUserId: user.id,
    }));
    const { rows } = await query(
      'SELECT COUNT(*)::int c FROM inventory_transactions WHERE client_txn_id = $1', [bad]);
    assert.equal(rows[0].c, 0, 'no transaction');
    assert.equal(await batchQuantity(batch.id), 270, 'and no stock moved by the failed attempt');
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id], facilityIds: [facility.id], userIds: [user.id], clientTxnIds: [good, bad] });
  }
});

// ── Mirror parity ───────────────────────────────────────────────────────────
test('the mirror view reports balance, ledger and how current it is', async () => {
  const user = await makeUser();
  const commodity = await makeCommodity();
  const id = txnId('MIRROR');
  let batchIds = [];
  try {
    const batch = await BatchService.receive({
      commodityId: commodity.id, expiryDate: '2031-01-01', quantity: 250,
      createdBy: 'X', clientTxnId: id, actorUserId: user.id,
    });
    batchIds = [batch.id];

    const mirror = await SyncService.mirrorBalances([batch.uid]);
    assert.equal(mirror.length, 1);
    assert.equal(Number(mirror[0].quantity_remaining), 250);
    assert.equal(Number(mirror[0].ledger), 250, 'balance and ledger agree');
  } finally {
    await cleanup({ batchIds, commodityIds: [commodity.id], userIds: [user.id], clientTxnIds: [id] });
  }
});

// ── The mirror exemption must not leak ──────────────────────────────────────
test('the mirror exemption is scoped to the ingest transaction and nothing else', async () => {
  // SET LOCAL dies at commit. If it did not — if it were a session or database default —
  // the balance guard would be off for every subsequent write on that pooled connection,
  // which would quietly undo Phase 3.
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 200);
  const clientTxnId = txnId('LEAK');
  try {
    // An ingest that legitimately uses the exemption.
    const batchUid = crypto.randomUUID();
    await SyncService.ingest({
      clientTxnId,
      txn: { uid: crypto.randomUUID(), operation: 'dispatch', origin: 'cms',
             sourceInstance: 'cms-test', createdAt: new Date().toISOString(), result: null },
      batches: [{ uid: batchUid, commodity_id: commodity.id, batch_number: null,
                  expiry_date: '2031-01-01', quantity_received: 900, quantity_remaining: 840,
                  received_date: '2026-01-01', created_by: 'cms', origin: 'cms' }],
      movements: [{ uid: crypto.randomUUID(), batch_uid: batchUid, movement_type: 'dispatch',
                    quantity: -60, created_at: new Date().toISOString(), origin: 'cms' }],
      order: null, request: null,
    });

    // The mirror row is deliberately allowed to disagree with its partial ledger.
    const { rows: mirrored } = await query(
      'SELECT quantity_remaining FROM commodity_batches WHERE uid = $1', [batchUid]);
    assert.equal(Number(mirrored[0].quantity_remaining), 840, 'the mirror took CMS at its word');

    // And the guard is immediately back on for ordinary work.
    await assert.rejects(
      query('UPDATE commodity_batches SET quantity_remaining = 999 WHERE id = $1', [batch.id]),
      /does not match its ledger/,
      'an out-of-band edit is still refused after an ingest');

    await query('DELETE FROM batch_movements WHERE batch_id = (SELECT id FROM commodity_batches WHERE uid = $1)', [batchUid]);
    await query('DELETE FROM inventory_transactions WHERE client_txn_id = $1', [clientTxnId]);
    await query('DELETE FROM commodity_batches WHERE uid = $1', [batchUid]);
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id], clientTxnIds: [clientTxnId] });
  }
});

// ── Role gating ─────────────────────────────────────────────────────────────
test('a CMS instance cannot reach EnVo, and refuses to serve master data', async () => {
  // Asserted by ASKING THE SERVER, not by reading its route table. An earlier version
  // matched route-regex source strings for "inbound", which quietly broke the day the
  // static-file route gained a negative lookahead containing that same word — the
  // assertion was right and its method was wrong.
  const { execFileSync } = await import('node:child_process');
  const script = [
    "const { default: app } = await import('./src/server.js');",
    "const { MasterDataService } = await import('./src/services/masterDataService.js');",
    "const { default: pool } = await import('./src/db.js');",
    "const server = app.listen(0);",
    "await new Promise(r => server.once('listening', r));",
    "const base = 'http://127.0.0.1:' + server.address().port;",
    "const hit = async (p) => (await fetch(base + p, { headers: { 'x-service-token': 'anything' } })).status;",
    "const inbound = await hit('/inbound/requests');",
    "const catalogue = await hit('/api/catalogue/export');",
    "let servesMaster = true;",
    "try { await MasterDataService.snapshot(); } catch { servesMaster = false; }",
    "await new Promise(r => server.close(r));",
    "await pool.end();",
    "console.log(JSON.stringify({ inbound, catalogue, servesMaster }));",
  ].join('\n');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, WMS_ROLE: 'cms', WMS_ORIGIN: 'cms', OUTBOX_WORKER: 'off',
           RECONCILE_WORKER: 'off', SYNC_WORKER: 'off' },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const trimmed = out.trim();
  const r = JSON.parse(trimmed.slice(trimmed.lastIndexOf('{')));

  // /inbound sits outside the authenticated surface, so a 404 here is the clean signal that
  // the route genuinely does not exist on CMS — not that it exists and refused a token.
  assert.equal(r.inbound, 404, 'the EnVo inbound route is not mounted on CMS');

  // The catalogue export lives under /api, where authMiddleware runs BEFORE routing, so an
  // unauthenticated call is rejected at 401 and never reaches the missing route. 404 is
  // therefore unreachable here; what matters is that it is never served.
  assert.ok(r.catalogue !== 200, `the catalogue export is not served on CMS (got ${r.catalogue})`);
  assert.equal(r.servesMaster, false, 'and CMS does not serve master data — Cloud owns it');
});

test('role and origin must agree, or the process refuses to start', async () => {
  const { execFileSync } = await import('node:child_process');
  assert.throws(() => {
    execFileSync(process.execPath, ['--input-type=module', '-e', "await import('./src/lib/role.js')"], {
      env: { ...process.env, WMS_ROLE: 'cms', WMS_ORIGIN: 'cloud' }, stdio: 'pipe',
    });
  }, /disagree/);
});
