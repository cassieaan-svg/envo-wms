// Phase 5.5 — request status events, reprints, and the withdrawal of the offline blocks.

import test from 'node:test';
import assert from 'node:assert/strict';
import pool, { query } from '../src/db.js';
import { DispatchService } from '../src/services/dispatchService.js';
import { RequestService } from '../src/services/requestService.js';
import { RequestStatusService } from '../src/services/requestStatusService.js';
import { MasterDataService, classifyStaleness } from '../src/services/masterDataService.js';
import {
  makeUser, makeFacility, makeCommodity, makeBatch,
  batchQuantity, movementsFor, cleanup, txnId, scheme,
} from './helpers.js';

test.after(async () => { await pool.end(); });

async function makeRequest(facility, commodity, qty = 100) {
  const envoId = `P55-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await query('INSERT INTO commodity_prices (commodity_id, unit_price, is_current) VALUES ($1, 10, true)',
    [commodity.id]);
  const req = await RequestService.receiveFromEnvo({
    envoRequestId: envoId, envoFacilityId: null, facilityName: facility.name,
    items: [{ wmsCommodityId: commodity.id, quantity: qty }], requestedBy: 'Facility Officer',
  });
  return { req, envoId };
}

async function dropRequest(requestId, envoId, commodityId) {
  // inventory_transactions point at the request they fulfilled, so that link has to go
  // first. The transactions themselves are removed by cleanup() via their clientTxnIds.
  await query('UPDATE inventory_transactions SET request_id = NULL WHERE request_id = $1', [requestId]);
  await query('DELETE FROM request_status_events WHERE request_id = $1', [requestId]);
  await query('DELETE FROM request_items WHERE request_id = $1', [requestId]);
  await query('UPDATE requests SET dispatch_order_id = NULL WHERE id = $1', [requestId]);
  await query("DELETE FROM outbox WHERE payload->>'envoRequestId' = $1", [envoId]);
  await query('DELETE FROM requests WHERE id = $1', [requestId]);
  if (commodityId) await query('DELETE FROM commodity_prices WHERE commodity_id = $1', [commodityId]);
}

// ── A. Request status events ────────────────────────────────────────────────
test('every request transition records an event that can travel', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 500);
  const { req, envoId } = await makeRequest(facility, commodity, 80);
  const id = txnId('P55A');

  try {
    await RequestService.markPicking(req.id, { pickedBy: 'Picker' });
    await RequestService.fulfil(req.id, {
      dispatchedBy: 'Store Officer', carrierName: 'Driver', carrierPhone: '08012345678',
      clientTxnId: id, actorUserId: user.id,
    });

    const { rows } = await query(
      `SELECT status, actor, origin FROM request_status_events
        WHERE request_id = $1 ORDER BY id`, [req.id]);
    assert.deepEqual(rows.map((r) => r.status), ['picking', 'dispatched'],
      'both transitions recorded, in the order they happened');
    assert.equal(rows[0].actor, 'Picker');
    assert.ok(rows.every((r) => r.uid !== null));
  } finally {
    await dropRequest(req.id, envoId, commodity.id);
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id],
                    facilityIds: [facility.id], userIds: [user.id], clientTxnIds: [id] });
  }
});

test('a rejection records an event carrying its reason', async () => {
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const { req, envoId } = await makeRequest(facility, commodity);
  try {
    await RequestService.reject(req.id, { rejectedBy: 'Store Officer', reason: 'Nothing on the shelf' });
    const { rows } = await query(
      "SELECT status, note, actor FROM request_status_events WHERE request_id = $1", [req.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'rejected');
    assert.equal(rows[0].note, 'Nothing on the shelf');
    assert.equal(rows[0].actor, 'Store Officer');
  } finally {
    await dropRequest(req.id, envoId, commodity.id);
    await cleanup({ facilityIds: [facility.id], commodityIds: [commodity.id] });
  }
});

test('an envelope carries what Cloud needs to tell EnVo', async () => {
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const { req, envoId } = await makeRequest(facility, commodity);
  try {
    await RequestService.markPicking(req.id, { pickedBy: 'Picker' });
    const { rows } = await query(
      'SELECT uid FROM request_status_events WHERE request_id = $1', [req.id]);
    const env = await RequestStatusService.envelope(rows[0].uid);
    assert.ok(env, 'envelope built');
    assert.equal(env.event.status, 'picking');
    assert.equal(env.event.envo_request_id, envoId, 'addressed by EnVo\'s own id');
    assert.match(env.event.uid, /^[0-9a-f-]{36}$/);
  } finally {
    await dropRequest(req.id, envoId, commodity.id);
    await cleanup({ facilityIds: [facility.id], commodityIds: [commodity.id] });
  }
});

test('status ingest refuses an event Cloud did not receive from CMS', async () => {
  await assert.rejects(
    RequestStatusService.ingest({ event: { uid: crypto.randomUUID(), status: 'picking', origin: 'cloud' } }),
    /only mirrors what CMS reports/);
  await assert.rejects(RequestStatusService.ingest({ event: { origin: 'cms' } }), /malformed/);
});

test('a duplicate status event produces no second EnVo callback', async () => {
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const { req, envoId } = await makeRequest(facility, commodity);
  try {
    const eventUid = crypto.randomUUID();
    const envelope = { envelopeVersion: 1, event: {
      uid: eventUid, status: 'picking', actor: 'Picker', note: null,
      occurred_at: new Date().toISOString(), origin: 'cms', source_instance: 'cms-uyo',
      envo_request_id: envoId, picked_by: 'Picker' } };

    const first = await RequestStatusService.ingest(envelope);
    assert.equal(first.applied, true);
    const second = await RequestStatusService.ingest(envelope);
    assert.equal(second.duplicate, true, 'the replay applied nothing');

    const { rows: cb } = await query(
      `SELECT COUNT(*)::int c FROM outbox
        WHERE kind = 'request_status' AND payload->>'envoRequestId' = $1
          AND payload->>'status' = 'picking'`, [envoId]);
    assert.equal(cb[0].c, 1, 'EnVo is told once, not twice');

    const { rows: st } = await query('SELECT status FROM requests WHERE id = $1', [req.id]);
    assert.equal(st[0].status, 'picking', 'the status was applied');
  } finally {
    await dropRequest(req.id, envoId, commodity.id);
    await cleanup({ facilityIds: [facility.id], commodityIds: [commodity.id] });
  }
});

test('a late status event cannot walk a terminal request backwards', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 300);
  const { req, envoId } = await makeRequest(facility, commodity, 50);
  const id = txnId('P55L');
  try {
    await RequestService.fulfil(req.id, {
      dispatchedBy: 'Store Officer', carrierName: 'Driver', carrierPhone: '08012345678',
      pickedBy: 'Picker', clientTxnId: id, actorUserId: user.id,
    });

    // A 'picking' that was stuck in a queue and arrives after the dispatch.
    await RequestStatusService.ingest({ envelopeVersion: 1, event: {
      uid: crypto.randomUUID(), status: 'picking', actor: 'Picker', note: null,
      occurred_at: new Date(Date.now() - 60000).toISOString(), origin: 'cms',
      source_instance: 'cms-uyo', envo_request_id: envoId, picked_by: 'Picker' } });

    const { rows } = await query('SELECT status FROM requests WHERE id = $1', [req.id]);
    assert.equal(rows[0].status, 'dispatched', 'the later, terminal state stands');
  } finally {
    await dropRequest(req.id, envoId, commodity.id);
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id],
                    facilityIds: [facility.id], userIds: [user.id], clientTxnIds: [id] });
  }
});

// ── B. Reprints ─────────────────────────────────────────────────────────────
test('reprints are numbered, and move no stock whatsoever', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 400);
  const id = txnId('P55P');
  try {
    const order = await DispatchService.createOrder({
      facilityId: facility.id,
      items: [{ commodityId: commodity.id, quantity: 60, unitPrice: 2 }],
      dispatchedBy: 'Store Officer', scheme: await scheme(), clientTxnId: id, actorUserId: user.id,
    });

    const stockBefore = await batchQuantity(batch.id);
    const movesBefore = (await movementsFor(batch.id)).length;
    // Scoped to THIS order, not a count of the whole table: the test files run in parallel
    // and other transactions are legitimately being created while this one runs.
    const txCount = async () => (await query(
      'SELECT COUNT(*)::int c FROM inventory_transactions WHERE dispatch_order_id = $1',
      [order.id])).rows[0].c;
    const txBefore = await txCount();

    const first = await DispatchService.recordPrint(order.id, { printedBy: 'Store Officer' });
    const second = await DispatchService.recordPrint(order.id, { printedBy: 'Store Officer' });
    const third = await DispatchService.recordPrint(order.id, { printedBy: 'Another Officer' });

    assert.equal(first.label, 'ORIGINAL');
    assert.equal(first.isReprint, false);
    assert.equal(second.label, 'REPRINT #1');
    assert.equal(second.isReprint, true);
    assert.equal(third.label, 'REPRINT #2');

    // The assertion that matters: a reprint is paper, not stock.
    assert.equal(await batchQuantity(batch.id), stockBefore, 'stock unchanged by printing');
    assert.equal((await movementsFor(batch.id)).length, movesBefore, 'no movement written');
    assert.equal(await txCount(), txBefore, 'no inventory transaction written');

    const history = await DispatchService.printHistory(order.id);
    assert.equal(history.length, 3, 'every copy is logged');
    assert.deepEqual(history.map((h) => h.label), ['ORIGINAL', 'REPRINT #1', 'REPRINT #2']);
    assert.equal(history[2].printed_by, 'Another Officer', 'with who took it');

    const { rows: ord } = await query('SELECT print_count FROM dispatch_orders WHERE id = $1', [order.id]);
    assert.equal(Number(ord[0].print_count), 3);
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id],
                    facilityIds: [facility.id], userIds: [user.id], clientTxnIds: [id] });
  }
});

test('concurrent print requests cannot both claim the same copy number', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 200);
  const id = txnId('P55PC');
  try {
    const order = await DispatchService.createOrder({
      facilityId: facility.id,
      items: [{ commodityId: commodity.id, quantity: 10, unitPrice: 1 }],
      dispatchedBy: 'X', scheme: await scheme(), clientTxnId: id, actorUserId: user.id,
    });

    const results = await Promise.all([
      DispatchService.recordPrint(order.id, { printedBy: 'A' }),
      DispatchService.recordPrint(order.id, { printedBy: 'B' }),
      DispatchService.recordPrint(order.id, { printedBy: 'C' }),
    ]);
    const numbers = results.map((r) => Number(r.print_number)).sort();
    assert.deepEqual(numbers, [0, 1, 2], 'three distinct copy numbers');
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id],
                    facilityIds: [facility.id], userIds: [user.id], clientTxnIds: [id] });
  }
});

// ── D. Offline operations are never blocked ─────────────────────────────────
test('stale master data warns but never blocks warehouse work', async () => {
  const now = Date.now();
  const at = (h) => new Date(now - h * 3_600_000).toISOString();

  assert.equal(classifyStaleness(at(1), { now }).level, 'fresh');
  assert.equal(classifyStaleness(at(30), { now }).level, 'warn', 'still warns past 24h');

  // The withdrawal: nothing is refused, however old the copy is.
  for (const hours of [30, 72, 200, 24 * 30]) {
    assert.equal(classifyStaleness(at(hours), { now }).pricedWorkAllowed, true,
      `${hours}h stale must not block work`);
  }
  assert.equal(classifyStaleness(null).pricedWorkAllowed, true,
    'a warehouse that has never synced can still operate');

  assert.equal(typeof MasterDataService.assertPricedWorkAllowed, 'undefined',
    'the blocking gate is gone from the service entirely');
});

test('dispatch and fulfilment succeed with master data long stale', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 500);
  const { req, envoId } = await makeRequest(facility, commodity, 40);
  const idA = txnId('P55S1');
  const idB = txnId('P55S2');
  try {
    await query(
      `INSERT INTO sync_state (stream, cursor, last_success_at, updated_at)
       VALUES ('master_data', 't', now() - interval '400 hours', now())
       ON CONFLICT (stream) DO UPDATE SET last_success_at = now() - interval '400 hours'`);

    const order = await DispatchService.createOrder({
      facilityId: facility.id,
      items: [{ commodityId: commodity.id, quantity: 25, unitPrice: 10 }],
      dispatchedBy: 'Store Officer', scheme: await scheme(), clientTxnId: idA, actorUserId: user.id,
    });
    assert.ok(order.id, 'direct dispatch works with a 400-hour-old copy');

    await RequestService.fulfil(req.id, {
      dispatchedBy: 'Store Officer', carrierName: 'Driver', carrierPhone: '08012345678',
      pickedBy: 'Picker', clientTxnId: idB, actorUserId: user.id,
    });
    assert.equal(await batchQuantity(batch.id), 435, '500 - 25 - 40');
  } finally {
    await query("DELETE FROM sync_state WHERE stream = 'master_data'");
    await dropRequest(req.id, envoId, commodity.id);
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id],
                    facilityIds: [facility.id], userIds: [user.id], clientTxnIds: [idA, idB] });
  }
});

test('sign-in never expires because Cloud is unreachable', async () => {
  const { UserService } = await import('../src/services/userService.js');
  const bcrypt = (await import('bcryptjs')).default;
  const hash = await bcrypt.hash('warehouse-pass', 4);
  const username = `p55-user-${Date.now()}`;
  const { rows } = await query(
    `INSERT INTO users (username, password_hash, full_name, role, is_active)
     VALUES ($1,$2,'Officer','admin',true) RETURNING id`, [username, hash]);
  try {
    await query(
      `INSERT INTO sync_state (stream, cursor, last_success_at, updated_at)
       VALUES ('master_data', 't', now() - interval '900 hours', now())
       ON CONFLICT (stream) DO UPDATE SET last_success_at = now() - interval '900 hours'`);

    const ok = await UserService.login(username, 'warehouse-pass');
    assert.ok(ok?.token, 'a roster 900 hours old still authenticates');

    const roster = await MasterDataService.authRosterStatus();
    assert.equal(roster.usable, true, 'and the roster reports itself usable');
  } finally {
    await query("DELETE FROM sync_state WHERE stream = 'master_data'");
    await query('DELETE FROM users WHERE id = $1', [rows[0].id]);
  }
});
