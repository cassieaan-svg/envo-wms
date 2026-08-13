import { query } from '../db.js'

export class ModuleService {
  /**
   * The modules the caller may work in. Every module in the `modules` table is
   * returned with an `enrolled` flag so the client can render all of them and grey
   * out the ones a facility isn't enabled for. Facility users are enrolled per
   * facility_modules; admin tiers oversee every module, so all are marked enrolled.
   */
  static async listForCaller(scope) {
    const all = (await query('select key, label from modules order by label')).rows
    let enrolled
    if (scope.accessLevel === 'facility' && scope.facilityId) {
      const rows = (await query(
        'select module from facility_modules where facility_id = $1', [scope.facilityId]
      )).rows
      const set = new Set(rows.map(r => r.module))
      // Essential Commodities is a pharmacy-section module — lab accounts don't get it.
      enrolled = new Set(
        all.map(m => m.key).filter(k => set.has(k) && !(k === 'essential' && scope.section !== 'pharmacy'))
      )
    } else {
      enrolled = new Set(all.map(m => m.key)) // admin tiers see every module
    }
    return all.map(m => ({ ...m, enrolled: enrolled.has(m.key) }))
  }
}
