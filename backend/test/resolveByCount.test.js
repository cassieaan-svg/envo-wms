// ReconciliationService.resolveByCount had no test coverage at all before this — flagged in
// the workflow audit. It now shares its movement-writing with BatchService.applyAdjustment
// via BatchService.writeAdjustmentMovement (consolidating what were two independent copies
// of the same INSERT/UPDATE pair); this covers both the refactor's correctness and the
// method's own behavior directly.

import test from 'node:test';
import assert from 'node:assert/strict';
import pool, { query } from '../src/db.js';
import { ReconciliationService } from '../src/services/reconciliationService.js';
import { makeCommodity, makeBatch, batchQuantity, movementsFor, cleanup } from './helpers.js';

test.after(async () => { await pool.end(); });

async function withGuardDisabled(fn) {
  await query('ALTER TABLE commodity_batches DISABLE TRIGGER commodity_batches_balance_guard');
  try { return await fn(); }
  finally { await query('ALTER TABLE commodity_batches ENABLE TRIGGER commodity_batches_balance_guard'); }
}

async function openFinding(batch) {
  const result = await ReconciliationService.run({ batchIds: [batch.id], source: 'test' });
  const { rows } = await query(
    'SELECT * FROM stock_discrepancies WHERE batch_id = $1 AND resolved_at IS NULL', [batch.id]);
  return rows[0];
}

test('resolving with a count that differs from the ledger writes one correction and closes the finding', async () => {
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 500); // ledger: 500

  try {
    // Balance drifts to 480 with no movement — the failure this whole mechanism exists for.
    await withGuardDisabled(() =>
      query('UPDATE commodity_batches SET quantity_remaining = 480 WHERE id = $1', [batch.id]));
    const finding = await openFinding(batch);
    assert.ok(finding, 'a discrepancy was recorded');

    // The physical count found 475 — neither the ledger's 500 nor the drifted balance's 480.
    const closed = await ReconciliationService.resolveByCount(finding.id, {
      countedQuantity: 475, resolvedBy: 'Store Officer', note: 'Recount after stock-take',
    });

    assert.ok(closed.resolved_at, 'the finding is closed');
    assert.equal(closed.resolved_by, 'Store Officer');
    assert.equal(await batchQuantity(batch.id), 475, 'balance is set to what was counted, not ledger+delta against the old balance');

    const corrections = await movementsFor(batch.id, 'adjustment');
    assert.equal(corrections.length, 1, 'exactly one correction movement');
    assert.equal(Number(corrections[0].quantity), -25, 'delta is against the LEDGER (500), not the drifted balance (480)');
    assert.equal(corrections[0].reason, 'count_correction');
    assert.match(corrections[0].note, /Physical count: 475/);

    // The guard's own invariant now holds with no outstanding allowance.
    const { rows: variance } = await query('SELECT 1 FROM batch_balance_variance WHERE batch_id = $1', [batch.id]);
    assert.equal(variance.length, 0, 'the allowance is retired — somebody has counted');
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id] });
  }
});

test('a count that agrees with the ledger closes the finding and writes no movement', async () => {
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 500); // ledger: 500

  try {
    await withGuardDisabled(() =>
      query('UPDATE commodity_batches SET quantity_remaining = 480 WHERE id = $1', [batch.id]));
    const finding = await openFinding(batch);

    // The count agrees with what the LEDGER always said (500) — the drift was a phantom, not
    // a real loss. No correction is invented for a number that was already right.
    const closed = await ReconciliationService.resolveByCount(finding.id, {
      countedQuantity: 500, resolvedBy: 'Store Officer', note: 'Recount confirms the ledger',
    });

    assert.ok(closed.resolved_at);
    assert.equal(await batchQuantity(batch.id), 500);
    assert.equal((await movementsFor(batch.id, 'adjustment')).length, 0, 'no movement for a count that matches the ledger');
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id] });
  }
});

test('resolveByCount on an already-resolved or unknown finding returns null', async () => {
  const result = await ReconciliationService.resolveByCount(2_147_483_000, {
    countedQuantity: 10, resolvedBy: 'X', note: 'Y',
  });
  assert.equal(result, null);
});

test('resolveByCount requires the counter\'s name and a note', async () => {
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 500);

  try {
    await withGuardDisabled(() =>
      query('UPDATE commodity_batches SET quantity_remaining = 480 WHERE id = $1', [batch.id]));
    const finding = await openFinding(batch);

    await assert.rejects(
      ReconciliationService.resolveByCount(finding.id, { countedQuantity: 480, note: 'ok' }),
      /name of the person who counted/
    );
    await assert.rejects(
      ReconciliationService.resolveByCount(finding.id, { countedQuantity: 480, resolvedBy: 'X' }),
      /note describing the count/
    );
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id] });
  }
});
