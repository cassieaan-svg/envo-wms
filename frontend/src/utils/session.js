import { api } from '../lib/api'
import { useAppStore } from '../store/appStore'
import { allowedCategoriesFor, allowsCommodity } from './helpers'

// Rebuild the app store from a Supabase auth user. Used both on fresh sign-in
// and when restoring a persisted session on page refresh, so the two paths
// stay identical. Returns the resolved role info for callers that need it.
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

  // Restrict to the account's section, or to the hub-store set (lab + general
  // consumables) for a State Office / Cluster Lab Store. Admins (no section) keep the
  // full catalogue. allowedCats null = all.
  const allowedCats = allowedCategoriesFor(
    commoditySection, meta.facility_name, meta.essential === true)
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

  // Populate the store
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
  store.setAllFacilities(facs || [])
  store.setAllCommodities(allCommodities)
  store.setCurrentFacility(currentFacility)
  store.setAmcWindows(amcWindows)

  return { accessLevel, facilityRole }
}
