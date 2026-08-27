// Phase 1 — reconciliation (cases G, H) and FEFO preservation (case I).
//
// The point of G and H together: a healthy batch must not be reported, and an unhealthy one
// must be reported AND LEFT ALONE. A reconciliation that quietly fixed the number would
// pass a naive "no discrepancies afterwards" check while destroying the evidence, so H
// asserts the stock is still wrong after the run.

import test from 'node:test';
import assert from 'node:assert/strict';
import pool, { query } from '../src/db.js';
import { DispatchService } from '../src/services/dispatchService.js';
import { BatchService } from '../src/services/batchService.js';
import { ReconciliationService } from '../src/services/reconciliationService.js';
import {
  makeUser, makeFacility, makeCommodity, makeBatch,
  batchQuantity, movementsFor, cleanup, txnId, scheme,
} from './helpers.js';

test.after(async () => { await pool.end(); });

// Drift can no longer be created through the database's front door: the balance guard (035)
// rejects any change to quantity_remaining that no movement explains. That is the whole
// point of Phase 3. But reconciliation still has to be provable, and the drift it exists to
// find was caused by exactly this — an edit from OUTSIDE the application, by someone with
// rights the application does not have. So the tests reproduce it the same way: disable the
// guard, make the unexplained change, put the guard back.
async function withGuardDisabled(fn) {
  await query('ALTER TABLE commodity_batches DISABLE TRIGGER commodity_batches_balance_guard');
  try { return await fn(); }
  finally { await query('ALTER TABLE commodity_batches ENABLE TRIGGER commodity_batches_balance_guard'); }
}


// ── G. Reconciliation passes on a valid history ──────────────────────────────
test('G: a batch with a valid movement history reconciles', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 1000);
  const idD = txnId('G1');
  const idA = txnId('G2');

  try {
    await DispatchService.createOrder({
      facilityId: facility.id,
      items: [{ commodityId: commodity.id, quantity: 250, unitPrice: 5 }],
      dispatchedBy: 'Tester', scheme: await scheme(), clientTxnId: idD, actorUserId: user.id,
    });
    await BatchService.adjust(batch.id, {
      quantity: 30, reason: 'damaged', createdBy: 'Tester', clientTxnId: idA, actorUserId: user.id,
    });

    // 1000 received - 250 dispatched - 30 damaged = 720
    assert.equal(await batchQuantity(batch.id), 720);

    const found = await ReconciliationService.check({ batchIds: [batch.id] });
    assert.equal(found.length, 0, 'no discrepancy for a correctly-kept batch');
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id], facilityIds: [facility.id], userIds: [user.id], clientTxnIds: [idD, idA] });
  }
});

// ── H. Discrepancy detected, and NOT corrected ───────────────────────────────
test('H: an introduced mismatch is detected, recorded, and left uncorrected', async () => {
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 500);

  try {
    // Introduce drift the way the real failure looked: the balance moves without a movement
    // to justify it. 500 on the ledger, 480 on the shelf.
    await withGuardDisabled(() =>
      query('UPDATE commodity_batches SET quantity_remaining = 480 WHERE id = $1', [batch.id]));

    const result = await ReconciliationService.run({ batchIds: [batch.id], source: 'test' });
    const mine = result.discrepancies.find((d) => d.batchId === batch.id);

    assert.ok(mine, 'the discrepancy was detected');
    assert.equal(mine.expected, 500, 'expected comes from the ledger');
    assert.equal(mine.actual, 480, 'actual comes from the batch');
    assert.equal(mine.variance, -20, 'variance is actual minus expected');

    // Recorded, with everything an investigation needs.
    const { rows } = await query(
      'SELECT * FROM stock_discrepancies WHERE batch_id = $1 AND resolved_at IS NULL', [batch.id]);
    assert.equal(rows.length, 1, 'exactly one open finding');
    assert.equal(Number(rows[0].variance), -20);
    assert.equal(rows[0].source, 'test');
    assert.ok(rows[0].detected_at, 'detection is timestamped');

    // THE IMPORTANT ASSERTION: nothing was silently put right.
    assert.equal(await batchQuantity(batch.id), 480, 'stock was NOT auto-corrected');
    assert.equal((await movementsFor(batch.id, 'adjustment')).length, 0,
      'no compensating adjustment was invented');

    // Re-running updates the finding rather than stacking duplicates.
    await ReconciliationService.run({ batchIds: [batch.id], source: 'test-again' });
    const { rows: after } = await query(
      'SELECT * FROM stock_discrepancies WHERE batch_id = $1 AND resolved_at IS NULL', [batch.id]);
    assert.equal(after.length, 1, 'still one open finding, not two');
    assert.equal(after[0].source, 'test-again', 'the finding was refreshed');
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id] });
  }
});

test('H2: resolving a finding is a human act that records a reason and touches no stock', async () => {
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 100);

  try {
    await withGuardDisabled(() =>
      query('UPDATE commodity_batches SET quantity_remaining = 90 WHERE id = $1', [batch.id]));
    await ReconciliationService.run({ batchIds: [batch.id], source: 'test' });
    const { rows } = await query('SELECT id FROM stock_discrepancies WHERE batch_id = $1', [batch.id]);

    await assert.rejects(
      ReconciliationService.resolve(rows[0].id, { resolvedBy: 'Store Officer', note: '' }),
      /note explaining/i, 'a resolution without an explanation is refused');

    const resolved = await ReconciliationService.resolve(rows[0].id, {
      resolvedBy: 'Store Officer', note: 'Counted again; ten went out on a paper waybill.',
    });
    assert.ok(resolved.resolved_at, 'the finding is closed');
    assert.equal(resolved.resolved_by, 'Store Officer');
    assert.equal(await batchQuantity(batch.id), 90, 'resolving changed no stock');
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id] });
  }
});

// ── I. FEFO preserved ────────────────────────────────────────────────────────
test('I: FEFO still draws soonest-expiry first and skips expired lots', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();

  const expired = await makeBatch(commodity.id, 100, { expiryDate: '2020-01-01', batchNumber: `EXP-${Date.now()}` });
  const soon    = await makeBatch(commodity.id, 100, { expiryDate: '2030-01-01', batchNumber: `SOON-${Date.now()}` });
  const later   = await makeBatch(commodity.id, 100, { expiryDate: '2035-01-01', batchNumber: `LATE-${Date.now()}` });
  const id = txnId('FEFO');

  try {
    // 150 across the usable lots: 100 from the sooner one, then 50 from the later one.
    // The expired lot holds 100 but must not be touched.
    await DispatchService.createOrder({
      facilityId: facility.id,
      items: [{ commodityId: commodity.id, quantity: 150, unitPrice: 1 }],
      dispatchedBy: 'Tester', scheme: await scheme(), clientTxnId: id, actorUserId: user.id,
    });

    assert.equal(await batchQuantity(expired.id), 100, 'the expired lot was left alone');
    assert.equal(await batchQuantity(soon.id), 0, 'the soonest-expiry lot was emptied first');
    assert.equal(await batchQuantity(later.id), 50, 'the remainder came from the later lot');
  } finally {
    await cleanup({
      batchIds: [expired.id, soon.id, later.id], commodityIds: [commodity.id],
      facilityIds: [facility.id], userIds: [user.id], clientTxnIds: [id],
    });
  }
});

test('I2: an over-draw that only expired stock could satisfy is refused', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const expired = await makeBatch(commodity.id, 500, { expiryDate: '2020-01-01' });
  const usable  = await makeBatch(commodity.id, 50,  { expiryDate: '2030-01-01' });
  const id = txnId('FEFO2');

  try {
    await assert.rejects(
      DispatchService.createOrder({
        facilityId: facility.id,
        items: [{ commodityId: commodity.id, quantity: 200, unitPrice: 1 }],
        dispatchedBy: 'Tester', scheme: await scheme(), clientTxnId: id, actorUserId: user.id,
      }),
      /insufficient stock/i, 'expired stock does not count towards availability');

    assert.equal(await batchQuantity(expired.id), 500);
    assert.equal(await batchQuantity(usable.id), 50);
  } finally {
    await cleanup({
      batchIds: [expired.id, usable.id], commodityIds: [commodity.id],
      facilityIds: [facility.id], userIds: [user.id], clientTxnIds: [id],
    });
  }
});
