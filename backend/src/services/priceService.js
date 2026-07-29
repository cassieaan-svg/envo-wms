import { query, withTransaction } from '../db.js';

export class PriceService {
  static async history(commodityId) {
    const { rows } = await query(
      `SELECT cp.id,
              cp.vendor_id,
              v.name AS vendor_name,
              cp.brand_name,
              cp.unit_price,
              cp.effective_date,
              cp.is_current,
              cp.created_by,
              cp.created_at
         FROM commodity_prices cp
         JOIN vendors v ON v.id = cp.vendor_id
        WHERE cp.commodity_id = $1
        ORDER BY cp.effective_date DESC, cp.created_at DESC`,
      [commodityId]
    );
    return rows;
  }

  // Never overwrites a price: the old row is flipped to is_current = false and a new
  // current row is inserted, so history is preserved. Both steps in one transaction.
  static async setCurrentPrice(commodityId, { vendorId, brandName, unitPrice, effectiveDate, createdBy }) {
    return withTransaction(async (client) => {
      await client.query(
        `UPDATE commodity_prices
            SET is_current = FALSE
          WHERE commodity_id = $1
            AND vendor_id = $2
            AND brand_name IS NOT DISTINCT FROM $3
            AND is_current`,
        [commodityId, vendorId, brandName ?? null]
      );

      const { rows } = await client.query(
        `INSERT INTO commodity_prices
           (commodity_id, vendor_id, brand_name, unit_price, effective_date, is_current, created_by)
         VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE), TRUE, $6)
         RETURNING id, commodity_id, vendor_id, brand_name, unit_price, effective_date, is_current, created_at`,
        [commodityId, vendorId, brandName ?? null, unitPrice, effectiveDate ?? null, createdBy ?? null]
      );
      return rows[0];
    });
  }
}
