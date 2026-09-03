// Data tests for the Phase 2C ACL seed: the approved 24 permissions, 6 system
// roles, and their role_permissions mappings.
//
// These assert the SEEDED DATA matches docs/authorization/permission-catalogue.md
// exactly — not authorization behavior, because nothing reads these tables yet.
// user_roles and user_permissions must stay empty: this phase seeds definitions
// and role→permission mappings only, never a user assignment.
//
// INTEGRATION test: requires 20260903_acl_foundation.sql AND
// 20260903_acl_seed_roles_permissions.sql applied to the local `envo` database.
// Fails loudly rather than skipping — see stockSummary.test.js for the house
// convention.
//
//   npm test --prefix backend

import test from 'node:test'
import assert from 'node:assert/strict'
import { query, pool } from '../src/db.js'

test.after(async () => { await pool.end() })

// aclFoundation.test.js shares these same tables and runs CONCURRENTLY —
// `node --test` runs test FILES in parallel. Its fixtures are prefixed
// 'aclschematest.' (permissions) / 'aclschematest_' (roles), cleaned up in
// `finally`/`test.after`, but can transiently coexist with whatever this file
// checks mid-run. Every query below that could observe the whole table therefore
// excludes that prefix explicitly, rather than asserting a raw table-wide COUNT(*)
// — the same fix as the earlier sweepFixtures.js cross-file race.
const NOT_FIXTURE_PERMISSION = `key not like 'aclschematest.%'`               // permissions.key
const NOT_FIXTURE_ROLE = `name not like 'aclschematest_%'`                     // roles.name
const NOT_FIXTURE_RP = `permission_key not like 'aclschematest.%'`             // role_permissions.permission_key

const APPROVED_KEYS = [
  'stock.read', 'stock.write',
  'dsd_stock.read', 'dsd_stock.write',
  'sdp_stock.read', 'sdp_stock.write',
  'transfer.read', 'transfer.write',
  'dispense_log.read', 'dispense_log.write',
  'intake_log.read', 'intake_log.write',
  'adjustment_log.read', 'adjustment_log.write',
  'amc_settings.read', 'amc_settings.write',
  'edit_history.read', 'edit_history.write',
  'commodity.read',
  'facility.read',
  'report.read', 'activity.read', 'bincard.read',
  'system.diagnostics.read',
].sort()

const APPROVED_ROLES = ['facility', 'state_admin', 'state_viewer', 'cluster_admin', 'lga_admin', 'overall_admin'].sort()

// ═════════════════════════════════════════════════════════════════════════════
// 1. Exactly the approved 24 permissions — no more, no fewer
// ═════════════════════════════════════════════════════════════════════════════

test('exactly the 24 approved permission keys exist', async () => {
  const { rows } = await query(`select key from permissions where ${NOT_FIXTURE_PERMISSION} order by key`)
  assert.deepEqual(rows.map(r => r.key), APPROVED_KEYS)
})

test('no unapproved key sneaked in — specifically not the excluded ones', async () => {
  const { rows } = await query(
    `select key from permissions where key = any($1)`,
    [['stock_lot.read', 'stock_lot.write', 'commodity.write', 'facility.write',
      'stock.create', 'stock.update', 'stock.delete',
      'transfer.accept', 'transfer.authorize', 'transfer.dispatch']])
  assert.deepEqual(rows, [], 'none of these were ever approved for seeding')
})

test('every SEEDED permission is active by default', async () => {
  const { rows } = await query(
    `select count(*)::int n from permissions where key = any($1) and is_active = false`,
    [APPROVED_KEYS])
  assert.equal(rows[0].n, 0)
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. Exactly the approved 6 roles, all system roles
// ═════════════════════════════════════════════════════════════════════════════

test('exactly the 6 approved role names exist, all is_system = true', async () => {
  const { rows } = await query(`select name, is_system from roles where ${NOT_FIXTURE_ROLE} order by name`)
  assert.deepEqual(rows.map(r => r.name), APPROVED_ROLES)
  assert.ok(rows.every(r => r.is_system === true), 'every seeded role must be a system role')
})

test('no unapproved role sneaked in — specifically not hq_tools or facility_role', async () => {
  const { rows } = await query(
    `select name from roles where name = any($1)`,
    [['hq_tools', 'facility_role', 'dispenser', 'store_manager', 'sdp', 'dsd', 'admin', 'super_admin']])
  assert.deepEqual(rows, [], 'facility_role values are frontend-only and were never approved as roles')
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. role_permissions — the exact matrix, not just a row count
// ═════════════════════════════════════════════════════════════════════════════

async function permsFor(role) {
  const { rows } = await query(
    `select rp.permission_key from role_permissions rp
       join roles r on r.id = rp.role_id
      where r.name = $1 order by rp.permission_key`, [role])
  return rows.map(r => r.permission_key)
}

test('total mapping count is 107', async () => {
  const { rows } = await query(
    `select count(*)::int n from role_permissions where ${NOT_FIXTURE_RP}`)
  assert.equal(rows[0].n, 107)
})

test('facility holds every permission except system.diagnostics.read (23)', async () => {
  const perms = await permsFor('facility')
  assert.equal(perms.length, 23)
  assert.deepEqual(perms, APPROVED_KEYS.filter(k => k !== 'system.diagnostics.read'))
})

test('state_admin holds all 24 — the full read+write set, plus diagnostics', async () => {
  const perms = await permsFor('state_admin')
  assert.deepEqual(perms, APPROVED_KEYS)
})

test('the four read-only admin tiers hold the identical 15-key set', async () => {
  // Every key ending .read — including system.diagnostics.read, which is itself
  // .read-suffixed, so this is 14 resource reads + 1 diagnostics read = 15.
  const expected = APPROVED_KEYS.filter(k => k.endsWith('.read')).sort()
  assert.equal(expected.length, 15)
  for (const role of ['state_viewer', 'cluster_admin', 'lga_admin', 'overall_admin']) {
    const perms = await permsFor(role)
    assert.deepEqual(perms, expected, `${role} must hold exactly the 15 read keys`)
  }
})

test('no read-only role holds any *.write permission', async () => {
  for (const role of ['state_viewer', 'cluster_admin', 'lga_admin', 'overall_admin']) {
    const perms = await permsFor(role)
    assert.ok(perms.every(k => !k.endsWith('.write')), `${role} must hold zero write permissions`)
  }
})

test('overall_admin specifically holds zero writes — the deliberate design decision', async () => {
  // Singled out because the catalogue explicitly warns this is the one a naive
  // seed could get wrong: "grants the admin role every permission
  // indiscriminately would silently break this."
  const perms = await permsFor('overall_admin')
  assert.equal(perms.filter(k => k.endsWith('.write')).length, 0)
  assert.equal(perms.length, 15)
})

test('every SEEDED role holds only permissions that exist in the approved 24', async () => {
  const { rows } = await query(
    `select distinct rp.permission_key from role_permissions rp
       join roles r on r.id = rp.role_id
      where ${NOT_FIXTURE_ROLE.replace('name', 'r.name')}
        and rp.permission_key <> all($1)`, [APPROVED_KEYS])
  assert.deepEqual(rows, [], 'no seeded role maps to a permission outside the approved catalogue')
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. This is a mapping seed, not a user migration
// ═════════════════════════════════════════════════════════════════════════════

test('user_roles and user_permissions remain completely empty', async () => {
  const { rows: ur } = await query('select count(*)::int n from user_roles')
  const { rows: up } = await query('select count(*)::int n from user_permissions')
  assert.equal(ur[0].n, 0, 'no user was assigned a role in this phase')
  assert.equal(up[0].n, 0, 'no user was granted or denied a direct permission in this phase')
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. Idempotency — re-applying the seed must be a no-op, not a duplicate/error
// ═════════════════════════════════════════════════════════════════════════════

test('re-inserting an already-seeded permission/role/mapping is a silent no-op', async () => {
  // Mirrors exactly what re-running the migration file does (its own
  // `on conflict do nothing` clauses) — proving the migration is safe to re-apply.
  await query(`insert into permissions (key, module) values ('stock.read','stock')
               on conflict (key) do nothing`)
  await query(`insert into roles (name, is_system) values ('facility', true)
               on conflict (name) do nothing`)
  const facilityId = (await query(`select id from roles where name='facility'`)).rows[0].id
  await query(`insert into role_permissions (role_id, permission_key) values ($1,'stock.read')
               on conflict (role_id, permission_key) do nothing`, [facilityId])

  const { rows: p } = await query(`select count(*)::int n from permissions where ${NOT_FIXTURE_PERMISSION}`)
  const { rows: r } = await query(`select count(*)::int n from roles where ${NOT_FIXTURE_ROLE}`)
  const { rows: rp } = await query(`select count(*)::int n from role_permissions where ${NOT_FIXTURE_RP}`)
  assert.equal(p[0].n, 24, 'permission count unchanged after re-insert')
  assert.equal(r[0].n, 6, 'role count unchanged after re-insert')
  assert.equal(rp[0].n, 107, 'mapping count unchanged after re-insert')
})
