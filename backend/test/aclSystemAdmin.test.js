// Phase 2M.1 — the system_admin identity.
//
// The claim under test is narrow and load-bearing: adding a NEW access_level
// grants NO operational access, and changes NOTHING for any existing role.
//
// Both halves matter. scope.js was not modified to support system_admin — the
// value simply matches nothing in READ_ADMIN_LEVELS/WRITE_ADMIN_LEVELS, and the
// account carries no facility_id for the `facilityId === scope.facilityId`
// fallback to latch onto. That is two independent denials, and these tests pin
// both so a later "convenience" edit — handing the account a facility to make a
// screen render — fails loudly.
//
// Shadow-only: the resolver is exercised directly, never through a request path.
//
//   npm test --prefix backend

import test from 'node:test'
import assert from 'node:assert/strict'
import { query, pool } from '../src/db.js'
import {
  attachScope, enforceFacilityRead, enforceFacilityWrite, scopedReadFacilityIds,
  isAdminScope, mayWriteTransferFacility, scopedCategories,
} from '../src/middleware/scope.js'
import { AclResolver } from '../src/services/aclResolver.js'

test.after(async () => { await pool.end() })

const SYS_EMAIL = 'sysadmin@envo.ng'

// Tables with a real per-facility policy. amc_settings/commodities/facilities are
// deliberately absent: READ_ADMIN_LEVELS marks them 'public', so EVERY
// authenticated account reads them and they prove nothing about this one.
const SCOPED_TABLES = ['stock', 'dsd_stock', 'sdp_stock', 'transfers',
                       'dispense_log', 'intake_log', 'adjustment_log']
const PUBLIC_TABLES = ['amc_settings', 'commodities', 'facilities']

const OPERATIONAL_KEYS = [
  'stock.read', 'stock.write', 'dsd_stock.write', 'sdp_stock.write',
  'transfer.read', 'transfer.write', 'dispense_log.write', 'intake_log.write',
  'adjustment_log.write', 'amc_settings.write', 'report.read', 'activity.read',
  'bincard.read', 'commodity.read', 'facility.read', 'system.diagnostics.read',
]
const USER_ADMIN_KEYS = ['user.read', 'user.write', 'user_permission.write']

function scopeFor(meta) {
  const req = { user: { user_metadata: meta }, query: {} }
  attachScope(req, {}, () => {})
  return req
}
const fakeRes = () => ({ status: () => ({ json: () => {} }) })

const sysMeta = { access_level: 'system_admin', email_verified: true }

async function sysUser() {
  const { rows } = await query(`select id from users where email = $1`, [SYS_EMAIL])
  if (!rows.length) throw new Error(`no ${SYS_EMAIL} — run scripts/addSystemAdmin.mjs`)
  return rows[0].id
}
const anyFacility = async () => (await query(`select id from facilities limit 1`)).rows[0].id

// ═════════════════════════════════════════════════════════════════════════════
// 1. attachScope: recognised, and carrying nothing
// ═════════════════════════════════════════════════════════════════════════════

test('attachScope surfaces the level but grants no identity to hang access on', async () => {
  const { scope } = scopeFor(sysMeta)
  assert.equal(scope.accessLevel, 'system_admin')
  assert.equal(scope.isAdmin, false, 'must NOT be the overall-admin flag')
  assert.equal(scope.facilityId, null, 'no facility — this is half of why every guard denies')
  assert.equal(scope.adminState, null)
  assert.equal(scope.adminLga, null)
  assert.equal(scope.adminCluster, null)
})

test('isAdminScope is false, so the diagnostics surface stays shut', async () => {
  assert.equal(isAdminScope(scopeFor(sysMeta).scope), false)
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. The denial table — asserted, not observed
// ═════════════════════════════════════════════════════════════════════════════

test('every facility-scoped table denies both read and write', async () => {
  const req = scopeFor(sysMeta)
  const facilityId = await anyFacility()
  for (const table of SCOPED_TABLES) {
    assert.equal(await enforceFacilityRead(req, fakeRes(), facilityId, table), false,
      `${table}: read must deny`)
    assert.equal(await enforceFacilityWrite(req, fakeRes(), facilityId, table), false,
      `${table}: write must deny`)
  }
})

test('the stock list resolves to an empty scope, not an unconstrained one', async () => {
  // The dangerous failure would be `null`, which every caller reads as "all
  // facilities". [] is "nothing".
  const ids = await scopedReadFacilityIds(scopeFor(sysMeta), 'stock')
  assert.deepEqual(ids, [], 'must be the empty set, never null')
})

test('it cannot be a party to a transfer at any facility', async () => {
  assert.equal(await mayWriteTransferFacility(scopeFor(sysMeta), await anyFacility()), false)
})

test('the public tables behave EXACTLY as they do for a state_viewer', async () => {
  // These three are 'public' in READ_ADMIN_LEVELS — every authenticated account
  // reads them. Compared against another account rather than asserted as `true`,
  // so this documents "no new exposure" instead of "some exposure is fine".
  const sys = scopeFor(sysMeta)
  const viewer = scopeFor({ access_level: 'state_viewer', admin_state: 'Akwa Ibom' })
  const facilityId = await anyFacility()
  for (const table of PUBLIC_TABLES) {
    assert.equal(
      await enforceFacilityRead(sys, fakeRes(), facilityId, table),
      await enforceFacilityRead(viewer, fakeRes(), facilityId, table),
      `${table}: system_admin must read no more than an ordinary viewer`)
  }
})

test('the full catalogue is visible and that is the approved decision', async () => {
  // Phase 2M.1: system_admin may see the whole catalogue, Essential included.
  // It follows from having no section pin, and grants nothing — commodity.read
  // is 'public', and every table that HOLDS commodities is denied above.
  assert.equal(scopedCategories(scopeFor(sysMeta)), null, 'no category restriction')
  const req = scopeFor(sysMeta)
  assert.deepEqual(req.scope.sectionCommodityNames, [])
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. The ACL side
// ═════════════════════════════════════════════════════════════════════════════

test('the account holds the system_admin role and NO scope row in any dimension', async () => {
  const id = await sysUser()
  const { rows: role } = await query(
    `select r.name from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = $1`, [id])
  assert.deepEqual(role.map(r => r.name), ['system_admin'])

  const { rows: scopes } = await query(
    `select dimension from user_role_scopes where user_id = $1`, [id])
  assert.deepEqual(scopes, [],
    'unscoped means national; a facility/section/module row here would be the bug')
})

test('the resolver grants the three user keys and refuses every operational one', async () => {
  const id = await sysUser()
  const facilityId = await anyFacility()
  const { rows: c } = await query(`select id from commodities limit 1`)

  for (const key of USER_ADMIN_KEYS) {
    assert.equal((await AclResolver.can(id, key, { facilityId })).decision, true, `${key} must be held`)
  }
  for (const key of OPERATIONAL_KEYS) {
    const res = await AclResolver.can(id, key,
      { facilityId, commodityId: c[0].id, sendingFacilityId: facilityId })
    assert.equal(res.decision, false, `${key} must be refused`)
    assert.equal(res.reason, 'role lacks permission', `${key}: refused by capability, not by scope`)
  }
})

test('being unscoped does not leak into a commodity or module grant', async () => {
  // An empty dimension is unconstrained, so moduleCovers/commodityCovers return
  // true for this account. That must never MATTER, because the permission check
  // already refused — this pins the ordering.
  const id = await sysUser()
  const { rows: ess } = await query(`select id from commodities where module = 'essential' limit 1`)
  assert.equal(await AclResolver.moduleCovers(id, ess[0].id), true, 'unconstrained, as designed')
  const res = await AclResolver.can(id, 'stock.read',
    { facilityId: await anyFacility(), commodityId: ess[0].id })
  assert.equal(res.decision, false)
  assert.equal(res.reason, 'role lacks permission', 'capability is checked before scope, so scope cannot rescue it')
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. Nothing changed for anyone else
// ═════════════════════════════════════════════════════════════════════════════

test('no existing role gained or lost a permission', async () => {
  const { rows } = await query(`
    select r.name, count(*)::int n from role_permissions rp
      join roles r on r.id = rp.role_id
     where r.name in ('facility','state_admin','state_viewer','cluster_admin','lga_admin','overall_admin')
     group by 1 order by 1`)
  assert.deepEqual(rows, [
    { name: 'cluster_admin', n: 15 },
    { name: 'facility', n: 23 },
    { name: 'lga_admin', n: 15 },
    { name: 'overall_admin', n: 15 },
    { name: 'state_admin', n: 26 },
    { name: 'state_viewer', n: 15 },
  ])
})

test('the module backfill gave HIV scope to neither national nor cross-module roles', async () => {
  // Both are excluded from the `module = hiv` backfill, but for DIFFERENT reasons,
  // and this asserts each rather than lumping them together:
  //
  //   system_admin     national — unscoped in every dimension (Phase 2M.1)
  //   essential_admin  another module — given `module = essential` by its own
  //                    migration (Phase 2M.2). An ABSENT module row would leave it
  //                    unconstrained, which is exactly the defect that migration
  //                    closes, so "no rows" is the wrong assertion for it.
  const { rows } = await query(`
    select r.name, s.scope_id
      from user_role_scopes s
      join user_roles ur on ur.user_id = s.user_id and ur.role_id = s.role_id
      join roles r on r.id = ur.role_id
     where r.name in ('system_admin', 'essential_admin') and s.dimension = 'module'`)

  assert.equal(rows.filter(r => r.name === 'system_admin').length, 0,
    'system_admin carries no module row at all')
  for (const r of rows.filter(r => r.name === 'essential_admin')) {
    assert.equal(r.scope_id, 'essential', 'essential_admin is confined to its own module, never HIV')
  }
})

test('every other account still has exactly one module scope', async () => {
  const { rows } = await query(`
    select count(*)::int n from user_roles ur
      join users u on u.id = ur.user_id
      join roles r on r.id = ur.role_id
     where u.email not like '%.invalid'
       and r.name not in ('system_admin', 'essential_admin')
       and not exists (select 1 from user_role_scopes s
                        where s.user_id = ur.user_id and s.dimension = 'module')`)
  assert.equal(rows[0].n, 0)
})
