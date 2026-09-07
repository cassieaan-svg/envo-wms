// Phase 2M — user-administration permissions, the two new roles, and the module
// scope dimension.
//
// The load-bearing property here is that `module` is its OWN dimension. Scope
// resolves OR within a dimension and AND across dimensions, so putting module
// alongside section in the commodity dimension would make Lab HQ resolve as
// "HIV module OR lab section" — every HIV category. Several tests below exist
// specifically to catch that regression if anyone ever collapses the two.
//
// Shadow-only: scope.js remains authoritative and nothing here touches the
// request path.
//
// Read-only against real seeded data except the two tests that add and remove a
// scope row, which restore in `finally`; a final test asserts the shape is back.
//
//   npm test --prefix backend

import test from 'node:test'
import assert from 'node:assert/strict'
import { query, pool } from '../src/db.js'
import { AclResolver } from '../src/services/aclResolver.js'

test.after(async () => { await pool.end() })

const NEW_KEYS = ['user.read', 'user.write', 'user_permission.write']

async function oneCommodity(module, category) {
  const { rows } = await query(
    category
      ? `select id, name, category, module from commodities where module = $1 and category = $2 limit 1`
      : `select id, name, category, module from commodities where module = $1 limit 1`,
    category ? [module, category] : [module])
  if (!rows.length) throw new Error(`no commodity for module=${module} category=${category}`)
  return rows[0]
}

async function userByEmail(email) {
  const { rows } = await query(`select id from users where email = $1`, [email])
  if (!rows.length) throw new Error(`no user ${email}`)
  return rows[0].id
}

const anyFacility = async () => (await query(`select id from facilities limit 1`)).rows[0].id

// ═════════════════════════════════════════════════════════════════════════════
// 1. Catalogue: three keys, two roles
// ═════════════════════════════════════════════════════════════════════════════

test('the three user-administration permissions are declared', async () => {
  const { rows } = await query(
    `select key, module from permissions where key = any($1) order by key`, [NEW_KEYS])
  assert.deepEqual(rows.map(r => r.key), [...NEW_KEYS].sort())
  assert.ok(rows.every(r => r.module === 'user_admin'), 'grouped under their own module')
})

test('exactly two roles were added, and both are system roles', async () => {
  const { rows } = await query(
    `select name, is_system from roles where name in ('system_admin','essential_admin') order by name`)
  assert.deepEqual(rows, [
    { name: 'essential_admin', is_system: true },
    { name: 'system_admin', is_system: true },
  ])
  const { rows: all } = await query(`select count(*)::int n from roles`)
  assert.equal(all[0].n, 8, 'six original plus these two — no others invented')
})

test('system_admin holds the three user keys and NO operational access', async () => {
  const { rows } = await query(
    `select rp.permission_key from role_permissions rp join roles r on r.id = rp.role_id
      where r.name = 'system_admin' order by 1`)
  assert.deepEqual(rows.map(r => r.permission_key), [...NEW_KEYS].sort(),
    'a role that can grant itself anything must not also write stock')
})

test('only system_admin may set direct per-user overrides', async () => {
  const { rows } = await query(
    `select r.name from role_permissions rp join roles r on r.id = rp.role_id
      where rp.permission_key = 'user_permission.write' order by 1`)
  assert.deepEqual(rows.map(r => r.name), ['system_admin'])
})

test('user administration is held exactly by the roles that can write', async () => {
  const { rows } = await query(
    `select r.name from role_permissions rp join roles r on r.id = rp.role_id
      where rp.permission_key = 'user.write' order by 1`)
  assert.deepEqual(rows.map(r => r.name), ['essential_admin', 'state_admin', 'system_admin'],
    'the confirmed rule: user administration requires write capability')
})

test('the read-only tiers hold no user-administration permission at all', async () => {
  const { rows } = await query(
    `select distinct r.name from role_permissions rp join roles r on r.id = rp.role_id
      where rp.permission_key = any($1)
        and r.name in ('overall_admin','state_viewer','cluster_admin','lga_admin','facility')`,
    [NEW_KEYS])
  assert.deepEqual(rows, [], 'confirmed: these tiers manage nobody')
})

test('essential_admin mirrors state_admin operationally, scope_mode included', async () => {
  const { rows } = await query(`
    select rp.permission_key, rp.scope_mode, r.name
      from role_permissions rp join roles r on r.id = rp.role_id
     where r.name in ('state_admin','essential_admin')
       and rp.permission_key <> 'user_permission.write'
     order by rp.permission_key, r.name`)
  const byRole = k => rows.filter(r => r.name === k)
    .map(r => `${r.permission_key}:${r.scope_mode}`).sort()
  assert.deepEqual(byRole('essential_admin'), byRole('state_admin'),
    'copied from the data, so the two cannot drift — and own_facility_only survives the copy')
  assert.ok(byRole('essential_admin').some(s => s.endsWith(':own_facility_only')),
    'non-vacuous: the copy really did carry a narrowed grant')
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. The module dimension
// ═════════════════════════════════════════════════════════════════════════════

test('every real account with a role carries exactly one module scope', async () => {
  const { rows } = await query(`
    select count(*)::int n from user_roles ur
      join users u on u.id = ur.user_id
      join roles r on r.id = ur.role_id
     where u.email not like '%.invalid' and r.name <> 'essential_admin'
       and not exists (select 1 from user_role_scopes s
                        where s.user_id = ur.user_id and s.dimension = 'module')`)
  assert.equal(rows[0].n, 0, 'an absent module dimension means unconstrained — nobody may be left that way')
})

test('the dimension check constraint accepts module and rejects anything else', async () => {
  const u = await userByEmail('labhq@envo.ng')
  const { rows: role } = await query(
    `select role_id from user_roles where user_id = $1`, [u])
  await assert.rejects(
    () => query(
      `insert into user_role_scopes (user_id, role_id, dimension, scope_type, scope_id)
       values ($1, $2, 'galaxy', 'module', 'hiv')`, [u, role[0].role_id]),
    err => err.code === '23514', 'an undeclared dimension must be refused by the database')
})

test('an Essential Commodities item is denied to every HIV-scoped account', async () => {
  const ess = await oneCommodity('essential')
  const facilityId = await anyFacility()
  const { rows } = await query(`
    select u.id, r.name from user_roles ur
      join roles r on r.id = ur.role_id
      join users u on u.id = ur.user_id
     where u.email not like '%.invalid'
       and r.name in ('overall_admin','state_admin','state_viewer','lga_admin','cluster_admin')
     limit 6`)
  assert.ok(rows.length >= 4, 'need a spread of tiers to make this meaningful')
  for (const u of rows) {
    const res = await AclResolver.can(u.id, 'stock.read', { facilityId, commodityId: ess.id })
    assert.equal(res.decision, false, `${u.name} must not reach Essential Commodities`)
  }
})

test('the same accounts still reach HIV commodities — the denial is the module, not a blanket', async () => {
  const hiv = await oneCommodity('hiv', 'Lab consumables')
  const { rows } = await query(`
    select u.id, ur.scope_id from user_roles ur
      join roles r on r.id = ur.role_id
      join users u on u.id = ur.user_id
     where r.name = 'state_admin' and u.email not like '%.invalid'
       and u.raw_user_meta_data->>'commodity_section' is null
     limit 1`)
  const { rows: fac } = await query(
    `select id from facilities where state = $1 limit 1`, [rows[0].scope_id])
  const res = await AclResolver.can(rows[0].id, 'stock.read',
    { facilityId: fac[0].id, commodityId: hiv.id })
  assert.equal(res.decision, true, 'non-vacuous: HIV items are still reachable')
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. HQ viewers — module AND section, never OR
// ═════════════════════════════════════════════════════════════════════════════

test('Lab HQ sees lab categories only, not every HIV category', async () => {
  const id = await userByEmail('labhq@envo.ng')
  const facilityId = await anyFacility()
  const lab = await oneCommodity('hiv', 'Lab consumables')
  const pharm = await oneCommodity('hiv', 'Pharmacy drugs')

  assert.equal((await AclResolver.can(id, 'stock.read', { facilityId, commodityId: lab.id })).decision,
    true, 'its own section')
  // THE REGRESSION GUARD. If module were a scope_type inside the commodity
  // dimension, OR-within-dimension would make this true.
  assert.equal((await AclResolver.can(id, 'stock.read', { facilityId, commodityId: pharm.id })).decision,
    false, 'module must AND with section, never OR')
})

test('Pharmacy HQ is the mirror image', async () => {
  const id = await userByEmail('pharmacyhq@envo.ng')
  const facilityId = await anyFacility()
  assert.equal((await AclResolver.can(id, 'stock.read',
    { facilityId, commodityId: (await oneCommodity('hiv', 'Pharmacy drugs')).id })).decision, true)
  assert.equal((await AclResolver.can(id, 'stock.read',
    { facilityId, commodityId: (await oneCommodity('hiv', 'Lab consumables')).id })).decision, false)
})

test('an overall_admin with no section tag still sees every HIV section', async () => {
  const { rows } = await query(`
    select u.id from user_roles ur join roles r on r.id = ur.role_id join users u on u.id = ur.user_id
     where r.name = 'overall_admin' and u.raw_user_meta_data->>'commodity_section' is null limit 1`)
  const facilityId = await anyFacility()
  for (const cat of ['Lab consumables', 'Pharmacy drugs', 'RTKs']) {
    const c = await oneCommodity('hiv', cat)
    assert.equal((await AclResolver.can(rows[0].id, 'stock.read',
      { facilityId, commodityId: c.id })).decision, true, `${cat} must remain visible`)
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. Fail closed
// ═════════════════════════════════════════════════════════════════════════════

test('moduleCovers denies an unknown commodity and a scopeless request', async () => {
  const id = await userByEmail('labhq@envo.ng')
  assert.equal(await AclResolver.moduleCovers(id, '00000000-0000-0000-0000-000000000000'), false)
  assert.equal(await AclResolver.moduleCovers(id, null), false,
    'a module-scoped user naming no commodity cannot be covered')
})

test('no module rows means unconstrained, matching the other dimensions', async () => {
  // Proven by removing the rows rather than asserted from the code, then restored.
  const id = await userByEmail('labhq@envo.ng')
  const ess = await oneCommodity('essential')
  const { rows: saved } = await query(
    `select role_id, scope_type, scope_id from user_role_scopes
      where user_id = $1 and dimension = 'module'`, [id])
  try {
    await query(`delete from user_role_scopes where user_id = $1 and dimension = 'module'`, [id])
    assert.equal(await AclResolver.moduleCovers(id, ess.id), true,
      'an empty dimension is unconstrained, not denied')
  } finally {
    for (const s of saved) {
      await query(
        `insert into user_role_scopes (user_id, role_id, dimension, scope_type, scope_id)
         values ($1, $2, 'module', $3, $4) on conflict do nothing`,
        [id, s.role_id, s.scope_type, s.scope_id])
    }
  }
  assert.equal(await AclResolver.moduleCovers(id, ess.id), false, 'and the restore worked')
})

test('a module scope grants nothing on its own — the permission still gates', async () => {
  const id = await userByEmail('labhq@envo.ng') // overall_admin: read-only by design
  const facilityId = await anyFacility()
  const lab = await oneCommodity('hiv', 'Lab consumables')
  const res = await AclResolver.can(id, 'stock.write', { facilityId, commodityId: lab.id })
  assert.equal(res.decision, false)
  assert.equal(res.reason, 'role lacks permission', 'denied by capability, before any scope check')
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. Left as found
// ═════════════════════════════════════════════════════════════════════════════

test('this suite restored the scope rows it touched', async () => {
  const { rows } = await query(`
    select dimension, count(*)::int n from user_role_scopes s
      join users u on u.id = s.user_id
     where u.email not like '%.invalid' group by 1 order by 1`)
  assert.deepEqual(rows, [
    { dimension: 'commodity', n: 7533 },
    { dimension: 'geography', n: 7563 },
    { dimension: 'module', n: 7566 },
  ])
})
