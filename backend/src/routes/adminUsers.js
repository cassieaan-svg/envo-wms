import express from 'express';
import { AdminUsersService } from '../services/adminUsersService.js';
import { AuthzService } from '../services/authzService.js';
import { requirePermission } from '../middleware/requirePermission.js';

const router = express.Router();

// User/role administration. Held by System Administrator and Warehouse Admin (both hold
// users.create/users.disable — see the Phase 1 matrix); role-grant permission is checked
// per-request below because which one is required depends on the target role's tier.

router.get('/users', requirePermission('users.create'), async (req, res, next) => {
  try { return res.json(await AdminUsersService.listUsers()); }
  catch (err) { return next(err); }
});

router.get('/roles', requirePermission('users.create'), async (req, res, next) => {
  try { return res.json(await AdminUsersService.listRoles()); }
  catch (err) { return next(err); }
});

router.post('/users', requirePermission('users.create'), async (req, res, next) => {
  try {
    const user = await AdminUsersService.createUser({
      username: req.body?.username,
      password: req.body?.password,
      fullName: req.body?.fullName,
      actorUserId: req.user.id,
    });
    return res.status(201).json(user);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

router.put('/users/:id/disable', requirePermission('users.disable'), async (req, res, next) => {
  try {
    return res.json(await AdminUsersService.disableUser(Number(req.params.id), { actorUserId: req.user.id }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

router.put('/users/:id/enable', requirePermission('users.disable'), async (req, res, next) => {
  try {
    return res.json(await AdminUsersService.enableUser(Number(req.params.id), { actorUserId: req.user.id }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

/**
 * PUT /api/admin/users/:id/local-disable — body { disabled: true|false }.
 * The offline emergency lockout: local-only, never synced (see migration 040), so it can
 * take effect immediately without waiting on Cloud, and can never be undone by the next
 * roster pull.
 */
router.put('/users/:id/local-disable', requirePermission('users.disable'), async (req, res, next) => {
  try {
    const disabled = req.body?.disabled !== false;
    const result = await AdminUsersService.setLocalDisabled(Number(req.params.id), disabled, {
      actorUserId: req.user.id,
    });
    return res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

/**
 * POST /api/admin/users/:id/roles — body { role: '<role key>' }.
 * Which permission is required depends on the role's tier: assigning Picker/Dispatcher or
 * Receiving Clerk needs roles.assignOperational (Warehouse Admin has this); assigning
 * System Administrator or Warehouse Admin needs roles.assignAny (System Administrator
 * only). Self-targeting is refused unconditionally in the service, regardless of tier.
 */
router.post('/users/:id/roles', async (req, res, next) => {
  try {
    const roleKey = req.body?.role;
    const tier = AdminUsersService.roleTier(roleKey);
    if (!tier) return res.status(400).json({ error: 'unknown role' });

    const permission = tier === 'operational' ? 'roles.assignOperational' : 'roles.assignAny';
    if (!(await AuthzService.hasPermission(req.user.id, permission))) {
      return res.status(403).json({ error: `permission required: ${permission}` });
    }

    const result = await AdminUsersService.grantRole(Number(req.params.id), roleKey, { actorUserId: req.user.id });
    return res.status(201).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

router.delete('/users/:id/roles/:roleKey', async (req, res, next) => {
  try {
    const { roleKey } = req.params;
    const tier = AdminUsersService.roleTier(roleKey);
    if (!tier) return res.status(400).json({ error: 'unknown role' });

    const permission = tier === 'operational' ? 'roles.assignOperational' : 'roles.assignAny';
    if (!(await AuthzService.hasPermission(req.user.id, permission))) {
      return res.status(403).json({ error: `permission required: ${permission}` });
    }

    const removed = await AdminUsersService.revokeRole(Number(req.params.id), roleKey, { actorUserId: req.user.id });
    if (!removed) return res.status(404).json({ error: 'role assignment not found' });
    return res.json({ removed: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

export default router;
