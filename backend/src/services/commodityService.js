import { query } from '../db.js'

export class CommodityService {
  /**
   * List commodities, ordered category → name to match the old Supabase query the
   * session bootstrap relied on. Section-level filtering is applied client-side (see
   * SECTION_CATEGORIES). When a `module` is given the catalogue is scoped to that
   * programme (HIV vs Essential Commodities); omitting it returns every module.
   */
  static async getCommodities({ module } = {}) {
    const params = []
    let sql = `select id, name, category, unit, pack_size, dispensing_unit, module, wms_commodity_id, unit_price
               from commodities`
    if (module) { params.push(module); sql += ` where module = $${params.length}` }
    sql += ` order by category nulls last, name`
    const { rows } = await query(sql, params)
    return rows
  }
}
