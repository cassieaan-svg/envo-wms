import express from 'express'
import {
  adminIdentity, listUsers, getUserConfig, setUserRoleAndScope, setUserOverride,
  listFeatureConfig, setFeatureConfig, featureRegistry,
  ASSIGNABLE_ROLES, SECTIONS, AclAdminError,
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
 * GET /api/admin/users/:id — role, scope, and the permission list split into
 * role-inherited versus direct override.
 */
router.get('/users/:id', async (req, res) => {
  const identity = requireAdmin(req, res); if (!identity) return
  try {
    res.json({ success: true, data: await getUserConfig(identity, req.params.id) })
  } catch (err) { fail(res, err, 'get user') }
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
    res.json({
      success: true,
      data: {
        roles: ASSIGNABLE_ROLES,
        sections: SECTIONS.map(key => ({ key, categories: SECTION_CATEGORIES[key] })),
        features: featureRegistry(),
        permissions,
        identity: { kind: identity.kind, state: identity.state, canOverride: identity.canOverride },
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
