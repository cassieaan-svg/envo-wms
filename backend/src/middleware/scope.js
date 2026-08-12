import { query } from '../db.js'
import { categoriesForSection, isStateOfficeName, STATE_OFFICE_CATEGORIES } from '../constants/sections.js'
import { MODULES, DEFAULT_MODULE } from '../constants/modules.js'

// Facility + section scoping for the API layer.
//
// Role model (redesigned 2026-07 — see the access-model-redesign memory):
//   facility     — own facility; own commodity_section; READ + WRITE
//   state_admin  — own state (admin_state); both sections; READ + WRITE
//                  (the only cross-facility writer — assigns transfer sources, stock)
//   overall_admin / is_admin — everything; both sections; READ-ONLY
//   state_viewer — own state (admin_state); both sections; READ-ONLY
//   cluster_admin— own cluster (admin_cluster); one section; READ-ONLY
//   lga_admin    — own LGA (admin_lga); one section; READ-ONLY
//
// So relative to the original RLS port: overall_admin, cluster_admin and lga_admin
// no longer write; only state_admin (state-scoped) and facility users do. There is
// deliberately no in-app super-writer — emergency cross-state fixes go via the DB.
//
// Two axes are enforced here:
//   1. Facility scope — which facilities a caller may touch (own / state / cluster /
//      lga / all), via narrowedAdminFacilityIds.
//   2. Section scope — pharmacy vs lab, enforced by commodity category (not just the
//      client-side display filter it used to be). A section-pinned caller can only
//      read/write commodities whose category is in their section.

// Per-table admin tiers that get cross-facility READ access. cluster_admin is now
// included on `stock` too (the old "cluster omitted from stock" RLS quirk is dropped
// — a cluster viewer must see stock across its cluster). state_viewer reads wherever
// state_admin reads.
const READ_ADMIN_LEVELS = {
  stock:          ['state_admin', 'state_viewer', 'cluster_admin', 'lga_admin'],
  dsd_stock:      'public',                                                  // RLS read USING (true)
  sdp_stock:      'public',
  transfers:      ['state_admin', 'state_viewer', 'cluster_admin', 'lga_admin'],
  dispense_log:   ['state_admin', 'state_viewer', 'cluster_admin', 'lga_admin'],
  intake_log:     ['state_admin', 'state_viewer', 'cluster_admin', 'lga_admin'],
  adjustment_log: ['state_admin', 'state_viewer', 'cluster_admin', 'lga_admin'],
  amc_settings:   'public',
  commodities:    'public',
  facilities:     'public',
}

// Per-table admin tiers that get cross-facility WRITE access. state_admin is now the
// ONLY cross-facility writer. Log-table writes stay `[]` (own facility only — an
// admin isn't the one physically dispensing/receiving), matching the original
// dispense/intake/adjustment insert rule. overall_admin (is_admin) NO LONGER writes:
// isWriteAdmin does not short-circuit on isAdmin, so a read-only super-admin can't
// mutate anything.
const WRITE_ADMIN_LEVELS = {
  stock:          ['state_admin'],
  dsd_stock:      ['state_admin'],
  sdp_stock:      ['state_admin'],
  amc_settings:   ['state_admin'],
  transfers:      ['state_admin'],  // assigns sources / processes; read-only tiers excluded
  dispense_log:   [],
  intake_log:     [],
  adjustment_log: [],
}

// Normalize the JWT user_metadata into req.scope. Mirrors session.js.
export function attachScope(req, res, next) {
  const meta = (req.user && req.user.user_metadata) || {}
  const isAdminFlag = meta.is_admin === true || meta.is_admin === 'true'

  // Active module (which commodity programme the caller is working in). Comes from
  // the `x-envo-module` header, then a `?module=` query param, else the default.
  // An explicit but unknown value is a client error — reject it rather than
  // silently scoping to the wrong (or empty) catalogue.
  const rawModule = req.get?.('x-envo-module') || req.query?.module || null
  const module = rawModule ? String(rawModule).toLowerCase() : DEFAULT_MODULE
  if (!MODULES.includes(module)) {
    return res.status(400).json({ success: false, error: `Unknown module: ${rawModule}`, code: 'BAD_MODULE' })
  }

  let accessLevel = 'facility'
  if (meta.access_level) accessLevel = meta.access_level
  else if (isAdminFlag) accessLevel = 'overall_admin'

  // Section (pharmacy/lab) is null — "sees both" — for overall_admin / state_admin.
  // Everyone else (cluster_admin, lga_admin, section-scoped state_viewers) is pinned
  // to their token's commodity_section; a state_viewer with none set still sees both.
  const bothSections = isAdminFlag ||
    ['overall_admin', 'state_admin'].includes(accessLevel)
  const section = bothSections ? null : (meta.commodity_section || null)

  // Section include-list. A State Office Store handles a bespoke set (lab consumables
  // + general consumables), which REPLACES its normal section list — not RTKs or
  // reagents. Null-section admins already see everything.
  let sectionCategories = categoriesForSection(section) // null = all, or [categories]
  if (sectionCategories && isStateOfficeName(meta.facility_name)) {
    sectionCategories = [...STATE_OFFICE_CATEGORIES]
  }
  // Essential Commodities has no pharmacy/lab split, and its categories aren't the HIV
  // section lists — so the section-category filter must not apply there (it would drop
  // every essential row). `section` itself is kept for the pharmacy-only module gate.
  if (module === 'essential') sectionCategories = null

  req.scope = {
    accessLevel,
    isAdmin: isAdminFlag || accessLevel === 'overall_admin',
    facilityId: meta.facility_id || null,
    facilityName: meta.facility_name || null,
    facilityRole: meta.facility_role || null,
    adminState: meta.admin_state || null,
    adminLga: meta.admin_lga || null,
    adminCluster: meta.admin_cluster || null,
    section,
    sectionCategories,
    module,
  }
  next()
}

// The facility ids an admin user may touch, applying state/cluster/lga narrowing.
// Returns null = unconstrained (overall_admin/is_admin, or an admin tier whose
// narrowing field isn't set — matches session.js leaving the filter off). Memoized
// per request since several guards may call it.
async function narrowedAdminFacilityIds(req) {
  if (req._narrowedAdminIds !== undefined) return req._narrowedAdminIds
  const s = req.scope
  let ids = null
  if ((s.accessLevel === 'state_admin' || s.accessLevel === 'state_viewer') && s.adminState) {
    ids = (await query('select id from facilities where state = $1', [s.adminState])).rows.map(r => r.id)
  } else if (s.accessLevel === 'cluster_admin' && s.adminCluster) {
    ids = (await query('select id from facilities where cluster = $1', [s.adminCluster])).rows.map(r => r.id)
  } else if (s.accessLevel === 'lga_admin' && s.adminLga) {
    ids = (await query('select id from facilities where lga = $1', [s.adminLga])).rows.map(r => r.id)
  }
  // overall_admin / is_admin / unscoped tier → null (all)
  req._narrowedAdminIds = ids
  return ids
}

// Stock-only: a facility-level user can also see the counterparty facility of any
// pending transfer they're part of (RLS stock_select sub-selects).
async function pendingTransferCounterparties(facilityId) {
  if (!facilityId) return []
  const { rows } = await query(
    `select sending_facility_id as fid from stock_transfer_log
       where receiving_facility_id = $1 and status = 'pending'
     union
     select receiving_facility_id from stock_transfer_log
       where sending_facility_id = $1 and status = 'pending'`,
    [facilityId]
  )
  return rows.map(r => r.fid).filter(Boolean)
}

function isReadAdmin(scope, table) {
  if (scope.isAdmin) return true
  const levels = READ_ADMIN_LEVELS[table]
  return Array.isArray(levels) && levels.includes(scope.accessLevel)
}

// NOTE: unlike isReadAdmin, this does NOT grant on isAdmin — overall_admin is
// read-only in the redesigned model. Only the tiers listed per table (state_admin)
// get cross-facility write.
function isWriteAdmin(scope, table) {
  const levels = WRITE_ADMIN_LEVELS[table]
  return Array.isArray(levels) && levels.includes(scope.accessLevel)
}

const forbid = (res, msg = 'Not authorized for this facility') =>
  res.status(403).json({ success: false, error: msg, code: 'FORBIDDEN' })

// The set of facility ids a caller may READ for `table`, for list endpoints that
// don't pin a single facility_id. Returns:
//   null  = unconstrained (public-read table, or overall_admin with no narrowing)
//   []    = nothing in scope (e.g. a facility user with no facility_id)
//   [...] = the allowed facility ids (own facility + stock pending-transfer
//           counterparties, or a state/cluster/lga-narrowed admin set)
export async function scopedReadFacilityIds(req, table) {
  const s = req.scope
  if (READ_ADMIN_LEVELS[table] === 'public') return null
  if (isReadAdmin(s, table)) return narrowedAdminFacilityIds(req) // null or array
  if (!s.facilityId) return []
  if (table === 'stock') {
    return [s.facilityId, ...(await pendingTransferCounterparties(s.facilityId))]
  }
  return [s.facilityId]
}

// Resolve the facility id constraint for a scoped LIST endpoint (no pinned
// facility_id): start from the caller's token scope for `table` and INTERSECT an
// optional client-supplied `facility_ids` view-filter (CSV string). A narrowed
// admin therefore can't widen access by passing ids outside their scope. Returns
// null=all, []=none, [...]=these.
export async function resolveListFacilityIds(req, table, clientFacilityIdsCsv) {
  let client = clientFacilityIdsCsv
    ? String(clientFacilityIdsCsv).split(',').map(s => s.trim()).filter(Boolean)
    : null
  // Compact state/LGA view-filter: lets an admin narrow to a whole state/LGA
  // without enumerating (potentially hundreds of) facility ids in the URL, which
  // otherwise blows past proxy request-URI limits. Resolve it here and treat it as
  // the client filter (intersected with any explicit facility_ids).
  const loc = await locationFacilityIds(req)
  if (loc) client = client ? client.filter(id => loc.includes(id)) : loc
  let ids = await scopedReadFacilityIds(req, table)
  if (client) ids = ids === null ? client : ids.filter(id => client.includes(id))
  return ids
}

// Resolve the optional `state` / `lga` query params to the facility ids they
// cover. Returns null when neither is present (no location narrowing). An admin
// still can't widen access: callers intersect this with their token scope.
export async function locationFacilityIds(req) {
  const state = req.query?.state, lga = req.query?.lga
  if (!state && !lga) return null
  const conds = [], params = []
  if (state) { params.push(state); conds.push(`state = $${params.length}`) }
  if (lga)   { params.push(lga);   conds.push(`lga = $${params.length}`) }
  const { rows } = await query(`select id from facilities where ${conds.join(' and ')}`, params)
  return rows.map(r => r.id)
}

// Guard a read that targets a single facility_id. Returns true if allowed; on
// denial it writes a 403 and returns false (caller should `return`).
export async function enforceFacilityRead(req, res, facilityId, table) {
  const s = req.scope
  if (READ_ADMIN_LEVELS[table] === 'public') return true
  if (isReadAdmin(s, table)) {
    const allowed = await narrowedAdminFacilityIds(req)
    if (allowed === null || allowed.includes(facilityId)) return true
    return forbid(res), false
  }
  // facility-level user
  if (facilityId === s.facilityId) return true
  if (table === 'stock' && (await pendingTransferCounterparties(s.facilityId)).includes(facilityId)) return true
  return forbid(res), false
}

// Guard a write that targets a single facility_id.
export async function enforceFacilityWrite(req, res, facilityId, table) {
  const s = req.scope
  if (isWriteAdmin(s, table)) {
    const allowed = await narrowedAdminFacilityIds(req)
    if (allowed === null || allowed.includes(facilityId)) return true
    return forbid(res), false
  }
  if (facilityId === s.facilityId) return true
  return forbid(res), false
}

// The commodity categories the caller may touch, or null (no section restriction).
// Read routes pass this into the service query so it filters by c.category.
// Any administrative tier — the same set the READ_ADMIN_LEVELS tables grant
// oversight to, plus overall_admin. Exported so guards share one definition
// instead of each route re-listing the levels and drifting apart.
export function isAdminScope(scope) {
  return !!scope && (scope.isAdmin === true ||
    ['overall_admin', 'state_admin', 'state_viewer', 'cluster_admin', 'lga_admin'].includes(scope.accessLevel))
}

export function scopedCategories(req) {
  return req.scope.sectionCategories // null = all, or [categories]
}

// The caller's active module. Read routes pass this into the service query so it
// filters by commodities.module (and facility_modules).
export function scopedModule(req) {
  return req.scope.module
}

// The modules a facility-level caller is enrolled in (from facility_modules),
// memoized per request. Returns null for admin tiers — they oversee every module,
// so module is a view filter for them, not an access gate.
async function callerModules(req) {
  if (req._callerModules !== undefined) return req._callerModules
  const s = req.scope
  let mods = null
  if (s.accessLevel === 'facility' && s.facilityId) {
    mods = (await query('select module from facility_modules where facility_id = $1', [s.facilityId]))
      .rows.map(r => r.module)
  }
  req._callerModules = mods
  return mods
}

// Guard a module-scoped endpoint: a facility user may only work in a module they're
// enrolled in; admins pass through. Returns true if allowed; on denial writes a 403
// and returns false (caller should `return`).
export async function enforceModuleAccess(req, res) {
  const s = req.scope
  const mods = await callerModules(req)
  if (mods === null) return true // admin tiers see every module
  if (!mods.includes(s.module)) return forbid(res, 'Not enrolled in this module'), false
  // Essential Commodities is a pharmacy-section module — lab accounts can't open it.
  if (s.module === 'essential' && s.section !== 'pharmacy') {
    return forbid(res, 'Essential Commodities is available to pharmacy only'), false
  }
  return true
}

// Guard a single-commodity read/write against the caller's section. Skips (allows)
// when the caller isn't section-restricted. Looks up the commodity's category and
// 403s if it's outside the caller's section. Returns true/false like the facility
// guards. Pass `category` directly (e.g. from an already-loaded row) to avoid the
// lookup.
export async function enforceCommoditySection(req, res, commodityId, category) {
  const cats = req.scope.sectionCategories
  if (!cats) return true // sees both sections
  let cat = category
  if (cat === undefined) {
    const { rows } = await query('select category from commodities where id = $1', [commodityId])
    cat = rows[0]?.category
  }
  if (cat && cats.includes(cat)) return true
  return forbid(res, 'Not authorized for this commodity section'), false
}

// The facility_id a facility-level caller is implicitly scoped to, for endpoints
// that may omit it. Admins get null (= no implicit constraint / all in scope).
export function ownFacilityId(req) {
  return req.scope.isAdmin ? null : req.scope.facilityId
}

// Transfer mutation/read guard: caller must be a party (sending/receiving) or a
// transfer read-admin, AND (if section-restricted) the transfer's commodity must be
// in the caller's section. `transfer` is a row with sending/receiving_facility_id
// and a nested `commodities` object carrying category.
export async function enforceTransferAccess(req, res, transfer) {
  const s = req.scope
  // Section gate first — a lab viewer must not touch a pharmacy transfer, etc.
  if (s.sectionCategories) {
    const cat = transfer.commodities?.category
    if (!cat || !s.sectionCategories.includes(cat)) {
      return forbid(res, 'Not authorized for this transfer'), false
    }
  }
  if (isReadAdmin(s, 'transfers')) {
    const allowed = await narrowedAdminFacilityIds(req)
    if (allowed === null) return true
    if (allowed.includes(transfer.sending_facility_id) || allowed.includes(transfer.receiving_facility_id)) return true
    return forbid(res, 'Not authorized for this transfer'), false
  }
  if (transfer.sending_facility_id === s.facilityId || transfer.receiving_facility_id === s.facilityId) return true
  return forbid(res, 'Not authorized for this transfer'), false
}

// Transfer WRITE guard (create/mutate/delete). Stricter than enforceTransferAccess:
// only a facility party or state_admin (state-narrowed to either endpoint) may write —
// the read-only tiers (overall_admin, state_viewer, cluster_admin, lga_admin) are
// rejected even though they can read. Also applies the section gate. When `transfer`
// carries no nested commodity (e.g. a create line), pass its category via the
// separate enforceCommoditySection check instead.
export async function enforceTransferWrite(req, res, transfer) {
  const s = req.scope
  if (s.sectionCategories) {
    const cat = transfer.commodities?.category
    if (cat != null && !s.sectionCategories.includes(cat)) {
      return forbid(res, 'Not authorized for this transfer'), false
    }
  }
  if (isWriteAdmin(s, 'transfers')) { // state_admin
    const allowed = await narrowedAdminFacilityIds(req)
    if (allowed === null) return true
    if (allowed.includes(transfer.sending_facility_id) || allowed.includes(transfer.receiving_facility_id)) return true
    return forbid(res, 'Not authorized for this transfer'), false
  }
  if (s.facilityId && (transfer.sending_facility_id === s.facilityId || transfer.receiving_facility_id === s.facilityId)) return true
  return forbid(res, 'Not authorized for this transfer'), false
}

// May the caller create/write a transfer touching this facility as a party? Used by
// the create route per line (facility user → own facility; state_admin → in-state;
// read-only tiers → never). Returns boolean (no response written).
export async function mayWriteTransferFacility(req, facilityId) {
  const s = req.scope
  if (isWriteAdmin(s, 'transfers')) {
    const allowed = await narrowedAdminFacilityIds(req)
    return allowed === null || allowed.includes(facilityId)
  }
  return !!s.facilityId && facilityId === s.facilityId
}

// Expose for routes that need to constrain a list query for an admin (returns
// null = unconstrained, or an array of facility ids to filter by).
export { narrowedAdminFacilityIds }
