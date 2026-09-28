// Phase 1 — permission-first authorization (permissions -> roles -> user_roles).
//
// Runs the real Express app over a real socket with a real JWT, so authMiddleware,
// requirePermission and the router all take part — the same pattern as
// routes.idempotency.test.js, extended to the routes this phase re-gated.

import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import pool, { query } from '../src/db.js';
import { AdminUsersService } from '../src/services/adminUsersService.js';
import { AuthzService } from '../src/services/authzService.js';
import {
  makeUser, makeFacility, makeCommodity, makeBatch, cleanup, txnId, scheme,
} from './helpers.js';

process.env.OUTBOX_WORKER = 'off';
process.env.PORT = '0';

const { default: app } = await import('../src/server.js');

let server;
let base;

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
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ── Gap closure: routes that were previously reachable by anyone logged in ────────────
test('a user with no roles at all is refused the four previously-unguarded actions', async () => {
  const user = await makeUser({ roles: [] });
  const facility = await makeFacility();
  const token = tokenFor(user);

  try {
    const fulfil = await req('POST', `/api/requests/999999/fulfil`, { body: {}, token });
    assert.equal(fulfil.status, 403, 'fulfil requires requests.fulfil');

    const reject = await req('POST', `/api/requests/999999/reject`, { body: {}, token });
    assert.equal(reject.status, 403, 'reject requires requests.fulfil');

    const receipt = await req('POST', `/api/requests/999999/receipt`, { body: { receivedBy: 'X' }, token });
    assert.equal(receipt.status, 403, 'receipt requires requests.receipt');

    const print = await req('POST', `/api/dispatch-orders/999999/print`, { body: {}, token });
    assert.equal(print.status, 403, 'print requires dispatchOrders.print');
  } finally {
    await cleanup({ facilityIds: [facility.id], userIds: [user.id] });
  }
});

// ── Role composition: Dispatch/Receiver ────────────────────────────────────────────────
// The role redesign merged Picker/Dispatcher and Receiving Clerk into one role that
// covers BOTH the pick/dispatch workflow and receiving/batch adjustment — so, unlike
// Phase 1, this role legitimately holds batches.create/adjust AND requests.fulfil AND
// dispatchOrders.print together. What it still doesn't hold is anything admin-tier:
// commodity/price management, facility management, or user administration.
test('Dispatch/Receiver can dispatch, receive and adjust stock, but not manage commodities, prices, facilities, or users', async () => {
  const user = await makeUser({ roles: ['dispatch_receiver'] });
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 500);
  const token = tokenFor(user);

  try {
    // Allowed: dispatch print is the cheapest thing to prove without a real order — the
    // route itself will 404/error on the missing order, but that is a DIFFERENT failure
    // than the 403 this test is checking for. Assert it is NOT a permission refusal.
    const print = await req('POST', `/api/dispatch-orders/999999/print`, { body: {}, token });
    assert.notEqual(print.status, 403, 'Dispatch/Receiver holds dispatchOrders.print');

    // Allowed: batches.create (receiving).
    const create = await req('POST', '/api/batches', {
      body: { commodityId: commodity.id, expiryDate: '2030-01-01', quantity: 50, clientTxnId: txnId('AUTHZ-DR-create') },
      token,
    });
    assert.equal(create.status, 201, 'Dispatch/Receiver holds batches.create');

    // Allowed: batches.adjust.
    const adjust = await req('POST', `/api/batches/${batch.id}/adjust`, {
      body: { quantity: -10, reason: 'damaged', clientTxnId: txnId('AUTHZ-DR-adjust') },
      token,
    });
    assert.equal(adjust.status, 200, 'Dispatch/Receiver holds batches.adjust');

    // Allowed: requests.fulfil (a 404 for the made-up id, not a 403).
    const fulfil = await req('POST', '/api/requests/999999/fulfil', { body: {}, token });
    assert.notEqual(fulfil.status, 403, 'Dispatch/Receiver holds requests.fulfil');

    // Disallowed: commodities.manage/setPrices and facilities.manage stay admin-only.
    const manageCommodity = await req('PUT', `/api/commodities/${commodity.id}`, { body: { name: 'Renamed' }, token });
    assert.equal(manageCommodity.status, 403, 'Dispatch/Receiver does not hold commodities.manage');

    const setPrice = await req('PUT', `/api/commodities/${commodity.id}/prices`, { body: { unitPrice: 5 }, token });
    assert.equal(setPrice.status, 403, 'Dispatch/Receiver does not hold commodities.setPrices');

    const manageFacility = await req('PUT', `/api/facilities/${facility.id}`, { body: { name: 'Renamed' }, token });
    assert.equal(manageFacility.status, 403, 'Dispatch/Receiver does not hold facilities.manage');

    // Disallowed: user administration.
    const createUser = await req('POST', '/api/admin/users', { body: { username: 'x', password: 'a-long-enough-password' }, token });
    assert.equal(createUser.status, 403, 'Dispatch/Receiver does not hold users.create');
  } finally {
    await cleanup({ facilityIds: [facility.id], commodityIds: [commodity.id], batchIds: [batch.id], userIds: [user.id] });
  }
});

// ── Role composition: System Administrator has no operational permissions ─────────────
test('System Administrator cannot adjust stock, edit dispatch, or manage facilities', async () => {
  const user = await makeUser({ roles: ['system_administrator'] });
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 100);
  const token = tokenFor(user);

  try {
    const adjust = await req('POST', `/api/batches/${batch.id}/adjust`, {
      body: { quantity: -5, reason: 'damaged', clientTxnId: txnId('AUTHZ-SA') }, token,
    });
    assert.equal(adjust.status, 403, 'System Administrator does not hold batches.adjust');

    const manage = await req('PUT', `/api/facilities/${facility.id}`, { body: { name: 'X' }, token });
    assert.equal(manage.status, 403, 'System Administrator does not hold facilities.manage');
  } finally {
    await cleanup({ facilityIds: [facility.id], commodityIds: [commodity.id], batchIds: [batch.id], userIds: [user.id] });
  }
});

// ── Admin cannot touch the permission architecture ──────────────────────────
test('Admin cannot assign System Administrator or Admin', async () => {
  const admin = await makeUser({ roles: ['admin'] });
  const target = await makeUser({ roles: [] });
  const token = tokenFor(admin);

  try {
    const grant = await req('POST', `/api/admin/users/${target.id}/roles`, {
      body: { role: 'admin' }, token,
    });
    assert.equal(grant.status, 403, 'Admin lacks roles.assignAny');

    // But CAN assign an operational role.
    const grantOperational = await req('POST', `/api/admin/users/${target.id}/roles`, {
      body: { role: 'dispatch_receiver' }, token,
    });
    assert.equal(grantOperational.status, 201, 'Admin holds roles.assignOperational');
  } finally {
    await cleanup({ userIds: [admin.id, target.id] });
  }
});

// ── Self-escalation is refused, even for System Administrator ─────────────────────────
test('a System Administrator cannot grant themselves a role', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  const token = tokenFor(admin);

  try {
    const grant = await req('POST', `/api/admin/users/${admin.id}/roles`, {
      body: { role: 'admin' }, token,
    });
    assert.equal(grant.status, 403, 'self-targeted role grant is refused unconditionally');
    assert.match(grant.body.error, /own roles/);
  } finally {
    await cleanup({ userIds: [admin.id] });
  }
});

// ── Migration: the two existing accounts keep exactly their old reach ─────────────────
test('cms.admin maps to Admin, not System Administrator', async () => {
  const { rows } = await query(
    `SELECT r.key FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
      WHERE u.username = 'cms.admin'`
  );
  const keys = rows.map((r) => r.key);
  // Only assert when the seed account exists in this database — some scratch test DBs
  // won't have it, and that's fine; this test documents the migration's intent, not a
  // fixture requirement.
  if (keys.length) {
    assert.ok(keys.includes('admin'), 'cms.admin holds Admin');
    assert.ok(!keys.includes('system_administrator'), 'cms.admin was NOT assumed to be System Administrator');
  }
});

test('cms.viewer maps to Dispatch/Receiver', async () => {
  const { rows } = await query(
    `SELECT r.key FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
      WHERE u.username = 'cms.viewer'`
  );
  const keys = rows.map((r) => r.key);
  if (keys.length) {
    assert.deepEqual(keys, ['dispatch_receiver']);
  }
});

// ── Offline emergency lockout ──────────────────────────────────────────────────────────
test('a locally-disabled user is refused regardless of their synced permissions', async () => {
  const admin = await makeUser({ roles: ['admin'] });
  const token = tokenFor(admin);

  try {
    await AdminUsersService.setLocalDisabled(admin.id, true, { actorUserId: admin.id });

    const anyRoute = await req('GET', '/api/auth/me', { token });
    assert.equal(anyRoute.status, 403, 'locally-disabled account is refused at the auth layer, before any permission check');
  } finally {
    await AdminUsersService.setLocalDisabled(admin.id, false, { actorUserId: admin.id });
    await cleanup({ userIds: [admin.id] });
  }
});

test('AuthzService.hasPermission returns false for a locally-disabled user even with a granted role', async () => {
  const user = await makeUser({ roles: ['admin'] });
  try {
    assert.ok(await AuthzService.hasPermission(user.id, 'batches.adjust'));
    await AdminUsersService.setLocalDisabled(user.id, true, { actorUserId: user.id });
    assert.equal(await AuthzService.hasPermission(user.id, 'batches.adjust'), false);
  } finally {
    await AdminUsersService.setLocalDisabled(user.id, false, { actorUserId: user.id });
    await cleanup({ userIds: [user.id] });
  }
});

// ── Audit logging ───────────────────────────────────────────────────────────────────────
test('creating a user and granting a role are both attributed in authz_audit_log', async () => {
  const admin = await makeUser({ roles: ['system_administrator'] });
  let created;
  try {
    created = await AdminUsersService.createUser({
      username: `authz-audit-${txnId()}`, password: 'a-long-enough-password', fullName: 'Audit Test',
      actorUserId: admin.id,
    });
    await AdminUsersService.grantRole(created.id, 'dispatch_receiver', { actorUserId: admin.id });

    const { rows } = await query(
      `SELECT action, actor_user_id, target_user_id FROM authz_audit_log
        WHERE target_user_id = $1 ORDER BY id`,
      [created.id]
    );
    assert.deepEqual(rows.map((r) => r.action), ['user.create', 'role.grant']);
    assert.ok(rows.every((r) => r.actor_user_id === admin.id), 'every row is attributed to the acting admin');
  } finally {
    await cleanup({ userIds: [admin.id, created?.id].filter(Boolean) });
  }
});

// ── /api/sync is permission-gated, and never exposes the Cloud<->CMS protocol ─────────
// Regression for the verification-audit finding: /api/sync was previously the same router
// as /sync (server-to-server, syncAuth), mounted a second time behind nothing but a plain
// login — reachable by a zero-permission user, and on Cloud including master-data.snapshot,
// which carries every user's password hash.
test('a user with no roles cannot read or trigger sync over /api/sync', async () => {
  const user = await makeUser({ roles: [] });
  const token = tokenFor(user);

  try {
    const status = await req('GET', '/api/sync/status', { token });
    assert.equal(status.status, 403, '/api/sync/status requires sync.view');

    const run = await req('POST', '/api/sync/run', { body: {}, token });
    assert.equal(run.status, 403, '/api/sync/run requires sync.forceRun');
  } finally {
    await cleanup({ userIds: [user.id] });
  }
});

test('the Cloud<->CMS sync protocol is not reachable under /api/sync at all', async () => {
  const user = await makeUser({ roles: ['system_administrator'] }); // holds sync.forceRun/sync.view
  const token = tokenFor(user);

  try {
    // Even the most privileged sync role cannot reach the server-to-server protocol routes
    // here — they simply are not mounted at /api/sync any more. A 404, not a permission
    // check, is the point: master-data.snapshot (password hashes) must not be behind ANY
    // user JWT, however privileged.
    const masterData = await req('GET', '/api/sync/master-data', { token });
    assert.equal(masterData.status, 404, '/api/sync/master-data does not exist; only /sync/master-data (syncAuth) does');

    const transactions = await req('POST', '/api/sync/transactions', { body: {}, token });
    assert.equal(transactions.status, 404);
  } finally {
    await cleanup({ userIds: [user.id] });
  }
});

// ── Idempotency of the sync replacement rule for user_roles ───────────────────────────
test('MasterDataService.apply replaces user_roles wholesale without duplicating grants', async () => {
  const { MasterDataService } = await import('../src/services/masterDataService.js');
  const user = await makeUser({ roles: [] });
  const { rows: roleRows } = await query("SELECT id FROM roles WHERE key = 'dispatch_receiver'");
  const roleId = roleRows[0].id;

  try {
    const snapshot = {
      version: 'test',
      generatedAt: new Date().toISOString(),
      counts: {},
      data: {
        commodities: [], commodity_prices: [], facilities: [], facility_commodities: [],
        schemes: [], vendors: [], users: [],
        user_roles: [{ id: 9_000_001, user_id: user.id, role_id: roleId, facility_scope_id: null,
                       granted_by: null, granted_at: new Date().toISOString() }],
      },
    };
    await MasterDataService.apply(snapshot);
    await MasterDataService.apply(snapshot); // replayed — must not duplicate or error

    const { rows } = await query('SELECT id FROM user_roles WHERE user_id = $1', [user.id]);
    assert.equal(rows.length, 1, 'exactly one grant survives a replayed identical snapshot');
  } finally {
    await query('DELETE FROM user_roles WHERE id = 9000001');
    await cleanup({ userIds: [user.id] });
  }
});
