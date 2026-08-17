// Regression suite locking GET /api/stock/summary to the client-side computation
// it replaces (groupStockByComm + the DSD/SDP sum loops in the dashboards).
//
// These are INTEGRATION tests: they run the real aggregate SQL against the local
// `envo` database and compare it, per commodity, to a verbatim JS re-implementation
// of the old browser-side path over the same rows. If the two ever disagree, the
// migration has changed a number a user sees.
//
// Requires a populated Postgres (backend/.env). If the database is unreachable or
// empty the suite FAILS LOUDLY rather than skipping — a validation suite that
// quietly passes because it verified nothing is worse than no suite at all. Set
// ENVO_TEST_ALLOW_NO_DB=1 to downgrade that to a skip, for an environment where
// running without a database is a deliberate choice.
//
//   npm test --prefix backend

import test from 'node:test'
import assert from 'node:assert/strict'
import { query, pool } from '../src/db.js'
import { StockService } from '../src/services/stockService.js'
import { SECTION_CATEGORIES, STATE_OFFICE_CATEGORIES } from '../src/constants/sections.js'

// ── Reference implementation: the browser-side path, copied verbatim ──────────
// Mirrors frontend/src/utils/helpers.js groupStockByComm plus the dashboards'
// `aggSiteStock` reduce. Intentionally NOT refactored — its job is to be the old
// behaviour, including its float accumulation.
function groupStockByComm(stockRows) {
  const map = {}
  stockRows.forEach(r => {
    if (!map[r.commodity_id]) {
      map[r.commodity_id] = { ...r, storeQty: 0, dispensaryQty: 0, dsdQty: 0, _amcByFac: {} }
    }
    const g = map[r.commodity_id]
    if (r.location_type === 'store') g.storeQty += r.quantity
    else if (r.location_type === 'dispensary') g.dispensaryQty += r.quantity
    else if (r.location_type === 'dsd') g.dsdQty += r.quantity
    if (r.baseline_amc > 0) {
      g._amcByFac[r.facility_id] = Math.max(g._amcByFac[r.facility_id] || 0, r.baseline_amc)
    }
  })
  return Object.values(map).map(({ _amcByFac, ...r }) => ({
    ...r,
    quantity: r.storeQty + r.dispensaryQty + r.dsdQty,
    baseline_amc: Object.values(_amcByFac).reduce((s, v) => s + Number(v), 0),
  }))
}

// getMOS / getStockStatus, mirrored from frontend/src/utils/helpers.js.
const getMOS = (quantity, amc) => (!amc || amc <= 0) ? null : quantity / amc
function getStockStatus(quantity, amc) {
  if (quantity === 0) return 'out'
  const mos = getMOS(quantity, amc)
  if (mos === null) return 'nodata'
  if (mos < 2) return 'low'
  if (mos > 4) return 'over'
  return 'ok'
}

// ── One snapshot per comparison ───────────────────────────────────────────────
// Every test here compares the aggregate SQL against a re-implementation over the
// raw tables. Those are separate queries, so by default each one sees a different
// snapshot of a LIVE database: anything that commits in between — a dev server, a
// concurrent test file seeding fixtures — makes the two halves disagree and the
// suite fails for a reason that has nothing to do with the code under test.
//
// Running both halves inside one REPEATABLE READ transaction pins them to a single
// snapshot, so a concurrent write is invisible to both rather than to one. READ
// ONLY makes that explicit and stops a stray write here from touching real data.
async function withSnapshot(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    return await fn((text, params) => client.query(text, params))
  } finally {
    try { await client.query('ROLLBACK') } catch { /* ignore */ }
    client.release()
  }
}

// Fetch the raw rows the old client would have downloaded, for the same scope.
async function oldPath({ facilityIds = null, commodityIds = null, categories = null } = {}, exec = query) {
  const params = []
  const facIdx = Array.isArray(facilityIds) ? (params.push(facilityIds), params.length) : null
  const commIdx = (Array.isArray(commodityIds) && commodityIds.length) ? (params.push(commodityIds), params.length) : null
  const catIdx = (Array.isArray(categories) && categories.length) ? (params.push(categories), params.length) : null
  const filt = t => [
    facIdx ? ` and ${t}.facility_id = any($${facIdx})` : '',
    commIdx ? ` and ${t}.commodity_id = any($${commIdx})` : '',
    catIdx ? ` and c.category = any($${catIdx})` : '',
  ].join('')

  const stock = (await exec(
    `select st.commodity_id, st.facility_id, st.quantity, st.location_type, st.baseline_amc
       from stock st join commodities c on c.id = st.commodity_id where true${filt('st')}`, params)).rows
  const dsd = (await exec(
    `select dd.commodity_id, dd.quantity from dsd_stock dd
       join commodities c on c.id = dd.commodity_id where true${filt('dd')}`, params)).rows
  const sdp = (await exec(
    `select sp.commodity_id, sp.quantity from sdp_stock sp
       join commodities c on c.id = sp.commodity_id where true${filt('sp')}`, params)).rows

  const gMap = {}
  groupStockByComm(stock).forEach(g => { gMap[g.commodity_id] = g })
  const dsdMap = {}, sdpMap = {}
  dsd.forEach(d => { dsdMap[d.commodity_id] = (dsdMap[d.commodity_id] || 0) + d.quantity })
  sdp.forEach(d => { sdpMap[d.commodity_id] = (sdpMap[d.commodity_id] || 0) + d.quantity })
  return { gMap, dsdMap, sdpMap }
}

// Compare the aggregate to the reference path over one scope, field by field.
async function assertScopeMatches(scope, label, exec) {
  if (!exec) return withSnapshot(e => assertScopeMatches(scope, label, e))
  const rows = await StockService.getScopedStockSummary(scope, exec)
  const { gMap, dsdMap, sdpMap } = await oldPath(scope, exec)
  const byId = Object.fromEntries(rows.map(r => [r.commodity_id, r]))

  // Every commodity the old path would have surfaced must be present, and the
  // aggregate must not invent any the old path wouldn't have shown.
  const expectedIds = new Set([...Object.keys(gMap), ...Object.keys(dsdMap), ...Object.keys(sdpMap)])
  assert.deepEqual(
    [...new Set(rows.map(r => r.commodity_id))].sort(),
    [...expectedIds].sort(),
    `${label}: commodity set differs`
  )

  for (const id of expectedIds) {
    const a = byId[id]
    const g = gMap[id] || { storeQty: 0, dispensaryQty: 0, baseline_amc: 0 }
    const oldDsd = dsdMap[id] || 0
    const oldSdp = sdpMap[id] || 0

    assert.equal(a.store_qty, g.storeQty, `${label}/${id}: store SOH`)
    assert.equal(a.dispensary_qty, g.dispensaryQty, `${label}/${id}: dispensary SOH`)
    assert.equal(a.dsd_qty, oldDsd, `${label}/${id}: DSD SOH`)
    assert.equal(a.sdp_qty, oldSdp, `${label}/${id}: SDP SOH`)
    assert.equal(a.has_stock, !!gMap[id], `${label}/${id}: has_stock ("in use" signal)`)

    // AMC: exact-numeric server sum vs the browser's float accumulation across
    // facilities. Equal to well within the .toFixed(1) the UI renders; the
    // observed drift on the largest commodity (278 facilities) was ~3e-11.
    assert.ok(
      Math.abs(a.baseline_amc - g.baseline_amc) < 1e-6,
      `${label}/${id}: baseline AMC ${a.baseline_amc} vs ${g.baseline_amc}`
    )

    // Derived figures the cards and table render. Pharmacy total = store +
    // dispensary + DSD; lab total = store + SDP (see the Dashboard's enrichedAll).
    for (const [kind, oldQty, newQty] of [
      ['pharmacy', g.storeQty + g.dispensaryQty + oldDsd, a.store_qty + a.dispensary_qty + a.dsd_qty],
      ['lab', g.storeQty + oldSdp, a.store_qty + a.sdp_qty],
    ]) {
      assert.equal(newQty, oldQty, `${label}/${id}: ${kind} total SOH`)
      assert.equal(
        getStockStatus(newQty, a.baseline_amc), getStockStatus(oldQty, g.baseline_amc),
        `${label}/${id}: ${kind} stock status`
      )
      const oldMos = getMOS(oldQty, g.baseline_amc), newMos = getMOS(newQty, a.baseline_amc)
      if (oldMos === null || newMos === null) {
        assert.equal(newMos, oldMos, `${label}/${id}: ${kind} MOS null-ness`)
      } else {
        assert.ok(Math.abs(newMos - oldMos) < 1e-6, `${label}/${id}: ${kind} MOS ${newMos} vs ${oldMos}`)
      }
    }
  }
  return rows
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Loaded at module scope so `skip` can be a plain value — node:test treats a
// FUNCTION passed as `skip` as truthy and would silently skip the whole suite.
let states = [], busiestFacility = null, allCommodityIds = []
let unavailable = false

try {
  states = (await query('select distinct state from facilities where state is not null order by 1')).rows.map(r => r.state)
  busiestFacility = (await query('select facility_id from stock group by 1 order by count(*) desc limit 1')).rows[0]?.facility_id
  allCommodityIds = (await query('select id from commodities')).rows.map(r => r.id)
  if (!busiestFacility || !allCommodityIds.length) unavailable = 'database is reachable but has no stock/commodity data'
} catch (err) {
  unavailable = `no database reachable (${err.message})`
}

// Fail rather than skip by default: these tests exist to prove the aggregate
// matches the old computation, and a green run that asserted nothing would be a
// false signal at exactly the moment it matters.
if (unavailable && !process.env.ENVO_TEST_ALLOW_NO_DB) {
  await pool.end().catch(() => {})
  throw new Error(
    `stock summary tests cannot run: ${unavailable}. ` +
    'Point backend/.env at a populated Postgres, or set ENVO_TEST_ALLOW_NO_DB=1 to skip them deliberately.'
  )
}
if (unavailable) console.warn(`\n[skip] ENVO_TEST_ALLOW_NO_DB set — ${unavailable}\n`)

test.after(async () => { await pool.end().catch(() => {}) })

const dbTest = (name, fn) => test(name, { skip: unavailable }, fn)

// Canary: proves the suite actually executed against a database. If the fixtures
// above ever degrade to "empty but not throwing", this fails instead of the whole
// file quietly reporting success.
test('suite ran against a populated database', { skip: unavailable }, () => {
  assert.ok(allCommodityIds.length > 0, 'no commodities loaded — fixtures did not run')
  assert.ok(busiestFacility, 'no facility with stock found — fixtures did not run')
})

// ── Scoping ──────────────────────────────────────────────────────────────────
dbTest('unscoped (overall admin) matches the client-side computation', async () => {
  const rows = await assertScopeMatches({}, 'unscoped')
  assert.ok(rows.length > 0, 'expected some commodities with stock')
})

dbTest('facility scoping matches, and excludes out-of-scope facilities', async () => {
  await withSnapshot(async exec => {
    const rows = await assertScopeMatches({ facilityIds: [busiestFacility] }, 'one facility', exec)
    const unscoped = await StockService.getScopedStockSummary({}, exec)
    const totalOne = rows.reduce((s, r) => s + r.store_qty, 0)
    const totalAll = unscoped.reduce((s, r) => s + r.store_qty, 0)
    assert.ok(totalOne < totalAll, 'a single facility must hold less than the whole network')
  })
})

dbTest('state scoping matches for every state', async () => {
  for (const state of states) {
    const ids = (await query('select id from facilities where state = $1', [state])).rows.map(r => r.id)
    if (!ids.length) continue
    await assertScopeMatches({ facilityIds: ids }, `state:${state}`)
  }
})

dbTest('commodity scoping matches (section-filtered catalogue)', async () => {
  const subset = allCommodityIds.slice(0, Math.ceil(allCommodityIds.length / 3))
  const rows = await assertScopeMatches({ commodityIds: subset }, 'commodity subset')
  const allowed = new Set(subset)
  assert.ok(rows.every(r => allowed.has(r.commodity_id)), 'returned a commodity outside the requested set')
})

dbTest('empty scope short-circuits to no rows', async () => {
  assert.deepEqual(await StockService.getScopedStockSummary({ facilityIds: [] }), [])
})

dbTest('unknown facility id yields no rows (not an error, not everything)', async () => {
  const rows = await StockService.getScopedStockSummary({
    facilityIds: ['00000000-0000-0000-0000-000000000000'],
  })
  assert.deepEqual(rows, [])
})

// ── Section / category enforcement ───────────────────────────────────────────
dbTest('section enforcement restricts to the section categories', async () => {
  for (const [section, categories] of Object.entries(SECTION_CATEGORIES)) {
    const rows = await assertScopeMatches({ categories }, `section:${section}`)
    const ids = rows.map(r => r.commodity_id)
    if (!ids.length) continue
    const cats = (await query('select distinct category from commodities where id = any($1)', [ids])).rows.map(r => r.category)
    assert.ok(cats.every(c => categories.includes(c)), `section ${section} leaked categories: ${cats}`)
  }
})

dbTest('state-office category set is honoured', async () => {
  const rows = await assertScopeMatches({ categories: STATE_OFFICE_CATEGORIES }, 'state office')
  const ids = rows.map(r => r.commodity_id)
  if (ids.length) {
    const cats = (await query('select distinct category from commodities where id = any($1)', [ids])).rows.map(r => r.category)
    assert.ok(cats.every(c => STATE_OFFICE_CATEGORIES.includes(c)), `leaked categories: ${cats}`)
  }
})

dbTest('a section caller cannot widen scope by asking for other commodities', async () => {
  // Simulates the route handing the token's categories alongside a client-supplied
  // commodity_ids list that reaches outside the section: the category filter must win.
  const pharmacy = SECTION_CATEGORIES.pharmacy
  const labIds = (await query(
    'select id from commodities where category = any($1)', [SECTION_CATEGORIES.lab])).rows.map(r => r.id)
  if (!labIds.length) return
  const rows = await StockService.getScopedStockSummary({ categories: pharmacy, commodityIds: labIds })
  assert.deepEqual(rows, [], 'section categories must intersect, never union, with the client filter')
})

dbTest('a facility-scoped caller cannot widen scope via extra facility ids', async () => {
  // The route intersects the token scope with the client filter before calling the
  // service (resolveListFacilityIds). This locks the service half: given the
  // already-intersected set, only those facilities contribute.
  await withSnapshot(async exec => {
    const scoped = await StockService.getScopedStockSummary({ facilityIds: [busiestFacility] }, exec)
    const { gMap } = await oldPath({ facilityIds: [busiestFacility] }, exec)
    for (const r of scoped) {
      assert.equal(r.store_qty, gMap[r.commodity_id]?.storeQty ?? 0, 'scoped total drew in another facility')
    }
  })
})

// ── Edge-case commodity shapes ───────────────────────────────────────────────
dbTest('commodities with only DSD/SDP stock appear with has_stock false', async () => {
  const rows = await StockService.getScopedStockSummary({})
  const siteOnly = rows.filter(r => !r.has_stock)
  for (const r of siteOnly) {
    assert.equal(r.store_qty, 0, 'no stock row must mean no store SOH')
    assert.equal(r.dispensary_qty, 0, 'no stock row must mean no dispensary SOH')
    assert.ok(r.dsd_qty > 0 || r.sdp_qty > 0, 'a row with no stock and no site stock should not be returned')
  }
})

dbTest('zero-stock commodities keep their row and read as out of stock', async () => {
  const rows = await StockService.getScopedStockSummary({})
  const zeroed = rows.filter(r => r.store_qty + r.dispensary_qty + r.dsd_qty === 0 && r.has_stock)
  for (const r of zeroed) {
    assert.equal(getStockStatus(r.store_qty + r.dispensary_qty + r.dsd_qty, r.baseline_amc), 'out',
      'a tracked commodity at zero must still report out-of-stock, not disappear')
  }
})

dbTest('commodities with no stock anywhere are omitted (catalogue is added client-side)', async () => {
  await withSnapshot(async exec => {
    const rows = await StockService.getScopedStockSummary({}, exec)
    const returned = new Set(rows.map(r => r.commodity_id))
    const untouched = (await exec(`
      select id from commodities c
       where not exists (select 1 from stock where commodity_id = c.id)
         and not exists (select 1 from dsd_stock where commodity_id = c.id)
         and not exists (select 1 from sdp_stock where commodity_id = c.id) limit 5`)).rows
    for (const c of untouched) {
      assert.ok(!returned.has(c.id), 'a commodity with no stock record anywhere must not be returned')
    }
  })
})

// ── Dashboard card counts ────────────────────────────────────────────────────
dbTest('dashboard card counts are identical to the client-side computation', async () => {
  const scopes = [
    { label: 'overall admin', scope: {} },
    { label: 'one facility', scope: { facilityIds: [busiestFacility] } },
    { label: 'section pharmacy', scope: { categories: SECTION_CATEGORIES.pharmacy } },
  ]
  for (const { label, scope } of scopes) {
    const { rows, gMap, dsdMap, sdpMap } = await withSnapshot(async exec => ({
      rows: await StockService.getScopedStockSummary(scope, exec),
      ...await oldPath(scope, exec),
    }))

    // Card counts are computed over the whole catalogue (every tracked commodity,
    // so zero-stock items count as out-of-stock), exactly as the Dashboard does.
    const count = statuses => statuses.reduce((acc, s) => (acc[s] = (acc[s] || 0) + 1, acc), {})
    const newStatuses = allCommodityIds.map(id => {
      const r = rows.find(x => x.commodity_id === id)
      const q = r ? r.store_qty + r.dispensary_qty + r.dsd_qty : 0
      return getStockStatus(q, r ? r.baseline_amc : 0)
    })
    const oldStatuses = allCommodityIds.map(id => {
      const g = gMap[id] || { storeQty: 0, dispensaryQty: 0, baseline_amc: 0 }
      const q = g.storeQty + g.dispensaryQty + (dsdMap[id] || 0)
      return getStockStatus(q, g.baseline_amc)
    })
    assert.deepEqual(count(newStatuses), count(oldStatuses), `${label}: dashboard card counts differ`)
    void sdpMap
  }
})

// ── Shape / scalability guardrail ────────────────────────────────────────────
dbTest('response is one row per commodity, not one per stock row', async () => {
  const { rows, stockRows } = await withSnapshot(async exec => ({
    rows: await StockService.getScopedStockSummary({}, exec),
    stockRows: (await exec('select count(*)::int c from stock')).rows[0].c,
  }))
  const ids = rows.map(r => r.commodity_id)
  assert.equal(ids.length, new Set(ids).size, 'duplicate commodity rows — the aggregate is not collapsing')

  assert.ok(rows.length < stockRows / 10,
    `summary returned ${rows.length} rows against ${stockRows} stock rows — payload is tracking data volume`)
})

// ── Facility grain: what All Facilities needs ────────────────────────────────
// It counts reporting sites and per-site status per commodity, which the
// commodity-grain rollup cannot answer. Today it derives that from the whole
// stock array plus two paginated site-stock drains.
dbTest('facility grain reproduces the per-(commodity, facility) reduction', async () => {
  await withSnapshot(async exec => {
  const rows = await StockService.getScopedStockByFacility({}, exec)

  // The old client-side path: group every stock row by (commodity, facility),
  // summing quantity and taking the max baseline_amc, then fold in site stock.
  const raw = (await exec('select commodity_id, facility_id, quantity, location_type, baseline_amc from stock')).rows
  const expect = {}
  const key = (c, f) => `${c}|${f}`
  raw.forEach(r => {
    const k = key(r.commodity_id, r.facility_id)
    if (!expect[k]) expect[k] = { total: 0, amc: 0, store: 0, dispensary: 0, other: 0 }
    expect[k].total += r.quantity
    if (r.location_type === 'store') expect[k].store += r.quantity
    else if (r.location_type === 'dispensary') expect[k].dispensary += r.quantity
    else expect[k].other += r.quantity
    if ((r.baseline_amc || 0) > expect[k].amc) expect[k].amc = r.baseline_amc || 0
  })
  for (const [table, col] of [['dsd_stock', 'dsd'], ['sdp_stock', 'sdp']]) {
    for (const r of (await exec(`select commodity_id, facility_id, quantity from ${table}`)).rows) {
      const k = key(r.commodity_id, r.facility_id)
      if (!expect[k]) expect[k] = { total: 0, amc: 0, store: 0, dispensary: 0, other: 0 }
      expect[k][col] = (expect[k][col] || 0) + r.quantity
    }
  }

  const got = Object.fromEntries(rows.map(r => [key(r.commodity_id, r.facility_id), r]))
  assert.deepEqual(Object.keys(got).sort(), Object.keys(expect).sort(), 'pair set differs')
  for (const [k, e] of Object.entries(expect)) {
    const a = got[k]
    assert.equal(a.store_qty, e.store, `${k}: store`)
    assert.equal(a.dispensary_qty, e.dispensary, `${k}: dispensary`)
    assert.equal(a.other_qty, e.other, `${k}: other (non store/dispensary stock rows)`)
    assert.equal(a.dsd_qty, e.dsd || 0, `${k}: DSD site stock`)
    assert.equal(a.sdp_qty, e.sdp || 0, `${k}: SDP site stock`)
    assert.ok(Math.abs(a.baseline_amc - e.amc) < 1e-6, `${k}: baseline AMC`)
    // The overview's per-facility total sums every stock row regardless of location.
    assert.equal(a.store_qty + a.dispensary_qty + a.other_qty, e.total, `${k}: per-facility total`)
  }
  })
})

dbTest('facility grain honours facility, commodity and section scope', async () => {
  assert.deepEqual(await StockService.getScopedStockByFacility({ facilityIds: [] }), [])

  const scoped = await StockService.getScopedStockByFacility({ facilityIds: [busiestFacility] })
  assert.ok(scoped.length > 0)
  assert.ok(scoped.every(r => r.facility_id === busiestFacility), 'leaked another facility')

  const cats = SECTION_CATEGORIES.pharmacy
  const sect = await StockService.getScopedStockByFacility({ categories: cats })
  const ids = [...new Set(sect.map(r => r.commodity_id))]
  if (ids.length) {
    const got = (await query('select distinct category from commodities where id = any($1)', [ids])).rows.map(r => r.category)
    assert.ok(got.every(c => cats.includes(c)), `section leaked: ${got}`)
  }
})

dbTest('facility grain: commodity_id narrows to the drill-down commodity only', async () => {
  await withSnapshot(async exec => {
    const all = await StockService.getScopedStockByFacility({}, exec)
    const one = all[0].commodity_id
    const drill = await StockService.getScopedStockByFacility({ commodityId: one }, exec)
    assert.ok(drill.length > 0)
    assert.ok(drill.every(r => r.commodity_id === one), 'drill returned another commodity')
    assert.equal(drill.length, all.filter(r => r.commodity_id === one).length, 'drill dropped facilities')
  })
})

dbTest('facility grain totals reconcile with the commodity grain', async () => {
  const { byFac, byComm } = await withSnapshot(async exec => ({
    byFac: await StockService.getScopedStockByFacility({}, exec),
    byComm: await StockService.getScopedStockSummary({}, exec),
  }))
  const roll = {}
  byFac.forEach(r => {
    if (!roll[r.commodity_id]) roll[r.commodity_id] = { store: 0, disp: 0, dsd: 0, sdp: 0 }
    roll[r.commodity_id].store += r.store_qty
    roll[r.commodity_id].disp += r.dispensary_qty
    roll[r.commodity_id].dsd += r.dsd_qty
    roll[r.commodity_id].sdp += r.sdp_qty
  })
  for (const c of byComm) {
    const r = roll[c.commodity_id]
    assert.ok(r, `${c.commodity_id} missing from the facility grain`)
    assert.equal(r.store, c.store_qty, `${c.commodity_id}: store must roll up`)
    assert.equal(r.disp, c.dispensary_qty, `${c.commodity_id}: dispensary must roll up`)
    assert.equal(r.dsd, c.dsd_qty, `${c.commodity_id}: DSD must roll up`)
    assert.equal(r.sdp, c.sdp_qty, `${c.commodity_id}: SDP must roll up`)
  }
})
