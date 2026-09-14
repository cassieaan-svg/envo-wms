// Individual user permission overrides — the exception layer above role-derived access.
// Normal access stays user -> role -> role_permissions, unchanged; this proves the second,
// narrower path: user -> direct override, and its precedence over the role union.
//
// Numbered to match the task's own 24-scenario test plan.

import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import pool, { query } from '../src/db.js';
import { AdminUsersService } from '../src/services/adminUsersService.js';
import { AuthzService } from '../src/services/authzService.js';
import { makeUser, cleanup } from './helpers.js';

process.env.OUTBOX_WORKER = 'off';
process.env.PORT = '0';
const { default: app } = await import('../src/server.js');

let server, base;
test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

const tokenFor = (user) =>
  jwt.sign({ sub: user.id, username: user.username, role: user.role }, process.env.JWT_SECRET);

async function req(method, path, { body, token } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function overrideRowsFor(userId, key) {
  const { rows } = await query(
    'SELECT * FROM user_permission_overrides WHERE user_id = $1 AND permission_key = $2', [userId, key]);
  return rows;
}

async function auditRowsFor(userId, action) {
  const { rows } = await query(
    'SELECT * FROM authz_audit_log WHERE target_user_id = $1 AND action = $2 ORDER BY id', [userId, action]);
  return rows;
}

// ── 1. Existing role permission still works ────────────────────────────────────────────
test('1. Existing role permission still works, no override in the way', async () => {
  const user = await makeUser({ roles: ['picker_dispatcher'] }); // holds requests.view
  try {
    assert.equal(await AuthzService.hasPermission(user.id, 'requests.view'), true);
    assert.deepEqual(await overrideRowsFor(user.id, 'requests.view'), []);
  } finally {
    await cleanup({ userIds: [user.id] });
  }
});

// ── 2. Direct grant works ───────────────────────────────────────────────────────────────
test('2. Direct grant works', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const user = await makeUser({ roles: ['picker_dispatcher'] }); // does not hold commodities.manage
  try {
    assert.equal(await AuthzService.hasPermission(user.id, 'commodities.manage'), false);
    await AdminUsersService.setPermissionOverride(user.id, 'commodities.manage', 'grant', { actorUserId: admin.id });
    assert.equal(await AuthzService.hasPermission(user.id, 'commodities.manage'), true);
  } finally {
    await cleanup({ userIds: [admin.id, user.id] });
  }
});

// ── 3. Direct deny overrides an inherited role permission ─────────────────────────────
test('3. Direct deny overrides an inherited role permission', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const user = await makeUser({ roles: ['picker_dispatcher'] }); // holds requests.view via role
  try {
    assert.equal(await AuthzService.hasPermission(user.id, 'requests.view'), true);
    await AdminUsersService.setPermissionOverride(user.id, 'requests.view', 'deny', { actorUserId: admin.id });
    assert.equal(await AuthzService.hasPermission(user.id, 'requests.view'), false);
  } finally {
    await cleanup({ userIds: [admin.id, user.id] });
  }
});

// ── 4. Removing override restores role behaviour ───────────────────────────────────────
test('4. Removing override restores role behaviour, in both directions', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const user = await makeUser({ roles: ['picker_dispatcher'] });
  try {
    // deny -> remove restores the role's true.
    await AdminUsersService.setPermissionOverride(user.id, 'requests.view', 'deny', { actorUserId: admin.id });
    await AdminUsersService.removePermissionOverride(user.id, 'requests.view', { actorUserId: admin.id });
    assert.equal(await AuthzService.hasPermission(user.id, 'requests.view'), true);

    // grant -> remove restores the role's false.
    await AdminUsersService.setPermissionOverride(user.id, 'commodities.manage', 'grant', { actorUserId: admin.id });
    await AdminUsersService.removePermissionOverride(user.id, 'commodities.manage', { actorUserId: admin.id });
    assert.equal(await AuthzService.hasPermission(user.id, 'commodities.manage'), false);
  } finally {
    await cleanup({ userIds: [admin.id, user.id] });
  }
});

// ── 5. Direct grant can provide a permission absent from the user's role ──────────────
test('5. Direct grant provides a permission the role never included', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const user = await makeUser({ roles: ['receiving_clerk'] }); // no requests.* at all
  try {
    assert.equal(await AuthzService.hasPermission(user.id, 'requests.fulfil'), false);
    await AdminUsersService.setPermissionOverride(user.id, 'requests.fulfil', 'grant', { actorUserId: admin.id });
    assert.equal(await AuthzService.hasPermission(user.id, 'requests.fulfil'), true);
  } finally {
    await cleanup({ userIds: [admin.id, user.id] });
  }
});

// ── 6. Direct deny can be stored even where the role doesn't grant it ─────────────────
test("6. Direct deny can be stored even where the role never granted the permission", async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const user = await makeUser({ roles: ['receiving_clerk'] });
  try {
    await AdminUsersService.setPermissionOverride(user.id, 'requests.fulfil', 'deny', { actorUserId: admin.id });
    const rows = await overrideRowsFor(user.id, 'requests.fulfil');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].effect, 'deny');
    assert.equal(await AuthzService.hasPermission(user.id, 'requests.fulfil'), false, 'still false — nothing to override was true');
  } finally {
    await cleanup({ userIds: [admin.id, user.id] });
  }
});

// ── 7. Multiple roles + direct override ────────────────────────────────────────────────
test('7. A direct deny wins even when TWO roles together would grant the permission', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  // Neither role alone grants batches.create... wait: receiving_clerk DOES grant
  // batches.create. Use both roles so the union is unambiguous, then deny on top.
  const user = await makeUser({ roles: ['picker_dispatcher', 'receiving_clerk'] });
  try {
    assert.equal(await AuthzService.hasPermission(user.id, 'batches.create'), true, 'receiving_clerk alone already grants it');
    await AdminUsersService.setPermissionOverride(user.id, 'batches.create', 'deny', { actorUserId: admin.id });
    assert.equal(await AuthzService.hasPermission(user.id, 'batches.create'), false, 'the deny wins over the role union');
  } finally {
    await cleanup({ userIds: [admin.id, user.id] });
  }
});

// ── 8, 9, 10. Self-targeting blocked ────────────────────────────────────────────────────
test('8. Self-grant is blocked', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  try {
    await assert.rejects(
      AdminUsersService.setPermissionOverride(admin.id, 'commodities.manage', 'grant', { actorUserId: admin.id }),
      /own permissions/
    );
  } finally {
    await cleanup({ userIds: [admin.id] });
  }
});

test('9. Self-deny is blocked', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  try {
    await assert.rejects(
      AdminUsersService.setPermissionOverride(admin.id, 'monitoring.view', 'deny', { actorUserId: admin.id }),
      /own permissions/
    );
  } finally {
    await cleanup({ userIds: [admin.id] });
  }
});

test('10. Self-remove is blocked', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  try {
    await assert.rejects(
      AdminUsersService.removePermissionOverride(admin.id, 'monitoring.view', { actorUserId: admin.id }),
      /own permissions/
    );
  } finally {
    await cleanup({ userIds: [admin.id] });
  }
});

// ── 11. Warehouse Admin receives 403 ────────────────────────────────────────────────────
test('11. Warehouse Admin cannot view, grant, deny, or remove permission overrides', async () => {
  const wa = await makeUser({ roles: ['warehouse_admin'] });
  const target = await makeUser({ roles: ['picker_dispatcher'] });
  const token = tokenFor(wa);
  try {
    const view = await req('GET', `/api/admin/users/${target.id}/permissions`, { token });
    assert.equal(view.status, 403);
    const grant = await req('PUT', `/api/admin/users/${target.id}/permissions/commodities.manage`, { body: { effect: 'grant' }, token });
    assert.equal(grant.status, 403);
    const deny = await req('PUT', `/api/admin/users/${target.id}/permissions/requests.view`, { body: { effect: 'deny' }, token });
    assert.equal(deny.status, 403);
    const remove = await req('DELETE', `/api/admin/users/${target.id}/permissions/requests.view`, { token });
    assert.equal(remove.status, 403);
  } finally {
    await cleanup({ userIds: [wa.id, target.id] });
  }
});

// ── 12. Operational users receive 403 ───────────────────────────────────────────────────
test('12. Picker/Dispatcher and Receiving Clerk cannot manage permission overrides', async () => {
  const picker = await makeUser({ roles: ['picker_dispatcher'] });
  const clerk = await makeUser({ roles: ['receiving_clerk'] });
  const target = await makeUser({ roles: [] });
  try {
    for (const actor of [picker, clerk]) {
      const res = await req('GET', `/api/admin/users/${target.id}/permissions`, { token: tokenFor(actor) });
      assert.equal(res.status, 403);
    }
  } finally {
    await cleanup({ userIds: [picker.id, clerk.id, target.id] });
  }
});

// ── 13, 14, 15. System Administrator can grant/deny/remove ────────────────────────────
test('13. System Administrator can grant', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const target = await makeUser({ roles: [] });
  try {
    const res = await req('PUT', `/api/admin/users/${target.id}/permissions/commodities.manage`,
      { body: { effect: 'grant' }, token: tokenFor(admin) });
    assert.equal(res.status, 200);
    assert.equal(res.body.effect, 'grant');
  } finally {
    await cleanup({ userIds: [admin.id, target.id] });
  }
});

test('14. System Administrator can deny', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const target = await makeUser({ roles: ['picker_dispatcher'] });
  try {
    const res = await req('PUT', `/api/admin/users/${target.id}/permissions/requests.view`,
      { body: { effect: 'deny' }, token: tokenFor(admin) });
    assert.equal(res.status, 200);
    assert.equal(res.body.effect, 'deny');
  } finally {
    await cleanup({ userIds: [admin.id, target.id] });
  }
});

test('15. System Administrator can remove an override', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const target = await makeUser({ roles: [] });
  try {
    await req('PUT', `/api/admin/users/${target.id}/permissions/commodities.manage`,
      { body: { effect: 'grant' }, token: tokenFor(admin) });
    const res = await req('DELETE', `/api/admin/users/${target.id}/permissions/commodities.manage`, { token: tokenFor(admin) });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { removed: true });
  } finally {
    await cleanup({ userIds: [admin.id, target.id] });
  }
});

// ── 16, 17, 18. Audit entries ────────────────────────────────────────────────────────────
test('16. Audit entry created for a grant', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const target = await makeUser({ roles: [] });
  try {
    await AdminUsersService.setPermissionOverride(target.id, 'commodities.manage', 'grant', { actorUserId: admin.id });
    const rows = await auditRowsFor(target.id, 'permission.override.grant');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_user_id, admin.id);
    assert.equal(rows[0].detail.permission, 'commodities.manage');
    assert.equal(rows[0].detail.previousEffect, null);
    assert.equal(rows[0].detail.newEffect, 'grant');
    assert.equal(rows[0].detail.sensitive, false);
  } finally {
    await cleanup({ userIds: [admin.id, target.id] });
  }
});

test('17. Audit entry created for a deny, and flags a sensitive permission', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const target = await makeUser({ roles: ['warehouse_admin'] }); // holds batches.adjust via role
  try {
    await AdminUsersService.setPermissionOverride(target.id, 'batches.adjust', 'deny', { actorUserId: admin.id });
    const rows = await auditRowsFor(target.id, 'permission.override.deny');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].detail.newEffect, 'deny');
    assert.equal(rows[0].detail.sensitive, true, 'batches.adjust is on the sensitive list');
  } finally {
    await cleanup({ userIds: [admin.id, target.id] });
  }
});

test('18. Audit entry created for a removal, carrying the prior state', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const target = await makeUser({ roles: [] });
  try {
    await AdminUsersService.setPermissionOverride(target.id, 'commodities.manage', 'grant', { actorUserId: admin.id });
    await AdminUsersService.removePermissionOverride(target.id, 'commodities.manage', { actorUserId: admin.id });
    const rows = await auditRowsFor(target.id, 'permission.override.remove');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].detail.previousEffect, 'grant');
    assert.equal(rows[0].detail.newEffect, null);
  } finally {
    await cleanup({ userIds: [admin.id, target.id] });
  }
});

// ── 19, 20. Repeated grant/deny is safe ────────────────────────────────────────────────
test('19. Repeated grant is idempotent — one row, effective state unchanged', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const target = await makeUser({ roles: [] });
  try {
    await AdminUsersService.setPermissionOverride(target.id, 'commodities.manage', 'grant', { actorUserId: admin.id });
    await AdminUsersService.setPermissionOverride(target.id, 'commodities.manage', 'grant', { actorUserId: admin.id });
    const rows = await overrideRowsFor(target.id, 'commodities.manage');
    assert.equal(rows.length, 1, 'still exactly one row, not two');
    assert.equal(await AuthzService.hasPermission(target.id, 'commodities.manage'), true);
  } finally {
    await cleanup({ userIds: [admin.id, target.id] });
  }
});

test('20. Repeated deny is idempotent — one row, effective state unchanged', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const target = await makeUser({ roles: ['picker_dispatcher'] });
  try {
    await AdminUsersService.setPermissionOverride(target.id, 'requests.view', 'deny', { actorUserId: admin.id });
    await AdminUsersService.setPermissionOverride(target.id, 'requests.view', 'deny', { actorUserId: admin.id });
    const rows = await overrideRowsFor(target.id, 'requests.view');
    assert.equal(rows.length, 1);
    assert.equal(await AuthzService.hasPermission(target.id, 'requests.view'), false);
  } finally {
    await cleanup({ userIds: [admin.id, target.id] });
  }
});

// ── 21. Concurrent updates leave exactly one override row ─────────────────────────────
test('21. Concurrent grant and deny on the same permission leave exactly one row', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const target = await makeUser({ roles: [] });
  try {
    await Promise.allSettled([
      AdminUsersService.setPermissionOverride(target.id, 'commodities.manage', 'grant', { actorUserId: admin.id }),
      AdminUsersService.setPermissionOverride(target.id, 'commodities.manage', 'deny', { actorUserId: admin.id }),
    ]);
    const rows = await overrideRowsFor(target.id, 'commodities.manage');
    assert.equal(rows.length, 1, 'the UNIQUE constraint plus upsert leaves exactly one row, whichever write landed last');
    assert.ok(['grant', 'deny'].includes(rows[0].effect));
  } finally {
    await cleanup({ userIds: [admin.id, target.id] });
  }
});

// ── 22. Removing a non-existent override is a safe no-op ──────────────────────────────
test('22. Removing a non-existent override is a successful no-op with no misleading audit entry', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const target = await makeUser({ roles: [] });
  try {
    const result = await AdminUsersService.removePermissionOverride(target.id, 'commodities.manage', { actorUserId: admin.id });
    assert.deepEqual(result, { removed: false });
    const rows = await auditRowsFor(target.id, 'permission.override.remove');
    assert.equal(rows.length, 0, 'no audit row for a removal that changed nothing');
  } finally {
    await cleanup({ userIds: [admin.id, target.id] });
  }
});

// ── 23. Existing users with no overrides behave exactly as before ─────────────────────
test('23. A user with no overrides has exactly their role-derived permission set', async () => {
  const user = await makeUser({ roles: ['warehouse_admin'] });
  try {
    const effective = await AuthzService.permissionsForUser(user.id);
    assert.ok(effective.has('batches.adjust'));
    assert.ok(!effective.has('roles.assignAny'), 'unchanged — Warehouse Admin still lacks this');
    assert.equal(await overrideRowsFor(user.id, 'batches.adjust').then((r) => r.length), 0);
  } finally {
    await cleanup({ userIds: [user.id] });
  }
});

// ── 24. Disabled users remain denied regardless of overrides ──────────────────────────
test('24. A locally-disabled user is refused even with a direct grant in place', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const user = await makeUser({ roles: [] });
  try {
    await AdminUsersService.setPermissionOverride(user.id, 'commodities.manage', 'grant', { actorUserId: admin.id });
    assert.equal(await AuthzService.hasPermission(user.id, 'commodities.manage'), true);

    await AdminUsersService.setLocalDisabled(user.id, true, { actorUserId: admin.id });
    assert.equal(await AuthzService.hasPermission(user.id, 'commodities.manage'), false, 'local disable outranks every override');
  } finally {
    await AdminUsersService.setLocalDisabled(user.id, false, { actorUserId: admin.id });
    await cleanup({ userIds: [admin.id, user.id] });
  }
});

// ── Extra: unknown permission key is a clear 400 ───────────────────────────────────────
test('setting an override on an unknown permission key is a clear 400', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const target = await makeUser({ roles: [] });
  try {
    await assert.rejects(
      AdminUsersService.setPermissionOverride(target.id, 'made.up.key', 'grant', { actorUserId: admin.id }),
      /unknown permission/
    );
  } finally {
    await cleanup({ userIds: [admin.id, target.id] });
  }
});

// ── Extra: an invalid effect value is refused ──────────────────────────────────────────
test('an invalid effect value is refused', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const target = await makeUser({ roles: [] });
  try {
    await assert.rejects(
      AdminUsersService.setPermissionOverride(target.id, 'commodities.manage', 'maybe', { actorUserId: admin.id }),
      /must be 'grant' or 'deny'/
    );
  } finally {
    await cleanup({ userIds: [admin.id, target.id] });
  }
});

// ── Extra: the effective-permission view reports source correctly ─────────────────────
test('getUserPermissions reports role/override source correctly', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const user = await makeUser({ roles: ['picker_dispatcher'] });
  try {
    await AdminUsersService.setPermissionOverride(user.id, 'requests.view', 'deny', { actorUserId: admin.id });
    await AdminUsersService.setPermissionOverride(user.id, 'commodities.manage', 'grant', { actorUserId: admin.id });

    const details = await AdminUsersService.getUserPermissions(user.id);
    const byKey = Object.fromEntries(details.map((d) => [d.key, d]));

    assert.equal(byKey['requests.view'].source, 'override-deny');
    assert.equal(byKey['requests.view'].effective, false);
    assert.equal(byKey['requests.view'].roleGranted, true);

    assert.equal(byKey['commodities.manage'].source, 'override-grant');
    assert.equal(byKey['commodities.manage'].effective, true);
    assert.equal(byKey['commodities.manage'].roleGranted, false);

    assert.equal(byKey['dispatchOrders.view'].source, 'role');
    assert.equal(byKey['dispatchOrders.view'].roleLabel, 'Picker/Dispatcher');

    assert.equal(byKey['instance.configure'].source, 'none');
    assert.equal(byKey['instance.configure'].effective, false);
  } finally {
    await cleanup({ userIds: [admin.id, user.id] });
  }
});
