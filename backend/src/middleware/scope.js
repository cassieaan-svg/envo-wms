import { query } from '../db.js'

// Facility scoping — ports the Supabase RLS access model into the API layer.
// Source of truth: the RLS policies in db/_migration/supabase_public.sql and the
// client-side interpretation in frontend/src/utils/session.js.
//
// Two deliberate decisions vs. the literal SQL policies:
//   1. State/LGA admins ARE narrowed here (facilities.state = admin_state /
//      facilities.lga = admin_lga). The RLS policies did NOT narrow admin tiers
//      server-side — narrowing was client-only (session.js filtered the facility
//      dropdown). Since the API is now the sole guard, we enforce it here so a
//      state_admin token can't read another state's data by calling the API directly.
//   2. The cluster_admin/stock quirk is replicated literally: cluster_admin is
//      absent from the stock read/update admin lists, so a cluster_admin is treated
//      as a non-admin for the `stock` table only (own-facility access), exactly as
//      the original policy behaved.
//
// `is_admin` (truthy) and access_level 'overall_admin' are unconstrained super-admins
// on every table — this matches how is_admin users are minted with access_level
// overall_admin in session.js, so it never diverges in practice.

// Per-table admin tiers that get cross-facility READ access.
const READ_ADMIN_LEVELS = {
  stock:          ['state_admin', 'lga_admin'],                              // cluster omitted (literal quirk)
  dsd_stock:      'public',                                                  // RLS read USING (true)
  sdp_stock:      'public',
  transfers:      ['state_admin', 'cluster_admin', 'lga_admin'],
  dispense_log:   ['state_admin', 'cluster_admin', 'lga_admin'],
  intake_log:     ['state_admin', 'cluster_admin', 'lga_admin'],
  adjustment_log: ['state_admin', 'cluster_admin', 'lga_admin'],
  amc_settings:   'public',
  commodities:    'public',
  facilities:     'public',
}

// Per-table admin tiers that get cross-facility WRITE access. Empty array means
// "no admin tier" — only the own-facility match or is_admin grants write (this is
// the dispense/intake/adjustment log-write rule). Stock writes are scoped own-or-admin
// here; the RLS insert policy was `true` but the update policy was scoped, and scoping
// inserts too closes an obvious hole with no behavioural change for the frontend.
const WRITE_ADMIN_LEVELS = {
  stock:          ['state_admin', 'lga_admin'],
  dsd_stock:      ['state_admin', 'cluster_admin', 'lga_admin'],
  sdp_stock:      ['state_admin', 'cluster_admin', 'lga_admin'],
  amc_settings:   ['state_admin', 'cluster_admin', 'lga_admin'],
  dispense_log:   [],
  intake_log:     [],
  adjustment_log: [],
}

// Normalize the JWT user_metadata into req.scope. Mirrors session.js exactly.
export function attachScope(req, res, next) {
  const meta = (req.user && req.user.user_metadata) || {}
  const isAdminFlag = meta.is_admin === true || meta.is_admin === 'true'

  let accessLevel = 'facility'
  if (meta.access_level) accessLevel = meta.access_level
  else if (isAdminFlag) accessLevel = 'overall_admin'

  req.scope = {
    accessLevel,
    isAdmin: isAdminFlag || accessLevel === 'overall_admin',
    facilityId: meta.facility_id || null,
    facilityName: meta.facility_name || null,
    adminState: meta.admin_state || null,
    adminLga: meta.admin_lga || null,
  }
  next()
}

// The facility ids an admin user may touch, applying state/lga narrowing.
// Returns null = unconstrained (overall/cluster, or state/lga admin with no
// narrowing field set — matches session.js leaving the filter off). Memoized per
// request since several guards may call it.
async function narrowedAdminFacilityIds(req) {
  if (req._narrowedAdminIds !== undefined) return req._narrowedAdminIds
  const s = req.scope
  let ids = null
  if (s.accessLevel === 'state_admin' && s.adminState) {
    ids = (await query('select id from facilities where state = $1', [s.adminState])).rows.map(r => r.id)
  } else if (s.accessLevel === 'lga_admin' && s.adminLga) {
    ids = (await query('select id from facilities where lga = $1', [s.adminLga])).rows.map(r => r.id)
  }
  // overall_admin / cluster_admin / is_admin / unscoped state|lga → null (all)
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

function isWriteAdmin(scope, table) {
  if (scope.isAdmin) return true
  const levels = WRITE_ADMIN_LEVELS[table]
  return Array.isArray(levels) && levels.includes(scope.accessLevel)
}

const forbid = (res, msg = 'Not authorized for this facility') =>
  res.status(403).json({ success: false, error: msg, code: 'FORBIDDEN' })

// The set of facility ids a caller may READ for `table`, for list endpoints that
// don't pin a single facility_id. Returns:
//   null  = unconstrained (public-read table, or overall/cluster admin with no narrowing)
//   []    = nothing in scope (e.g. a facility user with no facility_id, or a
//           cluster_admin against `stock` — the literal cluster/stock quirk)
//   [...] = the allowed facility ids (own facility + stock pending-transfer
//           counterparties, or a state/lga-narrowed admin set)
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
  const client = clientFacilityIdsCsv
    ? String(clientFacilityIdsCsv).split(',').map(s => s.trim()).filter(Boolean)
    : null
  let ids = await scopedReadFacilityIds(req, table)
  if (client) ids = ids === null ? client : ids.filter(id => client.includes(id))
  return ids
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

// The facility_id a facility-level caller is implicitly scoped to, for endpoints
// that may omit it. Admins get null (= no implicit constraint / all in scope).
export function ownFacilityId(req) {
  return req.scope.isAdmin ? null : req.scope.facilityId
}

// Transfer mutation/read guard: caller must be a party (sending/receiving) or a
// transfer read-admin. `transfer` is a row with sending_facility_id/receiving_facility_id.
export async function enforceTransferAccess(req, res, transfer) {
  const s = req.scope
  if (isReadAdmin(s, 'transfers')) {
    const allowed = await narrowedAdminFacilityIds(req)
    if (allowed === null) return true
    if (allowed.includes(transfer.sending_facility_id) || allowed.includes(transfer.receiving_facility_id)) return true
    return forbid(res, 'Not authorized for this transfer'), false
  }
  if (transfer.sending_facility_id === s.facilityId || transfer.receiving_facility_id === s.facilityId) return true
  return forbid(res, 'Not authorized for this transfer'), false
}

// Expose for routes that need to constrain a list query for an admin (returns
// null = unconstrained, or an array of facility ids to filter by).
export { narrowedAdminFacilityIds }
