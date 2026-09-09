import { query, withTransaction } from '../db.js';
import { PriceService } from './priceService.js';

// On-hand deliberately excludes expired batches — expired stock is still on the shelf but
// isn't dispensable, and counting it would mask an understock alert.
const LIST_SQL = `
  SELECT c.id,
         c.envo_commodity_id,
         c.name,
         c.category,
         c.unit,
         c.is_active,
         c.reorder_level,
         c.max_level,
         COALESCE(b.on_hand, 0) AS on_hand,
         COALESCE(b.batch_count, 0)::int AS batch_count,
         b.nearest_expiry,
         b.nearest_batch_number,
         p.unit_price AS current_price,
         p.effective_date AS price_effective_date
    FROM commodities c
    LEFT JOIN (
      -- One row per commodity: usable stock, how many lots it sits in, and the lot that
      -- expires first — enough for the list to show a batch column without a second query.
      SELECT commodity_id,
             SUM(quantity_remaining) AS on_hand,
             COUNT(*) AS batch_count,
             MIN(expiry_date) AS nearest_expiry,
             (ARRAY_AGG(batch_number ORDER BY expiry_date, id))[1] AS nearest_batch_number,
             COUNT(*) FILTER (WHERE batch_number IS NULL)::int AS unlabelled_count
        FROM commodity_batches
       WHERE quantity_remaining > 0
         AND expiry_date >= CURRENT_DATE
       GROUP BY commodity_id
    ) b ON b.commodity_id = c.id
    LEFT JOIN commodity_prices p
           ON p.commodity_id = c.id
          AND p.is_current
`;

export class CommodityService {
  static async list({ category = null, includeInactive = false, search = null } = {}) {
    const { rows } = await query(
      `${LIST_SQL}
        WHERE ($1 OR c.is_active)
          AND ($2::text IS NULL OR c.category = $2)
          AND ($3::text IS NULL OR c.name ILIKE '%' || $3 || '%')
        ORDER BY c.category NULLS LAST, c.name`,
      [includeInactive, category, search]
    );
    return rows;
  }

  static async getById(id) {
    const { rows } = await query(`${LIST_SQL} WHERE c.id = $1`, [id]);
    return rows[0] || null;
  }

  // Category and unit price are the substance of a new commodity, so the price is written
  // in the same transaction rather than left for a second step.
  static async create({ name, category, unit, unitPrice, envoCommodityId, reorderLevel, maxLevel, createdBy }) {
    return withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO commodities (name, category, unit, envo_commodity_id, reorder_level, max_level)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, name, category, unit, envo_commodity_id, reorder_level, max_level, is_active, created_at`,
        [name, category || null, unit || null, envoCommodityId || null, reorderLevel ?? null, maxLevel ?? null]
      );
      const commodity = rows[0];

      // Routed through PriceService rather than a second raw INSERT here — a commodity's
      // opening price is not a different kind of write from any later price change, and
      // duplicating the logic (uid stamping, the CMS->Cloud sync_price push, the price
      // authority check) is exactly how the two drift apart. See PriceService for why only
      // CMS may do this.
      if (unitPrice != null) {
        const price = await PriceService.setCurrentPrice(commodity.id, {
          unitPrice, createdBy, client,
        });
        commodity.current_price = price.unit_price;
      }

      return commodity;
    });
  }

  static async update(id, { name, category, unit, isActive }) {
    const { rows } = await query(
      `UPDATE commodities
          SET name = COALESCE($2, name),
              category = COALESCE($3, category),
              unit = COALESCE($4, unit),
              is_active = COALESCE($5, is_active)
        WHERE id = $1
        RETURNING id, name, category, unit, is_active`,
      [id, name ?? null, category ?? null, unit ?? null, isActive ?? null]
    );
    return rows[0] || null;
  }

  // Thresholds drive the understock/overstock alerts. Passing null clears a threshold,
  // switching that alert off, so these are set explicitly rather than COALESCEd.
  static async setStockLevels(id, { reorderLevel, maxLevel }) {
    const { rows } = await query(
      `UPDATE commodities
          SET reorder_level = $2,
              max_level = $3
        WHERE id = $1
        RETURNING id, name, reorder_level, max_level`,
      [id, reorderLevel ?? null, maxLevel ?? null]
    );
    return rows[0] || null;
  }

  static async listCategories() {
    const { rows } = await query(
      `SELECT category, COUNT(*)::int AS commodity_count
         FROM commodities
        WHERE is_active AND category IS NOT NULL
        GROUP BY category
        ORDER BY category`
    );
    return rows;
  }
}
