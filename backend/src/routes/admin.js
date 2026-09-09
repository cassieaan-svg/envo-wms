import express from 'express'
import {
  adminIdentity, listUsers, getUserConfig, createUser, createFacility, deleteUser,
  setUserRoleAndScope, setUserOverride,
  listFeatureConfig, setFeatureConfig, featureRegistry,
  assignableRolesFor, SECTIONS, AclAdminError,
} from '../services/aclAdminService.js'
import { SECTION_CATEGORIES } from '../constants/sections.js'
import { query } from '../db.js'

const router = express.Router()

// Administration surface for the ACL configuration screens.
//
// AUTHORIZATION HERE IS scope.js's, NOT THE ACL's. Every route derives its
// caller from req.scope — which attachScope built from the JWT — and the ACL
// resolver is never imported. The tables these routes edit are still shadow-only:
// changing a role here alters no live decision, because scope.js reads
// raw_user_meta_data, not user_roles. The screens say so.
//
// The gate is deliberately narrow. adminIdentity() admits system_admin (national)
// and state_admin (its own state) and returns null for everyone else, including
// overall_admin — which is read-only by design and, per the Phase 2M governance,
// administers nobody.
//
// No new middleware: the guard is one function called at the top of each handler,
// in the same shape as routes/commodities.js's isCatalogueManager.

const requireAdmin = (req, res) => {
  const identity = adminIdentity(req.scope, req.user?.sub)
  if (!identity) {
    res.status(403).json({
      success: false, code: 'FORBIDDEN',
      error: 'User administration requires a system or state administrator account.',
    })
    return null
  }
  return identity
}

// Errors from the service carry their own status and code; anything else is a
// genuine fault and must not leak its message to the client.
function fail(res, err, context) {
  if (err instanceof AclAdminError) {
    return res.status(err.status).json({ success: false, error: err.message, code: err.code })
  }
  console.error(`[admin] ${context}:`, err.message)
  return res.status(500).json({ success: false, error: 'Request failed.', code: 'INTERNAL' })
}

/**
 * GET /api/admin/users?q=&limit=&offset=
 * Searchable user list, scoped to the caller's remit.
 */
router.get('/users', async (req, res) => {
  const identity = requireAdmin(req, res); if (!identity) return
  try {
    const { q, limit, offset } = req.query
    const { users, total } = await listUsers(identity, { q, limit, offset })
    res.json({ success: true, data: users, total })
  } catch (err) { fail(res, err, 'list users') }
})

/**
 * POST /api/admin/users  { username, role, scopes }
 *
 * Creates an account and returns its generated password ONCE. Note this is the
 * only endpoint here that affects live authorization — see createUser.
 */
router.post('/users', async (req, res) => {
  const identity = requireAdmin(req, res); if (!identity) return
  try {
    const { username, role, scopes } = req.body || {}
    if (scopes != null && !Array.isArray(scopes)) throw new AclAdminError('Scopes must be a list.')
    const result = await createUser(identity, { username, role, scopes: scopes || [] })
    res.status(201).json({ success: true, data: result })
  } catch (err) { fail(res, err, 'create user') }
})

/**
 * GET /api/admin/users/:id — role, scope, and the permission list split into
 * role-inherited versus direct override.
 */
router.get('/users/:id', async (req, res) => {
  const identity = requireAdmin(req, res); if (!identity) return
  try {
    res.json({ success: true, data: await getUserConfig(identity, req.params.id) })
  } catch (err) { fail(res, err, 'get user') }
})

/** DELETE /api/admin/users/:id — system administrator only. */
router.delete('/users/:id', async (req, res) => {
  const identity = requireAdmin(req, res); if (!identity) return
  try {
    res.json({ success: true, data: await deleteUser(identity, req.params.id) })
  } catch (err) { fail(res, err, 'delete user') }
})

/**
 * POST /api/admin/facilities  { name, lga, state?, level?, module? }
 * Adds a facility the master roster left out. state/level/module are filled in
 * from the caller's own remit where it has one (essential_admin) and required
 * only from an unconfined caller (system_admin) — see createFacility.
 */
router.post('/facilities', async (req, res) => {
  const identity = requireAdmin(req, res); if (!identity) return
  try {
    const { name, lga, state, level, module } = req.body || {}
    res.status(201).json({ success: true, data: await createFacility(identity, { name, lga, state, level, module }) })
  } catch (err) { fail(res, err, 'create facility') }
})

/**
 * PUT /api/admin/users/:id/role  { role, scopes: [{dimension, scope_type, scope_id}] }
 * Role and scope are written together, in one transaction.
 */
router.put('/users/:id/role', async (req, res) => {
  const identity = requireAdmin(req, res); if (!identity) return
  try {
    const { role, scopes } = req.body || {}
    if (!role) throw new AclAdminError('A role is required.')
    if (scopes != null && !Array.isArray(scopes)) throw new AclAdminError('Scopes must be a list.')
    res.json({ success: true, data: await setUserRoleAndScope(identity, req.params.id, { role, scopes: scopes || [] }) })
  } catch (err) { fail(res, err, 'set role') }
})

/**
 * PUT /api/admin/users/:id/permission  { permission_key, effect: 'grant'|'deny'|null }
 * system_admin only — the service enforces it, not this route.
 */
router.put('/users/:id/permission', async (req, res) => {
  const identity = requireAdmin(req, res); if (!identity) return
  try {
    const { permission_key, effect } = req.body || {}
    if (!permission_key) throw new AclAdminError('A permission key is required.')
    res.json({ success: true, data: await setUserOverride(identity, req.params.id, { permission_key, effect: effect ?? null }) })
  } catch (err) { fail(res, err, 'set override') }
})

/**
 * GET /api/admin/meta — the vocabulary the screens need: assignable roles, the
 * declared sections, and the declared feature registry.
 *
 * Served from the code constants rather than from the database so the UI cannot
 * offer a section or feature that nothing enforces.
 */
router.get('/meta', async (req, res) => {
  const identity = requireAdmin(req, res); if (!identity) return
  try {
    const { rows: permissions } = await query(
      `select key, module, description from permissions where is_active order by module, key`)
    // Modules come from the `modules` table — the catalogue's own declaration —
    // not from distinct commodities.module, so a module with no items yet still
    // appears and a typo in a commodity row cannot invent one.
    const { rows: modules } = await query(`select key, label from modules order by label`)
    res.json({
      success: true,
      data: {
        // Narrowed per caller — see assignableRolesFor. A UI convenience only;
        // assertMayWrite enforces the real ceiling on every write regardless.
        roles: assignableRolesFor(identity),
        modules,
        // Sections partition the HIV module only. Essential has categories, not
        // sections, and M&E's section arrives with the envo-tools branch — so
        // this list is deliberately shorter than the module list. essential_admin
        // gets none at all: it cannot grant HIV, so pinning a caller to one of
        // HIV's own pharmacy/lab/general sections is meaningless for it.
        sections: identity.kind === 'essential_admin'
          ? [] : SECTIONS.map(key => ({ key, categories: SECTION_CATEGORIES[key] })),
        features: featureRegistry(),
        permissions,
        // `module` is the caller's own remit — whose accounts it administers —
        // and `grantableModules` is what it may put ON an account. They differ
        // for essential_admin (see aclAdminService.adminIdentity), and the
        // screens need both: the module pickers offer `grantableModules` and
        // require `module` among them, which is exactly what validateScopes
        // enforces. Sent so the UI cannot offer a choice the server will refuse.
        identity: {
          kind: identity.kind, state: identity.state, canOverride: identity.canOverride,
          // A Primary-only or Secondary-only essential_admin (see createUser's
          // level ceiling) — sent so the form can confine itself to that level
          // rather than let the caller pick a facility the server will reject.
          level: identity.level || null,
          module: identity.module, grantableModules: identity.grantableModules,
        },
      },
    })
  } catch (err) { fail(res, err, 'meta') }
})

/**
 * GET /api/admin/feature-config — the explicit disables. An absent row means
 * enabled, so this is deliberately NOT a full matrix.
 */
router.get('/feature-config', async (req, res) => {
  const identity = requireAdmin(req, res); if (!identity) return
  try {
    res.json({ success: true, data: await listFeatureConfig(identity) })
  } catch (err) { fail(res, err, 'list feature config') }
})

/**
 * PUT /api/admin/feature-config  { facility_id, department, feature, enabled }
 * Enabling DELETES the row — configuration is deny-only.
 */
router.put('/feature-config', async (req, res) => {
  const identity = requireAdmin(req, res); if (!identity) return
  try {
    const { facility_id, department, feature, enabled } = req.body || {}
    if (!facility_id || !department || !feature) {
      throw new AclAdminError('facility_id, department and feature are required.')
    }
    if (typeof enabled !== 'boolean') throw new AclAdminError('`enabled` must be true or false.')
    res.json({ success: true, data: await setFeatureConfig(identity, { facility_id, department, feature, enabled }) })
  } catch (err) { fail(res, err, 'set feature config') }
})

export default router
