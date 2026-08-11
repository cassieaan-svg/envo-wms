import { query, withTransaction } from '../db.js';

export class PriceService {
  static async history(commodityId) {
    const { rows } = await query(
      `SELECT id, unit_price, effective_date, is_current, created_by, created_at
         FROM commodity_prices
        WHERE commodity_id = $1
        ORDER BY effective_date DESC, created_at DESC`,
      [commodityId]
    );
    return rows;
  }

  // Adjusting a price never overwrites the old row: it's flipped to is_current = false and
  // a new current row is inserted, so the trail of what a commodity used to cost survives.
  static async setCurrentPrice(commodityId, { unitPrice, effectiveDate, createdBy }) {
    return withTransaction(async (client) => {
      await client.query(
        'UPDATE commodity_prices SET is_current = FALSE WHERE commodity_id = $1 AND is_current',
        [commodityId]
      );

      const { rows } = await client.query(
        `INSERT INTO commodity_prices (commodity_id, unit_price, effective_date, is_current, created_by)
         VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), TRUE, $4)
         RETURNING id, commodity_id, unit_price, effective_date, is_current, created_at`,
        [commodityId, unitPrice, effectiveDate ?? null, createdBy ?? null]
      );
      return rows[0];
    });
  }
}
