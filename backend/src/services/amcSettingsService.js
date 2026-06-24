import { query } from '../db.js'

// Per-facility custom AMC month selections. `months` is a text[] of 'YYYY-MM'
// strings (e.g. {'2026-01','2026-03'}); an absent row means the facility uses
// the default quarterly window. See db/migrations/20260608_facility_amc_settings.sql.
export class AmcSettingsService {
  /**
   * List AMC settings. With no facilityId, returns every row (the session
   * bootstrap loads them all and keys by facility_id).
   */
  static async getAmcSettings(options = {}) {
    const { facilityId } = options
    const params = []
    let sql = `select facility_id, months, updated_at, updated_by from facility_amc_settings`
    if (facilityId) { params.push(facilityId); sql += ` where facility_id = $1` }
    sql += ` order by facility_id`
    const { rows } = await query(sql, params)
    return rows
  }

  /**
   * Upsert a facility's month selection (keyed by facility_id).
   */
  static async upsertAmcSettings({ facility_id, months, updated_by }) {
    if (!facility_id || !Array.isArray(months) || months.length === 0) {
      throw new Error('facility_id and a non-empty months array are required')
    }
    const { rows } = await query(
      `insert into facility_amc_settings (facility_id, months, updated_at, updated_by)
       values ($1, $2, now(), $3)
       on conflict (facility_id)
       do update set months = excluded.months, updated_at = now(), updated_by = excluded.updated_by
       returning *`,
      [facility_id, months, updated_by || null]
    )
    return rows[0] || null
  }

  /**
   * Remove a facility's selection (reverts it to the default window).
   * Returns true if a row was deleted.
   */
  static async deleteAmcSettings(facilityId) {
    const { rowCount } = await query(
      'delete from facility_amc_settings where facility_id = $1',
      [facilityId]
    )
    return rowCount > 0
  }
}
