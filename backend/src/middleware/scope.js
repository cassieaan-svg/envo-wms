import { query } from '../db.js'
import { categoriesForSection, isHubStoreName, HUB_STORE_CATEGORIES,
         extraCommoditiesForFacility, allowsCommodity,
         HIV_CATEGORIES, ESSENTIAL_CATEGORIES } from '../constants/sections.js'
import { gateFacility, gateCommoditySection } from './authorityGate.js'

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
  // DSD/SDP site stock reads were ported as 'public' because the old RLS said
  // USING (true). That is stock held at a facility, so it belongs to the same tier
  // as `stock` — leaving it public let an Akwa Ibom admin pull Lagos and Cross River
  // site balances (visible in the all-facilities CRRF export, which reads all three).
  dsd_stock:      ['state_admin', 'state_viewer', 'cluster_admin', 'lga_admin'],
  sdp_stock:      ['state_admin', 'state_viewer', 'cluster_admin', 'lga_admin'],
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

  let accessLevel = 'facility'
  if (meta.access_level) accessLevel = meta.access_level
  else if (isAdminFlag) accessLevel = 'overall_admin'

  // Section (pharmacy/lab) is null — "sees both" — for overall_admin / state_admin.
  // Everyone else (cluster_admin, lga_admin, section-scoped state_viewers) is pinned
  // to their token's commodity_section; a state_viewer with none set still sees both.
  // overall_admin is NOT here. It was, and that discarded its commodity_section
  // before anything could read it — so Lab HQ and Pharmacy HQ, provisioned as
  // overall_admin tagged 'lab' and 'pharmacy', both saw every section. The tag
  // was read by the frontend to pick which pages to render and by nothing else,
  // which made a display field the only thing standing between an HQ viewer and
  // another section's data. create_hq_viewers.mjs says as much: the tag exists
  // "so the UI shows only that section's data".
  //
  // An UNTAGGED overall_admin (envo.admin) still sees every HIV section — it
  // falls through to the module default below, exactly as before. Only a tagged
  // one narrows, which is what the tag was always meant to mean.
  //
  // state_admin stays: it genuinely oversees both sections, and its own
  // commodity_section — where one exists — is not an access statement.
  const bothSections = isAdminFlag || accessLevel === 'state_admin'
  const section = bothSections ? null : (meta.commodity_section || null)

  // Section include-list. A hub store — state office or cluster store — handles a
  // bespoke set (lab consumables + general consumables) which REPLACES its normal
  // section list, so it sees neither RTKs nor reagents. Null-section admins already
  // see everything.
  let sectionCategories = categoriesForSection(section) // null = all, or [categories]
  if (sectionCategories && isHubStoreName(meta.facility_name)) {
    sectionCategories = [...HUB_STORE_CATEGORIES]
  }
  // AN UNPINNED CALLER DEFAULTS TO ITS MODULE, NOT TO EVERYTHING.
  //
  // `null` here means "no category filter", and that was written when the HIV
  // programme was the only thing in `commodities` — so "no filter" and "both
  // sections" described the same set. Essential Commodities then added 450 rows
  // to the same table and silently widened every unpinned caller: a state_admin
  // overseeing HIV pharmacy and lab could read Essential stock, because nobody
  // had written a rule to stop them. Nothing granted that access; it was
  // inherited from an absent filter.
  //
  // So an absent section now resolves to the caller's MODULE rather than to the
  // whole table. Two accounts keep the old unrestricted meaning, deliberately:
  //
  //   system_admin  administers users and holds no operational access at all
  //                 (Phase 2M.1); it may see the full catalogue and can act on
  //                 none of it.
  //   Essential     an account carrying the meta.essential grant, or the
  //                 essential_admin role, spans both modules by design.
  const seesEssential = meta.essential === true || accessLevel === 'essential_admin'
  if (sectionCategories === null && accessLevel !== 'system_admin') {
    sectionCategories = [...HIV_CATEGORIES]
  }

  // THE ESSENTIAL GRANT IS ADDITIVE, not a default.
  //
  // The 194 granted store-manager logins carry commodity_section = 'pharmacy'
  // explicitly — the essential-commodities branch requires that section as a
  // precondition for opening Essential at all. So they are PINNED, and a rule
  // that only filled in an absent section never reached them: they held the
  // grant and still could not see a single Essential item.
  //
  // Adding the categories to whatever section they already hold is what the
  // grant means. It also makes legacy agree with the ACL, which has given these
  // accounts {pharmacy, essential} since Phase 2M.2d — the two were describing
  // different access for the same people.
  if (sectionCategories && seesEssential) {
    sectionCategories = [...new Set([...sectionCategories, ...ESSENTIAL_CATEGORIES])]
  }

  // Individually-granted commodities that fall outside those categories (see
  // FACILITY_EXTRA_COMMODITIES). Empty for every facility without an explicit grant.
  const sectionCommodityNames = sectionCategories ? extraCommoditiesForFacility(meta.facility_name) : []

  req.scope = {
    accessLevel,
    isAdmin: isAdminFlag || accessLevel === 'overall_admin',
    facilityId: meta.facility_id || null,
    facilityName: meta.facility_name || null,
    adminState: meta.admin_state || null,
    adminLga: meta.admin_lga || null,
    adminCluster: meta.admin_cluster || null,
    section,
    sectionCategories,
    sectionCommodityNames,
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
//
// This is the LEGACY implementation. What routes import under this name is the
// gated version at the bottom of this file, which is a passthrough to exactly
// this function unless the authorization mode has been switched — see
// middleware/authorityGate.js and audit finding B-1.
async function enforceFacilityReadLegacy(req, res, facilityId, table) {
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

// Guard a write that targets a single facility_id. Legacy implementation; see
// the note on enforceFacilityReadLegacy.
async function enforceFacilityWriteLegacy(req, res, facilityId, table) {
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

/**
 * The caller's complete commodity-visibility filter, as the option pair every scoped
 * service accepts. Spread it into the service options:
 *
 *   StockService.getScopedStock({ facilityIds, ...sectionFilter(req) })
 *
 * Spread rather than two separate arguments on purpose: the category list and the
 * per-facility commodity grant must travel together. Passing only `categories` at one
 * endpoint would silently hide a granted commodity there and nowhere else.
 */
export function sectionFilter(req) {
  return {
    categories: req.scope.sectionCategories,
    commodityNames: req.scope.sectionCommodityNames,
  }
}

// Guard a single-commodity read/write against the caller's section. Skips (allows)
// when the caller isn't section-restricted. Looks up the commodity's category and
// 403s if it's outside the caller's section. Returns true/false like the facility
// guards. Pass `category` directly (e.g. from an already-loaded row) to avoid the
// lookup.
async function enforceCommoditySectionLegacy(req, res, commodityId, category) {
  const cats = req.scope.sectionCategories
  if (!cats) return true // sees both sections
  let cat = category, name
  // The commodity NAME is needed too, since an individually-granted commodity is
  // allowed despite its category being outside the caller's section. A caller passing
  // `category` in to skip the lookup still needs the name, so look it up when the
  // caller holds grants at all (nobody but a granted facility pays for this).
  if (cat === undefined || req.scope.sectionCommodityNames?.length) {
    const { rows } = await query('select category, name from commodities where id = $1', [commodityId])
    if (cat === undefined) cat = rows[0]?.category
    name = rows[0]?.name
  }
  if (allowsCommodity(cats, req.scope.sectionCommodityNames, cat, name)) return true
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
    const { category, name } = transfer.commodities || {}
    // Unknown category is still a refusal (the original rule) — allowsCommodity only
    // waives that when the commodity is one this facility was granted by name.
    if (!allowsCommodity(s.sectionCategories, s.sectionCommodityNames, category, name)) {
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
export async function mayWriteTransfer(req, transfer) {
  const s = req.scope
  if (s.sectionCategories) {
    // Unlike the read guard, an absent category is allowed through here (a create line
    // carries no nested commodity — the route checks it via enforceCommoditySection).
    const { category, name } = transfer.commodities || {}
    if (category != null && !allowsCommodity(s.sectionCategories, s.sectionCommodityNames, category, name)) {
      return false
    }
  }
  if (isWriteAdmin(s, 'transfers')) { // state_admin
    const allowed = await narrowedAdminFacilityIds(req)
    if (allowed === null) return true
    return allowed.includes(transfer.sending_facility_id) || allowed.includes(transfer.receiving_facility_id)
  }
  return !!s.facilityId &&
    (transfer.sending_facility_id === s.facilityId || transfer.receiving_facility_id === s.facilityId)
}

// Response-writing wrapper. Delegates to mayWriteTransfer so the rule has ONE
// definition: a bulk endpoint checking rows in a loop must not be able to drift from
// what the single-row endpoint enforces.
export async function enforceTransferWrite(req, res, transfer) {
  if (await mayWriteTransfer(req, transfer)) return true
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

// ═══════════════════════════════════════════════════════════════════════════
// THE AUTHORITY GATE — audit finding B-1
// ═══════════════════════════════════════════════════════════════════════════
//
// Routes import these three names and always have. What changed is that the
// name now resolves to a wrapper which asks authorityMode.currentMode() who
// decides. In 'legacy' — the default, and production's state — the wrapper
// calls straight through to the function above it and nothing else happens:
// no resolver, no stub response, no extra query.
//
// The point of routing every call site through one switch is that rolling the
// cutover back is an UPDATE against one row, not a deploy. See
// db/migrations/20260908_authorization_mode.sql for the modes and the
// fail-safe rules.
//
// The LEGACY implementations stay reachable by name for two callers who must
// not be affected by the mode: the shadow-comparison suites, which exist to
// compare the two authorities and would be measuring the gate instead, and
// anything that needs legacy's answer specifically.

export const enforceFacilityRead = gateFacility(enforceFacilityReadLegacy, 'read')
export const enforceFacilityWrite = gateFacility(enforceFacilityWriteLegacy, 'write')
export const enforceCommoditySection = gateCommoditySection(enforceCommoditySectionLegacy)

export const LEGACY = {
  enforceFacilityRead: enforceFacilityReadLegacy,
  enforceFacilityWrite: enforceFacilityWriteLegacy,
  enforceCommoditySection: enforceCommoditySectionLegacy,
}
