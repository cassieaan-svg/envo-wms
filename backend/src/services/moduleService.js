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
      // Essential Commodities is a pharmacy-section module, and only shown to a login that
      // carries the grant — so existing pharmacy logins at an enrolled facility still see
      // HIV only, and just the separate dual-module store-manager logins get both cards.
      const essentialOk = (k) => k !== 'essential' || (scope.section === 'pharmacy' && scope.essentialAccess === true)
      enrolled = new Set(all.map(m => m.key).filter(k => set.has(k) && essentialOk(k)))
    } else {
      // Admin tiers oversee every module — but Essential still requires the explicit
      // per-login grant, matching enforceModuleAccess. Without this an ungranted admin
      // was shown a card it would be 403'd out of the moment it opened anything.
      // There is no facility_modules row to consult for an admin: they aren't attached
      // to a facility, so the grant on the login is the whole test.
      enrolled = new Set(all.map(m => m.key)
        .filter(k => k !== 'essential' || scope.essentialAccess === true))
    }
    return all.map(m => ({ ...m, enrolled: enrolled.has(m.key) }))
  }
}
