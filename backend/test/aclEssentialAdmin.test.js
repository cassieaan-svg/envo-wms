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

test('the account carries EXACTLY ONE module scope: essential', async () => {
  // Phase 2M.2 confined it to `essential`, which fixed the real defect (an
  // ABSENT module row means unconstrained). Phase 2M.2c widened it to both, so
  // one administrator could work across programmes — and that reopened the hole
  // from the other side, because this dimension is read by the RESOLVER and
  // means operational reach, not administrative capability. See audit finding
  // B-2 and 20260908_acl_essential_admin_module_boundary.sql.
  //
  // Two invariants, not one. The row must be EXPLICIT (zero rows means every
  // module, including any added later) and it must be ALONE (a second row ORs
  // and reopens B-2).
  const { rows } = await query(
    `select scope_id from user_role_scopes
      where user_id = $1 and dimension = 'module' order by scope_id`,
    [await ecUser()])
  assert.deepEqual(rows.map(r => r.scope_id), ['essential'])
})

test('it reads its own module only, and the sections bound it further', async () => {
  const u = await ecUser()
  const facilityId = await facilityInState()

  assert.equal(await AclResolver.moduleCovers(u, await itemIn('essential')), true,
    'the module dimension covers essential')
  assert.equal(await AclResolver.moduleCovers(u, await itemIn('hiv')), false,
    'and does not cover hiv — the B-2 boundary')

  // Essential items are READABLE. This is what the `essential` section fixed:
  // sections AND with the module dimension, so while the only sections were
  // pharmacy and lab, an Essential-module item matched no section and was
  // refused however wide the module scope was.
  assert.equal((await AclResolver.can(u, 'stock.read',
    { facilityId, commodityId: await itemIn('essential') })).decision, true,
    'an Essential item is reachable through the essential section')

  // HIV Pharmacy drugs are NOT — the finding this fix closes. The account still
  // carries the `pharmacy` SECTION (Phase 2M.2d's confirmed shape, shared with
  // the 194 grantees), so the commodity dimension admits this item; the module
  // dimension is what refuses it, and the two AND. That makes the module row the
  // single guard here, which is exactly why it is asserted directly above.
  const pharmDrug = (await query(
    `select id from commodities where category = 'Pharmacy drugs' limit 1`)).rows[0].id
  assert.equal(await AclResolver.commodityCovers(u, pharmDrug), true,
    'the pharmacy section still admits it on the commodity dimension')
  for (const perm of ['stock.read', 'stock.write']) {
    const r = await AclResolver.can(u, perm, { facilityId, commodityId: pharmDrug })
    assert.equal(r.decision, false, `${perm} on an HIV Pharmacy drug must be refused`)
    assert.match(r.reason, /module/, 'and refused BY THE MODULE DIMENSION, not incidentally')
  }

  // The sections are still a boundary, not a formality: lab is not among them.
  assert.equal((await AclResolver.can(u, 'stock.read',
    { facilityId, commodityId: (await query(
      `select id from commodities where category = 'Lab consumables' limit 1`)).rows[0].id })).decision,
    false, 'lab is outside its sections')

  // THE ASYMMETRY. Essential sees HIV; HIV must NOT see Essential. Checked
  // against a real HIV administrator, because it is the half that protects a
  // programme boundary rather than the half that opens one.
  const { rows: hivAdmin } = await query(`
    select u.id, u.raw_user_meta_data->>'admin_state' state
      from users u join user_roles ur on ur.user_id = u.id
      join roles r on r.id = ur.role_id
     where r.name = 'state_admin' and u.email not like '%.invalid' and u.email not like 'probe.create.%'
       and (u.raw_user_meta_data->>'essential') is null
       and u.raw_user_meta_data->>'admin_state' is not null limit 1`)
  const { rows: fac } = await query(
    `select id from facilities where state = $1 limit 1`, [hivAdmin[0].state])
  const crossed = await AclResolver.can(hivAdmin[0].id, 'stock.read',
    { facilityId: fac[0].id, commodityId: await itemIn('essential') })
  assert.equal(crossed.decision, false, 'an HIV administrator must never reach Essential')
  assert.equal(crossed.reason, 'commodity outside module scope')

  // …and is not simply denied everything.
  const own = await AclResolver.can(hivAdmin[0].id, 'stock.read',
    { facilityId: fac[0].id, commodityId: await itemIn('hiv') })
  assert.equal(own.decision, true, 'non-vacuous: it still reads its own module')
})

test('an account holds an essential module scope only if it was granted one', async () => {
  // Not "one module each": 194 DUAL-module logins hold both, because
  // meta.essential grants HIV *and* Essential (see
  // 20260907_acl_dual_module_logins.sql). The invariant that actually matters is
  // that `essential` is never present without the grant behind it.
  const { rows } = await query(`
    select u.email,
           (u.raw_user_meta_data->>'essential')::boolean granted,
           r.name role
      from user_role_scopes s
      join user_roles ur on ur.user_id = s.user_id and ur.role_id = s.role_id
      join roles r on r.id = ur.role_id
      join users u on u.id = s.user_id
     where s.dimension = 'module' and s.scope_id = 'essential'
       and u.email not like '%.invalid'
       and u.email not like 'probe.create.%'`)
  assert.ok(rows.length > 0, 'non-vacuous')
  for (const r of rows) {
    assert.ok(r.granted === true || r.role === 'essential_admin',
      `${r.email} holds Essential module scope without meta.essential or the essential_admin role`)
  }
})

test('every dual-module login keeps its HIV half', async () => {
  // The failure this guards is silent: dropping the hiv row would leave a
  // pharmacy-section login with no reachable HIV category, and — because scope
  // ANDs across dimensions — nothing visible at all.
  const { rows } = await query(`
    select count(*)::int n from users u
     where (u.raw_user_meta_data->>'essential')::boolean is true
       and u.email not like '%.invalid' and u.email not like 'probe.create.%'
       and not exists (select 1 from user_role_scopes s
                        where s.user_id = u.id and s.dimension = 'module' and s.scope_id = 'hiv')`)
  assert.equal(rows[0].n, 0)
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

test('its user list contains only accounts granted the Essential module', async () => {
  const actor = await ecUser()
  const id = adminIdentity({ accessLevel: 'essential_admin', adminState: 'Akwa Ibom' }, actor)
  const { users } = await listUsers(id, { limit: 400 })
  assert.ok(users.length > 0, 'non-vacuous — it can see itself at least')

  // Dual-module logins ARE its users: meta.essential grants both modules, so
  // "only Essential-module accounts" means "holds an essential row", not "holds
  // nothing else".
  //
  // 'probe.create.%' accounts are skipped: aclAdminApi's createUser tests mint
  // REAL @envo.ng logins (that is the point of createUser), and one can be
  // deleted by its own cleanup between the listing above and the check below.
  for (const u of users) {
    if (u.email.startsWith('probe.create.')) continue
    const { rows } = await query(
      `select 1 from user_role_scopes
        where user_id = $1 and dimension = 'module' and scope_id = 'essential'`, [u.id])
    assert.equal(rows.length, 1, `${u.email} has no Essential grant and must not be listed`)
  }
  assert.equal(new Set(users.map(u => u.email)).size, users.length,
    'a dual-module account holds two module rows and must not be listed twice')
})

test('an HIV-only account is not in its list', async () => {
  const actor = await ecUser()
  const id = adminIdentity({ accessLevel: 'essential_admin', adminState: 'Akwa Ibom' }, actor)
  const { users } = await listUsers(id, { limit: 400 })
  const emails = new Set(users.map(u => u.email))
  const { rows } = await query(`
    select u.email from users u
     where u.raw_user_meta_data->>'admin_state' = 'Akwa Ibom'
       and (u.raw_user_meta_data->>'essential') is null
       and u.email not like '%.invalid' and u.email not like 'probe.create.%'
     limit 5`)
  assert.ok(rows.length > 0, 'non-vacuous')
  for (const r of rows) assert.ok(!emails.has(r.email), `${r.email} is HIV-only and must be hidden`)
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

test('it may grant a module it does not itself hold, but not escape its own remit', async () => {
  // GRANTING A MODULE IS NOT HOLDING ONE. The Essential programme's store
  // managers are dual-module logins, so minting one is part of this role's job —
  // while its OWN operational reach stays {essential} (audit finding B-2). The
  // two questions are answered by identity.grantableModules and the actor's
  // user_role_scopes rows respectively, and they are deliberately different.
  //
  // This test also used to pass for the wrong reason: its target was the ACTOR
  // ITSELF, so SELF_EDIT fired before the module check ran and the assertion —
  // which accepted either code — never exercised what its name claimed.
  const actor = await ecUser()
  const id = adminIdentity({ accessLevel: 'essential_admin', adminState: 'Akwa Ibom' }, actor)
  assert.deepEqual(id.grantableModules, ['essential', 'hiv'])
  assert.equal(id.module, 'essential', 'whose accounts it administers is a narrower set')

  const { rows: other } = await query(`
    select u.id from users u
      join user_roles ur on ur.user_id = u.id
      join roles r on r.id = ur.role_id
      join user_role_scopes s on s.user_id = u.id and s.dimension = 'module'
     where r.name = 'facility' and s.scope_id = 'essential' and u.id <> $1
       and u.email not like '%.invalid' and u.email not like 'probe.create.%'
     limit 1`, [actor])
  if (!other.length) return // no Essential grantee seeded here
  const target = other[0].id

  // REFUSED: an account it could not afterwards administer, or an unconstrained one.
  for (const [scopes, why] of [
    [[{ dimension: 'module', scope_type: 'module', scope_id: 'hiv' }],
     'hiv alone — listUsers filters on essential, so it could never see this account again'],
    [[], 'no module row at all means unconstrained across every module'],
  ]) {
    await assert.rejects(
      () => setUserRoleAndScope(id, target, { role: 'facility', scopes }),
      err => err.code === 'OUT_OF_MODULE', why)
  }

  // ALLOWED: dual-module, and single-module within its own programme.
  //
  // Only the module dimension varies — the account's real geography and section
  // rows are carried through unchanged, both because the facility role requires
  // exactly one facility scope and because a test that rewrote them would be
  // proving something other than what it claims. Restored in a finally, so the
  // suite leaves the account as it found it.
  const scopeRows = async () => (await query(
    `select dimension, scope_type, scope_id from user_role_scopes
      where user_id = $1 order by dimension, scope_id`, [target])).rows
  const modulesOf = rows => rows.filter(r => r.dimension === 'module').map(r => r.scope_id).sort()
  const before = await scopeRows()
  const others = before.filter(r => r.dimension !== 'module')
  try {
    for (const asked of [['essential', 'hiv'], ['essential']]) {
      await setUserRoleAndScope(id, target, {
        role: 'facility',
        scopes: [...others,
          ...asked.map(m => ({ dimension: 'module', scope_type: 'module', scope_id: m }))],
      })
      assert.deepEqual(modulesOf(await scopeRows()), [...asked].sort(),
        `granting {${asked}} must be permitted`)
    }
  } finally {
    await setUserRoleAndScope(id, target, { role: 'facility', scopes: before })
  }
  assert.deepEqual(await scopeRows(), before, 'the target account was left as found')

  // AND THE POINT OF ALL THIS: granting hiv did not give the ACTOR hiv.
  const mine = (await query(
    `select scope_id from user_role_scopes
      where user_id = $1 and dimension = 'module' order by scope_id`, [actor])).rows.map(r => r.scope_id)
  assert.deepEqual(mine, ['essential'],
    'the administrator handed out a module it still does not hold')
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
  server = app.listen(0)

  const token = m => jwt.sign({ sub: '00000000-0000-0000-0000-000000000001', email: EMAIL, user_metadata: m },
    process.env.JWT_SECRET, { expiresIn: '5m' })
  const post = async (m, body) => {
    const r = await fetch(`http://localhost:${server.address().port}/api/commodities`, {
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
  // Excludes aclFoundation's throwaway 'aclschematest_%' roles, which are created
  // and dropped concurrently and would otherwise appear as extra rows here.
  const { rows } = await query(`
    select r.name, count(*)::int n from role_permissions rp
      join roles r on r.id = rp.role_id
     where r.name not like 'aclschematest_%'
     group by 1 order by 1`)
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
