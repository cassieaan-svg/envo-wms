import { query, withTransaction } from '../db.js';

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
  static async receive({ commodityId, vendorId, batchNumber, expiryDate, quantity, unitCost, receivedDate, createdBy, note }) {
    return withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO commodity_batches
           (commodity_id, vendor_id, batch_number, expiry_date, unit_cost,
            quantity_received, quantity_remaining, received_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6, COALESCE($7::date, CURRENT_DATE), $8)
         RETURNING id, commodity_id, batch_number, expiry_date, quantity_received,
                   quantity_remaining, unit_cost, received_date`,
        [commodityId, vendorId ?? null, batchNumber?.trim() || null, expiryDate, unitCost ?? null, quantity, receivedDate ?? null, createdBy ?? null]
      );
      const batch = rows[0];

      await client.query(
        `INSERT INTO batch_movements (batch_id, movement_type, quantity, note, created_by)
         VALUES ($1, 'receipt', $2, $3, $4)`,
        [batch.id, quantity, note?.trim() || 'batch received', createdBy ?? null]
      );

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
  static async adjust(batchId, { delta, quantity, reason, note, createdBy }) {
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

    return BatchService.applyAdjustment(batchId, { signed, reason, note, createdBy });
  }

  static async applyAdjustment(batchId, { signed, reason, note, createdBy }) {
    const delta = signed;
    return withTransaction(async (client) => {
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
        `INSERT INTO batch_movements (batch_id, movement_type, quantity, reason, note, created_by)
         VALUES ($1, 'adjustment', $2, $3, $4, $5)`,
        [batchId, delta, reason, note?.trim() || null, createdBy ?? null]
      );

      return updated.rows[0];
    });
  }
}
