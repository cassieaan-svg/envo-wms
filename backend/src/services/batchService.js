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
  static async receive({ commodityId, vendorId, batchNumber, expiryDate, quantity, unitCost, receivedDate, createdBy }) {
    return withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO commodity_batches
           (commodity_id, vendor_id, batch_number, expiry_date, unit_cost,
            quantity_received, quantity_remaining, received_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6, COALESCE($7::date, CURRENT_DATE), $8)
         RETURNING id, commodity_id, batch_number, expiry_date, quantity_received,
                   quantity_remaining, unit_cost, received_date`,
        [commodityId, vendorId ?? null, batchNumber, expiryDate, unitCost ?? null, quantity, receivedDate ?? null, createdBy ?? null]
      );
      const batch = rows[0];

      await client.query(
        `INSERT INTO batch_movements (batch_id, movement_type, quantity, note, created_by)
         VALUES ($1, 'receipt', $2, $3, $4)`,
        [batch.id, quantity, 'batch received', createdBy ?? null]
      );

      return batch;
    });
  }

  // Corrections only (damage, recount). Routine outbound stock leaves via dispatch orders.
  static async adjust(batchId, { delta, note, createdBy }) {
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
        `INSERT INTO batch_movements (batch_id, movement_type, quantity, note, created_by)
         VALUES ($1, 'adjustment', $2, $3, $4)`,
        [batchId, delta, note ?? null, createdBy ?? null]
      );

      return updated.rows[0];
    });
  }
}
