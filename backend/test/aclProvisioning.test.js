// New accounts must receive an ACL role and scope.
//
// Phase 2D was a point-in-time backfill; nothing assigned roles to accounts
// created afterward, which would have denied those users everything at cutover.
// syncAcl() closes that by re-running the three idempotent backfill migrations —
// one copy of the derivation rules, not a second implementation.
//
// SAFETY: every fixture lives under the reserved @acl-schema-test.invalid domain
// and is removed in `finally`. No real user, role or scope row is modified.
//
//   npm test --prefix backend

import test from 'node:test'
import assert from 'node:assert/strict'
import { query, pool } from '../src/db.js'
import { syncAcl } from '../src/services/aclProvisioning.js'

test.after(async () => { await pool.end() })

const EMAIL = 'provisioning-sync@acl-schema-test.invalid'
const cleanup = () => query(`delete from users where email = $1`, [EMAIL])

// Creates a user exactly the way the provisioning scripts do — a `users` row and
// nothing else.
async function provisionUser(meta) {
  await cleanup()
  const { rows } = await query(
    `insert into users (id, email, encrypted_password, raw_user_meta_data)
     values (gen_random_uuid(), $1, 'x', $2::jsonb) returning id`,
    [EMAIL, JSON.stringify(meta)])
  return rows[0].id
}

const roleOf = async (userId) => {
  const { rows } = await query(
    `select r.name from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = $1`,
    [userId])
  return rows[0]?.name ?? null
}

const scopesOf = async (userId) => {
  const { rows } = await query(
    `select dimension, scope_type, scope_id from user_role_scopes
      where user_id = $1 order by dimension, scope_type`, [userId])
  return rows
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. The gap itself
// ═════════════════════════════════════════════════════════════════════════════

test('a newly provisioned account has NO ACL identity until synced', async () => {
  const { rows: f } = await query(`select id from facilities limit 1`)
  const id = await provisionUser({ access_level: 'facility', commodity_section: 'pharmacy', facility_id: f[0].id })
  try {
    assert.equal(await roleOf(id), null, 'provisioning alone assigns no role — this is the gap')
    assert.deepEqual(await scopesOf(id), [])
  } finally {
    await cleanup()
  }
})

test('syncAcl gives a new facility account its role and ALL THREE scope dimensions', async () => {
  const { rows: f } = await query(`select id from facilities where state is not null limit 1`)
  const id = await provisionUser({ access_level: 'facility', commodity_section: 'pharmacy', facility_id: f[0].id })
  try {
    const result = await syncUntilAssigned()
    assert.equal(result.synced, true)
    assert.equal(await roleOf(id), 'facility')
    assert.deepEqual(await scopesOf(id), [
      { dimension: 'commodity', scope_type: 'section', scope_id: 'pharmacy' },
      { dimension: 'geography', scope_type: 'facility', scope_id: f[0].id },
      // Phase 2M. Without a module row the account would be UNCONSTRAINED on
      // module — an absent dimension means unconstrained — and would therefore
      // see Essential Commodities as well as HIV. This assertion is the guard
      // that the module migration stays wired into syncAcl.
      { dimension: 'module', scope_type: 'module', scope_id: 'hiv' },
    ])
  } finally {
    await cleanup()
  }
})

// syncAcl runs four backfill migrations in ONE transaction and retries ONCE on
// conflict, by deliberate design — a second consecutive collision is meant to be
// reported rather than papered over. aclAdminApi.test.js runs concurrently and
// writes to the same tables, so that single retry can genuinely be exhausted.
//
// When it is, syncAcl returns { synced: false } and assigns nobody — and a test
// that then asserts on the scopes reports a confusing deepEqual mismatch instead
// of the contention that actually happened. This waits for a run that succeeded,
// so the assertions below are about the RULE and not about who won the race.
// Attempts raised as more suites began calling syncAcl concurrently
// (aclAdminApi, aclEssentialAdmin, aclEssentialSection). Each call is a single
// transaction over the whole users table, so several in flight genuinely
// contend; the work is idempotent, so retrying is free.
async function syncUntilAssigned(attempts = 10) {
  let last
  for (let i = 0; i < attempts; i++) {
    last = await syncAcl({ quiet: true })
    if (last.synced) return last
  }
  assert.fail(`syncAcl never completed: ${last?.reason}`)
}

test('an admin account gets its own geography scope and no commodity scope', async () => {
  const { rows: s } = await query(`select distinct state from facilities where state is not null limit 1`)
  const id = await provisionUser({ access_level: 'state_admin', admin_state: s[0].state, commodity_section: 'lab' })
  try {
    await syncUntilAssigned()
    assert.equal(await roleOf(id), 'state_admin')
    // state_admin is never section-pinned — attachScope ignores commodity_section
    // for it, so the section set above must NOT produce a commodity row.
    assert.deepEqual(await scopesOf(id), [
      { dimension: 'geography', scope_type: 'state', scope_id: s[0].state },
      // …but it IS confined to the HIV module. No commodity row means every
      // section; no module row would mean every module, which is a different and
      // much larger claim.
      { dimension: 'module', scope_type: 'module', scope_id: 'hiv' },
    ])
  } finally {
    await cleanup()
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. Eligibility — the same rules the backfill applies
// ═════════════════════════════════════════════════════════════════════════════

test('an unrecognised access_level is still never assigned a role', async () => {
  const id = await provisionUser({ access_level: 'hq_tools', commodity_section: 'tools' })
  try {
    await syncAcl({ quiet: true })
    assert.equal(await roleOf(id), null, 'hq_tools is not one of the six approved levels')
  } finally {
    await cleanup()
  }
})

test('a facility account with no facility_id is still excluded', async () => {
  const id = await provisionUser({ access_level: 'facility', commodity_section: 'pharmacy' })
  try {
    await syncAcl({ quiet: true })
    assert.equal(await roleOf(id), null, 'nothing to scope it to — deliberately excluded')
  } finally {
    await cleanup()
  }
})

test('a missing access_level defaults to facility, matching attachScope', async () => {
  const { rows: f } = await query(`select id from facilities limit 1`)
  const id = await provisionUser({ commodity_section: 'lab', facility_id: f[0].id })
  try {
    await syncUntilAssigned()
    assert.equal(await roleOf(id), 'facility')
  } finally {
    await cleanup()
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. Idempotency and safety
// ═════════════════════════════════════════════════════════════════════════════

test('syncing twice changes nothing the second time', async () => {
  const { rows: f } = await query(`select id from facilities limit 1`)
  const id = await provisionUser({ access_level: 'facility', commodity_section: 'lab', facility_id: f[0].id })
  try {
    // `assigned` is a GLOBAL count, and aclAdminApi/aclEssentialAdmin create
    // role-less fixtures concurrently — so it can legitimately exceed 1. The
    // subject here is idempotency for THIS user, so assert that.
    // NOT asserting on `assigned`: it is a global count, and three other suites
    // now call syncAcl concurrently — one of them can adopt this fixture first,
    // leaving our own call to report 0. The subject is that the account ends up
    // correctly assigned, which is what roleOf checks.
    await syncUntilAssigned()
    assert.equal(await roleOf(id), 'facility')
    const scopesAfterFirst = await scopesOf(id)

    await syncAcl({ quiet: true })
    assert.deepEqual(await scopesOf(id), scopesAfterFirst,
      'a second run must not duplicate or alter this user\'s scope rows')
  } finally {
    await cleanup()
  }
})

test('syncing does not disturb existing users', async () => {
  const before = await query(
    // Real accounts only. aclFoundation and aclUserRoleScopes create and drop
    // their own '.invalid' fixtures concurrently, and a global count would make
    // this assertion about their timing rather than about syncAcl.
    `select (select count(*)::int from user_roles ur join users u on u.id = ur.user_id
              where u.email not like '%.invalid' and u.email not like 'probe.create.%') roles,
            (select count(*)::int from user_role_scopes s join users u on u.id = s.user_id
              where u.email not like '%.invalid' and u.email not like 'probe.create.%') scopes`)
  await syncAcl({ quiet: true })
  const after = await query(
    // Real accounts only. aclFoundation and aclUserRoleScopes create and drop
    // their own '.invalid' fixtures concurrently, and a global count would make
    // this assertion about their timing rather than about syncAcl.
    `select (select count(*)::int from user_roles ur join users u on u.id = ur.user_id
              where u.email not like '%.invalid' and u.email not like 'probe.create.%') roles,
            (select count(*)::int from user_role_scopes s join users u on u.id = s.user_id
              where u.email not like '%.invalid' and u.email not like 'probe.create.%') scopes`)
  assert.deepEqual(after.rows[0], before.rows[0], 'a no-op sync must be exactly that')
})

test('syncAcl reports rather than throws when it cannot run', async () => {
  // The property that lets a provisioning script call this unconditionally: on a
  // database without the ACL tables (production today) it must return quietly,
  // not fail a run that has already created the user.
  const result = await syncAcl({ quiet: true })
  assert.equal(typeof result.synced, 'boolean')
  assert.ok(!('error' in result), 'never surfaces an exception to the caller')
})
