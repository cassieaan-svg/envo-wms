import { query, withTransaction } from '../db.js';

function round2(value) {
  return Math.round(value * 100) / 100;
}

export class DispatchService {
  // Creates one dispatch order covering every line. Each line is fulfilled FEFO
  // (soonest expiry first) across that commodity's batches. If any line cannot be
  // filled the whole transaction rolls back — no partially dispatched orders.
  static async createOrder({ facilityId, items, notes, dispatchedBy }) {
    return withTransaction(async (client) => {
      const facility = await client.query('SELECT id FROM facilities WHERE id = $1 AND is_active', [facilityId]);
      if (!facility.rows[0]) {
        const err = new Error('facility not found');
        err.status = 404;
        throw err;
      }

      const lines = items.map((item) => {
        const quantity = Number(item.quantity);
        const unitPrice = Number(item.unitPrice);
        return {
          commodityId: Number(item.commodityId),
          quantity,
          unitPrice,
          lineTotal: round2(quantity * unitPrice),
        };
      });

      const totalAmount = round2(lines.reduce((sum, line) => sum + line.lineTotal, 0));

      const orderResult = await client.query(
        `INSERT INTO dispatch_orders (facility_id, total_amount, dispatched_by, notes)
         VALUES ($1, $2, $3, $4)
         RETURNING id, facility_id, total_amount, dispatched_by, dispatched_at, notes`,
        [facilityId, totalAmount, dispatchedBy ?? null, notes ?? null]
      );
      const order = orderResult.rows[0];

      for (const line of lines) {
        const itemResult = await client.query(
          `INSERT INTO dispatch_order_items (dispatch_order_id, commodity_id, quantity, unit_price, line_total)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [order.id, line.commodityId, line.quantity, line.unitPrice, line.lineTotal]
        );
        const itemId = itemResult.rows[0].id;

        // Lock this commodity's usable batches in FEFO order for the duration of the
        // transaction so two concurrent dispatches can't both claim the same stock.
        const batches = await client.query(
          `SELECT b.id, b.batch_number, b.quantity_remaining, c.name AS commodity_name
             FROM commodity_batches b
             JOIN commodities c ON c.id = b.commodity_id
            WHERE b.commodity_id = $1
              AND b.quantity_remaining > 0
              AND b.expiry_date >= CURRENT_DATE
            ORDER BY b.expiry_date, b.id
              FOR UPDATE OF b`,
          [line.commodityId]
        );

        const available = batches.rows.reduce((sum, b) => sum + Number(b.quantity_remaining), 0);
        if (available < line.quantity) {
          const name = batches.rows[0]?.commodity_name || `commodity #${line.commodityId}`;
          const err = new Error(
            `insufficient stock for ${name}: requested ${line.quantity}, available ${available}`
          );
          err.status = 400;
          throw err;
        }

        let outstanding = line.quantity;
        for (const batch of batches.rows) {
          if (outstanding <= 0) break;

          const take = Math.min(outstanding, Number(batch.quantity_remaining));

          await client.query(
            'UPDATE commodity_batches SET quantity_remaining = quantity_remaining - $2 WHERE id = $1',
            [batch.id, take]
          );

          await client.query(
            `INSERT INTO batch_movements
               (batch_id, movement_type, quantity, facility_id, dispatch_order_item_id, created_by)
             VALUES ($1, 'dispatch', $2, $3, $4, $5)`,
            [batch.id, -take, facilityId, itemId, dispatchedBy ?? null]
          );

          outstanding = round2(outstanding - take);
        }
      }

      return this.getOrder(order.id, client);
    });
  }

  static async getOrder(orderId, client = null) {
    const run = client ? (text, params) => client.query(text, params) : query;

    const orderResult = await run(
      `SELECT o.id, o.facility_id, f.name AS facility_name, f.state, f.lga,
              o.total_amount, o.dispatched_by, o.dispatched_at, o.notes
         FROM dispatch_orders o
         JOIN facilities f ON f.id = o.facility_id
        WHERE o.id = $1`,
      [orderId]
    );
    const order = orderResult.rows[0];
    if (!order) return null;

    // Each line reports the batches it actually drew from, so a dispatched lot stays
    // traceable to the facility that received it.
    const itemsResult = await run(
      `SELECT i.id,
              i.commodity_id,
              c.name AS commodity_name,
              c.unit,
              i.quantity,
              i.unit_price,
              i.line_total,
              COALESCE(json_agg(
                json_build_object(
                  'batchId', b.id,
                  'batchNumber', b.batch_number,
                  'expiryDate', b.expiry_date,
                  'quantity', -m.quantity
                ) ORDER BY b.expiry_date
              ) FILTER (WHERE m.id IS NOT NULL), '[]'::json) AS batches
         FROM dispatch_order_items i
         JOIN commodities c ON c.id = i.commodity_id
         LEFT JOIN batch_movements m ON m.dispatch_order_item_id = i.id
         LEFT JOIN commodity_batches b ON b.id = m.batch_id
        WHERE i.dispatch_order_id = $1
        GROUP BY i.id, c.name, c.unit
        ORDER BY c.name`,
      [orderId]
    );

    return { ...order, items: itemsResult.rows };
  }

  static async listForFacility(facilityId) {
    const { rows } = await query(
      `SELECT o.id,
              o.total_amount,
              o.dispatched_by,
              o.dispatched_at,
              o.notes,
              COUNT(i.id)::int AS line_count,
              COALESCE(SUM(i.quantity), 0) AS total_quantity
         FROM dispatch_orders o
         LEFT JOIN dispatch_order_items i ON i.dispatch_order_id = o.id
        WHERE o.facility_id = $1
        GROUP BY o.id
        ORDER BY o.dispatched_at DESC`,
      [facilityId]
    );
    return rows;
  }
}
