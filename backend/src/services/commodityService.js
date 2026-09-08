import { query, withTransaction } from '../db.js'
import { SECTION_CATEGORIES } from '../constants/sections.js'

export class CommodityService {
  /**
   * List all commodities, ordered category → name to match the old Supabase
   * query the session bootstrap relied on. Section-level filtering is applied
   * client-side (see SECTION_CATEGORIES), so this returns the full catalogue.
   */
  /**
   * `section` and `category` both narrow on the LEGACY c.category column — the
   * one the catalogue table actually displays. A section expands to its category
   * list (SECTION_CATEGORIES), so the two filters compose: section=lab plus
   * category=RTKs is just RTKs, and section=lab alone is every lab category.
   *
   * Sections partition the HIV module only, so a section filter naturally
   * excludes Essential items rather than needing to say so.
   */
  static async getCommodities({ module, section, category, activeOnly = false, q } = {}) {
    const params = []
    const where = []
    if (module) { params.push(module); where.push(`cm.module = $${params.length}`) }
    if (activeOnly) where.push('c.is_active = true and cm.is_active = true')
    if (category) { params.push(category); where.push(`c.category = $${params.length}`) }
    else if (section) {
      const cats = SECTION_CATEGORIES[section]
      // An undeclared section matches nothing rather than everything — the same
      // fail-closed choice the scope guards make.
      params.push(Array.isArray(cats) ? cats : [])
      where.push(`c.category = any($${params.length})`)
    }
    if (q) { params.push(`%${q}%`); where.push(`(c.name ilike $${params.length} or c.item_code ilike $${params.length})`) }
    const { rows } = await query(
      // Every column qualified with c. — commodity_modules ALSO has is_active,
      // so the unqualified list was ambiguous the moment the join was added, and
      // any module-filtered or active-only request 500'd. The catalogue's module
      // filter silently did nothing because the frontend swallowed that error.
      `select c.id, c.name, c.category, c.unit, c.pack_size, c.dispensing_unit,
              c.item_type, c.item_code, c.is_active, c.description
         from commodities c
         ${module || activeOnly ? 'join commodity_modules cm on cm.commodity_id = c.id' : ''}
         ${where.length ? `where ${where.join(' and ')}` : ''}
        order by category nulls last, name`,
      params
    )
    return rows
  }

  static async getModules() {
    const { rows } = await query('select key, label from modules order by label')
    return rows
  }

  static async getCategories(module = null) {
    const params = []
    let where = ''
    if (module) { params.push(module); where = 'where cc.module = $1' }
    const { rows } = await query(
      `select cc.id, cc.module, cc.name, cc.code, cc.parent_id, cc.is_active, cc.sort_order,
              count(cm.commodity_id)::int as item_count
         from commodity_categories cc
         left join commodity_modules cm on cm.category_id = cc.id
         ${where}
        group by cc.id
        order by cc.module, cc.sort_order, cc.name`, params)
    return rows
  }

  static async createCategory({ module, name, code, parentId, sortOrder = 0 }) {
    const { rows } = await query(
      `insert into commodity_categories (module, name, code, parent_id, sort_order)
       values ($1, $2, $3, $4, $5)
       returning id, module, name, code, parent_id, is_active, sort_order`,
      [module, name, code || null, parentId || null, Number(sortOrder) || 0])
    return rows[0]
  }

  static async createCommodity({ name, itemType = 'commodity', itemCode, description, isActive = true, memberships }) {
    return withTransaction(async exec => {
      const primary = memberships[0]
      const categoryIds = memberships.map(m => m.category_id).filter(Boolean)
      if (categoryIds.length) {
        const { rows } = await exec(
          `select id, module from commodity_categories where id = any($1::uuid[])`, [categoryIds])
        const categories = new Map(rows.map(r => [r.id, r.module]))
        for (const membership of memberships) {
          if (membership.category_id && categories.get(membership.category_id) !== membership.module) {
            throw new Error('Selected category does not belong to its module')
          }
        }
      }

      const primaryCategory = primary.category_id
        ? (await exec('select name from commodity_categories where id = $1', [primary.category_id])).rows[0]?.name || null
        : null
      const { rows } = await exec(
        `insert into commodities (name, category, module, item_type, item_code, is_active, description)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id, name, category, module, item_type, item_code, is_active, description`,
        [name, primaryCategory, primary.module, itemType, itemCode || null, isActive, description || null])
      const commodity = rows[0]

      for (const membership of memberships) {
        await exec(
          `insert into commodity_modules (commodity_id, module, category_id, module_sku, configuration, is_active)
           values ($1, $2, $3, $4, $5::jsonb, $6)`,
          [commodity.id, membership.module, membership.category_id || null,
           membership.module_sku || null, JSON.stringify(membership.configuration || {}),
           membership.is_active !== false])
      }
      return commodity
    })
  }
}
