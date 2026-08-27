// Phase 3 — the balance guard.
//
// The rule: quantity_remaining may not change unless a batch_movements row in the same
// transaction explains the change. Enforced by a deferred constraint trigger (035), so it
// cannot be bypassed by application code — which matters, because the damage it prevents
// was done from outside the application in the first place.
//
// Every legitimate inventory path must still work, and the tests below exercise the real
// services rather than hand-written SQL, so a path that stopped satisfying the guard would
// fail here rather than in the warehouse.

import test from 'node:test';
import assert from 'node:assert/strict';
import pool, { query, withTransaction } from '../src/db.js';
import { BatchService } from '../src/services/batchService.js';
import { DispatchService } from '../src/services/dispatchService.js';
import { RequestService } from '../src/services/requestService.js';
import { ReconciliationService } from '../src/services/reconciliationService.js';
import {
  makeUser, makeFacility, makeCommodity, makeBatch,
  batchQuantity, movementsFor, cleanup, txnId, scheme,
} from './helpers.js';

test.after(async () => { await pool.end(); });

const ledgerOf = async (batchId) => Number((await query(
  'SELECT COALESCE(SUM(quantity),0) s FROM batch_movements WHERE batch_id = $1', [batchId])).rows[0].s);

// Assert the invariant the guard exists to hold.
async function assertAgrees(batchId, expected) {
  const balance = await batchQuantity(batchId);
  const ledger = await ledgerOf(batchId);
  assert.equal(balance, ledger, `balance ${balance} must equal ledger ${ledger}`);
  if (expected !== undefined) assert.equal(balance, expected);
}

// ── A. Receiving ────────────────────────────────────────────────────────────
test('A: a legitimate receipt is accepted and leaves the two sides agreeing', async () => {
  const user = await makeUser();
  const commodity = await makeCommodity();
  const id = txnId('P3A');
  let batchIds = [];
  try {
    const batch = await BatchService.receive({
      commodityId: commodity.id, expiryDate: '2031-01-01', quantity: 750,
      createdBy: 'Store Officer', clientTxnId: id, actorUserId: user.id,
    });
    batchIds = [batch.id];
    await assertAgrees(batch.id, 750);
  } finally {
    await cleanup({ batchIds, commodityIds: [commodity.id], userIds: [user.id], clientTxnIds: [id] });
  }
});

// ── B. Direct dispatch ──────────────────────────────────────────────────────
test('B: a legitimate dispatch is accepted', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 500);
  const id = txnId('P3B');
  try {
    await DispatchService.createOrder({
      facilityId: facility.id,
      items: [{ commodityId: commodity.id, quantity: 120, unitPrice: 3 }],
      dispatchedBy: 'Store Officer', scheme: await scheme(), clientTxnId: id, actorUserId: user.id,
    });
    await assertAgrees(batch.id, 380);
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id], facilityIds: [facility.id], userIds: [user.id], clientTxnIds: [id] });
  }
});

// ── C. Request fulfilment ───────────────────────────────────────────────────
test('C: a legitimate request fulfilment is accepted', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 400);
  const envoId = `P3C-${Date.now()}`;
  const id = txnId('P3C');
  let requestId = null;
  try {
    await query('INSERT INTO commodity_prices (commodity_id, unit_price, is_current) VALUES ($1, 12, true)', [commodity.id]);
    const req = await RequestService.receiveFromEnvo({
      envoRequestId: envoId, envoFacilityId: null, facilityName: facility.name,
      items: [{ wmsCommodityId: commodity.id, quantity: 90 }], requestedBy: 'Facility Officer',
    });
    requestId = req.id;

    await RequestService.fulfil(req.id, {
      dispatchedBy: 'Store Officer', carrierName: 'Driver', carrierPhone: '08012345678',
      pickedBy: 'Picker', clientTxnId: id, actorUserId: user.id,
    });
    await assertAgrees(batch.id, 310);
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

// ── D. Adjustments, every reason ────────────────────────────────────────────
test('D: every adjustment reason is accepted and keeps the two sides agreeing', async () => {
  const user = await makeUser();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 1000);
  const ids = [];
  try {
    for (const [reason, qty, expect] of [
      ['damaged', 10, 990], ['expired', 20, 970], ['loss', 5, 965], ['facility_return', 15, 980],
    ]) {
      const id = txnId('P3D'); ids.push(id);
      await BatchService.adjust(batch.id, { quantity: qty, reason, createdBy: 'Store Officer', clientTxnId: id, actorUserId: user.id });
      await assertAgrees(batch.id, expect);
    }
    // A recount carries its own sign.
    const id = txnId('P3Dc'); ids.push(id);
    await BatchService.adjust(batch.id, { quantity: -30, reason: 'count_correction', createdBy: 'Store Officer', clientTxnId: id, actorUserId: user.id });
    await assertAgrees(batch.id, 950);
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id], userIds: [user.id], clientTxnIds: ids });
  }
});

// ── E. Reversal (order edit) ────────────────────────────────────────────────
test('E: a reversal via an order edit is accepted — the same batch touched twice in one transaction', async () => {
  // This is the case a per-event delta rule would have rejected: updateOrder puts the
  // original quantity back and then draws the new one, so the batch row is updated twice in
  // a single transaction and neither update on its own matches the transaction's movements.
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 500);
  const idA = txnId('P3E1');
  const idB = txnId('P3E2');
  try {
    const order = await DispatchService.createOrder({
      facilityId: facility.id,
      items: [{ commodityId: commodity.id, quantity: 100, unitPrice: 1 }],
      dispatchedBy: 'Store Officer', scheme: await scheme(), clientTxnId: idA, actorUserId: user.id,
    });
    await assertAgrees(batch.id, 400);

    await DispatchService.updateOrder(order.id, {
      items: [{ commodityId: commodity.id, quantity: 60, unitPrice: 1 }],
      editedBy: 'Store Officer', clientTxnId: idB, actorUserId: user.id,
    });
    await assertAgrees(batch.id, 440);

    const kinds = (await movementsFor(batch.id)).map((m) => m.movement_type);
    assert.deepEqual(kinds.sort(), ['dispatch', 'dispatch', 'receipt', 'reversal']);
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id], facilityIds: [facility.id], userIds: [user.id], clientTxnIds: [idA, idB] });
  }
});

// ── F. Stocktake scripts ────────────────────────────────────────────────────
test('F: the stocktake statement sequences still satisfy the guard', async () => {
  // Reproduces the exact statement sequence of scripts/importStocktake.mjs and
  // scripts/baselineStocktake.mjs rather than invoking them (both are CLI entry points that
  // read a CSV and require --commit). Both already write the movement and the balance inside
  // one withTransaction, which is why neither script needed changing.
  const commodity = await makeCommodity();
  let batchId = null;
  try {
    // importStocktake: create the batch and its opening receipt together.
    batchId = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO commodity_batches
           (commodity_id, batch_number, expiry_date, quantity_received, quantity_remaining,
            received_date, created_by)
         VALUES ($1, NULL, $2, $3, $3, CURRENT_DATE, 'stocktake-import') RETURNING id`,
        [commodity.id, '2032-05-01', 640]);
      await client.query(
        `INSERT INTO batch_movements (batch_id, movement_type, quantity, note, created_by)
         VALUES ($1, 'receipt', $2, 'stock-take opening balance', 'stocktake-import')`,
        [rows[0].id, 640]);
      return rows[0].id;
    });
    await assertAgrees(batchId, 640);

    // baselineStocktake: write the superseding adjustment, then zero the balance.
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO batch_movements (batch_id, movement_type, quantity, reason, note, created_by)
         VALUES ($1, 'adjustment', $2, 'count_correction', 'superseded by physical count', 'stocktake-import')`,
        [batchId, -640]);
      await client.query('UPDATE commodity_batches SET quantity_remaining = 0 WHERE id = $1', [batchId]);
    });
    await assertAgrees(batchId, 0);

    // baselineStocktake also clears placeholder lot codes — a metadata-only update, which
    // must remain allowed because it does not touch the balance at all.
    await query('UPDATE commodity_batches SET batch_number = NULL WHERE id = $1', [batchId]);
  } finally {
    await cleanup({ batchIds: batchId ? [batchId] : [], commodityIds: [commodity.id] });
  }
});

// ── G. Out-of-band update rejected ──────────────────────────────────────────
test('G: a direct out-of-band UPDATE of quantity_remaining is rejected', async () => {
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 300);
  try {
    await assert.rejects(
      query('UPDATE commodity_batches SET quantity_remaining = 305 WHERE id = $1', [batch.id]),
      /does not match its ledger/,
      'raising the balance with no movement must be refused');

    await assert.rejects(
      query('UPDATE commodity_batches SET quantity_remaining = 0 WHERE id = $1', [batch.id]),
      /does not match its ledger/,
      'and so must lowering it');

    await assertAgrees(batch.id, 300);
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id] });
  }
});

test('G2: a batch inserted with an opening balance and no movement is rejected', async () => {
  const commodity = await makeCommodity();
  try {
    await assert.rejects(
      query(`INSERT INTO commodity_batches
               (commodity_id, batch_number, expiry_date, quantity_received, quantity_remaining, created_by)
             VALUES ($1, NULL, '2031-01-01', 500, 500, 'sneaky')`, [commodity.id]),
      /does not match its ledger/,
      'stock cannot be conjured by inserting a batch');
  } finally {
    await cleanup({ commodityIds: [commodity.id] });
  }
});

// ── H. Movement + balance together is accepted ──────────────────────────────
test('H: a balance change accompanied by its movement is accepted', async () => {
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 200);
  try {
    await withTransaction(async (client) => {
      await client.query('UPDATE commodity_batches SET quantity_remaining = quantity_remaining - 45 WHERE id = $1', [batch.id]);
      await client.query(`INSERT INTO batch_movements (batch_id, movement_type, quantity, created_by)
                          VALUES ($1, 'dispatch', -45, 'test')`, [batch.id]);
    });
    await assertAgrees(batch.id, 155);
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id] });
  }
});

// ── I. Never negative ───────────────────────────────────────────────────────
test('I: stock cannot be driven negative, by dispatch or by adjustment', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 40);
  const idA = txnId('P3I1');
  const idB = txnId('P3I2');
  try {
    await assert.rejects(DispatchService.createOrder({
      facilityId: facility.id,
      items: [{ commodityId: commodity.id, quantity: 100, unitPrice: 1 }],
      dispatchedBy: 'X', scheme: await scheme(), clientTxnId: idA, actorUserId: user.id,
    }), /insufficient stock/i);

    await assert.rejects(BatchService.adjust(batch.id, {
      quantity: 100, reason: 'damaged', createdBy: 'X', clientTxnId: idB, actorUserId: user.id,
    }), /negative balance/i);

    await assertAgrees(batch.id, 40);
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id], facilityIds: [facility.id], userIds: [user.id], clientTxnIds: [idA, idB] });
  }
});

// ── J. The concurrency requirement ──────────────────────────────────────────
test('J: 500 on hand, concurrent 300 + 300 — one succeeds, one fails, ledger 200, never negative', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 500);
  const idA = txnId('P3J1');
  const idB = txnId('P3J2');
  const s = await scheme();
  const order = (id) => DispatchService.createOrder({
    facilityId: facility.id,
    items: [{ commodityId: commodity.id, quantity: 300, unitPrice: 1 }],
    dispatchedBy: 'X', scheme: s, clientTxnId: id, actorUserId: user.id,
  });

  try {
    const results = await Promise.allSettled([order(idA), order(idB)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one succeeded');
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1, 'exactly one was refused');
    assert.match(results.find((r) => r.status === 'rejected').reason.message, /insufficient stock/i);

    const balance = await batchQuantity(batch.id);
    assert.equal(balance, 200, 'final stock is 200');
    assert.ok(balance >= 0, 'never negative');
    await assertAgrees(batch.id, 200);
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id], facilityIds: [facility.id], userIds: [user.id], clientTxnIds: [idA, idB] });
  }
});

// ── K. Multi-batch dispatch ─────────────────────────────────────────────────
test('K: a draw spanning several batches keeps every batch in agreement', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const b1 = await makeBatch(commodity.id, 100, { expiryDate: '2029-01-01' });
  const b2 = await makeBatch(commodity.id, 100, { expiryDate: '2030-01-01' });
  const b3 = await makeBatch(commodity.id, 100, { expiryDate: '2031-01-01' });
  const id = txnId('P3K');
  try {
    await DispatchService.createOrder({
      facilityId: facility.id,
      items: [{ commodityId: commodity.id, quantity: 250, unitPrice: 1 }],
      dispatchedBy: 'X', scheme: await scheme(), clientTxnId: id, actorUserId: user.id,
    });
    await assertAgrees(b1.id, 0);
    await assertAgrees(b2.id, 0);
    await assertAgrees(b3.id, 50);
  } finally {
    await cleanup({ batchIds: [b1.id, b2.id, b3.id], commodityIds: [commodity.id], facilityIds: [facility.id], userIds: [user.id], clientTxnIds: [id] });
  }
});

// ── L. Idempotency still holds under the guard ──────────────────────────────
test('L: a retried dispatch still moves stock exactly once', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 500);
  const id = txnId('P3L');
  const args = {
    facilityId: facility.id,
    items: [{ commodityId: commodity.id, quantity: 75, unitPrice: 1 }],
    dispatchedBy: 'X', scheme: await scheme(), clientTxnId: id, actorUserId: user.id,
  };
  try {
    const first = await DispatchService.createOrder(args);
    const second = await DispatchService.createOrder(args);
    assert.equal(second.id, first.id);
    await assertAgrees(batch.id, 425);
    assert.equal((await movementsFor(batch.id, 'dispatch')).length, 1);
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id], facilityIds: [facility.id], userIds: [user.id], clientTxnIds: [id] });
  }
});

// ── M/N/O. Reconciliation, and a grandfathered variance ─────────────────────
test('M/N: reconciliation reports variance and ledger-internal anomalies without correcting', async () => {
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 500);
  try {
    // The guard blocks the front door, so drift is introduced the way it really happened —
    // from outside the application, with the trigger disabled.
    await query('ALTER TABLE commodity_batches DISABLE TRIGGER commodity_batches_balance_guard');
    try {
      await query('UPDATE commodity_batches SET quantity_remaining = 470 WHERE id = $1', [batch.id]);
    } finally {
      await query('ALTER TABLE commodity_batches ENABLE TRIGGER commodity_batches_balance_guard');
    }

    const result = await ReconciliationService.run({ batchIds: [batch.id], source: 'p3-test' });
    const mine = result.discrepancies.find((d) => d.batchId === batch.id);
    assert.ok(mine, 'variance detected');
    assert.equal(mine.variance, -30);

    const anomalies = await ReconciliationService.anomalies();
    const byKey = Object.fromEntries(anomalies.map((a) => [a.key, a]));
    for (const key of ['balance_vs_ledger', 'negative_derived_balance', 'movement_without_txn',
                       'orphan_movement', 'broken_txn_link', 'reversal_without_dispatch',
                       'adjustment_without_reason', 'dispatch_without_order',
                       'batch_without_movements', 'grandfathered_variance']) {
      assert.ok(byKey[key], `the ${key} check is reported`);
      assert.equal(typeof byKey[key].count, 'number');
    }
    assert.ok(byKey.balance_vs_ledger.count >= 1, 'the drifted batch shows up in the ledger check');

    // Nothing was put right.
    assert.equal(await batchQuantity(batch.id), 470, 'not auto-corrected');
    assert.equal((await movementsFor(batch.id, 'adjustment')).length, 0, 'no invented adjustment');
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id] });
  }
});

test('O: a grandfathered variance is carried, not corrected, and only a physical count clears it', async () => {
  // The shape of the three historical discrepancies: a batch whose balance disagrees with
  // its ledger, allowed to keep operating so the warehouse is not frozen, with the gap
  // recorded rather than erased.
  const user = await makeUser();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 500);
  const id = txnId('P3O');
  try {
    await query('ALTER TABLE commodity_batches DISABLE TRIGGER commodity_batches_balance_guard');
    try {
      await query('UPDATE commodity_batches SET quantity_remaining = 503 WHERE id = $1', [batch.id]);
    } finally {
      await query('ALTER TABLE commodity_batches ENABLE TRIGGER commodity_batches_balance_guard');
    }
    await query(`INSERT INTO batch_balance_variance (batch_id, variance, balance_at_grant, ledger_at_grant, note)
                 VALUES ($1, 3, 503, 500, 'test grandfather')`, [batch.id]);

    // A legitimate operation on the batch still works: the variance is carried, unchanged.
    await BatchService.adjust(batch.id, {
      quantity: 3, reason: 'damaged', createdBy: 'Store Officer', clientTxnId: id, actorUserId: user.id,
    });
    assert.equal(await batchQuantity(batch.id), 500, 'the adjustment applied');
    assert.equal(await ledgerOf(batch.id), 497, 'the ledger moved with it');
    const { rows: still } = await query('SELECT variance FROM batch_balance_variance WHERE batch_id = $1', [batch.id]);
    assert.equal(Number(still[0].variance), 3, 'the variance is unchanged, not quietly absorbed');

    // Only a physical count closes it.
    await ReconciliationService.run({ batchIds: [batch.id], source: 'p3-test' });
    const { rows: finding } = await query(
      'SELECT id FROM stock_discrepancies WHERE batch_id = $1 AND resolved_at IS NULL', [batch.id]);

    await assert.rejects(
      ReconciliationService.resolveByCount(finding[0].id, { countedQuantity: 500, resolvedBy: '', note: 'x' }),
      /who counted is required/i);
    await assert.rejects(
      ReconciliationService.resolveByCount(finding[0].id, { countedQuantity: undefined, resolvedBy: 'Officer', note: 'x' }),
      /countedQuantity/i);

    const closed = await ReconciliationService.resolveByCount(finding[0].id, {
      countedQuantity: 500, resolvedBy: 'Store Officer', note: 'Counted the shelf.',
    });
    assert.ok(closed.resolved_at, 'the finding is closed');

    // The count is now the truth, explained by an attributed movement, with no allowance left.
    await assertAgrees(batch.id, 500);
    const corrections = (await movementsFor(batch.id, 'adjustment')).filter((m) => m.reason === 'count_correction');
    assert.equal(corrections.length, 1, 'exactly one count correction was written');
    assert.equal(Number(corrections[0].quantity), 3, 'for the gap between ledger and count');
    assert.equal(corrections[0].created_by, 'Store Officer', 'signed for');
    const { rows: gone } = await query('SELECT 1 FROM batch_balance_variance WHERE batch_id = $1', [batch.id]);
    assert.equal(gone.length, 0, 'the allowance is retired');
  } finally {
    await query('DELETE FROM batch_balance_variance WHERE batch_id = $1', [batch.id]);
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id], userIds: [user.id], clientTxnIds: [id] });
  }
});
