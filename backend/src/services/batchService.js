import { query, withTransaction } from '../db.js';
import { IdempotencyService } from './idempotencyService.js';
import { ORIGIN, INSTANCE_ID } from '../lib/instance.js';
import { assertCanWriteWarehouseStock } from '../lib/role.js';

export class BatchService {
  static async listForCommodity(commodityId, { includeDepleted = false } = {}) {
    const { rows } = await query(
      `SELECT b.id,
              b.commodity_id,
              b.batch_number,
              b.expiry_date,
              b.unit_cost,
              b.quantity_received,
              b.quantity_remaining,
              b.received_date,
              b.vendor_id,
              v.name AS vendor_name,
              (b.expiry_date < CURRENT_DATE) AS is_expired,
              (b.expiry_date - CURRENT_DATE) AS days_to_expiry
         FROM commodity_batches b
         LEFT JOIN vendors v ON v.id = b.vendor_id
        WHERE b.commodity_id = $1
          AND ($2 OR b.quantity_remaining > 0)
        ORDER BY b.expiry_date`,
      [commodityId, includeDepleted]
    );
    return rows;
  }

  static async movements(batchId) {
    const { rows } = await query(
      `SELECT m.id,
              m.movement_type,
              m.quantity,
              m.facility_id,
              f.name AS facility_name,
              m.dispatch_order_item_id,
              m.reason,
              m.note,
              m.created_by,
              m.created_at
         FROM batch_movements m
         LEFT JOIN facilities f ON f.id = m.facility_id
        WHERE m.batch_id = $1
        ORDER BY m.created_at`,
      [batchId]
    );
    return rows;
  }

  // Receiving a lot creates the batch and its opening 'receipt' movement together, so the
  // ledger always reconciles against quantity_remaining.
  // batchNumber is optional — stock is often on the shelf before anyone has read the lot
  // code off the carton. It can be filled in later with setBatchNumber.
  // `note` rides on the opening movement so a batch's origin stays readable in the
  // ledger — a stock-take opening balance is not the same event as a delivery.
  // `clientTxnId` names this receipt so a retry cannot create a second lot. It matters most
  // here: batch numbers are optional (see 021) and almost every lot on hand has none, so
  // UNIQUE(commodity_id, batch_number) does not catch a repeat — NULLs never collide.
  static async receive({ commodityId, vendorId, batchNumber, expiryDate, quantity, unitCost, receivedDate, createdBy, note, clientTxnId = null, actorUserId = null }) {
    // Ownership applies. The master-data staleness gate deliberately does NOT: receiving is
    // unpriced, and refusing it would stop the warehouse recording stock it is physically
    // holding — which loses information and helps nobody.
    assertCanWriteWarehouseStock();
    return withTransaction(async (client) => {
      // The gate: claimed before anything is written, so a duplicate never reaches the
      // INSERT below.
      let txnId = null;
      if (clientTxnId) {
        const { txn, replay } = await IdempotencyService.claim(client, {
          clientTxnId, operation: 'receipt', actorUserId, actor: createdBy ?? null,
        });
        if (replay) return txn.result;
        txnId = txn.id;
      }

      const { rows } = await client.query(
        `INSERT INTO commodity_batches
           (commodity_id, vendor_id, batch_number, expiry_date, unit_cost,
            quantity_received, quantity_remaining, received_date, created_by,
            origin, source_instance)
         VALUES ($1, $2, $3, $4, $5, $6, $6, COALESCE($7::date, CURRENT_DATE), $8, $9, $10)
         RETURNING id, uid, commodity_id, batch_number, expiry_date, quantity_received,
                   quantity_remaining, unit_cost, received_date`,
        [commodityId, vendorId ?? null, batchNumber?.trim() || null, expiryDate, unitCost ?? null, quantity, receivedDate ?? null, createdBy ?? null, ORIGIN, INSTANCE_ID]
      );
      const batch = rows[0];

      await client.query(
        `INSERT INTO batch_movements
           (batch_id, movement_type, quantity, note, created_by, txn_id, origin, source_instance)
         VALUES ($1, 'receipt', $2, $3, $4, $5, $6, $7)`,
        [batch.id, quantity, note?.trim() || 'batch received', createdBy ?? null, txnId, ORIGIN, INSTANCE_ID]
      );

      if (txnId) await IdempotencyService.complete(client, txnId, batch, { batchId: batch.id });

      return batch;
    });
  }

  // Record the real lot code on a batch that went in unlabelled, or correct a mistyped one.
  static async setBatchNumber(batchId, { batchNumber }) {
    const value = batchNumber?.trim() || null;
    const { rows } = await query(
      'UPDATE commodity_batches SET batch_number = $2 WHERE id = $1 RETURNING id, commodity_id, batch_number, expiry_date',
      [batchId, value]
    );
    return rows[0] || null;
  }

  // Why stock moved outside a receipt or a dispatch. The direction belongs to the reason,
  // not to whoever types the number: stock cannot be *gained* by expiring, and a facility
  // return cannot take stock away. Only a recount can go either way, which is the whole
  // point of a recount.
  static ADJUSTMENT_REASONS = {
    expired: { label: 'Expired', direction: -1 },
    loss: { label: 'Loss', direction: -1 },
    damaged: { label: 'Damaged', direction: -1 },
    count_correction: { label: 'Physical count correction', direction: 0 },
    facility_return: { label: 'Returned from facility', direction: 1 },
  };

  // Corrections only (damage, recount, returns). Routine outbound stock leaves via
  // dispatch orders. `quantity` is the size of the change; the reason decides its sign,
  // except for a recount, where the caller passes a signed delta because only they know
  // which way the count went.
  static async adjust(batchId, { delta, quantity, reason, note, createdBy, clientTxnId = null, actorUserId = null }) {
    const rule = BatchService.ADJUSTMENT_REASONS[reason];
    if (!rule) {
      const err = new Error(
        `unknown adjustment reason "${reason}" — expected one of ${Object.keys(BatchService.ADJUSTMENT_REASONS).join(', ')}`
      );
      err.status = 400;
      throw err;
    }

    const raw = Number(quantity ?? delta);
    if (!Number.isFinite(raw) || raw === 0) {
      const err = new Error('adjustment quantity must be a non-zero number');
      err.status = 400;
      throw err;
    }

    // A signed amount is only meaningful for a recount; elsewhere the magnitude is taken
    // and the reason applies the sign, so "-5 damaged" and "5 damaged" both remove five.
    const signed = rule.direction === 0 ? raw : Math.abs(raw) * rule.direction;

    return BatchService.applyAdjustment(batchId, { signed, reason, note, createdBy, clientTxnId, actorUserId });
  }

  static async applyAdjustment(batchId, { signed, reason, note, createdBy, clientTxnId = null, actorUserId = null }) {
    // Unpriced, like receiving: available whatever the state of master data.
    assertCanWriteWarehouseStock();
    const delta = signed;
    return withTransaction(async (client) => {
      // Claimed before the row is locked: a duplicate must not even take the lock, let
      // alone apply the delta twice.
      let txnId = null;
      if (clientTxnId) {
        const { txn, replay } = await IdempotencyService.claim(client, {
          clientTxnId, operation: 'adjustment', actorUserId, actor: createdBy ?? null,
        });
        if (replay) return txn.result;
        txnId = txn.id;
      }

      const { rows } = await client.query(
        'SELECT id, quantity_remaining FROM commodity_batches WHERE id = $1 FOR UPDATE',
        [batchId]
      );
      const batch = rows[0];
      if (!batch) {
        const err = new Error('batch not found');
        err.status = 404;
        throw err;
      }

      const next = Number(batch.quantity_remaining) + Number(delta);
      if (next < 0) {
        const err = new Error(
          `adjustment would leave a negative balance (remaining ${batch.quantity_remaining}, delta ${delta})`
        );
        err.status = 400;
        throw err;
      }

      const updated = await client.query(
        `UPDATE commodity_batches SET quantity_remaining = $2 WHERE id = $1
         RETURNING id, commodity_id, batch_number, quantity_remaining`,
        [batchId, next]
      );

      await client.query(
        `INSERT INTO batch_movements
           (batch_id, movement_type, quantity, reason, note, created_by, txn_id, origin, source_instance)
         VALUES ($1, 'adjustment', $2, $3, $4, $5, $6, $7, $8)`,
        [batchId, delta, reason, note?.trim() || null, createdBy ?? null, txnId, ORIGIN, INSTANCE_ID]
      );

      if (txnId) await IdempotencyService.complete(client, txnId, updated.rows[0], { batchId });

      return updated.rows[0];
    });
  }
}
