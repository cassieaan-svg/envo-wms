// Phase 2M.2d — every Essential account holds exactly the sections
// {pharmacy, essential}.
//
// Three hazards are being closed, and they are different from one another:
//
//   MISSING   an absent section row means UNCONSTRAINED, not empty — the account
//             would see every section, including lab
//   WRONG     a section outside the set (lab, general) would admit it somewhere
//             it has no business
//   EXTRA     section rows OR together within the commodity dimension, so a
//             stray row silently WIDENS rather than conflicting
//
// The last is the one worth naming: "holds pharmacy" is not the same claim as
// "holds exactly pharmacy and essential", and only the second is safe.
//
// Why two: `pharmacy` is the essential-commodities branch's precondition for
// opening Essential; `essential` is what makes that module's six categories
// reachable at all, since a section pin ANDs with the module dimension and no
// section previously contained an Essential category.
//
// Scope: the section dimension only. Geography and module are asserted to be
// untouched, not redesigned.
//
//   npm test --prefix backend

import test from 'node:test'
import assert from 'node:assert/strict'
import { query, pool } from '../src/db.js'
import { AclResolver } from '../src/services/aclResolver.js'
import { syncAcl } from '../src/services/aclProvisioning.js'
import { SECTION_CATEGORIES } from '../src/constants/sections.js'

const DOMAIN = '@acl-essential-section-test.invalid'

// Retried on deadlock (40P01): deleting a user cascades into user_roles and
// user_role_scopes, which the concurrent syncAcl transactions are writing. It is
// contention, not corruption — see the same note in aclAdminApi.test.js.
test.after(async () => {
  for (let i = 0; ; i++) {
    try { await query(`delete from users where email like $1`, [`%${DOMAIN}`]); break }
    catch (err) { if (err.code !== '40P01' || i >= 5) throw err }
  }
  await pool.end()
})

// The two independent markers of an Essential account. Kept as one fragment so
// every query below asks the same question.
const IS_ESSENTIAL = `((u.raw_user_meta_data->>'essential')::boolean is true or r.name = 'essential_admin')`

const sectionsOf = async userId => (await query(
  `select scope_id from user_role_scopes
    where user_id = $1 and dimension = 'commodity' and scope_type = 'section'
    order by scope_id`, [userId])).rows.map(r => r.scope_id)

// ═════════════════════════════════════════════════════════════════════════════
// 1. The population, as it stands
// ═════════════════════════════════════════════════════════════════════════════

// The allowed set. Two sections, not one: `pharmacy` is the essential-commodities
// branch's precondition for opening Essential, and `essential` is what makes the
// module's own six categories reachable — a section pin ANDs with the module
// dimension, so pharmacy alone left Essential items unreachable.
const ALLOWED = 'essential,pharmacy'

test('every Essential account has EXACTLY the allowed sections', async () => {
  const { rows } = await query(`
    select u.email,
           coalesce(string_agg(s.scope_id, ',' order by s.scope_id), '(NONE)') sections
      from users u
      join user_roles ur on ur.user_id = u.id
      join roles r on r.id = ur.role_id
      left join user_role_scopes s
        on s.user_id = u.id and s.dimension = 'commodity' and s.scope_type = 'section'
     where ${IS_ESSENTIAL} and u.email not like '%.invalid'
     group by u.email`)

  assert.ok(rows.length > 0, 'non-vacuous — Essential accounts exist')
  for (const r of rows) {
    assert.equal(r.sections, ALLOWED,
      `${r.email}: expected exactly "${ALLOWED}", got "${r.sections}"`)
  }
})

test('both markers are represented — the rule is not keyed on the email pattern', async () => {
  const { rows } = await query(`
    select count(*) filter (where (u.raw_user_meta_data->>'essential')::boolean is true)::int by_grant,
           count(*) filter (where r.name = 'essential_admin')::int by_role
      from users u
      join user_roles ur on ur.user_id = u.id
      join roles r on r.id = ur.role_id
     where ${IS_ESSENTIAL} and u.email not like '%.invalid'`)
  assert.ok(rows[0].by_grant > 0, 'grant-holders covered')
  assert.ok(rows[0].by_role > 0, 'the essential_admin role covered')
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. What that scope actually permits — the requirement, exercised
// ═════════════════════════════════════════════════════════════════════════════

test('an Essential account reaches its two sections and no others', async () => {
  const { rows } = await query(`
    select u.id, ur.scope_id facility_id
      from users u
      join user_roles ur on ur.user_id = u.id
      join roles r on r.id = ur.role_id
     where ${IS_ESSENTIAL} and r.name = 'facility' and ur.scope_type = 'facility'
       and u.email not like '%.invalid' limit 1`)
  const { id, facility_id } = rows[0]

  // Everything inside pharmacy OR essential must be reachable — including the
  // Essential module's own items, which a pharmacy-only pin made invisible.
  const held = ['pharmacy', 'essential']
  const heldCategories = held.flatMap(k => SECTION_CATEGORIES[k])
  const { rows: mine } = await query(
    `select distinct on (category) id, category from commodities where category = any($1)`,
    [heldCategories])
  assert.ok(mine.length >= 5, 'non-vacuous — both sections have items')
  for (const c of mine) {
    assert.equal((await AclResolver.can(id, 'stock.read',
      { facilityId: facility_id, commodityId: c.id })).decision, true,
      `${c.category} is inside its sections and must be reachable`)
  }

  // …and nothing outside them. lab and general are the sections it does NOT hold.
  const otherCategories = Object.entries(SECTION_CATEGORIES)
    .filter(([key]) => !held.includes(key)).flatMap(([, cats]) => cats)
  const { rows: others } = await query(
    `select id, category from commodities where category = any($1)`, [otherCategories])
  assert.ok(others.length > 0, 'non-vacuous — the other sections have items')
  for (const c of others) {
    const res = await AclResolver.can(id, 'stock.read',
      { facilityId: facility_id, commodityId: c.id })
    assert.equal(res.decision, false, `${c.category} is outside its sections`)
    assert.equal(res.reason, 'commodity outside scope')
  }
})

test('removing the section scope would UNSCOPE it — which is why the row must exist', async () => {
  // Proves the hazard rather than asserting it. With no section row the account
  // reaches a lab category it must never see; the row is restored immediately.
  const { rows } = await query(`
    select u.id, ur.role_id, ur.scope_id facility_id
      from users u
      join user_roles ur on ur.user_id = u.id
      join roles r on r.id = ur.role_id
     where ${IS_ESSENTIAL} and r.name = 'facility' and ur.scope_type = 'facility'
       and u.email not like '%.invalid' limit 1`)
  const { id, role_id, facility_id } = rows[0]
  const lab = (await query(
    `select id from commodities where category = 'Lab consumables' limit 1`)).rows[0].id

  try {
    await query(`delete from user_role_scopes
                  where user_id = $1 and dimension = 'commodity' and scope_type = 'section'`, [id])
    const unscoped = await AclResolver.can(id, 'stock.read',
      { facilityId: facility_id, commodityId: lab })
    assert.equal(unscoped.decision, true,
      'an absent section row means UNCONSTRAINED — this is the failure mode being prevented')
  } finally {
    // BOTH sections, or the restore silently narrows the account it borrowed.
    for (const key of ['pharmacy', 'essential']) {
      await query(
        `insert into user_role_scopes (user_id, role_id, dimension, scope_type, scope_id)
         values ($1, $2, 'commodity', 'section', $3) on conflict do nothing`, [id, role_id, key])
    }
  }

  assert.deepEqual(await sectionsOf(id), ['essential', 'pharmacy'], 'restored')
  assert.equal((await AclResolver.can(id, 'stock.read',
    { facilityId: facility_id, commodityId: lab })).decision, false, 'and closed again')
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. Non-Essential accounts are untouched
// ═════════════════════════════════════════════════════════════════════════════

test('lab and pharmacy accounts keep the sections they had', async () => {
  const { rows } = await query(`
    select u.raw_user_meta_data->>'commodity_section' meta_section,
           s.scope_id acl_section, count(*)::int n
      from users u
      join user_roles ur on ur.user_id = u.id
      join roles r on r.id = ur.role_id
      join user_role_scopes s
        on s.user_id = u.id and s.dimension = 'commodity' and s.scope_type = 'section'
     where not ${IS_ESSENTIAL} and u.email not like '%.invalid'
     group by 1, 2 order by 1, 2`)
  for (const r of rows) {
    assert.equal(r.acl_section, r.meta_section,
      'a non-Essential account\'s section must still mirror its own metadata')
  }
  assert.ok(rows.some(r => r.acl_section === 'lab'), 'non-vacuous — lab accounts still exist')
})

test('the hub-store category grants were not converted into sections', async () => {
  // State office / cluster stores carry CATEGORY scopes, a different mechanism.
  // The migration touches scope_type='section' only.
  const { rows } = await query(`
    select count(*)::int n from user_role_scopes
     where dimension = 'commodity' and scope_type = 'category'`)
  assert.ok(rows[0].n > 0, 'category grants survive untouched')
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. Geography and module are not collateral
// ═════════════════════════════════════════════════════════════════════════════

test('every Essential account kept its geographic scope', async () => {
  const { rows } = await query(`
    select count(*)::int n from users u
      join user_roles ur on ur.user_id = u.id
      join roles r on r.id = ur.role_id
     where ${IS_ESSENTIAL} and u.email not like '%.invalid'
       and not exists (select 1 from user_role_scopes s
                        where s.user_id = u.id and s.dimension = 'geography')`)
  assert.equal(rows[0].n, 0, 'the section change must not have cost anyone their geography')
})

test('module scopes are unchanged — this was the section dimension only', async () => {
  const { rows } = await query(`
    select count(*)::int n from users u
      join user_roles ur on ur.user_id = u.id
      join roles r on r.id = ur.role_id
     where ${IS_ESSENTIAL} and u.email not like '%.invalid'
       and not exists (select 1 from user_role_scopes s
                        where s.user_id = u.id and s.dimension = 'module' and s.scope_id = 'essential')`)
  assert.equal(rows[0].n, 0, 'every Essential account still holds the essential module')
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. It holds for NEW accounts, without anyone editing them by hand
// ═════════════════════════════════════════════════════════════════════════════

test('a newly provisioned Essential login is pinned by syncAcl alone', async () => {
  const { rows: f } = await query(
    `select id, state from facilities where state is not null limit 1`)
  const { rows: u } = await query(`
    insert into users (id, email, encrypted_password, raw_user_meta_data)
    values (gen_random_uuid(), $1, 'x', $2::jsonb) returning id`,
    [`new${Date.now()}${DOMAIN}`, JSON.stringify({
      access_level: 'facility', facility_id: f[0].id, essential: true,
      // Deliberately NO commodity_section: the point is that syncAcl supplies it.
    })])

  for (let i = 0; i < 4; i++) if ((await syncAcl({ quiet: true })).synced) break
  assert.deepEqual(await sectionsOf(u[0].id), ['essential', 'pharmacy'],
    'no manual edit — the backfill in syncAcl pins both sections')
})

test('re-running the backfill is a no-op, not a duplicate', async () => {
  const { rows } = await query(`
    select u.id from users u
      join user_roles ur on ur.user_id = u.id
      join roles r on r.id = ur.role_id
     where ${IS_ESSENTIAL} and u.email not like '%.invalid' limit 1`)
  const before = await sectionsOf(rows[0].id)
  for (let i = 0; i < 4; i++) if ((await syncAcl({ quiet: true })).synced) break
  assert.deepEqual(await sectionsOf(rows[0].id), before,
    'a second section row would OR with the first and silently widen')
})
