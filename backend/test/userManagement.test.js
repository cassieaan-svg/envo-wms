// User Management — the /api/admin/* surface built on top of the Phase 1 authorization
// model (permissions -> roles -> user_roles). No new authorization architecture here: every
// case below exercises AdminUsersService/adminUsers.js exactly as Phase 1 built them.
//
// Several of these overlap with test/authorization.test.js by design — that file proves the
// mechanism in general; this one maps directly onto the User Management task's own numbered
// scenario list, so each requirement has a named, traceable test.

import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import pool, { query } from '../src/db.js';
import { AdminUsersService } from '../src/services/adminUsersService.js';
import { makeUser, cleanup, uniq } from './helpers.js';

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

// ── 1. System Admin can view users ─────────────────────────────────────────────────────
test('1. System Administrator can view the user list', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const token = tokenFor(admin);
  try {
    const res = await req('GET', '/api/admin/users', { token });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.some((u) => u.id === admin.id));
  } finally {
    await cleanup({ userIds: [admin.id] });
  }
});

// ── 2. System Admin can create users where permitted ───────────────────────────────────
test('2. System Administrator can create a user', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const token = tokenFor(admin);
  let created;
  try {
    const res = await req('POST', '/api/admin/users', {
      body: { username: `um-${uniq()}`, password: 'a-long-enough-password', fullName: 'Test User' },
      token,
    });
    assert.equal(res.status, 201);
    created = res.body;
    assert.equal(created.is_active, true);
  } finally {
    await cleanup({ userIds: [admin.id, created?.id].filter(Boolean) });
  }
});

// ── 3. Warehouse Admin can create users ─────────────────────────────────────────────────
test('3. Warehouse Admin can create a user', async () => {
  const admin = await makeUser({ roles: ['warehouse_admin'] });
  const token = tokenFor(admin);
  let created;
  try {
    const res = await req('POST', '/api/admin/users', {
      body: { username: `um-${uniq()}`, password: 'a-long-enough-password' },
      token,
    });
    assert.equal(res.status, 201);
    created = res.body;
  } finally {
    await cleanup({ userIds: [admin.id, created?.id].filter(Boolean) });
  }
});

// ── 4. Warehouse Admin can assign operational roles ────────────────────────────────────
test('4. Warehouse Admin can assign Picker/Dispatcher and Receiving Clerk', async () => {
  const admin = await makeUser({ roles: ['warehouse_admin'] });
  const target = await makeUser({ roles: [] });
  const token = tokenFor(admin);
  try {
    const pd = await req('POST', `/api/admin/users/${target.id}/roles`, { body: { role: 'picker_dispatcher' }, token });
    assert.equal(pd.status, 201);
    const rc = await req('POST', `/api/admin/users/${target.id}/roles`, { body: { role: 'receiving_clerk' }, token });
    assert.equal(rc.status, 201);
  } finally {
    await cleanup({ userIds: [admin.id, target.id] });
  }
});

// ── 5. Warehouse Admin cannot assign System Administrator ─────────────────────────────
test('5. Warehouse Admin cannot assign System Administrator', async () => {
  const admin = await makeUser({ roles: ['warehouse_admin'] });
  const target = await makeUser({ roles: [] });
  const token = tokenFor(admin);
  try {
    const res = await req('POST', `/api/admin/users/${target.id}/roles`, { body: { role: 'system_administrator' }, token });
    assert.equal(res.status, 403);
  } finally {
    await cleanup({ userIds: [admin.id, target.id] });
  }
});

// ── 6. Warehouse Admin cannot assign Warehouse Admin ───────────────────────────────────
test('6. Warehouse Admin cannot assign Warehouse Admin', async () => {
  const admin = await makeUser({ roles: ['warehouse_admin'] });
  const target = await makeUser({ roles: [] });
  const token = tokenFor(admin);
  try {
    const res = await req('POST', `/api/admin/users/${target.id}/roles`, { body: { role: 'warehouse_admin' }, token });
    assert.equal(res.status, 403);
  } finally {
    await cleanup({ userIds: [admin.id, target.id] });
  }
});

// ── 7. Warehouse Admin cannot change their own role ────────────────────────────────────
test('7. Warehouse Admin cannot change their own role, even to an operational one', async () => {
  const admin = await makeUser({ roles: ['warehouse_admin'] });
  const token = tokenFor(admin);
  try {
    const grant = await req('POST', `/api/admin/users/${admin.id}/roles`, { body: { role: 'picker_dispatcher' }, token });
    assert.equal(grant.status, 403);
    assert.match(grant.body.error, /own roles/);

    // Revoking their own warehouse_admin role is refused too — here the tier-permission
    // check (roles.assignAny, which Warehouse Admin never holds) is what stops it before
    // the self-check inside the service even runs. Different mechanism, same outcome:
    // nothing about their own access changes.
    const revoke = await req('DELETE', `/api/admin/users/${admin.id}/roles/warehouse_admin`, { token });
    assert.equal(revoke.status, 403);
  } finally {
    await cleanup({ userIds: [admin.id] });
  }
});

// ── 8. A user cannot self-escalate ──────────────────────────────────────────────────────
test('8. A plain operational user cannot grant themselves any role, even with users.create if somehow held', async () => {
  // Self-targeting is refused unconditionally in AdminUsersService.grantRole, independent
  // of which permission the caller holds — verified directly at the service layer, which is
  // the actual enforcement point (the route's permission check happens first, but even a
  // caller that legitimately holds roles.assignOperational or roles.assignAny is still
  // refused by the service when the target is themselves).
  const user = await makeUser({ roles: ['picker_dispatcher'] });
  try {
    await assert.rejects(
      AdminUsersService.grantRole(user.id, 'receiving_clerk', { actorUserId: user.id }),
      /own roles/
    );
  } finally {
    await cleanup({ userIds: [user.id] });
  }
});

// ── 9. Disabled user cannot log in ──────────────────────────────────────────────────────
test('9. A disabled user cannot log in', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const username = `um-${uniq()}`;
  const password = 'a-long-enough-password';
  let created;
  try {
    created = await AdminUsersService.createUser({ username, password, fullName: null, actorUserId: admin.id });

    const before = await req('POST', '/api/auth/login', { body: { username, password } });
    assert.equal(before.status, 200, 'sanity check: the account can log in before being disabled');

    await AdminUsersService.disableUser(created.id, { actorUserId: admin.id });

    const after = await req('POST', '/api/auth/login', { body: { username, password } });
    assert.equal(after.status, 401);
    assert.match(after.body.error, /invalid credentials/);
  } finally {
    await cleanup({ userIds: [admin.id, created?.id].filter(Boolean) });
  }
});

// ── 10. Re-enabled user can authenticate again ─────────────────────────────────────────
test('10. A re-enabled user can log in again', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const username = `um-${uniq()}`;
  const password = 'a-long-enough-password';
  let created;
  try {
    created = await AdminUsersService.createUser({ username, password, fullName: null, actorUserId: admin.id });
    await AdminUsersService.disableUser(created.id, { actorUserId: admin.id });
    await AdminUsersService.enableUser(created.id, { actorUserId: admin.id });

    const res = await req('POST', '/api/auth/login', { body: { username, password } });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
  } finally {
    await cleanup({ userIds: [admin.id, created?.id].filter(Boolean) });
  }
});

// ── 11 & 12. Operational roles cannot access user management ──────────────────────────
test('11. Picker/Dispatcher cannot access user management', async () => {
  const user = await makeUser({ roles: ['picker_dispatcher'] });
  const token = tokenFor(user);
  try {
    const list = await req('GET', '/api/admin/users', { token });
    assert.equal(list.status, 403);
    const create = await req('POST', '/api/admin/users', { body: { username: 'x', password: 'a-long-enough-password' }, token });
    assert.equal(create.status, 403);
  } finally {
    await cleanup({ userIds: [user.id] });
  }
});

test('12. Receiving Clerk cannot access user management', async () => {
  const user = await makeUser({ roles: ['receiving_clerk'] });
  const token = tokenFor(user);
  try {
    const list = await req('GET', '/api/admin/users', { token });
    assert.equal(list.status, 403);
    const create = await req('POST', '/api/admin/users', { body: { username: 'x', password: 'a-long-enough-password' }, token });
    assert.equal(create.status, 403);
  } finally {
    await cleanup({ userIds: [user.id] });
  }
});

// ── Error-handling: duplicate username, invalid input ──────────────────────────────────
test('creating a user with an already-taken username is a clear 409', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const username = `um-${uniq()}`;
  let created;
  try {
    const first = await req('POST', '/api/admin/users', {
      body: { username, password: 'a-long-enough-password' }, token: tokenFor(admin),
    });
    assert.equal(first.status, 201);
    created = first.body;

    const second = await req('POST', '/api/admin/users', {
      body: { username, password: 'another-password-here' }, token: tokenFor(admin),
    });
    assert.equal(second.status, 409);
    assert.match(second.body.error, /already taken/);
  } finally {
    await cleanup({ userIds: [admin.id, created?.id].filter(Boolean) });
  }
});

test('creating a user with a short password is refused with a clear message', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  try {
    const res = await req('POST', '/api/admin/users', {
      body: { username: `um-${uniq()}`, password: 'short' }, token: tokenFor(admin),
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /at least 8 characters/);
  } finally {
    await cleanup({ userIds: [admin.id] });
  }
});

test('assigning an unknown role is a clear 400', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const target = await makeUser({ roles: [] });
  try {
    const res = await req('POST', `/api/admin/users/${target.id}/roles`, {
      body: { role: 'made_up_role' }, token: tokenFor(admin),
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /unknown role/);
  } finally {
    await cleanup({ userIds: [admin.id, target.id] });
  }
});
