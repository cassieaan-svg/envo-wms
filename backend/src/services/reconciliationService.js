import { query, withTransaction } from '../db.js';
import { BatchService } from './batchService.js';

// Does the shelf figure still agree with the ledger?
//
// The invariant: for every batch, quantity_remaining equals the sum of its movements.
// Receipts and returns add, dispatches and losses subtract, a reversal puts back what an
// edited order took, and a count correction moves it either way. If those add up to
// something other than what commodity_batches says, one of two things happened — stock
// moved without a movement, or a movement was written without the stock moving. Both are
// worth knowing about, and neither is safe to guess at.
//
// WHAT THIS DOES NOT DO. It never writes to commodity_batches. Finding that the ledger
// expects 500 where the batch says 480 does not make 500 true — the 20 are the interesting
// part, and overwriting the figure erases the only evidence they were ever missing. The
// finding is recorded; putting it right is a physical count and a `count_correction`
// adjustment, raised by a person who has been to the shelf.
//
// Explicit by design (never on a write path): one grouped scan over batch_movements is
// cheap for a warehouse of this size but has no business running inside a dispatch. Call it
// from the admin endpoint or scripts/reconcile.mjs.

export class ReconciliationService {
  /**
   * Compare every batch (or a named subset) against its ledger.
   * Returns [{ batchId, commodityId, batchNumber, expected, actual, variance, movementCount }]
   * — only the batches that disagree.
   */
  static async check({ batchIds = null, commodityId = null } = {}) {
    const { rows } = await query(
      `SELECT b.id                                AS batch_id,
              b.commodity_id,
              b.batch_number,
              c.name                              AS commodity_name,
              COALESCE(SUM(m.quantity), 0)::numeric AS expected,
              b.quantity_remaining::numeric         AS actual,
              (b.quantity_remaining - COALESCE(SUM(m.quantity), 0))::numeric AS variance,
              COUNT(m.id)::int                    AS movement_count
         FROM commodity_batches b
         JOIN commodities c ON c.id = b.commodity_id
         LEFT JOIN batch_movements m ON m.batch_id = b.id
        WHERE ($1::int[] IS NULL OR b.id = ANY($1))
          AND ($2::int   IS NULL OR b.commodity_id = $2)
        GROUP BY b.id, c.name
       HAVING b.quantity_remaining <> COALESCE(SUM(m.quantity), 0)
        ORDER BY ABS(b.quantity_remaining - COALESCE(SUM(m.quantity), 0)) DESC`,
      [batchIds, commodityId]
    );

    return rows.map((r) => ({
      batchId: r.batch_id,
      commodityId: r.commodity_id,
      commodityName: r.commodity_name,
      batchNumber: r.batch_number,
      expected: Number(r.expected),
      actual: Number(r.actual),
      variance: Number(r.variance),
      movementCount: r.movement_count,
    }));
  }

  /**
   * Run the check and record what it found. Returns { checkedAt, discrepancies, recorded }.
   *
   * An open finding for a batch is updated rather than duplicated, so the open list stays a
   * statement about the present. A batch that has come back into agreement is NOT silently
   * closed — someone corrected it, and that correction is theirs to sign for, so the finding
   * stays open until a person resolves it.
   */
  static async run({ batchIds = null, commodityId = null, source = 'manual' } = {}) {
    const discrepancies = await ReconciliationService.check({ batchIds, commodityId });

    const recorded = await withTransaction(async (client) => {
      let n = 0;
      for (const d of discrepancies) {
        await client.query(
          `INSERT INTO stock_discrepancies
             (batch_id, expected_quantity, actual_quantity, variance, source)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (batch_id) WHERE resolved_at IS NULL
           DO UPDATE SET expected_quantity = EXCLUDED.expected_quantity,
                         actual_quantity   = EXCLUDED.actual_quantity,
                         variance          = EXCLUDED.variance,
                         source            = EXCLUDED.source,
                         detected_at       = now()`,
          [d.batchId, d.expected, d.actual, d.variance, source]
        );
        n += 1;
      }
      return n;
    });

    return { checkedAt: new Date().toISOString(), discrepancies, recorded };
  }

  /**
   * Ledger-internal integrity, as distinct from cache-vs-ledger variance.
   *
   * The variance check asks "do the two sides agree?". These ask "is the ledger itself
   * coherent?" — which the variance check cannot see, because a ledger can be internally
   * wrong and still sum to whatever the balance happens to say.
   *
   * Several are expected to be non-zero on an existing database and say so: they describe
   * rows written before Phase 1 and Phase 2 added the fields being checked for. What matters
   * operationally is that those counts do not GROW. None of these corrects anything.
   */
  static async anomalies() {
    const checks = [
      ['balance_vs_ledger', 'Batches whose balance disagrees with their movements',
       `SELECT b.id AS batch_id, b.quantity_remaining AS balance,
               COALESCE(SUM(m.quantity),0) AS ledger
          FROM commodity_batches b LEFT JOIN batch_movements m ON m.batch_id = b.id
         GROUP BY b.id HAVING b.quantity_remaining <> COALESCE(SUM(m.quantity),0)`],

      ['negative_derived_balance', 'Batches whose movements sum to less than zero',
       `SELECT b.id AS batch_id, COALESCE(SUM(m.quantity),0) AS ledger
          FROM commodity_batches b LEFT JOIN batch_movements m ON m.batch_id = b.id
         GROUP BY b.id HAVING COALESCE(SUM(m.quantity),0) < 0`],

      ['movement_without_txn', 'Movements with no transaction identity (pre-Phase-1 rows)',
       `SELECT id AS movement_id, batch_id, movement_type, created_at
          FROM batch_movements WHERE txn_id IS NULL`],

      ['orphan_movement', 'Movements whose batch no longer exists',
       `SELECT m.id AS movement_id, m.batch_id FROM batch_movements m
          WHERE NOT EXISTS (SELECT 1 FROM commodity_batches b WHERE b.id = m.batch_id)`],

      ['broken_txn_link', 'Movements pointing at a transaction row that is gone',
       `SELECT m.id AS movement_id, m.txn_id FROM batch_movements m
          WHERE m.txn_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM inventory_transactions t WHERE t.id = m.txn_id)`],

      ['reversal_without_dispatch', 'Reversals with no dispatch on the same batch and order',
       `SELECT r.id AS movement_id, r.batch_id, r.dispatch_order_id
          FROM batch_movements r
         WHERE r.movement_type = 'reversal'
           AND NOT EXISTS (
             SELECT 1 FROM batch_movements d
              WHERE d.movement_type = 'dispatch' AND d.batch_id = r.batch_id
                AND d.dispatch_order_id IS NOT DISTINCT FROM r.dispatch_order_id)`],

      ['adjustment_without_reason', 'Adjustments that do not say why (pre-024 rows)',
       `SELECT id AS movement_id, batch_id, quantity, created_at
          FROM batch_movements WHERE movement_type = 'adjustment' AND reason IS NULL`],

      ['dispatch_without_order', 'Dispatch movements not linked to an order (pre-Phase-2 rows)',
       `SELECT id AS movement_id, batch_id, created_at
          FROM batch_movements WHERE movement_type = 'dispatch' AND dispatch_order_id IS NULL`],

      ['batch_without_movements', 'Batches with no movement history at all',
       `SELECT b.id AS batch_id, b.quantity_remaining
          FROM commodity_batches b
         WHERE NOT EXISTS (SELECT 1 FROM batch_movements m WHERE m.batch_id = b.id)`],

      ['grandfathered_variance', 'Batches running on an allowed variance, awaiting a count',
       `SELECT batch_id, variance, balance_at_grant, ledger_at_grant, granted_at
          FROM batch_balance_variance`],
    ];

    const out = [];
    for (const [key, description, sql] of checks) {
      const { rows } = await query(`WITH c AS (${sql}) SELECT * FROM c LIMIT 20`);
      const { rows: counted } = await query(`WITH c AS (${sql}) SELECT COUNT(*)::int n FROM c`);
      out.push({ key, description, count: counted[0].n, sample: rows });
    }
    return out;
  }

  /**
   * Close a finding by recording what a physical count actually found.
   *
   * This is the only way an allowed variance is retired, and it requires the counted
   * quantity — a number that can only come from someone standing at the shelf. It writes an
   * attributed `count_correction` movement for the difference between the ledger and the
   * count, sets the balance to what was counted, and drops the batch's allowance. All in one
   * transaction, so the balance guard validates the outcome: afterwards the two sides agree
   * exactly and the batch needs no allowance.
   *
   * It is not automatic correction. Nothing here decides what the right number is — it
   * records the number a person supplies, with their name against it.
   */
  static async resolveByCount(id, { countedQuantity, resolvedBy, note }) {
    if (!resolvedBy?.trim()) {
      const e = new Error('the name of the person who counted is required'); e.status = 400; throw e;
    }
    if (!note?.trim()) {
      const e = new Error('a note describing the count is required'); e.status = 400; throw e;
    }
    const counted = Number(countedQuantity);
    if (!Number.isFinite(counted) || counted < 0) {
      const e = new Error('countedQuantity must be the quantity physically counted (zero or more)');
      e.status = 400; throw e;
    }

    return withTransaction(async (client) => {
      const { rows: found } = await client.query(
        'SELECT * FROM stock_discrepancies WHERE id = $1 AND resolved_at IS NULL FOR UPDATE', [id]);
      const finding = found[0];
      if (!finding) return null;

      const { rows: batchRows } = await client.query(
        'SELECT id, quantity_remaining FROM commodity_batches WHERE id = $1 FOR UPDATE',
        [finding.batch_id]);
      if (!batchRows[0]) { const e = new Error('batch not found'); e.status = 404; throw e; }

      const { rows: led } = await client.query(
        'SELECT COALESCE(SUM(quantity),0) AS ledger FROM batch_movements WHERE batch_id = $1',
        [finding.batch_id]);
      const ledger = Number(led[0].ledger);
      const delta = counted - ledger;

      // The correction is the gap between what the ledger believed and what was counted. A
      // count that agrees with the ledger writes no movement — there is nothing to correct —
      // but still closes the finding and retires the allowance.
      //
      // Routed through BatchService.writeAdjustmentMovement — the same primitive
      // BatchService.applyAdjustment uses — so the shape of an 'adjustment' movement row is
      // written in exactly one place, not two independent copies of the same INSERT/UPDATE
      // pair. This call sets the balance to the COUNTED figure, not `ledger + delta` against
      // the batch's own current balance (applyAdjustment's usual arithmetic) — deliberately,
      // because closing pre-existing drift between the balance and its own ledger is the
      // entire point of a reconciliation resolution.
      if (delta !== 0) {
        await BatchService.writeAdjustmentMovement(client, finding.batch_id, {
          delta, newQuantityRemaining: counted, reason: 'count_correction',
          note: `Physical count: ${counted}. ${note.trim()}`, createdBy: resolvedBy.trim(),
        });
      } else {
        await client.query(
          'UPDATE commodity_batches SET quantity_remaining = $2 WHERE id = $1',
          [finding.batch_id, counted]);
      }

      // The allowance existed only because nobody had counted. Somebody has now.
      await client.query('DELETE FROM batch_balance_variance WHERE batch_id = $1', [finding.batch_id]);

      const { rows: closed } = await client.query(
        `UPDATE stock_discrepancies
            SET resolved_at = now(), resolved_by = $2, resolution_note = $3
          WHERE id = $1 RETURNING *`,
        [id, resolvedBy.trim(),
         `Counted ${counted}; ledger was ${ledger}; correction ${delta >= 0 ? '+' : ''}${delta}. ${note.trim()}`]);

      return closed[0];
    });
  }

  // Open findings, worst first — what someone needs to go and look at.
  static async listOpen() {
    const { rows } = await query(
      `SELECT d.*, b.batch_number, b.commodity_id, c.name AS commodity_name
         FROM stock_discrepancies d
         JOIN commodity_batches b ON b.id = d.batch_id
         JOIN commodities c ON c.id = b.commodity_id
        WHERE d.resolved_at IS NULL
        ORDER BY ABS(d.variance) DESC`
    );
    return rows;
  }

  /**
   * Close a finding once it has been investigated. This records that a person dealt with
   * it; it does not touch stock. If the count was wrong, the fix is a count_correction
   * adjustment through BatchService — which leaves its own movement, signed for, in the
   * ledger where it belongs.
   */
  static async resolve(id, { resolvedBy, note }) {
    if (!resolvedBy?.trim()) {
      const err = new Error('the name of the person resolving this is required');
      err.status = 400;
      throw err;
    }
    if (!note?.trim()) {
      const err = new Error('a note explaining what was found is required');
      err.status = 400;
      throw err;
    }
    const { rows } = await query(
      `UPDATE stock_discrepancies
          SET resolved_at = now(), resolved_by = $2, resolution_note = $3
        WHERE id = $1 AND resolved_at IS NULL
        RETURNING *`,
      [id, resolvedBy.trim(), note.trim()]
    );
    return rows[0] || null;
  }
}
