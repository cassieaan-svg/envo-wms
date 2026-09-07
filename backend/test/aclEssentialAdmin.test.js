// Phase 2M.2 — the essential_admin identity, and the module scope it was missing.
//
// THE DEFECT UNDER GUARD. Phase 2M excluded essential_admin from the
// `module = hiv` backfill but never gave it `module = essential`, and an absent
// dimension means UNCONSTRAINED — so the role reached every module. Nothing was
// exposed (no account held it), but the first test below is the regression guard
// that stops it coming back.
//
// Everything else follows the system_admin pattern: a recognised administrative
// identity with no operational access, proven by exercising the real guards
// rather than by reasoning about them.
//
//   npm test --prefix backend

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import jwt from 'jsonwebtoken'
import { query, pool } from '../src/db.js'
import {
  attachScope, enforceFacilityRead, enforceFacilityWrite, scopedReadFacilityIds,
  isAdminScope, mayWriteTransferFacility,
} from '../src/middleware/scope.js'
import { authMiddleware } from '../src/middleware/auth.js'
import commodityRoutes from '../src/routes/commodities.js'
import { AclResolver } from '../src/services/aclResolver.js'
import {
  adminIdentity, listUsers, getUserConfig, setUserRoleAndScope,
  listFeatureConfig, setFeatureConfig,
} from '../src/services/aclAdminService.js'

const EMAIL = 'ec.akwaibom@envo.ng'
const SCOPED_TABLES = ['stock', 'dsd_stock', 'sdp_stock', 'transfers',
                       'dispense_log', 'intake_log', 'adjustment_log']

let server
test.after(async () => { server?.close(); await pool.end() })

const meta = { access_level: 'essential_admin', admin_state: 'Akwa Ibom', email_verified: true }

function scopeFor(m) {
  const req = { user: { user_metadata: m }, query: {} }
  attachScope(req, {}, () => {})
  return req
}
const fakeRes = () => ({ status: () => ({ json: () => {} }) })

async function ecUser() {
  const { rows } = await query(`select id from users where email = $1`, [EMAIL])
  if (!rows.length) throw new Error(`no ${EMAIL} — run scripts/addEssentialAdmin.mjs`)
  return rows[0].id
}
const facilityInState = async () =>
  (await query(`select id from facilities where state = 'Akwa Ibom' limit 1`)).rows[0].id
const itemIn = async module =>
  (await query(`select id from commodities where module = $1 limit 1`, [module])).rows[0].id

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE REGRESSION GUARD — module confinement
// ═════════════════════════════════════════════════════════════════════════════

test('the account carries exactly one module scope, and it is essential', async () => {
  const { rows } = await query(
    `select scope_id from user_role_scopes where user_id = $1 and dimension = 'module'`,
    [await ecUser()])
  assert.deepEqual(rows.map(r => r.scope_id), ['essential'],
    'zero rows here means UNCONSTRAINED, which is how this role reached HIV before Phase 2M.2')
})

test('it reaches Essential commodities and is refused HIV ones', async () => {
  const u = await ecUser()
  const facilityId = await facilityInState()

  const ess = await AclResolver.can(u, 'stock.write',
    { facilityId, commodityId: await itemIn('essential') })
  assert.equal(ess.decision, true, 'its own module')

  const hiv = await AclResolver.can(u, 'stock.write',
    { facilityId, commodityId: await itemIn('hiv') })
  assert.equal(hiv.decision, false, 'THE FIX — this was true before Phase 2M.2')
  assert.equal(hiv.reason, 'commodity outside module scope')
})

test('no role holds a module scope it should not', async () => {
  const { rows } = await query(`
    select r.name, s.scope_id, count(*)::int n
      from user_role_scopes s
      join user_roles ur on ur.user_id = s.user_id and ur.role_id = s.role_id
      join roles r on r.id = ur.role_id
      join users u on u.id = s.user_id
     where s.dimension = 'module' and u.email not like '%.invalid'
     group by 1, 2 order by 1`)
  for (const r of rows) {
    const expected = r.name === 'essential_admin' ? 'essential' : 'hiv'
    assert.equal(r.scope_id, expected, `${r.name} must be scoped to ${expected}`)
  }
  assert.ok(rows.some(r => r.name === 'essential_admin'), 'non-vacuous')
  assert.ok(rows.some(r => r.scope_id === 'hiv'), 'non-vacuous')
})

test('system_admin still has NO module scope — national means unscoped', async () => {
  const { rows } = await query(`
    select count(*)::int n from user_role_scopes s
      join user_roles ur on ur.user_id = s.user_id
      join roles r on r.id = ur.role_id
     where r.name = 'system_admin' and s.dimension = 'module'`)
  assert.equal(rows[0].n, 0,
    'the 2M.2 migration must not have swept system_admin into a module')
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. No operational access, via the real guards
// ═════════════════════════════════════════════════════════════════════════════

test('every facility-scoped table denies both read and write', async () => {
  const req = scopeFor(meta)
  const facilityId = await facilityInState()
  for (const table of SCOPED_TABLES) {
    assert.equal(await enforceFacilityRead(req, fakeRes(), facilityId, table), false, `${table} read`)
    assert.equal(await enforceFacilityWrite(req, fakeRes(), facilityId, table), false, `${table} write`)
  }
})

test('admin_state narrows nothing — the stock scope is empty, not the whole state', async () => {
  // The subtle one. attachScope DOES record adminState, but
  // narrowedAdminFacilityIds only applies it to state_admin/state_viewer/
  // cluster_admin/lga_admin, and it is consulted only after isReadAdmin has
  // already returned true — which never happens for this role.
  const req = scopeFor(meta)
  assert.equal(req.scope.adminState, 'Akwa Ibom', 'the field is set…')
  assert.deepEqual(await scopedReadFacilityIds(req, 'stock'), [],
    '…and grants nothing: [] is nothing, not null')
  assert.equal(req.scope.facilityId, null)
  assert.equal(req.scope.isAdmin, false)
  assert.equal(isAdminScope(req.scope), false)
  assert.equal(await mayWriteTransferFacility(req, await facilityInState()), false)
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. Administrative identity
// ═════════════════════════════════════════════════════════════════════════════

test('it gets an identity, confined to BOTH its state and its module', async () => {
  const id = adminIdentity({ accessLevel: 'essential_admin', adminState: 'Akwa Ibom' }, 'actor')
  assert.equal(id.kind, 'essential_admin')
  assert.equal(id.state, 'Akwa Ibom')
  assert.equal(id.module, 'essential')
  assert.equal(id.canOverride, false, 'direct overrides stay with system_admin alone')
})

test('an essential_admin with no state gets no identity', async () => {
  assert.equal(adminIdentity({ accessLevel: 'essential_admin', adminState: null }, 'a'), null)
})

test('its user list contains only Essential-module accounts', async () => {
  const actor = await ecUser()
  const id = adminIdentity({ accessLevel: 'essential_admin', adminState: 'Akwa Ibom' }, actor)
  const { users } = await listUsers(id, { limit: 200 })
  assert.ok(users.length > 0, 'non-vacuous — it can see itself at least')
  for (const u of users) {
    const { rows } = await query(
      `select scope_id from user_role_scopes where user_id = $1 and dimension = 'module'`, [u.id])
    assert.deepEqual(rows.map(r => r.scope_id), ['essential'],
      `${u.email} is not an Essential account and must not be listed`)
  }
})

test('it cannot open an HIV account, even one in its own state', async () => {
  const actor = await ecUser()
  const id = adminIdentity({ accessLevel: 'essential_admin', adminState: 'Akwa Ibom' }, actor)
  const { rows } = await query(`
    select u.id from user_roles ur
      join users u on u.id = ur.user_id
      join user_role_scopes s on s.user_id = u.id and s.dimension = 'module'
     where s.scope_id = 'hiv' and u.raw_user_meta_data->>'admin_state' = 'Akwa Ibom'
     limit 1`)
  if (!rows.length) return
  await assert.rejects(
    () => getUserConfig(id, rows[0].id),
    err => err.code === 'NOT_FOUND',
    '404, not 403 — it must not be able to probe for accounts it does not administer')
})

test('it cannot write a scope outside its own module', async () => {
  const actor = await ecUser()
  const id = adminIdentity({ accessLevel: 'essential_admin', adminState: 'Akwa Ibom' }, actor)
  const target = await ecUser() // self — but the module check runs first
  for (const scopes of [
    [{ dimension: 'module', scope_type: 'module', scope_id: 'hiv' }],
    [], // omitting the module row entirely means UNCONSTRAINED
  ]) {
    await assert.rejects(
      () => setUserRoleAndScope(id, target, { role: 'facility', scopes }),
      err => err.code === 'OUT_OF_MODULE' || err.code === 'SELF_EDIT',
      'neither another module nor an absent one may be written')
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. Feature configuration is not its surface
// ═════════════════════════════════════════════════════════════════════════════

test('feature configuration is empty and unwritable for it', async () => {
  const actor = await ecUser()
  const id = adminIdentity({ accessLevel: 'essential_admin', adminState: 'Akwa Ibom' }, actor)
  assert.deepEqual(await listFeatureConfig(id), [],
    'features are keyed by SECTION, and sections belong to the HIV module')
  const facilityId = await facilityInState()
  await assert.rejects(
    () => setFeatureConfig(id, {
      facility_id: facilityId, department: 'pharmacy', feature: 'transfer', enabled: false,
    }),
    err => err.code === 'OUT_OF_MODULE')
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. Catalogue — may add Essential items only
// ═════════════════════════════════════════════════════════════════════════════

test('the catalogue accepts an Essential item and refuses an HIV one', async () => {
  const app = express()
  app.use(express.json())
  app.use('/api', authMiddleware, attachScope)
  app.use('/api/commodities', commodityRoutes)
  server = app.listen(5098)

  const token = m => jwt.sign({ sub: '00000000-0000-0000-0000-000000000001', email: EMAIL, user_metadata: m },
    process.env.JWT_SECRET, { expiresIn: '5m' })
  const post = async (m, body) => {
    const r = await fetch('http://localhost:5098/api/commodities', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token(m)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return [r.status, await r.json()]
  }

  const name = `phase2m2 probe ${Date.now()}`
  try {
    // The shared catalogue is ONE table, so "may add items" is not the whole
    // question — an Essential administrator writing an `hiv` membership would be
    // editing another programme's master data through a shared endpoint.
    const [hivStatus, hivBody] = await post(meta,
      { name: `${name} hiv`, memberships: [{ module: 'hiv' }] })
    assert.equal(hivStatus, 403, 'must not create an HIV catalogue item')
    assert.match(hivBody.error, /only add catalogue items to: essential/)

    const [essStatus] = await post(meta,
      { name, memberships: [{ module: 'essential' }] })
    assert.equal(essStatus, 201, 'its own module is allowed')

    // A facility user is still refused entirely — this widened the guard for one
    // role, not for everyone.
    const [facStatus] = await post({ access_level: 'facility' },
      { name: `${name} nope`, memberships: [{ module: 'essential' }] })
    assert.equal(facStatus, 403)
  } finally {
    await query(`delete from commodity_modules where commodity_id in
                   (select id from commodities where name like $1)`, [`${name}%`])
    await query(`delete from commodities where name like $1`, [`${name}%`])
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// 6. Nothing changed for anyone else
// ═════════════════════════════════════════════════════════════════════════════

test('no existing role gained or lost a permission', async () => {
  const { rows } = await query(`
    select r.name, count(*)::int n from role_permissions rp
      join roles r on r.id = rp.role_id group by 1 order by 1`)
  assert.deepEqual(rows, [
    { name: 'cluster_admin', n: 15 },
    { name: 'essential_admin', n: 26 },
    { name: 'facility', n: 23 },
    { name: 'lga_admin', n: 15 },
    { name: 'overall_admin', n: 15 },
    { name: 'state_admin', n: 26 },
    { name: 'state_viewer', n: 15 },
    { name: 'system_admin', n: 3 },
  ], 'the permission mismatch was DEFERRED, not silently corrected')
})

test('overall_admin is still the only unrestricted catalogue manager', async () => {
  // The widening was one role, scoped to one module. Everything else is as it was.
  const { rows } = await query(`select count(*)::int n from commodities where module = 'hiv'`)
  assert.ok(rows[0].n > 0, 'HIV catalogue intact')
})
