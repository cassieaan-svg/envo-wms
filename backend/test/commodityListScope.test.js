// GET /api/commodities — the catalogue list, scoped to the caller.
//
// WHAT CHANGED AND WHY. This endpoint returned the whole catalogue and relied on
// the browser to discard what the caller may not see (session.js still filters,
// and useStock turns that filtered list into a request parameter). So the client
// was the boundary — the frontend-field-as-access-control pattern this project
// has been unwinding everywhere else.
//
// The ceiling now comes from req.scope, the SAME rule the stock, dispensing,
// intake, adjustment, transfer, activity and report routes already apply. This
// closes a DATA-EXPOSURE gap, not an access-control one: nothing a section user
// could DO changes, because every operational route already enforced its section
// independently. What changes is that a pharmacy user can no longer read the
// Essential catalogue out of the network tab.
//
// Exercised over real HTTP against the mounted router, because the interesting
// behaviour is the interaction between the query string and req.scope.
//
//   npm test --prefix backend

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import jwt from 'jsonwebtoken'
import { query, pool } from '../src/db.js'
import { attachScope } from '../src/middleware/scope.js'
import { authMiddleware } from '../src/middleware/auth.js'
import commodityRoutes from '../src/routes/commodities.js'
import { SECTION_CATEGORIES, HIV_CATEGORIES, ESSENTIAL_CATEGORIES } from '../src/constants/sections.js'

let server
test.after(async () => { server?.close(); await pool.end() })

const app = express()
app.use(express.json())
app.use('/api', authMiddleware, attachScope)
app.use('/api/commodities', commodityRoutes)
server = app.listen(0)

const token = meta => jwt.sign(
  { sub: '00000000-0000-0000-0000-0000000000c1', email: 'probe@envo.ng', user_metadata: meta },
  process.env.JWT_SECRET, { expiresIn: '5m' })

// Returns the rows, so every assertion below is about what the caller actually
// receives rather than about a count the server reports.
async function list(meta, params = {}) {
  const qs = new URLSearchParams(params).toString()
  const r = await fetch(`http://localhost:${server.address().port}/api/commodities${qs ? `?${qs}` : ''}`,
    { headers: { Authorization: `Bearer ${token(meta)}` } })
  const body = await r.json()
  return { status: r.status, rows: body.data || [], error: body.error }
}

const categoriesOf = rows => [...new Set(rows.map(r => r.category))].sort()
const hasEssential = rows => rows.some(r => ESSENTIAL_CATEGORIES.includes(r.category))

const META = {
  pharmacy:  { access_level: 'facility', commodity_section: 'pharmacy', facility_id: 'f1' },
  lab:       { access_level: 'facility', commodity_section: 'lab', facility_id: 'f2' },
  stateAdmin:{ access_level: 'state_admin', admin_state: 'Akwa Ibom' },
  overall:   { access_level: 'overall_admin', is_admin: true },
  system:    { access_level: 'system_admin' },
  essential: { access_level: 'facility', commodity_section: 'pharmacy', facility_id: 'f3', essential: true },
  essAdmin:  { access_level: 'essential_admin', admin_state: 'Akwa Ibom' },
  hub:       { access_level: 'facility', commodity_section: 'lab',
               facility_name: 'Akwa Ibom State Office Store', facility_id: 'f4' },
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE CANARY — Laboratory must be unchanged
// ═════════════════════════════════════════════════════════════════════════════

test('a lab user receives exactly the lab categories, and the same count as before', async () => {
  // The regression this whole change risks: scoping the endpoint and quietly
  // narrowing the people who were already using it correctly. Asserted against
  // the database rather than a hardcoded number, so it stays true as the
  // catalogue grows.
  const { rows } = await list(META.lab)
  const expected = (await query(
    `select count(*)::int n from commodities where category = any($1)`,
    [SECTION_CATEGORIES.lab])).rows[0].n

  assert.equal(rows.length, expected, 'a lab user must lose nothing')
  assert.ok(rows.length > 0, 'non-vacuous')
  for (const c of categoriesOf(rows)) {
    assert.ok(SECTION_CATEGORIES.lab.includes(c), `${c} is not a lab category`)
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. Pharmacy cannot receive Essential
// ═════════════════════════════════════════════════════════════════════════════

test('a pharmacy user receives Pharmacy drugs and no Essential item', async () => {
  const { rows } = await list(META.pharmacy)
  assert.deepEqual(categoriesOf(rows), ['Pharmacy drugs'])
  assert.equal(hasEssential(rows), false, 'the exposure this change closes')
  assert.ok(rows.length > 0, 'non-vacuous')
})

test('a view filter cannot widen past the caller — the assertion that makes the rest mean anything', async () => {
  // If query parameters REPLACED the scope rather than narrowing within it,
  // every other test here would be trivially satisfiable by not passing one.
  for (const params of [
    { module: 'essential' },
    { section: 'essential' },
    { category: 'Tablets, caplets & capsules' },
    { section: 'lab' },
  ]) {
    const { status, rows } = await list(META.pharmacy, params)
    assert.equal(status, 200, 'an out-of-scope filter is empty, not an error')
    assert.equal(rows.length, 0,
      `?${new URLSearchParams(params)} must not reach outside the pharmacy section`)
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. Essential users get their permitted sections
// ═════════════════════════════════════════════════════════════════════════════

test('an Essential-granted login receives its section AND the Essential catalogue', async () => {
  // The grant is ADDITIVE to the section pin, not a fallback for its absence.
  //
  // The 194 granted logins carry commodity_section = 'pharmacy' explicitly —
  // that section is the essential-commodities branch's own precondition for
  // opening Essential — so a rule that only filled in an ABSENT section never
  // reached them: they held the grant and saw no Essential item at all.
  //
  // This also puts legacy and the ACL in agreement. The ACL has given these
  // accounts {pharmacy, essential} since Phase 2M.2d; until now the two
  // described different access for the same people.
  const { rows } = await list(META.essential)
  assert.ok(rows.some(r => r.category === 'Pharmacy drugs'), 'the section it is pinned to')
  assert.ok(hasEssential(rows), 'and the module its grant opens')
  assert.ok(!rows.some(r => SECTION_CATEGORIES.lab.includes(r.category)),
    'but the grant is not a wildcard — lab is still out of reach')
})

test('an UNPINNED Essential-granted login does receive both', async () => {
  // The half that does work today: with no commodity_section the meta.essential
  // default applies, and the account spans both modules. This is the shape the
  // essential_admin role has.
  const { rows } = await list(
    { access_level: 'facility', facility_id: 'f9', essential: true })
  assert.ok(hasEssential(rows), 'Essential items are reachable when nothing pins the section')
  assert.ok(rows.some(r => r.category === 'Pharmacy drugs'), 'alongside HIV')
})

test('the essential_admin role behaves the same way', async () => {
  const { rows } = await list(META.essAdmin)
  assert.ok(hasEssential(rows))
  assert.ok(rows.some(r => r.category === 'Pharmacy drugs'))
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. Administrators
// ═════════════════════════════════════════════════════════════════════════════

test('state_admin and overall_admin get the HIV catalogue — and are identical', async () => {
  const state = await list(META.stateAdmin)
  const overall = await list(META.overall)
  for (const [who, res] of [['state_admin', state], ['overall_admin', overall]]) {
    assert.equal(hasEssential(res.rows), false, `${who} must not receive Essential items`)
    for (const c of categoriesOf(res.rows)) {
      assert.ok(HIV_CATEGORIES.includes(c), `${who}: ${c} is outside the HIV module`)
    }
  }
  // Category SETS, not row counts: aclSystemAdmin and aclEssentialAdmin create
  // and drop catalogue items concurrently, so two requests a moment apart can
  // legitimately return different totals. What must hold is that the two tiers
  // reach the same categories.
  assert.deepEqual(categoriesOf(state.rows), categoriesOf(overall.rows),
    'the two HIV oversight tiers see the same catalogue')
})

test('system_admin receives the entire catalogue, including Essential', async () => {
  // Relative, not against a COUNT(*): aclSystemAdmin and aclEssentialAdmin
  // create and drop catalogue rows concurrently, so a total taken in a separate
  // statement is a different instant. What must hold is that system_admin is a
  // strict superset of an HIV admin and reaches both modules.
  const sys = await list(META.system)
  const hivOnly = await list(META.stateAdmin)
  assert.ok(hasEssential(sys.rows), 'the approved decision: full catalogue visibility')

  // Category sets again, for the same reason as above — a concurrent insert
  // between the two requests must not read as a scoping failure.
  const sysCats = new Set(categoriesOf(sys.rows))
  for (const c of categoriesOf(hivOnly.rows)) {
    assert.ok(sysCats.has(c), `system_admin must not lose ${c}, which an HIV admin sees`)
  }
  assert.ok(categoriesOf(sys.rows).length > categoriesOf(hivOnly.rows).length,
    'and reaches strictly more categories')
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. The catalogue-management escape hatch
// ═════════════════════════════════════════════════════════════════════════════

test('?all=true returns everything to a catalogue manager', async () => {
  // Compared against another unscoped response rather than a COUNT(*) — see the
  // note on the system_admin test about concurrent catalogue writes.
  const reference = await list(META.system, { all: 'true' })
  assert.ok(hasEssential(reference.rows) && reference.rows.some(r => r.category === 'Pharmacy drugs'),
    'the reference response spans both modules')

  for (const meta of [META.overall, META.essAdmin]) {
    const { status, rows } = await list(meta, { all: 'true' })
    assert.equal(status, 200)
    assert.ok(hasEssential(rows),
      'administering the item list needs every module, including ones this role does not operate in')
    assert.ok(rows.some(r => r.category === 'Pharmacy drugs'))
  }
})

test('?all=true is refused to everyone else', async () => {
  for (const meta of [META.pharmacy, META.lab, META.essential]) {
    const { status, error } = await list(meta, { all: 'true' })
    assert.equal(status, 403, 'the escape hatch is permission-checked, not a query-string opt-out')
    assert.match(error, /catalogue manager/i)
  }
})

test('an overall_admin is scoped by default and unscoped only when it asks', async () => {
  // The distinction the flag exists for: overseeing a programme versus
  // administering the item list. Same account, two answers.
  const scoped = await list(META.overall)
  const unscoped = await list(META.overall, { all: 'true' })
  assert.equal(hasEssential(scoped.rows), false, 'session bootstrap: HIV only')
  assert.equal(hasEssential(unscoped.rows), true, 'Catalogue page: everything')
})

// ═════════════════════════════════════════════════════════════════════════════
// 6. The per-facility grant survives the new filter
// ═════════════════════════════════════════════════════════════════════════════

test('the Akwa Ibom hub keeps Alere Determine, which its categories exclude', async () => {
  // sectionFilterSql takes categories AND names for exactly this case. Dropping
  // the names when the endpoint was scoped would have silently revoked the one
  // grant the mechanism exists for.
  const { rows } = await list(META.hub)
  assert.ok(rows.some(r => r.name === 'Alere Determine'),
    'the individually-granted commodity must survive')
  assert.ok(!rows.some(r => r.category === 'RTKs' && r.name !== 'Alere Determine'),
    'and it must not have dragged the rest of its category in')
})

// ═════════════════════════════════════════════════════════════════════════════
// 7. The vocabulary endpoints stay open
// ═════════════════════════════════════════════════════════════════════════════

test('/modules and /categories remain unscoped — they return vocabulary, not data', async () => {
  for (const path of ['modules', 'categories']) {
    const r = await fetch(`http://localhost:${server.address().port}/api/commodities/${path}`,
      { headers: { Authorization: `Bearer ${token(META.pharmacy)}` } })
    assert.equal(r.status, 200)
    const body = await r.json()
    assert.ok((body.data || []).length > 0,
      `${path} must stay available: the Catalogue page builds its filters from it`)
  }
})
