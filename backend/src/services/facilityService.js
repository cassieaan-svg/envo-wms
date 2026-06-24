import { query } from '../db.js'

export class FacilityService {
  /**
   * List facilities, optionally scoped by state / lga (used by state/lga admins)
   * or filtered by exact name. Ordered state → lga → name to match the old
   * Supabase query the session bootstrap relied on.
   */
  static async getFacilities(options = {}) {
    const { state, lga, name } = options

    const params = []
    const conds = []
    if (state) { params.push(state); conds.push(`state = $${params.length}`) }
    if (lga) { params.push(lga); conds.push(`lga = $${params.length}`) }
    if (name) { params.push(name); conds.push(`name = $${params.length}`) }

    let sql = `select id, name, code, state, lga, cluster from facilities`
    if (conds.length) sql += ` where ${conds.join(' and ')}`
    sql += ` order by state nulls last, lga nulls last, name`

    const { rows } = await query(sql, params)
    return rows
  }

  /**
   * Get a single facility by id (full row). Returns null when not found.
   */
  static async getFacilityById(id) {
    const { rows } = await query('select * from facilities where id = $1', [id])
    return rows[0] || null
  }
}
