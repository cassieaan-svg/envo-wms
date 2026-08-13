import { api } from '../lib/api'
import { useAppStore } from '../store/appStore'
import { allowedCategoriesFor, allowsCommodity } from './helpers'

// Rebuild the IDENTITY half of the store from an auth user: role, section, admin
// scope, and the modules this account may work in. Deliberately loads no
// module-scoped data (facilities / commodities / stock) — that waits until a module
// is chosen on the picker, then loadModuleData() runs. Used on both fresh sign-in
// and refresh so the two paths stay identical. Returns resolved role info.
export async function hydrateSession(user) {
  const store = useAppStore.getState()
  const meta  = user.user_metadata || {}

  // Determine access level
  let accessLevel = 'facility'
  if (meta.access_level) accessLevel = meta.access_level
  else if (meta.is_admin === true || meta.is_admin === 'true') accessLevel = 'overall_admin'

  // Section = the account's commodity_section (null = sees both pharmacy + lab).
  // Admins normally have none set (envo.admin, state_admins) so they still see
  // both; a section-tagged overall_admin is an HQ viewer (Lab HQ / Pharmacy HQ)
  // that sees only its section (read-only, national scope).
  const commoditySection = meta.commodity_section || null

  const facilityRole = meta.facility_role || 'dispenser'

  // Which modules this account can switch into (each with an `enrolled` flag). Not
  // module-scoped, so it's safe to fetch before a module is chosen.
  const modules = await api.modules.list().catch(() => [])

  // Populate the identity part of the store.
  store.setUser(user)
  store.setAccessLevel(accessLevel)
  store.setFacilityRole(facilityRole)
  store.setSdpName(meta.sdp_name || null)
  store.setDsdSiteName(meta.dsd_site_name || null)
  store.setDsdType(meta.dsd_type || null)
  store.setCommoditySection(commoditySection)
  store.setAdminState(meta.admin_state || null)
  store.setAdminLGA(meta.admin_lga || null)
  store.setAdminCluster(meta.admin_cluster || null)
  store.setAvailableModules(modules || [])

  return { accessLevel, facilityRole }
}

// Load the data scoped to the CURRENTLY SELECTED module (sent via the x-envo-module
// header, see lib/api). Called once a module is picked, and on refresh when a module
// is already chosen. Requires hydrateSession to have run (store.user populated).
export async function loadModuleData() {
  const store = useAppStore.getState()
  const meta  = store.user?.user_metadata || {}
  const accessLevel = store.accessLevel
  const commoditySection = store.commoditySection

  // Load facilities (scoped for state/lga admins — the server also enforces this,
  // but we pass the filter so the dropdown matches the admin's remit).
  const facParams = {}
  if ((accessLevel === 'state_admin' || accessLevel === 'state_viewer') && meta.admin_state) facParams.state = meta.admin_state
  if (accessLevel === 'cluster_admin' && meta.admin_cluster) facParams.cluster = meta.admin_cluster
  if (accessLevel === 'lga_admin'   && meta.admin_lga)   facParams.lga   = meta.admin_lga

  const [facs, comms, amcRows] = await Promise.all([
    api.facilities.list(facParams),
    api.commodities.list(),
    api.amcSettings.list(),
  ])

  // Per-facility custom AMC month selections, keyed by facility id.
  const amcWindows = {}
  ;(amcRows || []).forEach(r => { amcWindows[r.facility_id] = { months: r.months || [] } })

  // Restrict to the account's section, plus General Consumables for a State Office
  // Store. Admins (no section) keep the full catalogue. allowedCats null = all.
  // The pharmacy/lab split is an HIV-programme concept only — Essential Commodities
  // has no sections, so a section-pinned account must still see the whole essential
  // catalogue there. Only apply the section filter in the HIV module.
  const allowedCats = store.module === 'hiv' ? allowedCategoriesFor(commoditySection, meta.facility_name) : null
  let allCommodities = comms || []
  if (allowedCats) {
    // allowsCommodity, not a plain category test: a facility may hold individual
    // commodity grants outside its categories (see extraCommoditiesForFacility).
    allCommodities = allCommodities.filter(c => allowsCommodity(allowedCats, meta.facility_name, c))
  }

  // Resolve facility for facility-level users
  let currentFacility = null
  if (accessLevel === 'facility') {
    if (meta.facility_id) {
      try { currentFacility = await api.facilities.get(meta.facility_id) } catch { currentFacility = null }
    } else if (meta.facility_name) {
      const matches = await api.facilities.list({ name: meta.facility_name })
      currentFacility = matches?.[0] || null
    }
  }

  store.setAllFacilities(facs || [])
  store.setAllCommodities(allCommodities)
  store.setCurrentFacility(currentFacility)
  store.setAmcWindows(amcWindows)
  store.setModuleDataLoaded(true)
}
