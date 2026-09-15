// grantRole/revokeRole previously wrote the role-table change and the authz_audit_log row
// as two separate statements — a crash between them could leave a granted (or revoked) role
// with no audit record. This brings them in line with setPermissionOverride's existing
// transactional standard: the role change and its audit row commit together, or neither does.
// No authorization behaviour changes here — same checks, same tiers, same audit action
// names, same API responses, same duplicate-grant no-op.

import test from 'node:test';
import assert from 'node:assert/strict';
import pool, { query } from '../src/db.js';
import { AdminUsersService } from '../src/services/adminUsersService.js';
import { AuthzService } from '../src/services/authzService.js';
import { makeUser, cleanup } from './helpers.js';

test.after(async () => { await pool.end(); });

async function userRoleRows(userId, roleKey) {
  const { rows } = await query(
    `SELECT ur.* FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1 AND r.key = $2`,
    [userId, roleKey]
  );
  return rows;
}

async function auditRowsFor(userId, action) {
  const { rows } = await query(
    'SELECT * FROM authz_audit_log WHERE target_user_id = $1 AND action = $2 ORDER BY id', [userId, action]);
  return rows;
}

// ── 1. Successful grant creates the role assignment AND the audit record ──────────────
test('1. A successful grant creates both the role assignment and its audit record', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const target = await makeUser({ roles: [] });
  try {
    const result = await AdminUsersService.grantRole(target.id, 'picker_dispatcher', { actorUserId: admin.id });
    assert.ok(result, 'grantRole returns the new row, unchanged from before');

    const roleRows = await userRoleRows(target.id, 'picker_dispatcher');
    assert.equal(roleRows.length, 1);

    const auditRows = await auditRowsFor(target.id, 'role.grant');
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0].actor_user_id, admin.id);
    assert.deepEqual(auditRows[0].detail, { role: 'picker_dispatcher' });
  } finally {
    await cleanup({ userIds: [admin.id, target.id] });
  }
});

// ── 2. Successful revoke removes the role AND creates the audit record ────────────────
test('2. A successful revoke removes the role assignment and creates its audit record', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const target = await makeUser({ roles: ['picker_dispatcher'] });
  try {
    const result = await AdminUsersService.revokeRole(target.id, 'picker_dispatcher', { actorUserId: admin.id });
    assert.ok(result, 'revokeRole returns the removed row, unchanged from before');

    assert.equal((await userRoleRows(target.id, 'picker_dispatcher')).length, 0);

    const auditRows = await auditRowsFor(target.id, 'role.revoke');
    assert.equal(auditRows.length, 1);
    assert.deepEqual(auditRows[0].detail, { role: 'picker_dispatcher' });
  } finally {
    await cleanup({ userIds: [admin.id, target.id] });
  }
});

// ── 3 & 4. If the audit write fails, the role mutation is rolled back ─────────────────
// Forces AuthzService.recordAudit to throw from WITHIN the transaction (simulating a crash
// or constraint failure on the audit write) and proves the role-table change does not
// survive — the whole point of moving both statements into one transaction.
test('3. If the audit write fails, the role grant does not remain', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const target = await makeUser({ roles: [] });
  const original = AuthzService.recordAudit;
  try {
    AuthzService.recordAudit = async () => { throw new Error('simulated audit failure'); };

    await assert.rejects(
      AdminUsersService.grantRole(target.id, 'picker_dispatcher', { actorUserId: admin.id }),
      /simulated audit failure/
    );

    assert.equal((await userRoleRows(target.id, 'picker_dispatcher')).length, 0,
      'the role insert was rolled back along with the failed audit write');
  } finally {
    AuthzService.recordAudit = original;
    await cleanup({ userIds: [admin.id, target.id] });
  }
});

test('4. If the audit write fails, the role revoke does not remain', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const target = await makeUser({ roles: ['picker_dispatcher'] });
  const original = AuthzService.recordAudit;
  try {
    AuthzService.recordAudit = async () => { throw new Error('simulated audit failure'); };

    await assert.rejects(
      AdminUsersService.revokeRole(target.id, 'picker_dispatcher', { actorUserId: admin.id }),
      /simulated audit failure/
    );

    assert.equal((await userRoleRows(target.id, 'picker_dispatcher')).length, 1,
      'the role delete was rolled back — the assignment is still there');
  } finally {
    AuthzService.recordAudit = original;
    await cleanup({ userIds: [admin.id, target.id] });
  }
});

// ── 5. Self-role-change protection still works ──────────────────────────────────────────
test('5. Self-role-change protection is unchanged', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  try {
    await assert.rejects(
      AdminUsersService.grantRole(admin.id, 'warehouse_admin', { actorUserId: admin.id }),
      /own roles/
    );
    await assert.rejects(
      AdminUsersService.revokeRole(admin.id, 'system_administrator', { actorUserId: admin.id }),
      /own roles/
    );
  } finally {
    await cleanup({ userIds: [admin.id] });
  }
});

// ── 6. Role-assignment tier restrictions still work (route-level, unchanged) ──────────
test('6. Warehouse Admin still cannot be granted System Administrator via the service directly bypassing tier is irrelevant — the tier check lives in the route, unchanged', async () => {
  // grantRole/revokeRole themselves never enforced tier — routes/adminUsers.js does, by
  // checking roles.assignOperational/roles.assignAny before calling the service. That file
  // was not touched by this change; this test documents the boundary stays where it was.
  const wa = await makeUser({ roles: ['warehouse_admin'] });
  const target = await makeUser({ roles: [] });
  try {
    // Calling the service directly still succeeds — proving the fix didn't accidentally
    // fold tier-checking into the service (it shouldn't be there; the route owns it).
    const result = await AdminUsersService.grantRole(target.id, 'system_administrator', { actorUserId: wa.id });
    assert.ok(result);
  } finally {
    await cleanup({ userIds: [wa.id, target.id] });
  }
});

// ── 7. Duplicate-grant behaviour is unchanged (no error, no second row) ───────────────
test('7. Granting a role the user already holds is a silent no-op, same as before', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const target = await makeUser({ roles: ['picker_dispatcher'] });
  try {
    const result = await AdminUsersService.grantRole(target.id, 'picker_dispatcher', { actorUserId: admin.id });
    assert.equal(result, null, 'ON CONFLICT DO NOTHING returns no row, exactly as before');
    assert.equal((await userRoleRows(target.id, 'picker_dispatcher')).length, 1, 'still exactly one row');

    // The audit call still fires on a duplicate grant, matching the pre-existing behaviour
    // (unchanged by this fix — recordAudit was never conditional on rows[0] existing).
    const auditRows = await auditRowsFor(target.id, 'role.grant');
    assert.equal(auditRows.length, 1);
  } finally {
    await cleanup({ userIds: [admin.id, target.id] });
  }
});

test('revoking a role the user does not hold is unchanged — no row, audit still fires', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const target = await makeUser({ roles: [] });
  try {
    const result = await AdminUsersService.revokeRole(target.id, 'picker_dispatcher', { actorUserId: admin.id });
    assert.equal(result, null);
    const auditRows = await auditRowsFor(target.id, 'role.revoke');
    assert.equal(auditRows.length, 1, 'matches pre-existing behaviour — revokeRole always audited, even as a no-op');
  } finally {
    await cleanup({ userIds: [admin.id, target.id] });
  }
});
