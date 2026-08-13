// Per-facility grants of individual commodities.
//
// The case: Akwa Ibom's state office must see Alere Determine. Its category is RTKs,
// and state-office scope is defined by CATEGORY — so the obvious fix (add 'RTKs' to
// STATE_OFFICE_CATEGORIES) would have handed every RTK to every state office. These
// tests exist mainly to pin the blast radius: the assertions that matter most are the
// negative ones, that nothing changed for Cross River, Lagos, or any other facility.

import test from 'node:test'
import assert from 'node:assert/strict'
import { attachScope } from '../src/middleware/scope.js'
import {
  STATE_OFFICE_CATEGORIES, extraCommoditiesForFacility,
  narrowGrantsToCategories, sectionFilterSql, sectionFilterFixed, allowsCommodity,
} from '../src/constants/sections.js'
import { query, pool } from '../src/db.js'

const scopeFor = (meta) => {
  const req = { user: { user_metadata: meta }, get: () => null, query: {} }
  const res = { status: () => ({ json: () => {} }) }
  attachScope(req, res, () => {})
  return req.scope
}

const stateOffice = (state) => ({
  access_level: 'facility', commodity_section: 'lab',
  facility_name: `${state} State Office Store`, facility_id: 'f1',
})

test('the grant reaches Akwa Ibom and nowhere else', () => {
  assert.deepEqual(scopeFor(stateOffice('Akwa Ibom')).sectionCommodityNames, ['Alere Determine'])
  // The whole point of not touching STATE_OFFICE_CATEGORIES.
  for (const other of ['Cross River', 'Lagos']) {
    assert.deepEqual(scopeFor(stateOffice(other)).sectionCommodityNames, [],
      `${other} state office must be unaffected`)
  }
  // And an ordinary facility, and a lab account that merely has a similar name.
  assert.deepEqual(scopeFor({ access_level: 'facility', commodity_section: 'lab',
    facility_name: 'Ibeno General Hospital' }).sectionCommodityNames, [])
  assert.deepEqual(scopeFor({ access_level: 'facility', commodity_section: 'lab',
    facility_name: 'Akwa Ibom State Office Annexe' }).sectionCommodityNames, [])
})

test('the grant is additive — it does not alter the category list', () => {
  const s = scopeFor(stateOffice('Akwa Ibom'))
  assert.deepEqual(s.sectionCategories, STATE_OFFICE_CATEGORIES,
    'categories must be untouched; RTKs must NOT have been added')
  assert.ok(!s.sectionCategories.includes('RTKs'))
})

test('facility name matching tolerates case and whitespace', () => {
  assert.deepEqual(extraCommoditiesForFacility('  AKWA IBOM STATE OFFICE STORE '), ['Alere Determine'])
  assert.deepEqual(extraCommoditiesForFacility(null), [])
  assert.deepEqual(extraCommoditiesForFacility(''), [])
})

test('an unrestricted admin carries no grants', () => {
  // No section restriction → nothing to widen; the filter is null either way, so the
  // grant must not appear and cannot narrow what an admin sees.
  const admin = scopeFor({ access_level: 'state_admin', admin_state: 'Akwa Ibom',
    facility_name: 'Akwa Ibom State Office Store' })
  assert.equal(admin.sectionCategories, null)
  assert.deepEqual(admin.sectionCommodityNames, [])
})

test('sectionFilterSql binds correctly and stays inert without a grant', () => {
  // No categories at all (an admin) → no filter, nothing bound.
  const p0 = []
  assert.equal(sectionFilterSql('c', null, ['Alere Determine'], p0), null)
  assert.equal(p0.length, 0)

  // Categories but no grant → byte-identical to the original single-condition SQL.
  const p1 = ['already-bound']
  assert.equal(sectionFilterSql('c', ['Lab consumables'], [], p1), 'c.category = any($2)')
  assert.deepEqual(p1, ['already-bound', ['Lab consumables']])

  // With a grant → OR-ed, and composed after whatever was already bound.
  const p2 = ['x', 'y']
  assert.equal(sectionFilterSql('c', ['Lab consumables'], ['Alere Determine'], p2),
    '(c.category = any($3) or c.name = any($4))')
  assert.deepEqual(p2, ['x', 'y', ['Lab consumables'], ['Alere Determine']])
})

test('sectionFilterFixed numbers from the caller-bound parameter count', () => {
  const a = sectionFilterFixed('c', ['Lab consumables'], ['Alere Determine'], 3)
  assert.equal(a.cond, ' and (c.category = any($4) or c.name = any($5))')
  assert.deepEqual(a.params, [['Lab consumables'], ['Alere Determine']])

  const b = sectionFilterFixed('c', ['Lab consumables'], [], 1)
  assert.equal(b.cond, ' and c.category = any($2)')
  assert.deepEqual(b.params, [['Lab consumables']])

  assert.deepEqual(sectionFilterFixed('c', null, [], 3), { cond: '', params: [] })
})

test('an explicit section narrowing drops a grant from the wrong section', () => {
  const grants = ['Alere Determine']   // category RTKs → lab
  assert.deepEqual(narrowGrantsToCategories(grants, ['RTKs', 'Lab reagents', 'Lab consumables']), grants)
  assert.deepEqual(narrowGrantsToCategories(grants, ['Pharmacy drugs']), [],
    'a pharmacy-section view must not surface a lab commodity')
  // Not narrowing at all is a no-op, not a wipe.
  assert.deepEqual(narrowGrantsToCategories(grants, null), grants)
})

test('allowsCommodity mirrors the SQL', () => {
  const cats = STATE_OFFICE_CATEGORIES, grants = ['Alere Determine']
  assert.equal(allowsCommodity(cats, grants, 'Lab consumables', 'Gloves'), true)
  assert.equal(allowsCommodity(cats, grants, 'RTKs', 'Alere Determine'), true)
  // The precise boundary: another RTK is still refused.
  assert.equal(allowsCommodity(cats, grants, 'RTKs', 'Unigold'), false)
  assert.equal(allowsCommodity(cats, [], 'RTKs', 'Alere Determine'), false)
  assert.equal(allowsCommodity(null, [], 'RTKs', 'Unigold'), true, 'no category list = admin')
})

// ── Against the real database ────────────────────────────────────────────────
// Fails loudly rather than skipping if the DB is unreachable: a silently skipped
// access-control test is worse than none.

test('the granted commodity resolves to exactly one row in the catalogue', async () => {
  const { rows } = await query(
    `select name, category from commodities where name = any($1)`, [['Alere Determine']])
  assert.equal(rows.length, 1, 'Alere Determine must exist by that exact name')
  assert.equal(rows[0].category, 'RTKs', 'if this changed, the grant category must change too')

  // The reason for the whole mechanism: the category holds more than the one item.
  const all = await query(`select count(*)::int as n from commodities where category = 'RTKs'`)
  assert.ok(all.rows[0].n > 1,
    'RTKs holds more than Alere Determine — granting the category would over-grant')
})

test('the filter SQL runs and returns the granted commodity plus its categories', async () => {
  const params = []
  const cond = sectionFilterSql('c', STATE_OFFICE_CATEGORIES, ['Alere Determine'], params)
  const { rows } = await query(`select name, category from commodities c where ${cond}`, params)
  const names = rows.map(r => r.name)
  assert.ok(names.includes('Alere Determine'), 'the granted commodity must come through')
  for (const r of rows) {
    assert.ok(STATE_OFFICE_CATEGORIES.includes(r.category) || r.name === 'Alere Determine',
      `${r.name} (${r.category}) leaked through the filter`)
  }

  // Without the grant, the same query must NOT return it — proving the OR branch is
  // what admits it, not some pre-existing category overlap.
  const p2 = []
  const cond2 = sectionFilterSql('c', STATE_OFFICE_CATEGORIES, [], p2)
  const before = await query(`select name from commodities c where ${cond2}`, p2)
  assert.ok(!before.rows.map(r => r.name).includes('Alere Determine'))
  assert.equal(rows.length, before.rows.length + 1, 'exactly one commodity was added')
})

test.after(() => pool.end())
