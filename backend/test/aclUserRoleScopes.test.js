// Phase 2G — multi-dimensional scope: user_role_scopes backfill and resolution.
//
// Scope is now a SET over two dimensions (geography, commodity): OR within a
// dimension, AND across dimensions, a dimension with no rows is unconstrained.
// This suite tests the backfilled DATA and the resolver's handling of it.
//
// Still shadow-only: nothing reads this table in the request path, and scope.js
// remains authoritative. Read-only except the clearly-marked fixture section.
//
//   npm test --prefix backend

import test from 'node:test'
import assert from 'node:assert/strict'
import { query, pool } from '../src/db.js'
import { AclResolver } from '../src/services/aclResolver.js'
import { SECTION_CATEGORIES } from '../src/constants/sections.js'

test.after(async () => { await pool.end() })

const NOT_FIXTURE = `u.email not like '%@acl-schema-test.invalid'`

// ═════════════════════════════════════════════════════════════════════════════
// 1. Structural integrity of the backfill
// ═════════════════════════════════════════════════════════════════════════════

test('every scope row references a real user and a real role', async () => {
  const { rows } = await query(`
    select count(*)::int n from user_role_scopes urs
     where not exists (select 1 from users u where u.id = urs.user_id)
        or not exists (select 1 from roles r where r.id = urs.role_id)`)
  assert.equal(rows[0].n, 0)
})

test('no scope row references a non-existent role assignment', async () => {
  // The composite FK to user_roles cannot be declared — that table's primary key
  // is four columns, and a two-column unique constraint would forbid a user
  // holding one role at two scopes (which aclFoundation.test.js asserts is
  // allowed). This test is what enforces the pair instead. See the migration.
  const { rows } = await query(`
    select count(*)::int n from user_role_scopes urs
     where not exists (
       select 1 from user_roles ur
        where ur.user_id = urs.user_id and ur.role_id = urs.role_id)`)
  assert.equal(rows[0].n, 0, 'every (user_id, role_id) must match a real assignment')
})

test('only the three declared dimensions exist, with valid scope_types', async () => {
  const { rows } = await query(
    `select distinct dimension, scope_type from user_role_scopes order by 1,2`)
  const valid = {
    geography: ['cluster', 'facility', 'lga', 'state'],
    commodity: ['category', 'commodity', 'section'],
    // Phase 2M. Its own dimension, not a commodity scope_type: resolution is OR
    // within a dimension and AND across them, so a module row sitting beside a
    // section row would widen Lab HQ to every HIV category instead of narrowing
    // it to lab.
    module: ['module'],
  }
  for (const r of rows) {
    assert.ok(valid[r.dimension], `unexpected dimension: ${r.dimension}`)
    assert.ok(valid[r.dimension].includes(r.scope_type),
      `${r.dimension}/${r.scope_type} is not a declared scope_type`)
  }
})

test('no scope row has an empty scope_id', async () => {
  // An empty scope_id would be indistinguishable from "unconstrained" once read
  // as a row, inverting its meaning. overall_admin's unconstrained state is
  // represented by the ABSENCE of rows, never by an empty one.
  const { rows } = await query(`select count(*)::int n from user_role_scopes where scope_id = ''`)
  assert.equal(rows[0].n, 0)
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. Geography backfill reconciles 1:1 with user_roles
// ═════════════════════════════════════════════════════════════════════════════

test('geography rows reconcile exactly with user_roles scoped assignments', async () => {
  // Both sides exclude fixture accounts. Sibling suites create and sync users
  // under reserved .invalid domains concurrently — `node --test` runs test FILES
  // in parallel — so a whole-table count can catch a fixture that holds a
  // user_roles row a moment before its user_role_scopes rows land, or vice
  // versa. Counting only real accounts makes the reconciliation independent of
  // whatever another suite is doing at that instant.
  const { rows } = await query(`
    select
      (select count(*)::int from user_roles ur join users u on u.id = ur.user_id
        where ur.scope_type <> '' and ur.scope_id <> '' and u.email not like '%.invalid') expected,
      (select count(*)::int from user_role_scopes urs join users u on u.id = urs.user_id
        where urs.dimension = 'geography' and u.email not like '%.invalid') actual`)
  assert.equal(rows[0].actual, rows[0].expected)
})

test('every geography row matches its user_roles pair exactly', async () => {
  const { rows } = await query(`
    select count(*)::int n from user_role_scopes urs
      join user_roles ur on ur.user_id = urs.user_id and ur.role_id = urs.role_id
      join users u on u.id = urs.user_id
     where urs.dimension = 'geography'
       and u.email not like '%.invalid'
       and (urs.scope_type <> ur.scope_type or urs.scope_id <> ur.scope_id)`)
  assert.equal(rows[0].n, 0, 'the backfill must be a verbatim copy, not a reinterpretation')
})

test('overall_admin has NO geography rows — unconstrained is the absence of rows', async () => {
  const { rows } = await query(`
    select count(*)::int n from user_role_scopes urs
      join roles r on r.id = urs.role_id
     where r.name = 'overall_admin' and urs.dimension = 'geography'`)
  assert.equal(rows[0].n, 0)
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. Commodity backfill mirrors attachScope's own rules
// ═════════════════════════════════════════════════════════════════════════════

test('state_admin has no commodity rows; a section-tagged overall_admin now does', async () => {
  // ORIGINALLY both roles were given no commodity scope, because attachScope sets
  // bothSections for them and discards commodity_section — the ACL mirrored the
  // legacy behaviour. Phase 2M deliberately diverges for overall_admin ONLY.
  //
  // The reason: create_hq_viewers.mjs provisions Lab HQ / Pharmacy HQ / M&E HQ as
  // overall_admin tagged with a section, and describes the tag as being "so the UI
  // shows only that section's data". That is exactly true — the pin is enforced
  // nowhere on the server, so a frontend-only field is acting as an access
  // boundary. Carrying it into a commodity scope row makes it real, and those
  // accounts get NARROWER than legacy (an intended fix, recorded as its own
  // shadow-comparison class).
  //
  // An ORDINARY state_admin is unchanged: it genuinely sees both sections.
  //
  // The exception is a state_admin holding the Essential grant (meta.essential):
  // Phase 2M.2c pins every granted account to the pharmacy section, because that
  // section is the essential-commodities branch's own precondition for opening
  // Essential. So the carve-out is by GRANT, not by role.
  const { rows: sa } = await query(`
    select count(*)::int n from user_role_scopes urs
      join roles r on r.id = urs.role_id
      join users u on u.id = urs.user_id
     where r.name = 'state_admin' and urs.dimension = 'commodity'
       and (u.raw_user_meta_data->>'essential') is distinct from 'true'`)
  assert.equal(sa[0].n, 0, 'an ungranted state_admin still sees every section')

  const { rows: granted } = await query(`
    select count(*)::int n from user_role_scopes urs
      join roles r on r.id = urs.role_id
      join users u on u.id = urs.user_id
     where r.name = 'state_admin' and urs.dimension = 'commodity'
       and urs.scope_type = 'section' and urs.scope_id = 'pharmacy'
       and (u.raw_user_meta_data->>'essential')::boolean is true`)
  assert.ok(granted[0].n > 0, 'and a granted one IS pinned to pharmacy — non-vacuous')

  const { rows: tagged } = await query(`
    select u.raw_user_meta_data->>'commodity_section' section,
           count(urs.*)::int scoped
      from user_roles ur
      join roles r on r.id = ur.role_id
      join users u on u.id = ur.user_id
      left join user_role_scopes urs
        on urs.user_id = ur.user_id and urs.dimension = 'commodity'
     where r.name = 'overall_admin'
       and u.raw_user_meta_data->>'commodity_section' in ('pharmacy','lab')
     group by 1 order by 1`)
  assert.ok(tagged.length > 0, 'such accounts must exist, or this asserts nothing')
  for (const t of tagged) {
    assert.equal(t.scoped, 1, `${t.section} HQ must carry exactly its own section scope`)
  }

  // An overall_admin with NO tag keeps seeing all sections — the confirmed rule.
  const { rows: untagged } = await query(`
    select count(urs.*)::int scoped from user_roles ur
      join roles r on r.id = ur.role_id
      join users u on u.id = ur.user_id
      left join user_role_scopes urs
        on urs.user_id = ur.user_id and urs.dimension = 'commodity'
     where r.name = 'overall_admin'
       and coalesce(u.raw_user_meta_data->>'commodity_section','') = ''`)
  assert.equal(untagged[0].scoped, 0, 'an untagged overall_admin is not narrowed')
})

test('a section-pinned user has exactly one section row matching their metadata', async () => {
  // Essential accounts are excluded: Phase 2M.2d gives them TWO section rows
  // (pharmacy + essential) deliberately, so their ACL scope is wider than the
  // single value in their metadata. That divergence is the point — the
  // `essential` section has no metadata equivalent, because commodity_section
  // predates the module ever existing.
  //
  // For everyone else the backfill is still a verbatim copy, and this is what
  // catches it drifting.
  const { rows } = await query(`
    select count(*)::int n from user_roles ur
      join users u on u.id = ur.user_id
      join roles r on r.id = ur.role_id
      join user_role_scopes urs
        on urs.user_id = ur.user_id and urs.role_id = ur.role_id
       and urs.dimension = 'commodity' and urs.scope_type = 'section'
      left join facilities f on f.id::text = ur.scope_id
     where r.name not in ('overall_admin','state_admin')
       and ${NOT_FIXTURE}
       and (u.raw_user_meta_data->>'essential') is distinct from 'true'
       and r.name <> 'essential_admin'
       and (f.name is null or f.name !~* 'state office store|cluster lab store')
       and urs.scope_id <> u.raw_user_meta_data->>'commodity_section'`)
  assert.equal(rows[0].n, 0, 'section rows must copy commodity_section verbatim')
})

test('an Essential account is the deliberate exception, holding two sections', async () => {
  const { rows } = await query(`
    select count(*)::int n from users u
      join user_roles ur on ur.user_id = u.id
      join roles r on r.id = ur.role_id
     where ((u.raw_user_meta_data->>'essential')::boolean is true or r.name = 'essential_admin')
       and u.email not like '%.invalid'
       and (select count(*) from user_role_scopes s
             where s.user_id = u.id and s.dimension = 'commodity'
               and s.scope_type = 'section') <> 2`)
  assert.equal(rows[0].n, 0, 'exactly two — pharmacy for HIV, essential for its own module')
})

test('hub stores REPLACE their section with the hub category set, never extend it', async () => {
  const { rows: sections } = await query(`
    select count(*)::int n from user_role_scopes urs
      join user_roles ur on ur.user_id = urs.user_id
      join facilities f on f.id::text = ur.scope_id
     where urs.dimension = 'commodity' and urs.scope_type = 'section'
       and f.name ~* 'state office store|cluster lab store'`)
  assert.equal(sections[0].n, 0, 'a hub store must not keep a section row')

  const { rows: cats } = await query(`
    select f.name, array_agg(urs.scope_id order by urs.scope_id) cats
      from user_role_scopes urs
      join user_roles ur on ur.user_id = urs.user_id
      join facilities f on f.id::text = ur.scope_id
     where urs.dimension = 'commodity' and urs.scope_type = 'category'
       and f.name ~* 'state office store|cluster lab store'
     group by 1`)
  assert.ok(cats.length > 0, 'hub stores must exist in this database')
  for (const r of cats) {
    assert.deepEqual(r.cats, ['General Consumables', 'Lab consumables'], r.name)
  }
})

test('the Alere Determine exception is a commodity row, not a hardcoded name', async () => {
  const { rows } = await query(`
    select f.name facility, c.name commodity
      from user_role_scopes urs
      join user_roles ur on ur.user_id = urs.user_id
      join facilities f on f.id::text = ur.scope_id
      join commodities c on c.id::text = urs.scope_id
      join users u on u.id = urs.user_id
     where urs.dimension = 'commodity' and urs.scope_type = 'commodity'
       and u.email not like '%.invalid'`)
  assert.equal(rows.length, 1, 'exactly one individual-commodity grant exists today')
  assert.equal(rows[0].commodity, 'Alere Determine')
  assert.match(rows[0].facility, /akwa ibom state office store/i)
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. Resolver behaviour over the new dimensions
// ═════════════════════════════════════════════════════════════════════════════

async function userWith(sql) {
  const { rows } = await query(sql)
  if (!rows.length) throw new Error('fixture user not found')
  return rows[0]
}

test('a pharmacy facility user resolves a pharmacy commodity and not a lab one', async () => {
  const u = await userWith(`
    select u.id, ur.scope_id facility from user_roles ur
      join users u on u.id = ur.user_id join roles r on r.id = ur.role_id
      left join facilities f on f.id::text = ur.scope_id
     where r.name='facility' and u.raw_user_meta_data->>'commodity_section'='pharmacy'
       and (f.name is null or f.name !~* 'state office store|cluster lab store')
       and u.email not like '%@acl-schema-test.invalid' limit 1`)
  const pharm = await userWith(`select id from commodities where category = 'Pharmacy drugs' limit 1`)
  const lab = await userWith(`select id from commodities where category = 'RTKs' limit 1`)

  assert.equal(await AclResolver.commodityCovers(u.id, pharm.id), true)
  assert.equal(await AclResolver.commodityCovers(u.id, lab.id), false)
})

test('both dimensions must pass — right facility with wrong commodity is denied', async () => {
  const u = await userWith(`
    select u.id, ur.scope_id facility from user_roles ur
      join users u on u.id = ur.user_id join roles r on r.id = ur.role_id
      left join facilities f on f.id::text = ur.scope_id
     where r.name='facility' and u.raw_user_meta_data->>'commodity_section'='pharmacy'
       and (f.name is null or f.name !~* 'state office store|cluster lab store')
       and u.email not like '%@acl-schema-test.invalid' limit 1`)
  const lab = await userWith(`select id from commodities where category = 'RTKs' limit 1`)
  const pharm = await userWith(`select id from commodities where category = 'Pharmacy drugs' limit 1`)

  const ok = await AclResolver.can(u.id, 'stock.read', { facilityId: u.facility, commodityId: pharm.id })
  assert.equal(ok.decision, true, 'own facility + own section must pass')

  const denied = await AclResolver.can(u.id, 'stock.read', { facilityId: u.facility, commodityId: lab.id })
  assert.equal(denied.decision, false, 'own facility but wrong section must be denied')
  assert.equal(denied.reason, 'commodity outside scope')
})

test('an unconstrained role (state_admin) resolves any commodity', async () => {
  const u = await userWith(`
    select u.id from user_roles ur join users u on u.id=ur.user_id
      join roles r on r.id=ur.role_id where r.name='state_admin' limit 1`)
  const { rows: some } = await query(`select id from commodities limit 5`)
  for (const c of some) {
    assert.equal(await AclResolver.commodityCovers(u.id, c.id), true)
  }
})

test('the Akwa Ibom hub resolves its granted commodity despite it being outside its categories', async () => {
  // Alere Determine is an RTK; the hub's category rows are Lab consumables and
  // General Consumables. The individual grant is what lets it through — proving
  // OR-within-dimension works and the exception is genuinely additive.
  const u = await userWith(`
    select u.id from user_roles ur join users u on u.id = ur.user_id
      join facilities f on f.id::text = ur.scope_id
     where lower(btrim(f.name)) = 'akwa ibom state office store' limit 1`)
  const alere = await userWith(`select id, category from commodities where name = 'Alere Determine'`)
  assert.equal(alere.category, 'RTKs', 'precondition: the grant is outside the hub category set')

  assert.equal(await AclResolver.commodityCovers(u.id, alere.id), true, 'the grant must apply')

  const otherRtk = await query(
    `select id from commodities where category='RTKs' and name <> 'Alere Determine' limit 1`)
  if (otherRtk.rows.length) {
    assert.equal(await AclResolver.commodityCovers(u.id, otherRtk.rows[0].id), false,
      'the grant must be for that ONE commodity, not the whole RTKs category')
  }
})

test('an unrecognised section resolves to DENY, diverging from legacy fail-open', async () => {
  // Three live accounts carry commodity_section='tools'. categoriesForSection
  // returns null for an unknown value, which legacy treats as "sees everything".
  // The new model denies instead. This is a deliberate divergence from a
  // documented fail-open defect, not an implementation gap.
  const u = await query(`
    select u.id from user_roles ur join users u on u.id = ur.user_id
      join roles r on r.id = ur.role_id
     where r.name not in ('overall_admin','state_admin')
       and u.raw_user_meta_data->>'commodity_section' = 'tools' limit 1`)
  if (!u.rows.length) return // no such account in this database
  const { rows: any } = await query(`select id from commodities limit 1`)
  assert.equal(await AclResolver.commodityCovers(u.rows[0].id, any[0].id), false,
    "an unknown section must deny, not fall through to 'sees everything'")
  assert.equal(SECTION_CATEGORIES['tools'], undefined,
    'precondition: tools is genuinely not a declared section')
})

test('an unknown commodity id denies', async () => {
  const u = await userWith(`
    select u.id from user_roles ur join users u on u.id=ur.user_id
      join roles r on r.id=ur.role_id where r.name='facility'
      and u.email not like '%@acl-schema-test.invalid' limit 1`)
  assert.equal(await AclResolver.commodityCovers(u.id, '00000000-0000-0000-0000-000000000000'), false)
})
