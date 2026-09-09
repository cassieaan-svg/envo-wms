// Schema tests for the Phase 2B ACL foundation: permissions, roles,
// role_permissions, user_roles, user_permissions.
//
// These tables are currently UNUSED by authorization — nothing in scope.js or any
// route reads them. This suite tests the SCHEMA itself: the constraints that must
// hold before any resolver is ever built on top of it. It does not test — and must
// not be read as testing — any authorization decision, because none exists yet.
//
// SAFETY: every fixture lives under a reserved key/name prefix or a reserved email
// domain that cannot collide with real data:
//   - permission keys prefixed 'aclschematest.'
//   - role names prefixed 'aclschematest_'
//   - a single throwaway user at '@acl-schema-test.invalid' (.invalid is reserved
//     by RFC 2606 and can never be a real account)
// All fixtures are removed in `finally` blocks, children before parents, and
// test.after() sweeps by prefix as a backstop against a killed run — same pattern
// as sweepFixtures.js.
//
// INTEGRATION test: requires the local `envo` database with the
// 20260903_acl_foundation.sql migration applied. Fails loudly rather than
// skipping — see stockSummary.test.js for the house convention.
//
//   npm test --prefix backend

import test from 'node:test'
import assert from 'node:assert/strict'
import { query, pool } from '../src/db.js'

const PKEY = k => `aclschematest.${k}`
const ROLE = n => `aclschematest_${n}`
const TEST_EMAIL = 'phase2b-acl-schema@acl-schema-test.invalid'

// Deletes everything this suite could have left behind, children first (FKs
// otherwise block the parent deletes). Safe to call with nothing to clean.
async function sweep() {
  await query(`delete from user_permissions where permission_key like 'aclschematest.%'`)
  await query(`delete from role_permissions where permission_key like 'aclschematest.%'`)
  await query(`delete from user_roles where role_id in (select id from roles where name like 'aclschematest_%')`)
  await query(`delete from roles where name like 'aclschematest_%'`)
  await query(`delete from permissions where key like 'aclschematest.%'`)
  await query(`delete from users where email = $1`, [TEST_EMAIL])
}

let userId

test.before(async () => {
  await sweep()
  const { rows } = await query(
    `insert into users (id, email, encrypted_password, raw_user_meta_data)
     values (gen_random_uuid(), $1, 'x', '{}'::jsonb) returning id`,
    [TEST_EMAIL])
  userId = rows[0].id
})

test.after(async () => { await sweep(); await pool.end() })

// A duplicate-key / FK-violation / check-violation assertion helper: Postgres
// reports these as distinct SQLSTATE codes, so match on the code rather than the
// message text (which is locale- and wording-dependent).
const rejects = (p, sqlstate) => assert.rejects(p, err => err.code === sqlstate)
const UNIQUE_VIOLATION = '23505'
const FK_VIOLATION = '23503'
const CHECK_VIOLATION = '23514'
const NOT_NULL_VIOLATION = '23502'

// ═════════════════════════════════════════════════════════════════════════════
// 1. permission key uniqueness
// ═════════════════════════════════════════════════════════════════════════════

test('permission key is unique', async () => {
  const key = PKEY('unique_check')
  await query(`insert into permissions (key) values ($1)`, [key])
  try {
    await rejects(
      () => query(`insert into permissions (key) values ($1)`, [key]),
      UNIQUE_VIOLATION)
  } finally {
    await query(`delete from permissions where key = $1`, [key])
  }
})

test('permission key rejects a non-null-violating empty/malformed value', async () => {
  await rejects(() => query(`insert into permissions (key) values (null)`), NOT_NULL_VIOLATION)
  // Not the dot-notation shape the catalogue requires.
  await rejects(() => query(`insert into permissions (key) values ('NoDots')`), CHECK_VIOLATION)
  await rejects(() => query(`insert into permissions (key) values ('Upper.Case')`), CHECK_VIOLATION)
  await rejects(() => query(`insert into permissions (key) values ('has space.read')`), CHECK_VIOLATION)
})

test('a deeper dotted key is accepted (system.diagnostics.read shape)', async () => {
  const key = PKEY('deep.nested_key')
  await query(`insert into permissions (key) values ($1)`, [key])
  try {
    const { rows } = await query(`select is_active from permissions where key = $1`, [key])
    assert.equal(rows[0].is_active, true, 'is_active defaults to true')
  } finally {
    await query(`delete from permissions where key = $1`, [key])
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. role name uniqueness
// ═════════════════════════════════════════════════════════════════════════════

test('role name is unique', async () => {
  const name = ROLE('unique_check')
  await query(`insert into roles (name) values ($1)`, [name])
  try {
    await rejects(() => query(`insert into roles (name) values ($1)`, [name]), UNIQUE_VIOLATION)
  } finally {
    await query(`delete from roles where name = $1`, [name])
  }
})

test('roles.is_system defaults false; id is a generated uuid', async () => {
  const name = ROLE('defaults_check')
  const { rows } = await query(`insert into roles (name) values ($1) returning id, is_system`, [name])
  try {
    assert.equal(rows[0].is_system, false)
    assert.match(rows[0].id, /^[0-9a-f-]{36}$/)
  } finally {
    await query(`delete from roles where name = $1`, [name])
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// 3 & 4. role_permissions: FK integrity, duplicate prevention
// ═════════════════════════════════════════════════════════════════════════════

test('role_permissions rejects an unknown role_id or permission_key', async () => {
  const key = PKEY('rp_fk')
  await query(`insert into permissions (key) values ($1)`, [key])
  const { rows: r } = await query(`insert into roles (name) values ($1) returning id`, [ROLE('rp_fk')])
  const roleId = r[0].id
  const fakeUuid = '00000000-0000-0000-0000-000000000000'
  try {
    await rejects(
      () => query(`insert into role_permissions (role_id, permission_key) values ($1,$2)`, [fakeUuid, key]),
      FK_VIOLATION)
    await rejects(
      () => query(`insert into role_permissions (role_id, permission_key) values ($1,$2)`, [roleId, 'aclschematest.does_not_exist']),
      FK_VIOLATION)
  } finally {
    await query(`delete from roles where id = $1`, [roleId])
    await query(`delete from permissions where key = $1`, [key])
  }
})

test('role_permissions rejects a duplicate (role_id, permission_key) pair', async () => {
  const key = PKEY('rp_dup')
  await query(`insert into permissions (key) values ($1)`, [key])
  const { rows: r } = await query(`insert into roles (name) values ($1) returning id`, [ROLE('rp_dup')])
  const roleId = r[0].id
  try {
    await query(`insert into role_permissions (role_id, permission_key) values ($1,$2)`, [roleId, key])
    await rejects(
      () => query(`insert into role_permissions (role_id, permission_key) values ($1,$2)`, [roleId, key]),
      UNIQUE_VIOLATION) // composite PK violation reports as 23505
  } finally {
    await query(`delete from role_permissions where role_id = $1`, [roleId])
    await query(`delete from roles where id = $1`, [roleId])
    await query(`delete from permissions where key = $1`, [key])
  }
})

test('deleting a role cascades its role_permissions rows', async () => {
  const key = PKEY('rp_cascade')
  await query(`insert into permissions (key) values ($1)`, [key])
  const { rows: r } = await query(`insert into roles (name) values ($1) returning id`, [ROLE('rp_cascade')])
  const roleId = r[0].id
  try {
    await query(`insert into role_permissions (role_id, permission_key) values ($1,$2)`, [roleId, key])
    await query(`delete from roles where id = $1`, [roleId])
    const { rows } = await query(`select 1 from role_permissions where role_id = $1`, [roleId])
    assert.equal(rows.length, 0, 'role_permissions row must not outlive its role')
  } finally {
    await query(`delete from permissions where key = $1`, [key])
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. user_roles: FK integrity
// ═════════════════════════════════════════════════════════════════════════════

test('user_roles rejects an unknown user_id or role_id', async () => {
  const { rows: r } = await query(`insert into roles (name) values ($1) returning id`, [ROLE('ur_fk')])
  const roleId = r[0].id
  const fakeUuid = '00000000-0000-0000-0000-000000000000'
  try {
    await rejects(
      () => query(`insert into user_roles (user_id, role_id) values ($1,$2)`, [fakeUuid, roleId]),
      FK_VIOLATION)
    await rejects(
      () => query(`insert into user_roles (user_id, role_id) values ($1,$2)`, [userId, fakeUuid]),
      FK_VIOLATION)
  } finally {
    await query(`delete from roles where id = $1`, [roleId])
  }
})

test('deleting a user cascades their user_roles rows (users table itself untouched by this)', async () => {
  const { rows: r } = await query(`insert into roles (name) values ($1) returning id`, [ROLE('ur_cascade')])
  const roleId = r[0].id
  // A SEPARATE throwaway user for this one destructive test, so it never touches
  // the shared fixture user other tests in this file depend on.
  const { rows: u } = await query(
    `insert into users (id, email, encrypted_password, raw_user_meta_data)
     values (gen_random_uuid(), 'phase2b-acl-cascade@acl-schema-test.invalid', 'x', '{}'::jsonb)
     returning id`)
  const cascadeUserId = u[0].id
  try {
    await query(`insert into user_roles (user_id, role_id) values ($1,$2)`, [cascadeUserId, roleId])

    // DELETE retried on deadlock (40P01). aclProvisioning.test.js runs
    // concurrently and calls syncAcl, which applies four backfill migrations
    // inside ONE transaction that writes across user_roles and
    // user_role_scopes — the same tables this delete cascades into. Postgres
    // resolves the resulting lock cycle by killing one side, and it is
    // arbitrary which; syncAcl has its own retry, so this side needs one too.
    //
    // The deadlock is contention, not corruption: the cascade being tested here
    // is a schema property that either holds or does not. Retrying establishes
    // the precondition; the assertion below is untouched.
    for (let attempt = 0; ; attempt++) {
      try {
        await query(`delete from users where id = $1`, [cascadeUserId])
        break
      } catch (err) {
        if (err.code !== '40P01' || attempt >= 4) throw err
      }
    }
    const { rows } = await query(`select 1 from user_roles where user_id = $1`, [cascadeUserId])
    assert.equal(rows.length, 0, 'user_roles row must not outlive its user')
  } finally {
    await query(`delete from roles where id = $1`, [roleId])
    await query(`delete from users where id = $1`, [cascadeUserId]).catch(() => {})
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// 6. user_permissions: FK integrity
// ═════════════════════════════════════════════════════════════════════════════

test('user_permissions rejects an unknown user_id or permission_key', async () => {
  const key = PKEY('up_fk')
  await query(`insert into permissions (key) values ($1)`, [key])
  const fakeUuid = '00000000-0000-0000-0000-000000000000'
  try {
    await rejects(
      () => query(`insert into user_permissions (user_id, permission_key, effect) values ($1,$2,'grant')`, [fakeUuid, key]),
      FK_VIOLATION)
    await rejects(
      () => query(`insert into user_permissions (user_id, permission_key, effect) values ($1,$2,'grant')`, [userId, 'aclschematest.does_not_exist']),
      FK_VIOLATION)
  } finally {
    await query(`delete from permissions where key = $1`, [key])
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// 7. effect accepts only grant | deny
// ═════════════════════════════════════════════════════════════════════════════

test('user_permissions.effect rejects anything but grant or deny', async () => {
  const key = PKEY('effect_check')
  await query(`insert into permissions (key) values ($1)`, [key])
  try {
    await rejects(
      () => query(`insert into user_permissions (user_id, permission_key, effect) values ($1,$2,'allow')`, [userId, key]),
      CHECK_VIOLATION)
    await rejects(
      () => query(`insert into user_permissions (user_id, permission_key, effect) values ($1,$2,'')`, [userId, key]),
      CHECK_VIOLATION)
    // Both real values succeed (each at a distinct scope, or the second would hit
    // the primary-key rule tested next).
    await query(`insert into user_permissions (user_id, permission_key, effect, scope_type, scope_id)
                  values ($1,$2,'grant','facility','11111111-1111-1111-1111-111111111111')`, [userId, key])
    await query(`insert into user_permissions (user_id, permission_key, effect, scope_type, scope_id)
                  values ($1,$2,'deny','facility','22222222-2222-2222-2222-222222222222')`, [userId, key])
  } finally {
    await query(`delete from user_permissions where permission_key = $1`, [key])
    await query(`delete from permissions where key = $1`, [key])
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// 8. duplicate direct permission assignment — at most one row per
//    (user, permission, scope); a grant and a deny for the IDENTICAL scope
//    cannot both exist, by construction of the primary key.
// ═════════════════════════════════════════════════════════════════════════════

test('a second row for the same (user, permission, scope) is rejected — even with the other effect', async () => {
  const key = PKEY('dup_assignment')
  await query(`insert into permissions (key) values ($1)`, [key])
  try {
    await query(
      `insert into user_permissions (user_id, permission_key, effect, scope_type, scope_id)
       values ($1,$2,'grant','facility','33333333-3333-3333-3333-333333333333')`, [userId, key])
    // Same user, same permission, same scope — only the effect differs. Must still
    // be rejected: this table cannot represent "grant AND deny for the same thing."
    await rejects(
      () => query(
        `insert into user_permissions (user_id, permission_key, effect, scope_type, scope_id)
         values ($1,$2,'deny','facility','33333333-3333-3333-3333-333333333333')`, [userId, key]),
      UNIQUE_VIOLATION)
  } finally {
    await query(`delete from user_permissions where permission_key = $1`, [key])
    await query(`delete from permissions where key = $1`, [key])
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// 9. scope fields exist independently from permissions
// ═════════════════════════════════════════════════════════════════════════════

test('scope_type/scope_id are free text, unconstrained, and independent per row', async () => {
  const key = PKEY('scope_independence')
  await query(`insert into permissions (key) values ($1)`, [key])
  try {
    // Three different scope dimensions for the identical permission, same user.
    // None of these coupled a scope value into the permission KEY itself.
    for (const [t, id] of [['facility', 'some-facility-uuid'], ['state', 'Akwa Ibom'], ['', '']]) {
      await query(
        `insert into user_permissions (user_id, permission_key, effect, scope_type, scope_id)
         values ($1,$2,'grant',$3,$4)`, [userId, key, t, id])
    }
    const { rows } = await query(
      `select scope_type, scope_id from user_permissions where permission_key = $1 order by scope_type`, [key])
    assert.equal(rows.length, 3, 'all three distinct scopes coexist for one (user, permission)')
    // The unscoped row (no facility/state restriction) is representable as '' / ''
    // — NOT null. NULL cannot appear in a primary key, which is exactly why the
    // migration defaults these columns to '' instead of leaving them nullable.
    assert.ok(rows.some(r => r.scope_type === '' && r.scope_id === ''))
  } finally {
    await query(`delete from user_permissions where permission_key = $1`, [key])
    await query(`delete from permissions where key = $1`, [key])
  }
})

test('the same role can be assigned to the same user at two different scopes', async () => {
  const { rows: r } = await query(`insert into roles (name) values ($1) returning id`, [ROLE('multi_scope')])
  const roleId = r[0].id
  try {
    await query(`insert into user_roles (user_id, role_id, scope_type, scope_id) values ($1,$2,'state','Lagos')`, [userId, roleId])
    await query(`insert into user_roles (user_id, role_id, scope_type, scope_id) values ($1,$2,'state','Cross River')`, [userId, roleId])
    const { rows } = await query(`select scope_id from user_roles where user_id=$1 and role_id=$2 order by scope_id`, [userId, roleId])
    assert.deepEqual(rows.map(x => x.scope_id), ['Cross River', 'Lagos'])
  } finally {
    await query(`delete from user_roles where role_id = $1`, [roleId])
    await query(`delete from roles where id = $1`, [roleId])
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// 10. the existing `users` table is untouched by this migration
// ═════════════════════════════════════════════════════════════════════════════

test('users table shape is exactly what Phase 1 captured — this migration added nothing to it', async () => {
  const { rows } = await query(
    `select column_name, data_type, is_nullable, column_default
       from information_schema.columns
      where table_schema='public' and table_name='users'
      order by ordinal_position`)
  assert.deepEqual(rows.map(r => r.column_name),
    ['id', 'email', 'encrypted_password', 'raw_user_meta_data', 'created_at'])
  assert.equal(rows[0].column_default, null, 'id still has no default — unchanged from Phase 1')

  const { rows: cons } = await query(
    `select conname, contype from pg_constraint where conrelid = 'public.users'::regclass and contype in ('p','u')`)
  const types = cons.map(c => c.contype).sort()
  assert.deepEqual(types, ['p', 'u'], 'still exactly one PK and one UNIQUE, nothing added')
})

test('the fixture user is otherwise a completely ordinary row — no ACL side effect on it', async () => {
  const { rows } = await query(`select raw_user_meta_data from users where id = $1`, [userId])
  assert.deepEqual(rows[0].raw_user_meta_data, {}, 'creating ACL rows referencing this user did not touch its metadata')
})
