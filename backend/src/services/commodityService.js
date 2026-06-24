import { query } from '../db.js'

export class CommodityService {
  /**
   * List all commodities, ordered category → name to match the old Supabase
   * query the session bootstrap relied on. Section-level filtering is applied
   * client-side (see SECTION_CATEGORIES), so this returns the full catalogue.
   */
  static async getCommodities() {
    const { rows } = await query(
      `select id, name, category, unit, pack_size, dispensing_unit
       from commodities
       order by category nulls last, name`
    )
    return rows
  }
}
