// Data tests for the Phase 2D migration: existing users -> user_roles.
//
// These assert the MIGRATED DATA reconciles exactly against the legacy
// raw_user_meta_data.access_level distribution — not authorization behavior,
// since nothing reads user_roles yet (scope.js is untouched; verified by
// git diff --stat being empty on every tracked file, same as Phase 2B/2C).
//
// INTEGRATION test: requires 20260903_acl_foundation.sql,
// 20260903_acl_seed_roles_permissions.sql, and
// 20260903_acl_seed_user_roles.sql all applied to the local `envo` database.
// Fails loudly rather than skipping — see stockSummary.test.js for the house
// convention.
//
// Read-only: this suite never inserts, updates, or deletes anything. The real
// user_roles table, seeded once by the migration, is the thing under test.
//
//   npm test --prefix backend

import test from 'node:test'
import assert from 'node:assert/strict'
import { query, pool } from '../src/db.js'

test.after(async () => { await pool.end() })

const APPROVED_ROLES = ['facility', 'state_admin', 'state_viewer', 'cluster_admin', 'lga_admin', 'overall_admin']

// aclFoundation.test.js shares this same `users` table and runs CONCURRENTLY —
// `node --test` runs test FILES in parallel. It creates throwaway users under
// '@acl-schema-test.invalid' with NO access_level set, cleaned up in
// finally/test.after but transiently present mid-run. Such a user is
// indistinguishable from a genuine "missing access_level" legacy account to a
// query that doesn't know about it — it was simply never migrated because it
// didn't exist when this migration ran. Every query below that scans the whole
// `users` table therefore excludes that email domain, the same fix as the
// earlier aclSeed.test.js cross-file race.
const NOT_FIXTURE_USER = `u.email not like '%@acl-schema-test.invalid'`

// ═════════════════════════════════════════════════════════════════════════════
// 1. Every user_roles row references a real user and one of the 6 approved roles
// ═════════════════════════════════════════════════════════════════════════════

test('no orphan user_roles.user_id', async () => {
  const { rows } = await query(
    `select count(*)::int n from user_roles ur left join users u on u.id = ur.user_id where u.id is null`)
  assert.equal(rows[0].n, 0)
})

test('no orphan user_roles.role_id, and every role_id is one of the 6 approved', async () => {
  const { rows } = await query(
    `select r.name from user_roles ur left join roles r on r.id = ur.role_id`)
  assert.ok(rows.every(r => r.name !== null), 'every role_id resolves to a real role')
  const names = new Set(rows.map(r => r.name))
  for (const n of names) assert.ok(APPROVED_ROLES.includes(n), `unexpected role name in user_roles: ${n}`)
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. No duplicates; exactly one role per user
// ═════════════════════════════════════════════════════════════════════════════

test('no duplicate (user_id, role_id, scope_type, scope_id)', async () => {
  const { rows } = await query(
    `select user_id, role_id, scope_type, scope_id, count(*) c
       from user_roles group by 1,2,3,4 having count(*) > 1`)
  assert.deepEqual(rows, [], 'the primary key already forbids this — this is a belt-and-braces check')
})

test('every migrated user has EXACTLY one role assignment', async () => {
  const { rows } = await query(
    `select count(*)::int n from (select user_id from user_roles group by 1 having count(*) <> 1) x`)
  assert.equal(rows[0].n, 0)
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. Access-level reconciliation — the exact table the task required
// ═════════════════════════════════════════════════════════════════════════════

test('reconciliation: every approved access_level maps 1:1 to user_roles', async () => {
  const { rows } = await query(`
    select coalesce(u.raw_user_meta_data->>'access_level', '(missing)') access_level,
           count(distinct u.id)::int legacy_users,
           count(distinct ur.user_id)::int migrated
      from users u
      left join user_roles ur on ur.user_id = u.id
     where ${NOT_FIXTURE_USER}
       and (coalesce(u.raw_user_meta_data->>'access_level', 'facility') in
           ('facility','state_admin','state_viewer','cluster_admin','lga_admin','overall_admin')
        or u.raw_user_meta_data->>'access_level' is null)
     group by 1`)
  for (const r of rows) {
    assert.equal(r.migrated, r.legacy_users,
      `${r.access_level}: ${r.legacy_users} legacy users but only ${r.migrated} migrated`)
  }
  assert.ok(rows.length >= 6, 'at least the 6 approved buckets are represented')
})

test('a user with missing access_level is migrated as facility — matching attachScope\'s own default', async () => {
  const { rows } = await query(`
    select count(*)::int n from users u
      join user_roles ur on ur.user_id = u.id
      join roles r on r.id = ur.role_id
     where u.raw_user_meta_data->>'access_level' is null
       and ${NOT_FIXTURE_USER}
       and r.name = 'facility'`)
  const { rows: total } = await query(
    `select count(*)::int n from users u
      where raw_user_meta_data->>'access_level' is null and ${NOT_FIXTURE_USER}`)
  assert.equal(rows[0].n, total[0].n, 'every missing-access_level legacy user must be role=facility')
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. Unknown access_level (hq_tools) is excluded, not silently mapped
// ═════════════════════════════════════════════════════════════════════════════

test('an unrecognized access_level (hq_tools) receives NO role assignment', async () => {
  const { rows } = await query(`
    select u.id from users u
     where u.raw_user_meta_data->>'access_level' = 'hq_tools'
       and not exists (select 1 from user_roles ur where ur.user_id = u.id)`)
  const { rows: total } = await query(
    `select count(*)::int n from users where raw_user_meta_data->>'access_level' = 'hq_tools'`)
  // Every hq_tools user (if any exist in this database) must appear in the
  // "has no role" list — none may have slipped through with a role.
  assert.equal(rows.length, total[0].n)
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. Scope mapping matches exactly what attachScope() itself reads
// ═════════════════════════════════════════════════════════════════════════════

test('facility role: scope_type=facility, scope_id=raw_user_meta_data.facility_id verbatim', async () => {
  const { rows } = await query(`
    select count(*)::int mismatches from user_roles ur
      join roles r on r.id = ur.role_id
      join users u on u.id = ur.user_id
     where r.name = 'facility'
       and ur.scope_type = 'facility'
       and ur.scope_id <> coalesce(u.raw_user_meta_data->>'facility_id', '')`)
  assert.equal(rows[0].mismatches, 0)
})

test('state_admin/state_viewer: scope_type=state, scope_id=raw_user_meta_data.admin_state verbatim', async () => {
  const { rows } = await query(`
    select count(*)::int mismatches from user_roles ur
      join roles r on r.id = ur.role_id
      join users u on u.id = ur.user_id
     where r.name in ('state_admin','state_viewer')
       and (ur.scope_type <> 'state'
            or ur.scope_id <> coalesce(u.raw_user_meta_data->>'admin_state', ''))`)
  assert.equal(rows[0].mismatches, 0)
})

test('cluster_admin: scope_type=cluster, scope_id=raw_user_meta_data.admin_cluster verbatim', async () => {
  const { rows } = await query(`
    select count(*)::int mismatches from user_roles ur
      join roles r on r.id = ur.role_id
      join users u on u.id = ur.user_id
     where r.name = 'cluster_admin'
       and (ur.scope_type <> 'cluster'
            or ur.scope_id <> coalesce(u.raw_user_meta_data->>'admin_cluster', ''))`)
  assert.equal(rows[0].mismatches, 0)
})

test('lga_admin: scope_type=lga, scope_id=raw_user_meta_data.admin_lga verbatim', async () => {
  const { rows } = await query(`
    select count(*)::int mismatches from user_roles ur
      join roles r on r.id = ur.role_id
      join users u on u.id = ur.user_id
     where r.name = 'lga_admin'
       and (ur.scope_type <> 'lga'
            or ur.scope_id <> coalesce(u.raw_user_meta_data->>'admin_lga', ''))`)
  assert.equal(rows[0].mismatches, 0)
})

test('overall_admin: unscoped (empty scope_type/scope_id) for every one — never national-by-accident elsewhere', async () => {
  const { rows } = await query(`
    select count(*)::int n from user_roles ur join roles r on r.id=ur.role_id
     where r.name = 'overall_admin' and (ur.scope_type <> '' or ur.scope_id <> '')`)
  assert.equal(rows[0].n, 0, 'overall_admin rows must all be unscoped, matching attachScope never narrowing it')

  // The inverse check matters just as much: no OTHER role may carry an empty
  // scope_type — that would silently mean "unconstrained" for a role attachScope
  // always narrows, which would be a real widening of access.
  const { rows: leaked } = await query(`
    select r.name, count(*)::int n from user_roles ur join roles r on r.id=ur.role_id
     where r.name <> 'overall_admin' and ur.scope_type = ''
     group by 1`)
  assert.deepEqual(leaked, [], 'only overall_admin may have an empty scope_type')
})

// ═════════════════════════════════════════════════════════════════════════════
// 6. Security requirement: nothing was broadened. A missing scope value stays
//    the most restrictive possible representation, never a wildcard.
// ═════════════════════════════════════════════════════════════════════════════

test('a facility user with no facility_id gets an EMPTY scope_id, not a null/wildcard', async () => {
  const { rows } = await query(`
    select ur.scope_id from user_roles ur
      join roles r on r.id = ur.role_id
      join users u on u.id = ur.user_id
     where r.name = 'facility'
       and (u.raw_user_meta_data->>'facility_id' is null or u.raw_user_meta_data->>'facility_id' = '')`)
  assert.ok(rows.length >= 1, 'the known no-facility_id facility user must be present')
  assert.ok(rows.every(r => r.scope_id === ''), 'must be empty string, never null and never a real facility id')
})

// ═════════════════════════════════════════════════════════════════════════════
// 7. Legacy representation is untouched — this was a parallel copy, not a cutover
// ═════════════════════════════════════════════════════════════════════════════

test('users.raw_user_meta_data still carries access_level for every migrated user', async () => {
  // Confirms the migration did not rewrite or strip the legacy field it read.
  const { rows } = await query(`
    select count(*)::int n from user_roles ur
      join users u on u.id = ur.user_id
      join roles r on r.id = ur.role_id
     where r.name <> 'facility'
       and coalesce(u.raw_user_meta_data->>'access_level','') = ''`)
  assert.equal(rows[0].n, 0,
    'every non-facility role must still trace back to an explicit access_level value in raw_user_meta_data')
})

test('user_permissions remains completely empty — this phase seeds no direct grants', async () => {
  const { rows } = await query('select count(*)::int n from user_permissions')
  assert.equal(rows[0].n, 0)
})
