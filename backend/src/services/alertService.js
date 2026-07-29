import { query } from '../db.js';

export class AlertService {
  // Batches at or near expiry that still hold stock. Already-expired batches have a
  // negative days_to_expiry, so ordering by expiry_date floats them to the top.
  static async expiry({ withinDays = 90 } = {}) {
    const { rows } = await query(
      `SELECT b.id AS batch_id,
              b.batch_number,
              b.expiry_date,
              b.quantity_remaining,
              (b.expiry_date - CURRENT_DATE) AS days_to_expiry,
              (b.expiry_date < CURRENT_DATE) AS is_expired,
              c.id AS commodity_id,
              c.name AS commodity_name,
              c.category,
              c.unit,
              v.name AS vendor_name
         FROM commodity_batches b
         JOIN commodities c ON c.id = b.commodity_id
         LEFT JOIN vendors v ON v.id = b.vendor_id
        WHERE b.quantity_remaining > 0
          AND b.expiry_date <= CURRENT_DATE + ($1::int * INTERVAL '1 day')
        ORDER BY b.expiry_date, c.name`,
      [withinDays]
    );
    return rows;
  }

  // Commodities whose usable on-hand quantity has crossed an admin-configured threshold.
  // Commodities with neither threshold set never alert.
  static async stock() {
    const { rows } = await query(
      `SELECT c.id AS commodity_id,
              c.name AS commodity_name,
              c.category,
              c.unit,
              c.reorder_level,
              c.max_level,
              COALESCE(SUM(b.quantity_remaining), 0) AS on_hand
         FROM commodities c
         LEFT JOIN commodity_batches b
                ON b.commodity_id = c.id
               AND b.quantity_remaining > 0
               AND b.expiry_date >= CURRENT_DATE
        WHERE c.is_active
          AND (c.reorder_level IS NOT NULL OR c.max_level IS NOT NULL)
        GROUP BY c.id
       HAVING (c.reorder_level IS NOT NULL AND COALESCE(SUM(b.quantity_remaining), 0) < c.reorder_level)
           OR (c.max_level IS NOT NULL AND COALESCE(SUM(b.quantity_remaining), 0) > c.max_level)
        ORDER BY c.category NULLS LAST, c.name`
    );

    const understock = [];
    const overstock = [];
    for (const row of rows) {
      const onHand = Number(row.on_hand);
      if (row.reorder_level != null && onHand < Number(row.reorder_level)) {
        understock.push({ ...row, shortfall: Number(row.reorder_level) - onHand });
      } else {
        overstock.push({ ...row, excess: onHand - Number(row.max_level) });
      }
    }

    return { understock, overstock };
  }
}
