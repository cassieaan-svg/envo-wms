import { query } from '../db.js';

// Current prices and on-hand quantity are aggregated per commodity. On-hand deliberately
// excludes expired batches — expired stock is still on the shelf but is not dispensable,
// and counting it would mask an understock alert.
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
         COALESCE(p.prices, '[]'::json) AS current_prices
    FROM commodities c
    LEFT JOIN (
      SELECT commodity_id, SUM(quantity_remaining) AS on_hand
        FROM commodity_batches
       WHERE quantity_remaining > 0
         AND expiry_date >= CURRENT_DATE
       GROUP BY commodity_id
    ) b ON b.commodity_id = c.id
    LEFT JOIN (
      SELECT cp.commodity_id,
             json_agg(json_build_object(
               'priceId', cp.id,
               'vendorId', cp.vendor_id,
               'vendorName', v.name,
               'brandName', cp.brand_name,
               'unitPrice', cp.unit_price,
               'effectiveDate', cp.effective_date
             ) ORDER BY v.name) AS prices
        FROM commodity_prices cp
        JOIN vendors v ON v.id = cp.vendor_id
       WHERE cp.is_current
       GROUP BY cp.commodity_id
    ) p ON p.commodity_id = c.id
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

  static async create({ name, category, unit, envoCommodityId, reorderLevel, maxLevel }) {
    const { rows } = await query(
      `INSERT INTO commodities (name, category, unit, envo_commodity_id, reorder_level, max_level)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, category, unit, envo_commodity_id, reorder_level, max_level, is_active, created_at`,
      [name, category || null, unit || null, envoCommodityId || null, reorderLevel ?? null, maxLevel ?? null]
    );
    return rows[0];
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
  // which switches that alert off for the commodity, so these are set explicitly rather
  // than COALESCEd.
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
