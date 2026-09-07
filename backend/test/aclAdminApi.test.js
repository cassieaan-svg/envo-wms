// Phase 2M — the administration service: governance, validation, and the
// deny-only shape of feature configuration.
//
// These tests exercise the SERVICE, not the HTTP layer, because that is where
// every rule lives. routes/admin.js does two things only — derive the identity
// from req.scope and translate an AclAdminError into a status — so testing the
// service tests the rules, and a route that forgot a check would still be caught
// by the "no method trusts its caller" tests below.
//
// The rules under test (Phase 2M governance):
//   * only system_admin and state_admin reach this surface at all
//   * nobody edits their own role, scope or permissions
//   * nobody creates or modifies a role above their own
//   * a state_admin is confined to its own state
//   * direct overrides are system_admin only
//   * an invalid role/scope pair is refused
//   * feature configuration is deny-only and cannot invent a feature
//
// Fixtures live under '@acl-admin-test.invalid' and are removed in test.after.
//
//   npm test --prefix backend

import test from 'node:test'
import assert from 'node:assert/strict'
import { query, pool, withTransaction } from '../src/db.js'
import {
  adminIdentity, listUsers, getUserConfig, setUserRoleAndScope, setUserOverride,
  listFeatureConfig, setFeatureConfig, AclAdminError,
} from '../src/services/aclAdminService.js'

const DOMAIN = '@acl-admin-test.invalid'
const created = []

test.after(async () => {
  if (created.length) {
    await query(`delete from feature_config where updated_by = any($1::uuid[])`, [created])
    await query(`delete from users where id = any($1::uuid[])`, [created])
  }
  await query(`delete from users where email like $1`, [`%${DOMAIN}`])
  await pool.end()
})

// Create a user AND its role assignment in ONE transaction.
//
// aclProvisioning.test.js calls syncAcl() concurrently, and syncAcl assigns a
// role to any account that has none. Creating the user first and assigning
// afterwards leaves a window in which syncAcl adopts the fixture, giving it a
// second role and a set of scopes these tests never asked for — which then trips
// the global invariants other suites assert. One transaction means the fixture
// is never visible without its role.
async function makeUser(meta = {}, roleName = null, scopes = []) {
  const email = `u${Date.now()}${Math.random().toString(36).slice(2, 8)}${DOMAIN}`
  const id = await withTransaction(async exec => {
    const { rows } = await exec(
      `insert into users (id, email, encrypted_password, raw_user_meta_data)
       values (gen_random_uuid(), $1, 'x', $2::jsonb) returning id`,
      [email, JSON.stringify(meta)])
    const userId = rows[0].id
    if (roleName) await assignIn(exec, userId, roleName, scopes)
    return userId
  })
  created.push(id)
  return id
}

// The geography pair is mirrored onto user_roles exactly as the real seed and the
// admin service do — the resolver's own_facility_only check still reads it, and
// leaving it ('','') here would make these fixtures violate an invariant other
// suites assert.
async function assignIn(exec, userId, roleName, scopes = []) {
  const { rows: r } = await exec(`select id from roles where name = $1`, [roleName])
  const geo = scopes.find(s => s.dimension === 'geography')
  await exec(
    `insert into user_roles (user_id, role_id, scope_type, scope_id) values ($1,$2,$3,$4)
     on conflict do nothing`,
    [userId, r[0].id, geo?.scope_type ?? '', geo?.scope_id ?? ''])
  for (const s of scopes) {
    await exec(
      `insert into user_role_scopes (user_id, role_id, dimension, scope_type, scope_id)
       values ($1,$2,$3,$4,$5) on conflict do nothing`,
      [userId, r[0].id, s.dimension, s.scope_type, s.scope_id])
  }
}

const assign = (userId, roleName, scopes = []) =>
  withTransaction(exec => assignIn(exec, userId, roleName, scopes))

const sysIdentity = actorId => adminIdentity({ accessLevel: 'system_admin' }, actorId)
const stateIdentity = (actorId, state) =>
  adminIdentity({ accessLevel: 'state_admin', adminState: state }, actorId)

const someState = async () =>
  (await query(`select distinct state from facilities where state is not null order by 1 limit 1`)).rows[0].state
const otherState = async s =>
  (await query(`select distinct state from facilities where state is not null and state <> $1 limit 1`, [s])).rows[0].state
const facilityIn = async state =>
  (await query(`select id, state from facilities where state = $1 limit 1`, [state])).rows[0]

// ═════════════════════════════════════════════════════════════════════════════
// 1. Who reaches this surface at all
// ═════════════════════════════════════════════════════════════════════════════

test('only system_admin and state_admin get an administrative identity', async () => {
  const id = 'aaaaaaaa-0000-0000-0000-000000000000'
  assert.equal(adminIdentity({ accessLevel: 'system_admin' }, id).kind, 'system_admin')
  assert.equal(adminIdentity({ accessLevel: 'state_admin', adminState: 'Lagos' }, id).kind, 'state_admin')

  for (const level of ['overall_admin', 'state_viewer', 'cluster_admin', 'lga_admin', 'facility']) {
    assert.equal(adminIdentity({ accessLevel: level, adminState: 'Lagos' }, id), null,
      `${level} must not administer users`)
  }
  // overall_admin is the one worth naming: it is the most senior legacy tier and
  // is deliberately excluded — read-only, administers nobody.
  assert.equal(adminIdentity({ accessLevel: 'overall_admin', isAdmin: true }, id), null)
})

test('a state_admin with no state gets nothing — an unscoped state admin is not national', async () => {
  assert.equal(adminIdentity({ accessLevel: 'state_admin', adminState: null }, 'x'), null)
})

test('an identity without an actor id is refused', async () => {
  assert.equal(adminIdentity({ accessLevel: 'system_admin' }, null), null,
    'without the actor, the self-edit rule cannot be enforced')
})

test('only system_admin may override', async () => {
  assert.equal(sysIdentity('x').canOverride, true)
  assert.equal(stateIdentity('x', 'Lagos').canOverride, false)
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. Self-edit and level
// ═════════════════════════════════════════════════════════════════════════════

test('nobody may change their own role', async () => {
  const me = await makeUser({ access_level: 'system_admin' }, 'system_admin')
  await assert.rejects(
    () => setUserRoleAndScope(sysIdentity(me), me, { role: 'facility', scopes: [] }),
    err => err instanceof AclAdminError && err.code === 'SELF_EDIT')
})

test('nobody may set an override on themselves', async () => {
  const me = await makeUser({ access_level: 'system_admin' }, 'system_admin')
  await assert.rejects(
    () => setUserOverride(sysIdentity(me), me, { permission_key: 'stock.write', effect: 'grant' }),
    err => err.code === 'SELF_EDIT')
})

test('a state_admin cannot assign a role above its own', async () => {
  const state = await someState()
  const actor = await makeUser({ access_level: 'state_admin', admin_state: state })
  const target = await makeUser({ access_level: 'state_viewer', admin_state: state }, 'state_viewer', [{ dimension: 'geography', scope_type: 'state', scope_id: state }])

  for (const role of ['overall_admin', 'system_admin']) {
    await assert.rejects(
      () => setUserRoleAndScope(stateIdentity(actor, state), target,
        { role, scopes: [] }),
      err => err.code === 'ABOVE_LEVEL', `${role} must be refused`)
  }
})

test('a state_admin cannot modify an account that already holds a higher role', async () => {
  const state = await someState()
  const actor = await makeUser({ access_level: 'state_admin', admin_state: state })
  // admin_state is set so the target passes the state confinement check and the
  // assertion isolates the RANK rule. Without it the state check rejects first —
  // also correct, but a different rule.
  const target = await makeUser({ access_level: 'overall_admin', admin_state: state }, 'overall_admin')
  await assert.rejects(
    () => setUserRoleAndScope(stateIdentity(actor, state), target,
      { role: 'facility', scopes: [] }),
    err => err.code === 'ABOVE_LEVEL',
    'checking only the REQUESTED role would let a state_admin demote an overall_admin')
})

test('a state_admin may assign a role at its own level', async () => {
  const state = await someState()
  const actor = await makeUser({ access_level: 'state_admin', admin_state: state })
  const target = await makeUser({ access_level: 'state_viewer', admin_state: state }, 'state_viewer', [{ dimension: 'geography', scope_type: 'state', scope_id: state }])

  const cfg = await setUserRoleAndScope(stateIdentity(actor, state), target, {
    role: 'state_admin',
    scopes: [{ dimension: 'geography', scope_type: 'state', scope_id: state }],
  })
  assert.equal(cfg.role, 'state_admin', 'equal rank is allowed — only strictly higher is refused')
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. State confinement
// ═════════════════════════════════════════════════════════════════════════════

test('a state_admin cannot even see a user outside its state', async () => {
  const mine = await someState()
  const theirs = await otherState(mine)
  const actor = await makeUser({ access_level: 'state_admin', admin_state: mine })
  const outside = await makeUser({ access_level: 'state_viewer', admin_state: theirs }, 'state_viewer', [{ dimension: 'geography', scope_type: 'state', scope_id: theirs }])

  await assert.rejects(
    () => getUserConfig(stateIdentity(actor, mine), outside),
    // 404 not 403: a state_admin must not be able to probe for accounts it does
    // not administer.
    err => err.code === 'NOT_FOUND' && err.status === 404)
})

test('the user list is confined to the state, and the system admin sees more', async () => {
  const mine = await someState()
  const actor = await makeUser({ access_level: 'state_admin', admin_state: mine })
  const stateList = await listUsers(stateIdentity(actor, mine), { limit: 200 })
  const allList = await listUsers(sysIdentity(actor), { limit: 200 })
  assert.ok(stateList.total > 0, 'non-vacuous')
  assert.ok(allList.total > stateList.total,
    'a national administrator must see strictly more than one state')
})

test('a state_admin cannot configure a feature outside its state', async () => {
  const mine = await someState()
  const theirs = await otherState(mine)
  const actor = await makeUser({ access_level: 'state_admin', admin_state: mine })
  const far = await facilityIn(theirs)
  await assert.rejects(
    () => setFeatureConfig(stateIdentity(actor, mine),
      { facility_id: far.id, department: 'pharmacy', feature: 'transfer', enabled: false }),
    err => err.code === 'OUT_OF_SCOPE')
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. Role/scope validation
// ═════════════════════════════════════════════════════════════════════════════

test('a role is refused without the geography shape it requires', async () => {
  const actor = await makeUser({ access_level: 'system_admin' })
  const target = await makeUser({}, 'facility')
  const state = await someState()

  // facility needs a facility scope, not a state one
  await assert.rejects(
    () => setUserRoleAndScope(sysIdentity(actor), target, {
      role: 'facility',
      scopes: [{ dimension: 'geography', scope_type: 'state', scope_id: state }],
    }), /scoped by facility/)

  // …and needs one at all
  await assert.rejects(
    () => setUserRoleAndScope(sysIdentity(actor), target, { role: 'facility', scopes: [] }),
    /needs exactly one facility scope/)
})

test('a national role is refused a geographic scope', async () => {
  const actor = await makeUser({ access_level: 'system_admin' })
  const target = await makeUser({}, 'facility')
  const state = await someState()
  for (const role of ['overall_admin', 'system_admin']) {
    await assert.rejects(
      () => setUserRoleAndScope(sysIdentity(actor), target, {
        role, scopes: [{ dimension: 'geography', scope_type: 'state', scope_id: state }],
      }), /national and must carry no geographic scope/,
      `${role} must stay unscoped — an empty scope means unconstrained`)
  }
})

test('an empty scope value is refused outright', async () => {
  const actor = await makeUser({ access_level: 'system_admin' })
  const target = await makeUser({}, 'facility')
  await assert.rejects(
    () => setUserRoleAndScope(sysIdentity(actor), target, {
      role: 'facility',
      scopes: [{ dimension: 'geography', scope_type: 'facility', scope_id: '  ' }],
    }), /cannot be empty/,
    'an empty scope_id reads as UNCONSTRAINED to the resolver — a typo must not become a grant')
})

test('an undeclared section is refused', async () => {
  const actor = await makeUser({ access_level: 'system_admin' })
  const target = await makeUser({}, 'facility')
  const f = await facilityIn(await someState())
  await assert.rejects(
    () => setUserRoleAndScope(sysIdentity(actor), target, {
      role: 'facility',
      scopes: [
        { dimension: 'geography', scope_type: 'facility', scope_id: f.id },
        { dimension: 'commodity', scope_type: 'section', scope_id: 'tools' },
      ],
    }), /not a declared section/,
    'an undeclared section resolves to no categories — it must not be storable')
})

test('an unknown role is refused', async () => {
  const actor = await makeUser({ access_level: 'system_admin' })
  const target = await makeUser({}, 'facility')
  await assert.rejects(
    () => setUserRoleAndScope(sysIdentity(actor), target, { role: 'root', scopes: [] }),
    /Unknown role/)
})

test('a successful write replaces role and scope together, and preserves the module row', async () => {
  const actor = await makeUser({ access_level: 'system_admin' })
  const state = await someState()
  const f = await facilityIn(state)
  const target = await makeUser({}, 'facility', [
    { dimension: 'geography', scope_type: 'facility', scope_id: f.id },
    { dimension: 'module', scope_type: 'module', scope_id: 'hiv' },
  ])

  const cfg = await setUserRoleAndScope(sysIdentity(actor), target, {
    role: 'state_viewer',
    scopes: [
      { dimension: 'geography', scope_type: 'state', scope_id: state },
      { dimension: 'module', scope_type: 'module', scope_id: 'hiv' },
    ],
  })
  assert.equal(cfg.role, 'state_viewer')
  const dims = cfg.scopes.map(s => `${s.dimension}:${s.scope_type}=${s.scope_id}`).sort()
  assert.deepEqual(dims, [`geography:state=${state}`, 'module:module=hiv'].sort(),
    'the old facility scope is gone and the module row survived')
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. Overrides
// ═════════════════════════════════════════════════════════════════════════════

test('a state_admin cannot set a direct override', async () => {
  const state = await someState()
  const actor = await makeUser({ access_level: 'state_admin', admin_state: state })
  const target = await makeUser({ access_level: 'state_viewer', admin_state: state }, 'state_viewer', [{ dimension: 'geography', scope_type: 'state', scope_id: state }])
  await assert.rejects(
    () => setUserOverride(stateIdentity(actor, state), target,
      { permission_key: 'stock.write', effect: 'grant' }),
    err => err.code === 'FORBIDDEN')
})

test('system_admin sets and clears an override, and the split is reported', async () => {
  const actor = await makeUser({ access_level: 'system_admin' })
  const state = await someState()
  const target = await makeUser({ access_level: 'state_viewer', admin_state: state }, 'state_viewer', [{ dimension: 'geography', scope_type: 'state', scope_id: state }])

  const before = (await getUserConfig(sysIdentity(actor), target)).permissions
    .find(p => p.key === 'stock.write')
  assert.deepEqual(
    { inherited: before.inherited, override: before.override, effective: before.effective },
    { inherited: false, override: null, effective: false }, 'state_viewer holds no writes')

  const granted = (await setUserOverride(sysIdentity(actor), target,
    { permission_key: 'stock.write', effect: 'grant' })).permissions.find(p => p.key === 'stock.write')
  assert.deepEqual(
    { inherited: granted.inherited, override: granted.override, effective: granted.effective },
    { inherited: false, override: 'grant', effective: true },
    'a direct grant must be reported as DIRECT, never as inherited')

  // A deny on something the role does carry — the other half of the split.
  const denied = (await setUserOverride(sysIdentity(actor), target,
    { permission_key: 'stock.read', effect: 'deny' })).permissions.find(p => p.key === 'stock.read')
  assert.deepEqual(
    { inherited: denied.inherited, override: denied.override, effective: denied.effective },
    { inherited: true, override: 'deny', effective: false },
    'deny beats the role grant, and the UI can still see the role grant underneath')

  const cleared = (await setUserOverride(sysIdentity(actor), target,
    { permission_key: 'stock.read', effect: null })).permissions.find(p => p.key === 'stock.read')
  assert.equal(cleared.override, null)
  assert.equal(cleared.effective, true, 'clearing falls back to the role, not to denied')
})

test('an unknown permission key cannot be granted', async () => {
  const actor = await makeUser({ access_level: 'system_admin' })
  const target = await makeUser({}, 'facility')
  await assert.rejects(
    () => setUserOverride(sysIdentity(actor), target,
      { permission_key: 'stock.obliterate', effect: 'grant' }),
    /Unknown permission/)
})

test('an override effect other than grant/deny is refused', async () => {
  const actor = await makeUser({ access_level: 'system_admin' })
  const target = await makeUser({}, 'facility')
  await assert.rejects(
    () => setUserOverride(sysIdentity(actor), target,
      { permission_key: 'stock.write', effect: 'maybe' }),
    /grant.*deny/)
})

// ═════════════════════════════════════════════════════════════════════════════
// 6. Feature configuration is deny-only
// ═════════════════════════════════════════════════════════════════════════════

test('disabling stores a row; enabling DELETES it rather than storing true', async () => {
  const actor = await makeUser({ access_level: 'system_admin' })
  const state = await someState()
  const f = await facilityIn(state)
  const id = sysIdentity(actor)

  try {
    await setFeatureConfig(id, { facility_id: f.id, department: 'pharmacy', feature: 'transfer', enabled: false })
    const { rows: off } = await query(
      `select enabled from feature_config where facility_id = $1 and department = 'pharmacy' and feature = 'transfer'`,
      [f.id])
    assert.deepEqual(off, [{ enabled: false }])

    await setFeatureConfig(id, { facility_id: f.id, department: 'pharmacy', feature: 'transfer', enabled: true })
    const { rows: on } = await query(
      `select enabled from feature_config where facility_id = $1 and department = 'pharmacy' and feature = 'transfer'`,
      [f.id])
    assert.deepEqual(on, [],
      'an absent row already means enabled — storing enabled = true would be a second representation of the same state, and the first step towards reading configuration as a grant')
  } finally {
    await query(`delete from feature_config where facility_id = $1`, [f.id])
  }
})

test('departments are configured independently at the same facility', async () => {
  const actor = await makeUser({ access_level: 'system_admin' })
  const f = await facilityIn(await someState())
  const id = sysIdentity(actor)
  try {
    await setFeatureConfig(id, { facility_id: f.id, department: 'pharmacy', feature: 'transfer', enabled: false })
    const rows = await listFeatureConfig(id)
    const mine = rows.filter(r => r.facility_id === f.id)
    assert.deepEqual(mine.map(r => r.department), ['pharmacy'],
      'switching pharmacy off must not touch lab — the example from the brief')
  } finally {
    await query(`delete from feature_config where facility_id = $1`, [f.id])
  }
})

test('an undeclared feature cannot be created from the API', async () => {
  const actor = await makeUser({ access_level: 'system_admin' })
  const f = await facilityIn(await someState())
  await assert.rejects(
    () => setFeatureConfig(sysIdentity(actor),
      { facility_id: f.id, department: 'pharmacy', feature: 'teleportation', enabled: false }),
    /not a declared feature/,
    'features are declared in code so a typo cannot create one that nothing enforces')
})

test('an undeclared department cannot be configured', async () => {
  const actor = await makeUser({ access_level: 'system_admin' })
  const f = await facilityIn(await someState())
  await assert.rejects(
    () => setFeatureConfig(sysIdentity(actor),
      { facility_id: f.id, department: 'radiology', feature: 'transfer', enabled: false }),
    /not a declared section/)
})

// ═════════════════════════════════════════════════════════════════════════════
// 7. The screens cannot be the boundary
// ═════════════════════════════════════════════════════════════════════════════

test('facility_role is reported but is not writable', async () => {
  const actor = await makeUser({ access_level: 'system_admin' })
  const f = await facilityIn(await someState())
  const target = await makeUser({ facility_role: 'store_manager', facility_id: f.id }, 'facility', [{ dimension: 'geography', scope_type: 'facility', scope_id: f.id }])

  const cfg = await getUserConfig(sysIdentity(actor), target)
  assert.equal(cfg.legacy.facility_role, 'store_manager', 'shown, so its display-only nature is visible')
  // There is deliberately no service method that writes it: a frontend-only
  // field must never become an authorization source.
  assert.equal(typeof setUserRoleAndScope, 'function')
  const after = await getUserConfig(sysIdentity(actor), target)
  assert.equal(after.legacy.facility_role, 'store_manager', 'unchanged by any write path here')
})

test('editable is false for self and for a higher role', async () => {
  const state = await someState()
  const me = await makeUser({ access_level: 'state_admin', admin_state: state }, 'state_admin', [{ dimension: 'geography', scope_type: 'state', scope_id: state }])
  const higher = await makeUser({ access_level: 'overall_admin' }, 'overall_admin')

  const own = await getUserConfig(stateIdentity(me, state), me)
  assert.equal(own.editable, false, 'the UI is told, and the service enforces it anyway')

  const up = await getUserConfig(sysIdentity(me), higher)
  assert.equal(up.editable, true, 'a system_admin outranks overall_admin')
})
