// createUser/disableUser/enableUser previously wrote the users-table change and the
// authz_audit_log row as two separate statements — same class of gap already fixed for
// grantRole/revokeRole. This proves the identical fix here: the user-table write and its
// audit row commit in one transaction, or neither does.

import test from 'node:test';
import assert from 'node:assert/strict';
import pool, { query } from '../src/db.js';
import { AdminUsersService } from '../src/services/adminUsersService.js';
import { AuthzService } from '../src/services/authzService.js';
import { makeUser, cleanup, uniq } from './helpers.js';

test.after(async () => { await pool.end(); });

async function userRow(id) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function auditRowsFor(userId, action) {
  const { rows } = await query(
    'SELECT * FROM authz_audit_log WHERE target_user_id = $1 AND action = $2 ORDER BY id', [userId, action]);
  return rows;
}

// ── createUser ───────────────────────────────────────────────────────────────────────────
test('a successful createUser creates the account and its audit record', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  let created;
  try {
    created = await AdminUsersService.createUser({
      username: `atx-${uniq()}`, password: 'a-long-enough-password', fullName: 'Test User', actorUserId: admin.id,
    });
    assert.ok(created.id);

    const row = await userRow(created.id);
    assert.ok(row, 'the account exists');

    const auditRows = await auditRowsFor(created.id, 'user.create');
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0].actor_user_id, admin.id);
    assert.deepEqual(auditRows[0].detail, { username: created.username });
  } finally {
    await cleanup({ userIds: [admin.id, created?.id].filter(Boolean) });
  }
});

test('if the audit write fails, createUser does not leave the account behind', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const original = AuthzService.recordAudit;
  const username = `atx-${uniq()}`;
  try {
    AuthzService.recordAudit = async () => { throw new Error('simulated audit failure'); };

    await assert.rejects(
      AdminUsersService.createUser({ username, password: 'a-long-enough-password', fullName: null, actorUserId: admin.id }),
      /simulated audit failure/
    );

    const { rows } = await query('SELECT id FROM users WHERE username = $1', [username]);
    assert.equal(rows.length, 0, 'the insert was rolled back along with the failed audit write');
  } finally {
    AuthzService.recordAudit = original;
    await cleanup({ userIds: [admin.id] });
  }
});

test('createUser still refuses a duplicate username with the same 409, unchanged', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const username = `atx-${uniq()}`;
  let created;
  try {
    created = await AdminUsersService.createUser({
      username, password: 'a-long-enough-password', fullName: null, actorUserId: admin.id,
    });
    await assert.rejects(
      AdminUsersService.createUser({ username, password: 'another-password-here', fullName: null, actorUserId: admin.id }),
      (err) => { assert.equal(err.status, 409); assert.match(err.message, /already taken/); return true; }
    );
  } finally {
    await cleanup({ userIds: [admin.id, created?.id].filter(Boolean) });
  }
});

// ── disableUser ──────────────────────────────────────────────────────────────────────────
test('a successful disableUser disables the account and creates its audit record', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const target = await makeUser({ roles: [] });
  try {
    const result = await AdminUsersService.disableUser(target.id, { actorUserId: admin.id });
    assert.equal(result.is_active, false);

    const row = await userRow(target.id);
    assert.equal(row.is_active, false);

    const auditRows = await auditRowsFor(target.id, 'user.disable');
    assert.equal(auditRows.length, 1);
  } finally {
    await cleanup({ userIds: [admin.id, target.id] });
  }
});

test('if the audit write fails, disableUser does not leave the account disabled', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const target = await makeUser({ roles: [] });
  const original = AuthzService.recordAudit;
  try {
    AuthzService.recordAudit = async () => { throw new Error('simulated audit failure'); };

    await assert.rejects(
      AdminUsersService.disableUser(target.id, { actorUserId: admin.id }),
      /simulated audit failure/
    );

    const row = await userRow(target.id);
    assert.equal(row.is_active, true, 'the disable was rolled back along with the failed audit write');
  } finally {
    AuthzService.recordAudit = original;
    await cleanup({ userIds: [admin.id, target.id] });
  }
});

test('disableUser on an unknown id is still a 404, unchanged', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  try {
    await assert.rejects(
      AdminUsersService.disableUser(2_147_483_000, { actorUserId: admin.id }),
      (err) => { assert.equal(err.status, 404); return true; }
    );
  } finally {
    await cleanup({ userIds: [admin.id] });
  }
});

// ── enableUser ───────────────────────────────────────────────────────────────────────────
test('a successful enableUser re-enables the account and creates its audit record', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const target = await makeUser({ roles: [] });
  try {
    await AdminUsersService.disableUser(target.id, { actorUserId: admin.id });
    const result = await AdminUsersService.enableUser(target.id, { actorUserId: admin.id });
    assert.equal(result.is_active, true);

    const row = await userRow(target.id);
    assert.equal(row.is_active, true);

    const auditRows = await auditRowsFor(target.id, 'user.enable');
    assert.equal(auditRows.length, 1);
  } finally {
    await cleanup({ userIds: [admin.id, target.id] });
  }
});

test('if the audit write fails, enableUser does not leave the account enabled', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const target = await makeUser({ roles: [] });
  const original = AuthzService.recordAudit;
  try {
    await AdminUsersService.disableUser(target.id, { actorUserId: admin.id });
    AuthzService.recordAudit = async () => { throw new Error('simulated audit failure'); };

    await assert.rejects(
      AdminUsersService.enableUser(target.id, { actorUserId: admin.id }),
      /simulated audit failure/
    );

    const row = await userRow(target.id);
    assert.equal(row.is_active, false, 'the enable was rolled back along with the failed audit write');
  } finally {
    AuthzService.recordAudit = original;
    await cleanup({ userIds: [admin.id, target.id] });
  }
});

test('enableUser on an unknown id is still a 404, unchanged', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  try {
    await assert.rejects(
      AdminUsersService.enableUser(2_147_483_000, { actorUserId: admin.id }),
      (err) => { assert.equal(err.status, 404); return true; }
    );
  } finally {
    await cleanup({ userIds: [admin.id] });
  }
});
