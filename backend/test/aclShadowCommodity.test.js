// Phase 2G shadow comparison — the COMMODITY dimension.
//
// Legacy enforceCommoditySection vs the resolver's commodityCovers, for the same
// real users and the same commodities. Before 2G the ACL model had no commodity
// dimension at all, so this comparison could not be made — the gap was recorded
// in authorization-model.md §7 as an unmeasurable divergence. It is now
// measurable, which is the point of this file.
//
// Geography comparisons live in aclShadowComparison.test.js. Kept separate so
// the two dimensions can be read and reasoned about independently.
//
// Legacy remains authoritative; nothing here influences a real decision.
//
//   npm test --prefix backend

import test from 'node:test'
import assert from 'node:assert/strict'
import { query, pool } from '../src/db.js'
import { enforceCommoditySection } from '../src/middleware/scope.js'
import { AclResolver } from '../src/services/aclResolver.js'
import { scopeFor, verdict } from './helpers/legacyHarness.js'

test.after(async () => { await pool.end() })

let COMPARISONS = 0, MATCHES = 0
function record(label, legacy, acl, expectMatch, category) {
  COMPARISONS++
  const matched = legacy === acl
  if (matched) MATCHES++
  assert.equal(matched, expectMatch,
    `${label}: legacy=${legacy} acl=${acl} — expected ${expectMatch ? 'a match' : category}`)
}

test.after(() => {
  console.log(`\n[shadow commodity] ${MATCHES}/${COMPARISONS} matched, ${COMPARISONS - MATCHES} known mismatch(es)\n`)
})

// A real, non-hub facility user pinned to `section`. Hub stores are excluded
// because their categories are REPLACED by the hub set, which is a separate case
// covered below.
async function facilityUser(section) {
  const { rows } = await query(
    `select u.id, u.raw_user_meta_data meta from user_roles ur
       join users u on u.id = ur.user_id join roles r on r.id = ur.role_id
       left join facilities f on f.id::text = ur.scope_id
      where r.name = 'facility' and u.raw_user_meta_data->>'commodity_section' = $1
        and (f.name is null or f.name !~* 'state office store|cluster lab store')
        and u.email not like '%.invalid' limit 1`, [section])
  if (!rows.length) throw new Error(`no facility user with section ${section}`)
  return rows[0]
}

const oneCommodityIn = async (category) => {
  const { rows } = await query(`select id from commodities where category = $1 limit 1`, [category])
  return rows[0]
}

test('pharmacy user on a pharmacy commodity matches', async () => {
  const u = await facilityUser('pharmacy')
  const c = await oneCommodityIn('Pharmacy drugs')
  const legacy = await verdict(res => enforceCommoditySection(scopeFor(u.meta), res, c.id))
  record('pharmacy user / pharmacy commodity', legacy, await AclResolver.commodityCovers(u.id, c.id), true)
})

test('pharmacy user on a lab commodity matches — both deny', async () => {
  const u = await facilityUser('pharmacy')
  const c = await oneCommodityIn('RTKs')
  const legacy = await verdict(res => enforceCommoditySection(scopeFor(u.meta), res, c.id))
  record('pharmacy user / lab commodity', legacy, await AclResolver.commodityCovers(u.id, c.id), true)
})

test('lab user on a lab commodity matches', async () => {
  const u = await facilityUser('lab')
  const c = await oneCommodityIn('Lab consumables')
  const legacy = await verdict(res => enforceCommoditySection(scopeFor(u.meta), res, c.id))
  record('lab user / lab commodity', legacy, await AclResolver.commodityCovers(u.id, c.id), true)
})

test('lab user on a pharmacy commodity matches — both deny', async () => {
  const u = await facilityUser('lab')
  const c = await oneCommodityIn('Pharmacy drugs')
  const legacy = await verdict(res => enforceCommoditySection(scopeFor(u.meta), res, c.id))
  record('lab user / pharmacy commodity', legacy, await AclResolver.commodityCovers(u.id, c.id), true)
})

test('hub store on a hub category matches', async () => {
  const { rows: u } = await query(`
    select u.id, u.raw_user_meta_data meta from user_roles ur
      join users u on u.id = ur.user_id join facilities f on f.id::text = ur.scope_id
     where f.name ~* 'state office store|cluster lab store'
       and u.email not like '%.invalid' limit 1`)
  const c = await oneCommodityIn('Lab consumables')
  const legacy = await verdict(res => enforceCommoditySection(scopeFor(u[0].meta), res, c.id))
  record('hub store / Lab consumables', legacy, await AclResolver.commodityCovers(u[0].id, c.id), true)
})

test('the Akwa Ibom individual grant matches on Alere Determine', async () => {
  // The case that had no representation before 2G: a single named commodity
  // outside the facility's category set, previously hardcoded by facility name.
  const { rows: u } = await query(`
    select u.id, u.raw_user_meta_data meta from user_roles ur
      join users u on u.id = ur.user_id join facilities f on f.id::text = ur.scope_id
     where lower(btrim(f.name)) = 'akwa ibom state office store'
       and u.email not like '%.invalid' limit 1`)
  const { rows: c } = await query(`select id from commodities where name = 'Alere Determine'`)
  const legacy = await verdict(res => enforceCommoditySection(scopeFor(u[0].meta), res, c[0].id))
  record('akwa ibom / Alere Determine grant', legacy, await AclResolver.commodityCovers(u[0].id, c[0].id), true)
})

test('a non-hub facility does NOT get the Alere Determine grant — matches', async () => {
  // The blast-radius check: the grant is keyed to one facility, so an ordinary
  // lab user must still be refused an RTK outside their categories... except
  // Alere Determine IS an RTK and lab users hold RTKs. Use a pharmacy user, for
  // whom RTKs are out of section either way.
  const u = await facilityUser('pharmacy')
  const { rows: c } = await query(`select id from commodities where name = 'Alere Determine'`)
  const legacy = await verdict(res => enforceCommoditySection(scopeFor(u.meta), res, c[0].id))
  record('pharmacy user / Alere Determine', legacy, await AclResolver.commodityCovers(u.id, c[0].id), true)
})

test('MISMATCH (F — legacy fail-open, NOT reproduced): unrecognised commodity_section', async () => {
  // commodity_section='tools' is not a declared section. categoriesForSection
  // returns null for it, which downstream means "sees every category". The new
  // model denies. Asserted to REMAIN a mismatch — making these agree would mean
  // reproducing a documented fail-open in the replacement system.
  const { rows: u } = await query(`
    select u.id, u.raw_user_meta_data meta from user_roles ur
      join users u on u.id = ur.user_id join roles r on r.id = ur.role_id
     where r.name not in ('overall_admin','state_admin')
       and u.raw_user_meta_data->>'commodity_section' = 'tools' limit 1`)
  if (!u.length) return // no such account in this database
  const c = await oneCommodityIn('Pharmacy drugs')
  const legacy = await verdict(res => enforceCommoditySection(scopeFor(u[0].meta), res, c.id))
  const acl = await AclResolver.commodityCovers(u[0].id, c.id)
  record('unrecognised section', legacy, acl, false, 'F: legacy fail-open — must not be reproduced')
  assert.equal(legacy, true, 'legacy fail-open confirmed present')
  assert.equal(acl, false, 'ACL correctly denies an unknown section')
})
