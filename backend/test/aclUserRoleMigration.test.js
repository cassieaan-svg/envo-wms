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

// Phase 2D migrated these six. Phase 2M/2M.1 added two more that a user can hold:
// system_admin (national, unscoped, user administration only) and essential_admin
// (a different module). Both are listed here because this file's job is "every
// user_roles row names a real, approved role" — not "only the original six exist",
// which aclSeed.test.js asserts separately.
const APPROVED_ROLES = ['facility', 'state_admin', 'state_viewer', 'cluster_admin', 'lga_admin', 'overall_admin',
                        'system_admin', 'essential_admin']

// The roles whose scope is deliberately EMPTY, meaning national/unconstrained.
// An empty scope on any other role would be a silent widening — that is the
// invariant, and it is why this list is explicit rather than inferred.
const UNSCOPED_ROLES = ['overall_admin', 'system_admin']

// aclFoundation.test.js shares this same `users` table and runs CONCURRENTLY —
// `node --test` runs test FILES in parallel. It creates throwaway users under
// '@acl-schema-test.invalid' with NO access_level set, cleaned up in
// finally/test.after but transiently present mid-run. Such a user is
// indistinguishable from a genuine "missing access_level" legacy account to a
// query that doesn't know about it — it was simply never migrated because it
// didn't exist when this migration ran. Every query below that scans the whole
// `users` table therefore excludes that email domain, the same fix as the
// earlier aclSeed.test.js cross-file race.
//
// Broadened from that one domain to the whole '.invalid' TLD: aclProvisioning
// and aclUserRoleScopes create fixtures under their own '.invalid' domains, and
// a provisioning fixture briefly holds a user_roles row whose scope has not yet
// caught up with the metadata it is being re-synced against. '.invalid' is
// reserved by RFC 2606 and can never be a real account, so excluding all of it
// cannot hide a genuine defect.
const NOT_FIXTURE_USER = `u.email not like '%.invalid' and u.email not like 'probe.create.%'`

// Accounts whose access_level implies a facility scope but which carry no
// facility_id are deliberately excluded from the ACL entirely
// (20260904_acl_exclude_scopeless_accounts.sql). They can authenticate but hold
// no role, so reconciliation must not count them as "should have been migrated".
// Only facility-shaped roles are affected: state/cluster/LGA roles scope on
// their own admin_* field, and overall_admin is intentionally unscoped.
const HAS_RESOLVABLE_SCOPE = `
  (coalesce(u.raw_user_meta_data->>'access_level', 'facility') <> 'facility'
   or coalesce(u.raw_user_meta_data->>'facility_id', '') <> '')`

// Phase 2D was a POINT-IN-TIME backfill. Reconciliation can only hold for users
// that existed when it ran — a user created afterward has no role, because
// nothing assigns one (see the KNOWN GAP test at the end of this file). The
// backfill moment is derivable from the data itself rather than hardcoded: every
// row the migration inserted carries the same created_at default.
const EXISTED_AT_BACKFILL = `
  u.created_at <= (select min(created_at) from user_roles)`

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
  const { rows } = await query(`
    select count(*)::int n from (
      select ur.user_id from user_roles ur
        join users u on u.id = ur.user_id
       where ${NOT_FIXTURE_USER}
       group by 1 having count(*) <> 1) x`)
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
       and ${HAS_RESOLVABLE_SCOPE}
       and ${EXISTED_AT_BACKFILL}
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
      where raw_user_meta_data->>'access_level' is null
        and ${NOT_FIXTURE_USER} and ${HAS_RESOLVABLE_SCOPE}`)
  assert.equal(rows[0].n, total[0].n,
    'every missing-access_level legacy user WITH a facility must be role=facility')
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. Unknown access_level (hq_tools) is excluded, not silently mapped
// ═════════════════════════════════════════════════════════════════════════════

test('an unrecognized access_level (hq_tools) receives NO role assignment', async () => {
  // ONE query, not two. Counting "has no role" and "total" separately leaves a
  // window in which a concurrent suite changes the population between them, and
  // the assertion then reports that timing rather than the rule.
  const { rows } = await query(`
    select count(*)::int n from users u
     where u.raw_user_meta_data->>'access_level' = 'hq_tools'
       and exists (select 1 from user_roles ur where ur.user_id = u.id)`)
  assert.equal(rows[0].n, 0, 'no hq_tools account may hold a role')
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
       and ur.scope_id <> coalesce(u.raw_user_meta_data->>'facility_id', '')
       and ${NOT_FIXTURE_USER}`)
  assert.equal(rows[0].mismatches, 0)
})

test('state_admin/state_viewer: scope_type=state, scope_id=raw_user_meta_data.admin_state verbatim', async () => {
  const { rows } = await query(`
    select count(*)::int mismatches from user_roles ur
      join roles r on r.id = ur.role_id
      join users u on u.id = ur.user_id
     where r.name in ('state_admin','state_viewer')
       and (ur.scope_type <> 'state'
            or ur.scope_id <> coalesce(u.raw_user_meta_data->>'admin_state', ''))
       and ${NOT_FIXTURE_USER}`)
  assert.equal(rows[0].mismatches, 0)
})

test('cluster_admin: scope_type=cluster, scope_id=raw_user_meta_data.admin_cluster verbatim', async () => {
  const { rows } = await query(`
    select count(*)::int mismatches from user_roles ur
      join roles r on r.id = ur.role_id
      join users u on u.id = ur.user_id
     where r.name = 'cluster_admin'
       and (ur.scope_type <> 'cluster'
            or ur.scope_id <> coalesce(u.raw_user_meta_data->>'admin_cluster', ''))
       and ${NOT_FIXTURE_USER}`)
  assert.equal(rows[0].mismatches, 0)
})

test('lga_admin: scope_type=lga, scope_id=raw_user_meta_data.admin_lga verbatim', async () => {
  const { rows } = await query(`
    select count(*)::int mismatches from user_roles ur
      join roles r on r.id = ur.role_id
      join users u on u.id = ur.user_id
     where r.name = 'lga_admin'
       and (ur.scope_type <> 'lga'
            or ur.scope_id <> coalesce(u.raw_user_meta_data->>'admin_lga', ''))
       and ${NOT_FIXTURE_USER}`)
  assert.equal(rows[0].mismatches, 0)
})

test('the national roles are unscoped for every one — never national-by-accident elsewhere', async () => {
  const { rows } = await query(`
    select count(*)::int n from user_roles ur join roles r on r.id=ur.role_id
     where r.name = any($1) and (ur.scope_type <> '' or ur.scope_id <> '')`, [UNSCOPED_ROLES])
  assert.equal(rows[0].n, 0, 'overall_admin matches attachScope never narrowing it; system_admin is national by design')

  // The inverse check matters just as much: no OTHER role may carry an empty
  // scope_type — that would silently mean "unconstrained" for a role attachScope
  // always narrows, which would be a real widening of access.
  const { rows: leaked } = await query(`
    select r.name, count(*)::int n from user_roles ur
      join roles r on r.id = ur.role_id
      join users u on u.id = ur.user_id
     where r.name <> all($1) and ur.scope_type = ''
       and ${NOT_FIXTURE_USER}
     group by 1`, [UNSCOPED_ROLES])
  assert.deepEqual(leaked, [], 'only the national roles may have an empty scope_type')
})

// ═════════════════════════════════════════════════════════════════════════════
// 6. Security requirement: nothing was broadened. A missing scope value stays
//    the most restrictive possible representation, never a wildcard.
// ═════════════════════════════════════════════════════════════════════════════

test('a facility user with no facility_id is EXCLUDED from the ACL entirely', async () => {
  // Phase 2D originally migrated such a user with scope_id='' — the most
  // restrictive value, granting nothing. 20260904_acl_exclude_scopeless_accounts
  // then removed that row: a role assignment that can never authorise anything is
  // audit noise, and an empty scope is the shape a future bug could misread as
  // "unscoped therefore unrestricted". The invariant is now stronger — every
  // user_roles row names a scope that identifies something real.
  const { rows } = await query(`
    select ur.scope_id from user_roles ur
      join roles r on r.id = ur.role_id
      join users u on u.id = ur.user_id
     where r.name = 'facility'
       and (u.raw_user_meta_data->>'facility_id' is null or u.raw_user_meta_data->>'facility_id' = '')
       and ${NOT_FIXTURE_USER}`)
  assert.deepEqual(rows, [], 'a facility account with no facility_id must hold no ACL role at all')
})

test('no role outside the national ones carries an empty scope', async () => {
  // The invariant the exclusion establishes. An empty scope means "national", so
  // only roles that ARE national may carry one — overall_admin (Phase 2D) and
  // system_admin (Phase 2M.1). On any other role an empty scope is a widening
  // waiting to be misread as "unconstrained".
  const { rows } = await query(`
    select r.name, count(*)::int n from user_roles ur
      join roles r on r.id = ur.role_id
      join users u on u.id = ur.user_id
     where ur.scope_id = '' and r.name <> all($1)
       and ${NOT_FIXTURE_USER}
     group by 1`, [UNSCOPED_ROLES])
  assert.deepEqual(rows, [])
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
       and ${NOT_FIXTURE_USER}
       and coalesce(u.raw_user_meta_data->>'access_level','') = ''`)
  assert.equal(rows[0].n, 0,
    'every non-facility role must still trace back to an explicit access_level value in raw_user_meta_data')
})

test('user_permissions remains completely empty — this phase seeds no direct grants', async () => {
  // aclFoundation.test.js inserts and deletes a direct grant to prove the table
  // works, and runs concurrently — so this counts real accounts only.
  const { rows } = await query(
    `select count(*)::int n from user_permissions up
       join users u on u.id = up.user_id
      where ${NOT_FIXTURE_USER}`)
  assert.equal(rows[0].n, 0)
})

// ═════════════════════════════════════════════════════════════════════════════
// 8. KNOWN GAP — users created AFTER the backfill hold no ACL role
//
// Phase 2D was a one-shot migration. No provisioning script (addFacility.mjs,
// addDsdAccount.mjs, createClusterStores.mjs, create_state_offices.mjs, …)
// writes a user_roles row, and no runtime code creates one either. So every
// account created after the backfill has no ACL identity at all.
//
// Harmless today — nothing reads user_roles. At cutover it would deny those
// users everything. Asserted here so the gap stays visible and cannot be
// silently "fixed" by a migration re-run that hides the underlying cause:
// provisioning must assign roles, or the backfill must become repeatable.
// ═════════════════════════════════════════════════════════════════════════════

test('KNOWN GAP: accounts created after the backfill have no ACL role', async () => {
  const { rows } = await query(`
    select count(*)::int n from users u
     where u.created_at > (select min(created_at) from user_roles)
       and u.email not like '%@acl-schema-test.invalid'
       and not exists (select 1 from user_roles ur where ur.user_id = u.id)`)
  // Not asserting a specific count — it grows with every account provisioned.
  // The assertion is that this query is the RIGHT way to measure the gap, and
  // that it is reported rather than hidden.
  assert.ok(rows[0].n >= 0)
  if (rows[0].n > 0) {
    console.warn(`\n[known gap] ${rows[0].n} account(s) created since the Phase 2D backfill hold no ACL role. ` +
      `Provisioning does not assign roles; this must be closed before cutover.\n`)
  }
})
