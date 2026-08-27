// Phase 2 — record identity, origin, mandatory transaction identity, traceability.
//
// These prove the properties a second instance will depend on: every inventory row carries
// a globally unique id and says which instance wrote it, no inventory-changing request can
// be made without a transaction id, and a movement can name the document it belonged to.

import test from 'node:test';
import assert from 'node:assert/strict';
import pool, { query } from '../src/db.js';
import { BatchService } from '../src/services/batchService.js';
import { DispatchService } from '../src/services/dispatchService.js';
import { RequestService } from '../src/services/requestService.js';
import { IdempotencyService } from '../src/services/idempotencyService.js';
import { ORIGIN } from '../src/lib/instance.js';
import {
  makeUser, makeFacility, makeCommodity, makeBatch,
  batchQuantity, movementsFor, cleanup, txnId, scheme,
} from './helpers.js';

test.after(async () => { await pool.end(); });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Identity ────────────────────────────────────────────────────────────────
test('every inventory row is created with a globally unique uid', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const id = txnId('UID');

  let batchIds = [];
  // Declared out here so the cleanup in `finally` can see it.
  const orderTxn = txnId('UID2');
  try {
    const batch = await BatchService.receive({
      commodityId: commodity.id, expiryDate: '2030-01-01', quantity: 500,
      createdBy: 'Tester', clientTxnId: id, actorUserId: user.id,
    });
    batchIds = [batch.id];
    assert.match(batch.uid, UUID_RE, 'the batch carries a uid');

    const order = await DispatchService.createOrder({
      facilityId: facility.id,
      items: [{ commodityId: commodity.id, quantity: 100, unitPrice: 1 }],
      dispatchedBy: 'Tester', scheme: await scheme(),
      clientTxnId: orderTxn, actorUserId: user.id,
    });

    const { rows } = await query(
      `SELECT o.uid AS order_uid, i.uid AS item_uid, m.uid AS movement_uid, t.uid AS txn_uid
         FROM dispatch_orders o
         JOIN dispatch_order_items i ON i.dispatch_order_id = o.id
         JOIN batch_movements m ON m.dispatch_order_item_id = i.id
         JOIN inventory_transactions t ON t.id = m.txn_id
        WHERE o.id = $1`, [order.id]);

    assert.equal(rows.length, 1);
    for (const [field, value] of Object.entries(rows[0])) {
      assert.match(value, UUID_RE, `${field} is a uuid`);
    }

  } finally {
    // Both transaction ids go through the SAME cleanup call. Deleting a transaction before
    // its movements fails on the foreign key, and because cleanup reports rather than
    // throws, the failure was only a warning — so the rows quietly accumulated in the test
    // database on every run.
    await cleanup({
      batchIds, commodityIds: [commodity.id], facilityIds: [facility.id],
      userIds: [user.id], clientTxnIds: [id, orderTxn],
    });
  }
});

test('uids are unique across every existing row', async () => {
  // Cheap here, and it is the property the whole column exists for: a duplicate would make
  // a future merge unresolvable, and the unique index is what guarantees it.
  for (const table of ['commodity_batches', 'batch_movements', 'dispatch_orders',
                       'dispatch_order_items', 'inventory_transactions']) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS total, COUNT(DISTINCT uid)::int AS distinct_uids FROM ${table}`);
    assert.equal(rows[0].total, rows[0].distinct_uids, `${table} has no duplicate uid`);
    const { rows: nulls } = await query(`SELECT COUNT(*)::int c FROM ${table} WHERE uid IS NULL`);
    assert.equal(nulls[0].c, 0, `${table} has no null uid`);
  }
});

// ── Origin ──────────────────────────────────────────────────────────────────
test('rows record which instance authored them', async () => {
  const user = await makeUser();
  const commodity = await makeCommodity();
  const id = txnId('ORG');

  let batchIds = [];
  try {
    const batch = await BatchService.receive({
      commodityId: commodity.id, expiryDate: '2030-01-01', quantity: 100,
      createdBy: 'Tester', clientTxnId: id, actorUserId: user.id,
    });
    batchIds = [batch.id];

    const { rows } = await query(
      `SELECT b.origin AS batch_origin, m.origin AS movement_origin, t.origin AS txn_origin
         FROM commodity_batches b
         JOIN batch_movements m ON m.batch_id = b.id
         JOIN inventory_transactions t ON t.client_txn_id = $2
        WHERE b.id = $1`, [batch.id, id]);

    assert.equal(rows[0].batch_origin, ORIGIN);
    assert.equal(rows[0].movement_origin, ORIGIN);
    assert.equal(rows[0].txn_origin, ORIGIN);
  } finally {
    await cleanup({ batchIds, commodityIds: [commodity.id], userIds: [user.id], clientTxnIds: [id] });
  }
});

test('an unrecognised WMS_ORIGIN is refused rather than guessed at', async () => {
  // Imported in a child process, because the module throws at import time by design.
  const { execFileSync } = await import('node:child_process');
  assert.throws(() => {
    execFileSync(process.execPath, ['-e', "import('./src/lib/instance.js')"], {
      env: { ...process.env, WMS_ORIGIN: 'warehouse' },
      stdio: 'pipe',
    });
  }, /WMS_ORIGIN must be/);
});

// ── Mandatory transaction identity ──────────────────────────────────────────
test('an inventory-changing request without a transaction id is refused', () => {
  assert.throws(() => IdempotencyService.require(undefined), /clientTxnId is required/);
  assert.throws(() => IdempotencyService.require(''), /clientTxnId is required/);
  assert.throws(() => IdempotencyService.require(null), /clientTxnId is required/);
  // A valid one still passes straight through.
  assert.equal(IdempotencyService.require('01JABCDEF23456789'), '01JABCDEF23456789');
});

// ── Traceability ────────────────────────────────────────────────────────────
test('a dispatch movement names the order it belonged to', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 500);
  const id = txnId('TRACE');

  try {
    const order = await DispatchService.createOrder({
      facilityId: facility.id,
      items: [{ commodityId: commodity.id, quantity: 100, unitPrice: 1 }],
      dispatchedBy: 'Tester', scheme: await scheme(), clientTxnId: id, actorUserId: user.id,
    });

    const moves = await movementsFor(batch.id, 'dispatch');
    assert.equal(moves[0].dispatch_order_id, order.id, 'the movement names its order');
    assert.ok(moves[0].dispatch_order_item_id, 'and its line');
    assert.equal(moves[0].facility_id, facility.id, 'and where the stock went');
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id], facilityIds: [facility.id], userIds: [user.id], clientTxnIds: [id] });
  }
});

test('the order link survives an edit, which is what the line link cannot do', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 500);
  const idA = txnId('EDIT1');
  const idB = txnId('EDIT2');

  try {
    const order = await DispatchService.createOrder({
      facilityId: facility.id,
      items: [{ commodityId: commodity.id, quantity: 100, unitPrice: 1 }],
      dispatchedBy: 'Tester', scheme: await scheme(), clientTxnId: idA, actorUserId: user.id,
    });
    assert.equal(await batchQuantity(batch.id), 400);

    await DispatchService.updateOrder(order.id, {
      items: [{ commodityId: commodity.id, quantity: 60, unitPrice: 1 }],
      editedBy: 'Tester', clientTxnId: idB, actorUserId: user.id,
    });

    // 500 - 100 + 100 (reversal) - 60 = 440
    assert.equal(await batchQuantity(batch.id), 440, 'the edit reversed and re-drew correctly');

    const all = await movementsFor(batch.id);
    const orderLinked = all.filter((m) => m.dispatch_order_id === order.id);
    const kinds = orderLinked.map((m) => m.movement_type).sort();
    assert.deepEqual(kinds, ['dispatch', 'dispatch', 'reversal'],
      'the original draw, its reversal and the new draw all still name the order');

    // And the ledger still ties out to the batch after an edit.
    const { ReconciliationService } = await import('../src/services/reconciliationService.js');
    assert.equal((await ReconciliationService.check({ batchIds: [batch.id] })).length, 0);
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id], facilityIds: [facility.id], userIds: [user.id], clientTxnIds: [idA, idB] });
  }
});

test('a request fulfilment links its movements to the order it produced', async () => {
  // The Phase 1 gap: fulfilment allocated stock with itemId null, so seven movements in the
  // live database name no document at all.
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 500);
  const envoId = `TEST-REQ-${Date.now()}`;
  const id = txnId('FUL');

  let requestId = null;
  try {
    await query(
      `INSERT INTO commodity_prices (commodity_id, unit_price, is_current)
       VALUES ($1, 10, true)`, [commodity.id]);

    const req = await RequestService.receiveFromEnvo({
      envoRequestId: envoId,
      envoFacilityId: null,
      facilityName: facility.name,
      items: [{ wmsCommodityId: commodity.id, quantity: 50 }],
      requestedBy: 'Facility Officer',
    });
    requestId = req.id;

    await RequestService.fulfil(req.id, {
      dispatchedBy: 'Tester', carrierName: 'Driver', carrierPhone: '08012345678',
      pickedBy: 'Picker', clientTxnId: id, actorUserId: user.id,
    });

    const moves = await movementsFor(batch.id, 'dispatch');
    assert.equal(moves.length, 1);
    assert.ok(moves[0].dispatch_order_id, 'the fulfilment movement names its dispatch order');
    assert.ok(moves[0].dispatch_order_item_id, 'and the line on it');

    const { rows } = await query('SELECT dispatch_order_id FROM requests WHERE id = $1', [req.id]);
    assert.equal(moves[0].dispatch_order_id, rows[0].dispatch_order_id,
      'and it is the order the request actually produced');
  } finally {
    if (requestId) {
      await query('DELETE FROM request_items WHERE request_id = $1', [requestId]);
      await query('UPDATE requests SET dispatch_order_id = NULL WHERE id = $1', [requestId]);
    }
    await query('DELETE FROM outbox WHERE payload->>\'envoRequestId\' = $1', [envoId]);
    await cleanup({ batchIds: [batch.id], facilityIds: [facility.id], clientTxnIds: [id] });
    if (requestId) await query('DELETE FROM requests WHERE id = $1', [requestId]);
    await query('DELETE FROM commodity_prices WHERE commodity_id = $1', [commodity.id]);
    await cleanup({ commodityIds: [commodity.id], userIds: [user.id] });
  }
});
