import { sb } from '../lib/supabase'
import { useAppStore } from '../store/appStore'
import { SECTION_CATEGORIES } from './helpers'

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

  const commoditySection = ['overall_admin','state_admin'].includes(accessLevel)
    ? null
    : meta.commodity_section || null

  const facilityRole = meta.facility_role || 'dispenser'

  // Load facilities (scoped for state/lga admins)
  let facQuery = sb.from('facilities').select('id,name,code,state,lga').order('state').order('lga').order('name')
  if (accessLevel === 'state_admin' && meta.admin_state) facQuery = facQuery.eq('state', meta.admin_state)
  if (accessLevel === 'lga_admin'   && meta.admin_lga)   facQuery = facQuery.eq('lga',   meta.admin_lga)

  const [{ data: facs }, { data: comms }] = await Promise.all([
    facQuery,
    sb.from('commodities').select('id,name,category,unit,pack_size,dispensing_unit').order('category').order('name'),
  ])

  let allCommodities = comms || []
  if (commoditySection && SECTION_CATEGORIES[commoditySection]) {
    allCommodities = allCommodities.filter(c =>
      SECTION_CATEGORIES[commoditySection].includes(c.category)
    )
  }

  // Resolve facility for facility-level users
  let currentFacility = null
  if (accessLevel === 'facility') {
    if (meta.facility_id) {
      const { data: fac } = await sb.from('facilities').select('*').eq('id', meta.facility_id).maybeSingle()
      currentFacility = fac
    } else if (meta.facility_name) {
      const { data: fac } = await sb.from('facilities').select('*').eq('name', meta.facility_name).maybeSingle()
      currentFacility = fac
    }
  }

  // Populate the store
  store.setUser(user)
  store.setAccessLevel(accessLevel)
  store.setFacilityRole(facilityRole)
  store.setSdpName(meta.sdp_name || null)
  store.setDsdSiteName(meta.dsd_site_name || null)
  store.setCommoditySection(commoditySection)
  store.setAdminState(meta.admin_state || null)
  store.setAdminLGA(meta.admin_lga || null)
  store.setAllFacilities(facs || [])
  store.setAllCommodities(allCommodities)
  store.setCurrentFacility(currentFacility)

  return { accessLevel, facilityRole }
}
