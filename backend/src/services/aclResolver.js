import { query } from '../db.js'
import { SECTION_CATEGORIES } from '../constants/sections.js'
import { FEATURE_BY_PERMISSION } from '../constants/features.js'

// Phase 2E — ACL resolver, SHADOW MODE ONLY.
//
// This module answers "does this user hold this permission, in this scope?"
// using the new permissions/roles/role_permissions/user_roles/user_permissions
// tables. It is called from nowhere in the request path. No route imports it,
// no guard delegates to it, and its answer never reaches an HTTP response.
// scope.js remains the sole authorization authority — see
// docs/authorization/shadow-comparison.md for the comparison harness that
// calls this module ALONGSIDE (never instead of) the real guards.
//
// PRECEDENCE (Step 4 of the phase brief):
//   user-specific deny  >  user-specific grant  >  role permission  >  deny
// user_permissions holds 0 rows today (Phase 2C/2D never populated it), so this
// precedence chain is implemented for correctness but is not yet exercised by
// real data — only by the isolated test fixtures in aclResolver.test.js.
//
// SCOPE MODEL — what this resolver can and deliberately cannot represent.
//
// Three permission shapes exist in the current legacy code, and the resolver
// must know which one it's asked about to reproduce scope.js's actual decision:
//
//   UNSCOPED   — no facility dimension at all. amc_settings.read, commodity.read
//                and facility.read are literally READ_ADMIN_LEVELS[table] ===
//                'public' (any authenticated user); edit_history.read/write have
//                NO scoping code whatsoever (routes/editHistory.js has no
//                enforceFacilityRead/Write call at all — see the permission
//                catalogue, Section 6); system.diagnostics.read is gated by
//                isAdminScope() alone, with no facility parameter in the check.
//
//   FACILITY   — a single target facility id must fall within the caller's
//                scope (own facility_id, or — for admin tiers — a state/
//                cluster/LGA membership lookup identical to
//                narrowedAdminFacilityIds in scope.js).
//
//   TRANSFER   — TWO candidate facilities (sending, receiving); scope covers if
//                EITHER falls within the caller's scope. This directly mirrors
//                enforceTransferAccess / mayWriteTransfer, which both check
//                `sending === X || receiving === X`. This is not a legacy
//                special case grafted on — it is the natural generalization of
//                the same scope check to two candidates instead of one.
//
// PER-GRANT SCOPE NARROWING — the schema gap Phase 2E reported, now closed.
// WRITE_ADMIN_LEVELS in scope.js grants state_admin cross-facility write on
// stock/dsd_stock/sdp_stock/amc_settings/transfer, but NEVER on
// dispense_log/intake_log/adjustment_log (an admin isn't the one physically
// dispensing or receiving — see scope.js:48-53). That distinction used to live
// only in application code, mirrored here by a CROSS_FACILITY_WRITE_PERMISSIONS
// constant, because role_permissions had no way to express "this grant does not
// widen across facilities".
//
// role_permissions.scope_mode now carries it as data ('inherit' by default,
// 'own_facility_only' on the three log writes), so the constant is gone and the
// rule is configurable rather than compiled in.
//
// Deliberately NOT represented here — see Step 13 of the phase brief. These are
// legacy special cases the shadow comparison is meant to SURFACE, not absorb:
//   - pending-transfer counterparty visibility on stock.read (scope.js:129-142)
//   - commodity_section / category filtering (a dimension this ACL schema has
//     no column for at all — ANY section-restricted legacy decision is expected
//     to mismatch a resolver that only knows permission + facility/state/
//     cluster/LGA scope)
//   - hub-store category override, FACILITY_EXTRA_COMMODITIES grants (both are
//     category-level, same reason as above)
//   - enforceFacilityWrite's unconditional own-facility grant for a table
//     string absent from WRITE_ADMIN_LEVELS entirely (documented as a defect
//     in the catalogue, Section 6 — reproducing it here would bake a known bug
//     into the new system)

// Permissions with no facility dimension in the legacy code at all.
const UNSCOPED_PERMISSIONS = new Set([
  'amc_settings.read', 'commodity.read', 'facility.read',
  'edit_history.read', 'edit_history.write',
  'system.diagnostics.read',
])

// Permissions using the two-candidate (sending/receiving) transfer scope shape.
const TRANSFER_PERMISSIONS = new Set(['transfer.read', 'transfer.write'])

export class AclResolver {
  // The user's single ACL role assignment (Phase 2D migrated exactly one per
  // user). Returns null if the user has none — an unmigrated or unknown-legacy
  // (e.g. hq_tools) account. Never throws on a missing user.
  static async getUserRoleAssignment(userId) {
    const { rows } = await query(
      `select r.name as role, ur.scope_type, ur.scope_id
         from user_roles ur join roles r on r.id = ur.role_id
        where ur.user_id = $1`,
      [userId])
    return rows[0] || null // null if zero; Phase 2D guarantees at most one
  }

  // A direct user_permissions row for this exact (user, permission), if any,
  // preferring a deny over a grant when — pathologically — both existed (the
  // Phase 2B primary key already forbids both existing for the SAME scope; this
  // only matters if two different scopes each carried an override).
  static async getDirectOverrides(userId, permissionKey) {
    const { rows } = await query(
      `select effect, scope_type, scope_id from user_permissions
        where user_id = $1 and permission_key = $2`,
      [userId, permissionKey])
    return rows
  }

  // ── Phase 2G: multi-dimensional scope ──────────────────────────────────────
  //
  // Scope is a SET of rows over two dimensions (user_role_scopes):
  //   geography  — facility | state | cluster | lga
  //   commodity  — section  | category | commodity
  //
  // Resolution: OR within a dimension, AND across dimensions, a dimension with
  // NO rows is unconstrained on that dimension. That last rule is what makes
  // overall_admin (no rows at all) national, and what makes state_admin — never
  // section-pinned in attachScope — see every category.
  //
  // Nothing here reads user_roles.scope_type/scope_id. Those columns remain in
  // place, untouched, until a later phase retires them.

  static async getScopeRows(userId, dimension) {
    const { rows } = await query(
      `select scope_type, scope_id from user_role_scopes
        where user_id = $1 and dimension = $2`,
      [userId, dimension])
    return rows
  }

  // Is `facilityId` inside the user's geography scope? No geography rows means
  // unconstrained — NOT "denied" — because that is how an unscoped role
  // (overall_admin) is represented.
  static async geographyCovers(userId, facilityId) {
    const rows = await this.getScopeRows(userId, 'geography')
    if (rows.length === 0) return true
    if (!facilityId) return false
    for (const r of rows) {
      if (await this.facilityInScope(r.scope_type, r.scope_id, facilityId)) return true
    }
    return false
  }

  // Is `commodityId` inside the user's commodity scope? No commodity rows means
  // unconstrained, matching attachScope giving overall_admin/state_admin a null
  // section.
  //
  // A `section` row resolves through SECTION_CATEGORIES. An UNRECOGNISED section
  // (three live accounts carry commodity_section='tools') resolves to NO
  // categories and therefore DENIES. Legacy fails open here — categoriesForSection
  // returns null for an unknown value, which downstream means "sees everything".
  // That is a documented defect; reproducing it would bake a fail-open into the
  // new model, so this deliberately diverges and the shadow comparison records
  // the mismatch rather than hiding it.
  static async commodityCovers(userId, commodityId) {
    const rows = await this.getScopeRows(userId, 'commodity')
    if (rows.length === 0) return true
    if (!commodityId) return false

    const { rows: found } = await query(
      `select category from commodities where id = $1`, [commodityId])
    if (!found.length) return false // unknown commodity denies
    const category = found[0].category

    for (const r of rows) {
      if (r.scope_type === 'commodity' && r.scope_id === commodityId) return true
      if (r.scope_type === 'category' && r.scope_id === category) return true
      if (r.scope_type === 'section') {
        const cats = SECTION_CATEGORIES[r.scope_id]
        if (Array.isArray(cats) && cats.includes(category)) return true
      }
    }
    return false
  }

  // ── Phase 2H: feature configuration ────────────────────────────────────────
  //
  // Is `permissionKey` suppressed for this user by a disabled feature?
  //
  // DENY-ONLY, structurally. This method returns a boolean meaning "suppressed",
  // and `can()` uses it solely to turn an allow into a deny. There is no path by
  // which a feature_config row can turn a deny into an allow — a user without
  // the permission is already denied before this is consulted. That is what
  // stops configuration becoming a privilege-escalation surface.
  //
  // A user's department comes from their commodity `section` scope row, and
  // their facility from their geography `facility` row. A user with neither —
  // an admin with no department, say — cannot match a (facility, department)
  // row, so no departmental disable applies to them. That follows from having
  // no wildcards, and is deliberate.
  static async featureSuppresses(userId, permissionKey) {
    const feature = FEATURE_BY_PERMISSION[permissionKey]
    if (!feature) return false // not a gated permission

    const { rows } = await query(
      `select 1
         from feature_config fc
         join user_role_scopes fac
           on fac.user_id = $1 and fac.dimension = 'geography'
          and fac.scope_type = 'facility' and fac.scope_id = fc.facility_id::text
         join user_role_scopes dep
           on dep.user_id = $1 and dep.dimension = 'commodity'
          and dep.scope_type = 'section' and dep.scope_id = fc.department
        where fc.feature = $2 and fc.enabled = false
        limit 1`,
      [userId, feature])
    return rows.length > 0
  }

  // The scope_mode recorded on a role's grant of a permission.
  //
  //   'inherit'           use the role assignment's own scope
  //   'own_facility_only' never widen past the actor's own facility
  //
  // Returns null when no such grant exists. A null is NOT treated as 'inherit'
  // by the caller — a missing grant means the permission was held some other
  // way (a direct user_permissions grant), which carries its own scope.
  static async getScopeMode(roleName, permissionKey) {
    const { rows } = await query(
      `select rp.scope_mode from role_permissions rp
         join roles r on r.id = rp.role_id
        where r.name = $1 and rp.permission_key = $2`,
      [roleName, permissionKey])
    return rows[0]?.scope_mode ?? null
  }

  // Does `roleName` carry `permissionKey` via role_permissions? Unknown role or
  // unknown permission both resolve to false — never throws, never guesses.
  static async roleHasPermission(roleName, permissionKey) {
    const { rows } = await query(
      `select 1 from role_permissions rp
         join roles r on r.id = rp.role_id
        where r.name = $1 and rp.permission_key = $2`,
      [roleName, permissionKey])
    return rows.length > 0
  }

  // Does a (scope_type, scope_id) cover a given facility? Mirrors
  // narrowedAdminFacilityIds's membership lookups exactly — same fields, same
  // exact-match query, same fail-to-empty (not fail-open) when the scope id is
  // blank. '' scope_type (overall_admin's representation — see Phase 2D) always
  // covers everything, matching attachScope never narrowing it.
  static async facilityInScope(scopeType, scopeId, facilityId) {
    if (!facilityId) return false
    if (scopeType === '') return true // overall_admin: unconstrained, by design
    if (!scopeId) return false // a blank scope_id must never mean "everything"
    if (scopeType === 'facility') return scopeId === facilityId
    const column = { state: 'state', cluster: 'cluster', lga: 'lga' }[scopeType]
    if (!column) return false // an unrecognized scope_type denies, never guesses
    const { rows } = await query(
      `select 1 from facilities where id = $1 and ${column} = $2`, [facilityId, scopeId])
    return rows.length > 0
  }

  // The full decision for a single-facility-shaped permission. Permission and
  // scope are checked independently and BOTH must pass — never combined into
  // one query, so neither can silently substitute for the other.
  static async can(userId, permissionKey, context = {}) {
    const assignment = await this.getUserRoleAssignment(userId)

    // ── 1. Permission — deny wins, then grant, then role, then deny.
    const overrides = await this.getDirectOverrides(userId, permissionKey)
    const deny = overrides.find(o => o.effect === 'deny')
    if (deny) return { decision: false, reason: 'user_permissions deny', role: assignment?.role ?? null }
    const grant = overrides.find(o => o.effect === 'grant')
    let permissionHeld = !!grant
    if (!permissionHeld) {
      if (!assignment) return { decision: false, reason: 'no role assignment', role: null }
      permissionHeld = await this.roleHasPermission(assignment.role, permissionKey)
    }
    if (!permissionHeld) return { decision: false, reason: 'role lacks permission', role: assignment?.role ?? null }

    // ── 2. Feature configuration — can only suppress, never grant.
    //
    // Evaluated after the capability check (a user who lacks the permission is
    // already denied, so configuration never decides anything for them) and
    // before scope, purely because it is cheaper: a disabled feature
    // short-circuits without any facility-membership query.
    if (await this.featureSuppresses(userId, permissionKey)) {
      return { decision: false, reason: 'feature disabled for this department', role: assignment?.role ?? null }
    }

    // ── 3. Scope — independent of how the permission was held.
    if (UNSCOPED_PERMISSIONS.has(permissionKey)) {
      return { decision: true, reason: 'unscoped permission', role: assignment?.role ?? null }
    }
    // A direct grant's OWN scope_type/scope_id governs when it is what granted
    // the permission (role scope is irrelevant to an override's reach).
    const effectiveScope = grant
      ? { scope_type: grant.scope_type, scope_id: grant.scope_id }
      : assignment

    // GEOGRAPHY. A direct grant carries its own scope, so it is evaluated against
    // that pair directly. A role-based grant reads the multi-dimensional scope
    // set (Phase 2G) — never user_roles.scope_type/scope_id, which are now
    // vestigial for resolution purposes.
    const geoCovers = async (facilityId) => grant
      ? this.facilityInScope(grant.scope_type, grant.scope_id, facilityId)
      : this.geographyCovers(userId, facilityId)

    let geoOk, reason
    if (TRANSFER_PERMISSIONS.has(permissionKey)) {
      const { sendingFacilityId, receivingFacilityId } = context
      geoOk = (await geoCovers(sendingFacilityId)) || (await geoCovers(receivingFacilityId))
      reason = 'transfer party scope'
    } else {
      // PER-GRANT SCOPE NARROWING (role_permissions.scope_mode). Replaces the
      // CROSS_FACILITY_WRITE_PERMISSIONS constant this resolver carried while
      // the schema could not express the rule.
      //
      // A direct user_permissions grant carries its own scope and has no
      // role_permissions row, so it is treated as 'inherit'.
      const scopeMode = grant
        ? 'inherit'
        : await this.getScopeMode(assignment.role, permissionKey)

      if (scopeMode === 'own_facility_only') {
        // This grant never widens, whatever the role's assignment says. The
        // actor must be scoped to a specific facility — an admin scoped to a
        // state or cluster has no own-facility to fall back on, so this denies
        // rather than widening. Fail closed.
        const widest = assignment?.scope_type ?? ''
        if (widest !== 'facility') {
          return { decision: false, reason: 'grant is own-facility-only and this role has no facility scope', role: assignment?.role ?? null }
        }
      } else if (scopeMode !== 'inherit') {
        // Unrecognised (or missing) scope_mode. The CHECK constraint should make
        // this unreachable, but a value the resolver does not understand must
        // never be treated as permissive.
        return { decision: false, reason: `unrecognised scope_mode: ${scopeMode}`, role: assignment?.role ?? null }
      }

      geoOk = await geoCovers(context.facilityId)
      reason = geoOk ? 'facility scope match' : 'facility outside scope'
    }
    if (!geoOk) return { decision: false, reason, role: assignment?.role ?? null }

    // COMMODITY. Checked only when the caller names a commodity — mirroring
    // legacy, where enforceCommoditySection is a separate guard invoked only
    // where a commodity is actually in play. Both dimensions must pass (AND).
    if (context.commodityId) {
      const commodityOk = await this.commodityCovers(userId, context.commodityId)
      if (!commodityOk) {
        return { decision: false, reason: 'commodity outside scope', role: assignment?.role ?? null }
      }
    }

    return { decision: true, reason, role: assignment?.role ?? null }
  }
}
