// Phase 2E — unit tests for the shadow-mode ACL resolver (src/services/aclResolver.js).
//
// These test the RESOLVER IN ISOLATION against the real seeded roles/permissions
// and real migrated users. Nothing here calls a route or touches HTTP — the
// resolver is not wired into the request path at all (see aclResolver.js header).
// Comparison against the LEGACY decision lives in aclShadowComparison.test.js.
//
// TEST ISOLATION (Step 19): role-based checks below only ever READ real users —
// they never modify a real user's role assignment. Only the "user override"
// section creates data, and it does so under an isolated fixture user/permission,
// cleaned up in `finally`. No real user_roles row is ever touched.
//
// INTEGRATION test: requires the full ACL stack applied (Phase 2B/2C/2D
// migrations). Fails loudly rather than skipping — house convention.
//
//   npm test --prefix backend

import test from 'node:test'
import assert from 'node:assert/strict'
import { query, pool } from '../src/db.js'
import { AclResolver } from '../src/services/aclResolver.js'

const ALL_24 = [
  'stock.read', 'stock.write', 'dsd_stock.read', 'dsd_stock.write',
  'sdp_stock.read', 'sdp_stock.write', 'transfer.read', 'transfer.write',
  'dispense_log.read', 'dispense_log.write', 'intake_log.read', 'intake_log.write',
  'adjustment_log.read', 'adjustment_log.write', 'amc_settings.read', 'amc_settings.write',
  'edit_history.read', 'edit_history.write', 'commodity.read', 'facility.read',
  'report.read', 'activity.read', 'bincard.read', 'system.diagnostics.read',
]
const WRITE_KEYS = ALL_24.filter(k => k.endsWith('.write'))
const READ_ONLY_KEYS = ALL_24.filter(k => !k.endsWith('.write'))

// A real, currently-migrated user for a given role, excluding the sibling
// suites' known fixture email domain. Read-only — never modified.
async function aRealUserWithRole(roleName) {
  const { rows } = await query(
    `select u.id, ur.scope_type, ur.scope_id
       from user_roles ur
       join roles r on r.id = ur.role_id
       join users u on u.id = ur.user_id
      where r.name = $1 and u.email not like '%.invalid' and u.email not like 'probe.create.%'
        and ur.scope_id <> ''
      limit 1`,
    [roleName])
  if (!rows.length) throw new Error(`no real user with role ${roleName} and non-empty scope found`)
  return rows[0]
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Role permission — each role resolves exactly its assigned permission set
// ═════════════════════════════════════════════════════════════════════════════

test('facility role holds exactly its approved 23 permissions (permission layer only)', async () => {
  const u = await aRealUserWithRole('facility')
  for (const key of ALL_24) {
    const held = await AclResolver.roleHasPermission('facility', key)
    if (key === 'system.diagnostics.read') assert.equal(held, false, key)
    else assert.equal(held, true, key)
  }
})

test('state_admin holds all 24 approved permissions', async () => {
  for (const key of ALL_24) {
    assert.equal(await AclResolver.roleHasPermission('state_admin', key), true, key)
  }
})

test('the four read-only admin tiers hold exactly the 15 *.read permissions', async () => {
  for (const role of ['state_viewer', 'cluster_admin', 'lga_admin', 'overall_admin']) {
    for (const key of READ_ONLY_KEYS) {
      assert.equal(await AclResolver.roleHasPermission(role, key), true, `${role}/${key}`)
    }
    for (const key of WRITE_KEYS) {
      assert.equal(await AclResolver.roleHasPermission(role, key), false, `${role}/${key} must NOT resolve`)
    }
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. Read/write boundaries (explicit, per Step 16)
// ═════════════════════════════════════════════════════════════════════════════

test('state_viewer/cluster_admin/lga_admin/overall_admin cannot resolve ANY write permission', async () => {
  for (const role of ['state_viewer', 'cluster_admin', 'lga_admin', 'overall_admin']) {
    for (const key of WRITE_KEYS) {
      assert.equal(await AclResolver.roleHasPermission(role, key), false, `${role} must not hold ${key}`)
    }
  }
})

test('overall_admin specifically: 15 reads, 0 writes — the deliberate design decision (Step 8)', async () => {
  const reads = await Promise.all(READ_ONLY_KEYS.map(k => AclResolver.roleHasPermission('overall_admin', k)))
  const writes = await Promise.all(WRITE_KEYS.map(k => AclResolver.roleHasPermission('overall_admin', k)))
  assert.equal(reads.filter(Boolean).length, 15)
  assert.equal(writes.filter(Boolean).length, 0)
})

test('system.diagnostics.read does not resolve for ordinary facility users (Step 7)', async () => {
  assert.equal(await AclResolver.roleHasPermission('facility', 'system.diagnostics.read'), false)
  for (const role of ['state_admin', 'state_viewer', 'cluster_admin', 'lga_admin', 'overall_admin']) {
    assert.equal(await AclResolver.roleHasPermission(role, 'system.diagnostics.read'), true, role)
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. Scope — correct scope grants, wrong scope for a held permission denies
// ═════════════════════════════════════════════════════════════════════════════

test('facility scope: a real facility user\'s own facility is covered; another facility is not', async () => {
  const u = await aRealUserWithRole('facility')
  const { rows: other } = await query(`select id from facilities where id <> $1 limit 1`, [u.scope_id])
  const res = await AclResolver.can(u.id, 'stock.read', { facilityId: u.scope_id })
  assert.equal(res.decision, true, 'own facility must be covered')
  const denied = await AclResolver.can(u.id, 'stock.read', { facilityId: other[0].id })
  assert.equal(denied.decision, false, 'another facility must NOT be covered')
})

test('state scope: a real state_admin/state_viewer covers any facility in their state, not outside it', async () => {
  for (const role of ['state_admin', 'state_viewer']) {
    const u = await aRealUserWithRole(role)
    const { rows: inState } = await query(`select id from facilities where state = $1 limit 1`, [u.scope_id])
    const { rows: outState } = await query(`select id from facilities where state <> $1 limit 1`, [u.scope_id])
    const permission = role === 'state_admin' ? 'stock.write' : 'stock.read'
    const ok = await AclResolver.can(u.id, permission, { facilityId: inState[0].id })
    assert.equal(ok.decision, true, `${role}: in-state facility must be covered`)
    const denied = await AclResolver.can(u.id, permission, { facilityId: outState[0].id })
    assert.equal(denied.decision, false, `${role}: out-of-state facility must be denied`)
  }
})

test('cluster scope: covers facilities in the cluster, denies outside it', async () => {
  const u = await aRealUserWithRole('cluster_admin')
  const { rows: inCluster } = await query(`select id from facilities where cluster = $1 limit 1`, [u.scope_id])
  const { rows: outCluster } = await query(`select id from facilities where cluster is distinct from $1 limit 1`, [u.scope_id])
  assert.equal((await AclResolver.can(u.id, 'stock.read', { facilityId: inCluster[0].id })).decision, true)
  assert.equal((await AclResolver.can(u.id, 'stock.read', { facilityId: outCluster[0].id })).decision, false)
})

test('LGA scope: covers facilities in the LGA, denies outside it', async () => {
  const u = await aRealUserWithRole('lga_admin')
  const { rows: inLga } = await query(`select id from facilities where lga = $1 limit 1`, [u.scope_id])
  const { rows: outLga } = await query(`select id from facilities where lga is distinct from $1 limit 1`, [u.scope_id])
  assert.equal((await AclResolver.can(u.id, 'stock.read', { facilityId: inLga[0].id })).decision, true)
  assert.equal((await AclResolver.can(u.id, 'stock.read', { facilityId: outLga[0].id })).decision, false)
})

test('national scope applies ONLY to overall_admin — any facility, any state, no narrowing', async () => {
  const { rows } = await query(
    `select u.id from user_roles ur join roles r on r.id=ur.role_id join users u on u.id=ur.user_id
      where r.name='overall_admin' and u.email not like '%.invalid' and u.email not like 'probe.create.%' limit 1`)
  const { rows: anyFacility } = await query(`select id from facilities order by random() limit 1`)
  const res = await AclResolver.can(rows[0].id, 'stock.read', { facilityId: anyFacility[0].id })
  assert.equal(res.decision, true, 'overall_admin must cover any facility nationally')
})

test('a valid permission with the WRONG scope is denied, not silently allowed', async () => {
  const u = await aRealUserWithRole('facility')
  const fakeFacility = '00000000-0000-0000-0000-000000000000'
  const res = await AclResolver.can(u.id, 'stock.read', { facilityId: fakeFacility })
  assert.equal(res.decision, false)
})

test('the WRITE_ADMIN_LEVELS narrowing gap: state_admin cannot write dispense_log outside a facility scope', async () => {
  // state_admin holds dispense_log.write as a PERMISSION (role_permissions says
  // so, matching the approved catalogue), but its ASSIGNMENT scope is 'state',
  // not 'facility' — and dispense_log.write is not in the cross-facility-write
  // set (mirrors WRITE_ADMIN_LEVELS.dispense_log === []). So even a facility
  // that genuinely IS in the admin's state must still be denied for this one
  // permission — reproducing "state_admin cannot write these logs at all"
  // (permission-catalogue.md Section 3).
  const u = await aRealUserWithRole('state_admin')
  const { rows: inState } = await query(`select id from facilities where state = $1 limit 1`, [u.scope_id])
  const res = await AclResolver.can(u.id, 'dispense_log.write', { facilityId: inState[0].id })
  assert.equal(res.decision, false, 'state scope must not satisfy a facility-only write permission')
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. Unscoped permissions — always covered once the permission is held
// ═════════════════════════════════════════════════════════════════════════════

test('unscoped permissions ignore facility context entirely', async () => {
  const u = await aRealUserWithRole('facility')
  const res = await AclResolver.can(u.id, 'commodity.read', {}) // no facilityId at all
  assert.equal(res.decision, true)
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. User-specific overrides — ISOLATED FIXTURES ONLY (Step 19: never touch a
//    real user's role assignment)
// ═════════════════════════════════════════════════════════════════════════════

const FIXTURE_EMAIL = 'phase2e-resolver-override@acl-schema-test.invalid'
let fixtureUserId, fixtureRoleId

test.before(async () => {
  await query(`delete from users where email = $1`, [FIXTURE_EMAIL])
  const { rows } = await query(
    `insert into users (id, email, encrypted_password, raw_user_meta_data)
     values (gen_random_uuid(), $1, 'x', '{}'::jsonb) returning id`, [FIXTURE_EMAIL])
  fixtureUserId = rows[0].id
  fixtureRoleId = (await query(`select id from roles where name = 'facility'`)).rows[0].id
})

test.after(async () => {
  await query(`delete from user_permissions where user_id = $1`, [fixtureUserId])
  await query(`delete from user_roles where user_id = $1`, [fixtureUserId])
  await query(`delete from users where id = $1`, [fixtureUserId])
  await pool.end() // single teardown — a second top-level test.after in this
                    // file raced this against a bare pool.end(), closing the
                    // pool before fixture cleanup ran
})

test('role grant + user-specific deny => DENY (deny always wins)', async () => {
  await query(`insert into user_roles (user_id, role_id, scope_type, scope_id) values ($1,$2,'facility','ffffffff-ffff-ffff-ffff-ffffffffffff')`,
    [fixtureUserId, fixtureRoleId])
  await query(`insert into user_permissions (user_id, permission_key, effect, scope_type, scope_id)
               values ($1,'stock.read','deny','facility','ffffffff-ffff-ffff-ffff-ffffffffffff')`, [fixtureUserId])
  try {
    const res = await AclResolver.can(fixtureUserId, 'stock.read', { facilityId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' })
    assert.equal(res.decision, false)
    assert.equal(res.reason, 'user_permissions deny')
  } finally {
    await query(`delete from user_permissions where user_id = $1`, [fixtureUserId])
    await query(`delete from user_roles where user_id = $1`, [fixtureUserId])
  }
})

test('no role grant + user-specific grant => GRANT', async () => {
  // No user_roles row at all this time — the permission comes ONLY from the override.
  await query(`insert into user_permissions (user_id, permission_key, effect, scope_type, scope_id)
               values ($1,'stock.read','grant','facility','ffffffff-ffff-ffff-ffff-ffffffffffff')`, [fixtureUserId])
  try {
    const res = await AclResolver.can(fixtureUserId, 'stock.read', { facilityId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' })
    assert.equal(res.decision, true)
    assert.equal(res.reason, 'facility scope match')
  } finally {
    await query(`delete from user_permissions where user_id = $1`, [fixtureUserId])
  }
})

test('no role permission + no user grant => DENY', async () => {
  // Fixture user has no role and no override at this point in the test.
  const res = await AclResolver.can(fixtureUserId, 'stock.read', { facilityId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' })
  assert.equal(res.decision, false)
  assert.equal(res.reason, 'no role assignment')
})

// ═════════════════════════════════════════════════════════════════════════════
// 6. Unknown permission / unknown role / missing scope
// ═════════════════════════════════════════════════════════════════════════════

test('an unknown permission key resolves to deny', async () => {
  const u = await aRealUserWithRole('facility')
  const res = await AclResolver.can(u.id, 'nonexistent.permission', { facilityId: u.scope_id })
  assert.equal(res.decision, false)
})

test('an unknown role name resolves to deny at the role_permissions layer', async () => {
  assert.equal(await AclResolver.roleHasPermission('not_a_real_role', 'stock.read'), false)
})

test('missing scope (blank scope_id on a non-facility, non-overall_admin role) never grants nationally', async () => {
  // A defensive check on the resolver itself, not on real data (Phase 2D
  // guaranteed 0 missing scope for state/cluster/lga roles) — proves the
  // resolver's OWN handling of a blank scope_id denies rather than treating it
  // as "everything", independent of whether such a row could exist today.
  const covered = await AclResolver.facilityInScope('state', '', 'any-facility-id')
  assert.equal(covered, false, 'a blank scope_id must never mean unconstrained')
  const nationalOnly = await AclResolver.facilityInScope('', '', 'any-facility-id')
  assert.equal(nationalOnly, true, 'only the empty-STRING-TYPE (overall_admin) is unconstrained')
})
