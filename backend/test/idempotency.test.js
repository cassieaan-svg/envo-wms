// Phase 1 — transaction identity and idempotency.
//
// Cases A-F and J from the Phase 1 brief: a normal transaction, a duplicate retry, a
// concurrent duplicate, two legitimate transactions competing for the same batch,
// insufficient stock, rollback, and the committed-but-response-lost retry.
//
// The assertions deliberately check STOCK as well as row counts. A duplicate that wrote one
// movement but decremented twice would pass a row count and still be the bug this phase
// exists to prevent.

import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../src/db.js';
import { BatchService } from '../src/services/batchService.js';
import { DispatchService } from '../src/services/dispatchService.js';
import { IdempotencyService } from '../src/services/idempotencyService.js';
import {
  makeUser, makeFacility, makeCommodity, makeBatch,
  batchQuantity, movementsFor, cleanup, txnId, scheme,
} from './helpers.js';

test.after(async () => { await pool.end(); });

// ── A. Normal transaction ────────────────────────────────────────────────────
test('A: a dispatch moves stock once and writes one movement', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 500);
  const id = txnId('A');

  try {
    const order = await DispatchService.createOrder({
      facilityId: facility.id,
      items: [{ commodityId: commodity.id, quantity: 100, unitPrice: 10 }],
      dispatchedBy: 'Tester', scheme: await scheme(),
      clientTxnId: id, actorUserId: user.id,
    });

    assert.ok(order.id, 'an order was created');
    assert.equal(await batchQuantity(batch.id), 400, 'stock reduced by exactly 100');
    const moves = await movementsFor(batch.id, 'dispatch');
    assert.equal(moves.length, 1, 'exactly one dispatch movement');
    assert.equal(Number(moves[0].quantity), -100);
    assert.ok(moves[0].txn_id, 'the movement is linked to its transaction');
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id], facilityIds: [facility.id], userIds: [user.id], clientTxnIds: [id] });
  }
});

// ── B. Duplicate retry (and J: committed, response lost, client retries) ─────
test('B/J: retrying the same client_txn_id does not dispatch again', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 500);
  const id = txnId('B');
  const args = {
    facilityId: facility.id,
    items: [{ commodityId: commodity.id, quantity: 100, unitPrice: 10 }],
    dispatchedBy: 'Tester', scheme: await scheme(),
    clientTxnId: id, actorUserId: user.id,
  };

  try {
    const first = await DispatchService.createOrder(args);
    // The response never reached the client, so it sends the identical request again.
    const second = await DispatchService.createOrder(args);

    assert.equal(second.id, first.id, 'the retry is answered with the original order');
    assert.equal(await batchQuantity(batch.id), 400, 'stock moved once, not twice');
    assert.equal((await movementsFor(batch.id, 'dispatch')).length, 1, 'one movement only');

    const { rows } = await pool.query('SELECT COUNT(*)::int c FROM dispatch_orders WHERE facility_id = $1', [facility.id]);
    assert.equal(rows[0].c, 1, 'only one dispatch order exists');
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id], facilityIds: [facility.id], userIds: [user.id], clientTxnIds: [id] });
  }
});

// ── C. Concurrent duplicate ──────────────────────────────────────────────────
test('C: two identical requests at once produce one transaction', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 500);
  const id = txnId('C');
  const args = {
    facilityId: facility.id,
    items: [{ commodityId: commodity.id, quantity: 100, unitPrice: 10 }],
    dispatchedBy: 'Tester', scheme: await scheme(),
    clientTxnId: id, actorUserId: user.id,
  };

  try {
    // Fired together: both reach the INSERT, the unique index decides which one wins.
    const [a, b] = await Promise.all([
      DispatchService.createOrder(args),
      DispatchService.createOrder(args),
    ]);

    assert.equal(a.id, b.id, 'both callers see the same order');
    assert.equal(await batchQuantity(batch.id), 400, 'stock reduced once');
    assert.equal((await movementsFor(batch.id, 'dispatch')).length, 1, 'one movement only');
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id], facilityIds: [facility.id], userIds: [user.id], clientTxnIds: [id] });
  }
});

// ── D. Concurrent DIFFERENT transactions competing for the same batch ────────
test('D: two legitimate dispatches cannot consume the same stock twice', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 500);   // only 500 on hand
  const idA = txnId('D1');
  const idB = txnId('D2');
  const s = await scheme();
  const mk = (id) => ({
    facilityId: facility.id,
    items: [{ commodityId: commodity.id, quantity: 300, unitPrice: 10 }],
    dispatchedBy: 'Tester', scheme: s, clientTxnId: id, actorUserId: user.id,
  });

  try {
    // 300 + 300 against 500: row locking must let one through and refuse the other.
    const results = await Promise.allSettled([
      DispatchService.createOrder(mk(idA)),
      DispatchService.createOrder(mk(idB)),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    assert.equal(ok.length, 1, 'exactly one dispatch succeeded');
    assert.equal(failed.length, 1, 'the other was refused');
    assert.match(failed[0].reason.message, /insufficient stock/i);

    const remaining = await batchQuantity(batch.id);
    assert.equal(remaining, 200, 'stock reflects one dispatch of 300');
    assert.ok(remaining >= 0, 'stock never went negative');
    assert.equal((await movementsFor(batch.id, 'dispatch')).length, 1, 'one movement only');
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id], facilityIds: [facility.id], userIds: [user.id], clientTxnIds: [idA, idB] });
  }
});

// ── E. Insufficient stock ────────────────────────────────────────────────────
test('E: an over-draw is rejected and changes nothing', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 50);
  const id = txnId('E');

  try {
    await assert.rejects(
      DispatchService.createOrder({
        facilityId: facility.id,
        items: [{ commodityId: commodity.id, quantity: 100, unitPrice: 10 }],
        dispatchedBy: 'Tester', scheme: await scheme(),
        clientTxnId: id, actorUserId: user.id,
      }),
      /insufficient stock/i
    );

    assert.equal(await batchQuantity(batch.id), 50, 'stock untouched');
    assert.equal((await movementsFor(batch.id, 'dispatch')).length, 0, 'no movement written');

    // The rolled-back transaction released its id, so a corrected retry may reuse it.
    const { rows } = await pool.query('SELECT COUNT(*)::int c FROM inventory_transactions WHERE client_txn_id = $1', [id]);
    assert.equal(rows[0].c, 0, 'the failed attempt claimed no lasting identity');
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id], facilityIds: [facility.id], userIds: [user.id], clientTxnIds: [id] });
  }
});

// ── F. Rollback ──────────────────────────────────────────────────────────────
test('F: a failure after the stock mutation rolls back stock, movement and txn together', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 500);
  const id = txnId('F');

  try {
    // A second line naming a commodity that does not exist fails on the foreign key AFTER
    // the first line has already decremented stock and written its movement.
    await assert.rejects(
      DispatchService.createOrder({
        facilityId: facility.id,
        items: [
          { commodityId: commodity.id, quantity: 100, unitPrice: 10 },
          { commodityId: 2147483000, quantity: 1, unitPrice: 1 },
        ],
        dispatchedBy: 'Tester', scheme: await scheme(),
        clientTxnId: id, actorUserId: user.id,
      })
    );

    assert.equal(await batchQuantity(batch.id), 500, 'stock unchanged');
    assert.equal((await movementsFor(batch.id, 'dispatch')).length, 0, 'movement absent');

    const txn = await pool.query('SELECT COUNT(*)::int c FROM inventory_transactions WHERE client_txn_id = $1', [id]);
    assert.equal(txn.rows[0].c, 0, 'transaction identity absent');

    const orders = await pool.query('SELECT COUNT(*)::int c FROM dispatch_orders WHERE facility_id = $1', [facility.id]);
    assert.equal(orders.rows[0].c, 0, 'no order survived the rollback');
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id], facilityIds: [facility.id], userIds: [user.id], clientTxnIds: [id] });
  }
});

// ── Receiving: the path with no natural uniqueness of its own ────────────────
test('receiving: a retried receipt does not create a second lot', async () => {
  const user = await makeUser();
  const commodity = await makeCommodity();
  const id = txnId('R');
  const args = {
    commodityId: commodity.id, expiryDate: '2030-06-30', quantity: 1000,
    createdBy: 'Tester', clientTxnId: id, actorUserId: user.id,
    // No batch number — the normal case here, and the one UNIQUE(commodity, batch_number)
    // cannot catch, because NULLs never collide.
  };

  let batchIds = [];
  try {
    const first = await BatchService.receive(args);
    const second = await BatchService.receive(args);
    batchIds = [first.id];

    assert.equal(second.id, first.id, 'the retry returns the original batch');
    const { rows } = await pool.query('SELECT COUNT(*)::int c FROM commodity_batches WHERE commodity_id = $1', [commodity.id]);
    assert.equal(rows[0].c, 1, 'only one lot exists');
    assert.equal(await batchQuantity(first.id), 1000, 'quantity was not doubled');
    assert.equal((await movementsFor(first.id, 'receipt')).length, 1, 'one receipt movement');
  } finally {
    await cleanup({ batchIds, commodityIds: [commodity.id], userIds: [user.id], clientTxnIds: [id] });
  }
});

// ── Adjustments ──────────────────────────────────────────────────────────────
test('adjustment: a retried write-off is applied once', async () => {
  const user = await makeUser();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 200);
  const id = txnId('ADJ');
  const args = { quantity: 50, reason: 'damaged', createdBy: 'Tester', clientTxnId: id, actorUserId: user.id };

  try {
    await BatchService.adjust(batch.id, args);
    await BatchService.adjust(batch.id, args);

    assert.equal(await batchQuantity(batch.id), 150, 'fifty removed once');
    const moves = await movementsFor(batch.id, 'adjustment');
    assert.equal(moves.length, 1, 'one adjustment movement');
    assert.equal(Number(moves[0].quantity), -50, 'the reason set the sign');
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id], userIds: [user.id], clientTxnIds: [id] });
  }
});

// ── Security (Step 17) ───────────────────────────────────────────────────────
test('security: a transaction id is not a way to reach another user\'s transaction', async () => {
  const owner = await makeUser();
  const stranger = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 500);
  const id = txnId('SEC');
  const s = await scheme();

  try {
    await DispatchService.createOrder({
      facilityId: facility.id,
      items: [{ commodityId: commodity.id, quantity: 100, unitPrice: 10 }],
      dispatchedBy: 'Owner', scheme: s, clientTxnId: id, actorUserId: owner.id,
    });

    // Same id, different account: must be refused rather than replayed.
    await assert.rejects(
      DispatchService.createOrder({
        facilityId: facility.id,
        items: [{ commodityId: commodity.id, quantity: 100, unitPrice: 10 }],
        dispatchedBy: 'Stranger', scheme: s, clientTxnId: id, actorUserId: stranger.id,
      }),
      /belongs to another user/i
    );

    assert.equal(await batchQuantity(batch.id), 400, 'the refusal moved no stock');
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id], facilityIds: [facility.id], userIds: [owner.id, stranger.id], clientTxnIds: [id] });
  }
});

test('security: the same id cannot be reused for a different kind of operation', async () => {
  const user = await makeUser();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 200);
  const id = txnId('MIX');

  try {
    await BatchService.adjust(batch.id, { quantity: 10, reason: 'damaged', createdBy: 'T', clientTxnId: id, actorUserId: user.id });
    await assert.rejects(
      BatchService.receive({ commodityId: commodity.id, expiryDate: '2030-01-01', quantity: 5, createdBy: 'T', clientTxnId: id, actorUserId: user.id }),
      /different operation/i
    );
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id], userIds: [user.id], clientTxnIds: [id] });
  }
});

test('validation: a malformed client_txn_id is refused before it reaches the database', () => {
  assert.throws(() => IdempotencyService.validate('short'), /8-64 characters/);
  assert.throws(() => IdempotencyService.validate('has spaces in it'), /8-64 characters/);
  assert.equal(IdempotencyService.validate(null), null, 'absent is allowed');
  assert.equal(IdempotencyService.validate('01JABCDEF23456789'), '01JABCDEF23456789');
});
