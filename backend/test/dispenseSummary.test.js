// Regression suite locking GET /api/dispense/summary's aggregations to the
// client-side reduction they replace (Monitoring's loadConsumption, which drained
// dispense_log at 1000 rows a page and summed the rows in the browser).
//
// Same contract as stockSummary.test.js: integration tests against the real
// database, failing loudly rather than skipping when none is reachable. Set
// ENVO_TEST_ALLOW_NO_DB=1 to skip deliberately.
//
//   npm test --prefix backend

import test from 'node:test'
import assert from 'node:assert/strict'
import { query, pool } from '../src/db.js'
import { LogService, DISPENSE_GROUP_BY_KEYS } from '../src/services/logService.js'
import { SECTION_CATEGORIES } from '../src/constants/sections.js'

// ── The window Monitoring uses: N complete days ending yesterday ─────────────
// Mirrors periodWindow() in pharmacy/lab Monitoring.jsx.
function periodWindow(days, from = new Date()) {
  const midnightToday = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  const start = new Date(midnightToday); start.setDate(start.getDate() - days)
  const end = new Date(midnightToday.getTime() - 1)
  return { start, end }
}

// ── Reference implementation: Monitoring's browser-side reduction, verbatim ──
// Deliberately not refactored — its job is to be the old behaviour.
const localDay = d => {
  const t = new Date(d)
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
}
const utcDay = r => r.dispensed_at?.toISOString?.().slice(0, 10) ?? String(r.dispensed_at).slice(0, 10)

// The raw rows the drain loop would have downloaded, for a scope + window.
async function rawRows({ from, to, facilityIds = null, categories = null, commodityId = null, category = null }) {
  const params = [from, to]
  const conds = ['l.dispensed_at >= $1', 'l.dispensed_at <= $2']
  if (Array.isArray(facilityIds)) { params.push(facilityIds); conds.push(`l.facility_id = any($${params.length})`) }
  if (Array.isArray(categories) && categories.length) { params.push(categories); conds.push(`c.category = any($${params.length})`) }
  if (commodityId) { params.push(commodityId); conds.push(`l.commodity_id = $${params.length}`) }
  if (category) { params.push(category); conds.push(`c.category = $${params.length}`) }
  const { rows } = await query(
    `select l.commodity_id, l.facility_id, l.quantity, l.dispensed_at, c.category
       from dispense_log l left join commodities c on c.id = l.commodity_id
      where ${conds.join(' and ')}`, params)
  return rows
}

// Reduce raw rows the way Monitoring does, for a given key function.
function reduce(rows, keyFn) {
  const m = {}
  rows.forEach(r => {
    const k = keyFn(r)
    if (k == null) return
    if (!m[k]) m[k] = { qty: 0, txn: 0 }
    m[k].qty += r.quantity
    m[k].txn++
  })
  return m
}
// Index an aggregate response by the same key, for comparison.
function index(rows, keyFn) {
  const m = {}
  rows.forEach(r => { m[keyFn(r)] = { qty: r.qty, txn: r.txn } })
  return m
}
function assertSameBuckets(expected, actual, label) {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${label}: bucket keys differ`)
  for (const k of Object.keys(expected)) {
    assert.equal(actual[k].qty, expected[k].qty, `${label}: qty for ${k}`)
    assert.equal(actual[k].txn, expected[k].txn, `${label}: txn (record count) for ${k}`)
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────
let states = [], busiestFacility = null, topCommodity = null, aCategory = null
let unavailable = false
try {
  states = (await query('select distinct state from facilities where state is not null order by 1')).rows.map(r => r.state)
  busiestFacility = (await query('select facility_id from dispense_log group by 1 order by count(*) desc limit 1')).rows[0]?.facility_id
  topCommodity = (await query('select commodity_id from dispense_log group by 1 order by sum(quantity) desc limit 1')).rows[0]?.commodity_id
  aCategory = (await query('select category from commodities where category is not null group by 1 limit 1')).rows[0]?.category
  if (!busiestFacility || !topCommodity) unavailable = 'database is reachable but has no dispense data'
} catch (err) {
  unavailable = `no database reachable (${err.message})`
}
if (unavailable && !process.env.ENVO_TEST_ALLOW_NO_DB) {
  await pool.end().catch(() => {})
  throw new Error(
    `dispense summary tests cannot run: ${unavailable}. ` +
    'Point backend/.env at a populated Postgres, or set ENVO_TEST_ALLOW_NO_DB=1 to skip them deliberately.')
}
if (unavailable) console.warn(`\n[skip] ENVO_TEST_ALLOW_NO_DB set — ${unavailable}\n`)

test.after(async () => { await pool.end().catch(() => {}) })
const dbTest = (name, fn) => test(name, { skip: unavailable }, fn)

const win = periodWindow(30)
const W = { from: win.start.toISOString(), to: win.end.toISOString() }
const call = (opts) => LogService.getDispenseSummary(null, { ...W, ...opts })

// ── Grain equivalence ───────────────────────────────────────────────────────
dbTest('group_by=commodity matches the browser reduction (qty + txn)', async () => {
  const rows = await rawRows(W)
  assertSameBuckets(reduce(rows, r => r.commodity_id),
    index(await call({ groupBy: 'commodity' }), r => r.commodity_id), 'byCommodity')
})

dbTest('group_by=facility matches — powers the LGA/facility breakdown', async () => {
  const rows = await rawRows(W)
  assertSameBuckets(reduce(rows, r => r.facility_id),
    index(await call({ groupBy: 'facility' }), r => r.facility_id), 'byFacility')
})

dbTest('group_by=commodity,facility matches — the commodity drill-in', async () => {
  const rows = await rawRows({ ...W, commodityId: topCommodity })
  assertSameBuckets(reduce(rows, r => r.facility_id),
    index(await call({ groupBy: 'commodity,facility', commodityId: topCommodity }), r => r.facility_id),
    'commodity drill by facility')
})

dbTest('facility COUNT for a commodity matches (the "facilities" card)', async () => {
  const rows = await rawRows({ ...W, commodityId: topCommodity })
  const expected = new Set(rows.map(r => r.facility_id)).size
  const actual = (await call({ groupBy: 'commodity,facility', commodityId: topCommodity })).length
  assert.equal(actual, expected)
})

// ── Date bucketing: BOTH of Monitoring's current behaviours ─────────────────
// The section chart buckets by browser-local date, the per-commodity chart by
// UTC. This release preserves both rather than changing figures; standardising
// them on Africa/Lagos is a separate follow-up.
dbTest('group_by=day with tz reproduces the section chart (local-date buckets)', async () => {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const rows = await rawRows(W)
  assertSameBuckets(reduce(rows, r => localDay(r.dispensed_at)),
    index(await call({ groupBy: 'day', tz }), r => r.day), `byDay (${tz})`)
})

dbTest('group_by=commodity,day without tz reproduces the per-commodity chart (UTC)', async () => {
  const rows = await rawRows({ ...W, commodityId: topCommodity })
  assertSameBuckets(reduce(rows, utcDay),
    index(await call({ groupBy: 'commodity,day', commodityId: topCommodity }), r => r.day),
    'commodity daily (UTC)')
})

dbTest('an explicit tz actually shifts day boundaries (bucketing is not ignored)', async () => {
  const utc = await call({ groupBy: 'day' })
  const kiritimati = await call({ groupBy: 'day', tz: 'Pacific/Kiritimati' })  // UTC+14
  const sum = rs => rs.reduce((s, r) => s + r.qty, 0)
  assert.equal(sum(utc), sum(kiritimati), 'total must not change with timezone')
  assert.notDeepEqual(utc.map(r => r.day).sort(), kiritimati.map(r => r.day).sort(),
    'a +14h zone must move at least one row across a day boundary')
})

// ── Totals ──────────────────────────────────────────────────────────────────
dbTest('totals match: units consumed and consumption records', async () => {
  const rows = await rawRows(W)
  const agg = await call({ groupBy: 'commodity' })
  assert.equal(agg.reduce((s, r) => s + r.qty, 0), rows.reduce((s, r) => s + r.quantity, 0), 'units consumed')
  assert.equal(agg.reduce((s, r) => s + r.txn, 0), rows.length, 'consumption records')
  assert.equal(agg.length, new Set(rows.map(r => r.commodity_id)).size, 'commodities consumed')
})

dbTest('zero-quantity dispenses are counted as records but add no units', async () => {
  const { rows: [z] } = await query(
    `select count(*)::int c from dispense_log where quantity = 0 and dispensed_at >= $1 and dispensed_at <= $2`,
    [W.from, W.to])
  if (!z.c) return  // nothing to assert on this dataset
  const rows = await rawRows(W)
  const agg = await call({ groupBy: 'commodity' })
  assert.equal(agg.reduce((s, r) => s + r.txn, 0), rows.length,
    'a zero-quantity record must still count toward "consumption records"')
})

// ── Scoping ─────────────────────────────────────────────────────────────────
dbTest('facility scoping matches and excludes out-of-scope facilities', async () => {
  const rows = await rawRows({ ...W, facilityIds: [busiestFacility] })
  const agg = await LogService.getDispenseSummary(null, { ...W, groupBy: 'commodity', facilityIds: [busiestFacility] })
  assertSameBuckets(reduce(rows, r => r.commodity_id), index(agg, r => r.commodity_id), 'one facility')
  const scopedFacs = await LogService.getDispenseSummary(null, { ...W, groupBy: 'facility', facilityIds: [busiestFacility] })
  assert.deepEqual(scopedFacs.map(r => r.facility_id), [busiestFacility], 'leaked another facility')
})

dbTest('state scoping matches for every state', async () => {
  for (const state of states) {
    const ids = (await query('select id from facilities where state = $1', [state])).rows.map(r => r.id)
    if (!ids.length) continue
    const rows = await rawRows({ ...W, facilityIds: ids })
    const agg = await LogService.getDispenseSummary(null, { ...W, groupBy: 'commodity', facilityIds: ids })
    assertSameBuckets(reduce(rows, r => r.commodity_id), index(agg, r => r.commodity_id), `state:${state}`)
  }
})

dbTest('empty scope short-circuits to no rows', async () => {
  assert.deepEqual(await LogService.getDispenseSummary(null, { ...W, groupBy: 'commodity', facilityIds: [] }), [])
})

dbTest('section categories are enforced', async () => {
  for (const [section, categories] of Object.entries(SECTION_CATEGORIES)) {
    const rows = await rawRows({ ...W, categories })
    const agg = await call({ groupBy: 'commodity', categories })
    assertSameBuckets(reduce(rows, r => r.commodity_id), index(agg, r => r.commodity_id), `section:${section}`)
    const ids = agg.map(r => r.commodity_id)
    if (!ids.length) continue
    const cats = (await query('select distinct category from commodities where id = any($1)', [ids])).rows.map(r => r.category)
    assert.ok(cats.every(c => categories.includes(c)), `section ${section} leaked: ${cats}`)
  }
})

dbTest('category drill matches the client-side catFilter', async () => {
  const rows = await rawRows({ ...W, category: aCategory })
  const agg = await call({ groupBy: 'facility', category: aCategory })
  assertSameBuckets(reduce(rows, r => r.facility_id), index(agg, r => r.facility_id), `category:${aCategory}`)
})

dbTest('a category drill cannot widen past the token section', async () => {
  // The route returns [] when `category` sits outside the token's categories; the
  // service half must also refuse to widen when both filters are supplied.
  const labCat = SECTION_CATEGORIES.lab[0]
  const rows = await call({ groupBy: 'facility', categories: SECTION_CATEGORIES.pharmacy, category: labCat })
  assert.deepEqual(rows, [], 'section categories and the drill category must intersect, never union')
})

dbTest('commodity_ids and commodity_id intersect rather than widen', async () => {
  const other = (await query('select commodity_id from dispense_log where commodity_id <> $1 group by 1 limit 1',
    [topCommodity])).rows[0]?.commodity_id
  if (!other) return
  const rows = await call({ groupBy: 'commodity', commodityIds: [other], commodityId: topCommodity })
  assert.deepEqual(rows, [], 'a commodity_id outside commodity_ids must yield nothing')
})

// ── Periods ─────────────────────────────────────────────────────────────────
dbTest('every period length matches the browser reduction', async () => {
  for (const days of [7, 30, 90, 365]) {
    const w = periodWindow(days)
    const scope = { from: w.start.toISOString(), to: w.end.toISOString() }
    const rows = await rawRows(scope)
    const agg = await LogService.getDispenseSummary(null, { ...scope, groupBy: 'commodity' })
    assertSameBuckets(reduce(rows, r => r.commodity_id), index(agg, r => r.commodity_id), `${days}d`)
  }
})

dbTest('a window with no consumption returns no rows, not an error', async () => {
  const from = new Date('1990-01-01').toISOString(), to = new Date('1990-01-31').toISOString()
  assert.deepEqual(await LogService.getDispenseSummary(null, { from, to, groupBy: 'commodity' }), [])
})

dbTest('out-of-range junk dates are excluded exactly as the window query excludes them', async () => {
  const rows = await rawRows(W)
  const agg = await call({ groupBy: 'commodity' })
  assert.equal(agg.reduce((s, r) => s + r.txn, 0), rows.length,
    'aggregate must not be more permissive about the date window than the row query')
})

// ── Allowlist ───────────────────────────────────────────────────────────────
dbTest('group_by is an allowlist, not a generic GROUP BY', async () => {
  for (const bad of ['facility,day', 'commodity,facility,day', 'quantity', '', 'commodity;drop', 'month']) {
    await assert.rejects(() => call({ groupBy: bad }), /Unsupported group_by/, `accepted "${bad}"`)
  }
  assert.deepEqual(DISPENSE_GROUP_BY_KEYS,
    ['commodity,month', 'commodity', 'facility', 'day', 'commodity,facility', 'commodity,day', 'commodity,lifetime'],
    'allowlist changed — update the callers and this test together')
})

dbTest('the default grouping is unchanged, so the AMC caller is unaffected', async () => {
  const rows = await call({})
  assert.ok(rows.length > 0)
  for (const r of rows) {
    assert.ok('commodity_id' in r && 'ym' in r && 'qty' in r, 'AMC shape must keep commodity_id, ym, qty')
    assert.match(r.ym, /^\d{4}-\d{2}$/)
  }
})

// ── Scalability guardrail ───────────────────────────────────────────────────
dbTest('initial-load facets track commodities/facilities, not dispense_log size', async () => {
  const { rows: [{ c: logRows }] } = await query(
    'select count(*)::int c from dispense_log where dispensed_at >= $1 and dispensed_at <= $2', [W.from, W.to])
  const byComm = await call({ groupBy: 'commodity' })
  const byFac = await call({ groupBy: 'facility' })
  const byDay = await call({ groupBy: 'day', tz: 'Africa/Lagos' })
  const total = byComm.length + byFac.length + byDay.length
  assert.ok(total < logRows / 5,
    `initial facets returned ${total} rows against ${logRows} log rows — payload is tracking data volume`)
})

// ── Interim ("weekly") AMC: the lifetime grouping ────────────────────────────
dbTest('group_by=commodity,lifetime returns totals plus the first record date', async () => {
  const rows = await LogService.getDispenseSummary(null, { groupBy: 'commodity,lifetime' })
  assert.ok(rows.length > 0)
  for (const r of rows) {
    assert.ok('commodity_id' in r && 'qty' in r && 'txn' in r, 'missing aggregate columns')
    assert.ok(r.first_at instanceof Date, 'first_at must be a timestamp')
    assert.ok(r.last_at >= r.first_at, 'last_at must not precede first_at')
  }
})

dbTest('lifetime excludes junk dates that would corrupt the week span', async () => {
  // dispense_log holds rows dated before 2024 and in the future. A single stray
  // early date would stretch a commodity's span and drive its AMC toward zero,
  // hiding a stockout — so the aggregate must bound the range.
  const rows = await LogService.getDispenseSummary(null, { groupBy: 'commodity,lifetime' })
  const now = new Date(), floor = new Date('2024-01-01')
  for (const r of rows) {
    assert.ok(r.first_at >= floor, `first_at ${r.first_at} predates the floor`)
    assert.ok(r.last_at <= now, `last_at ${r.last_at} is in the future`)
  }
  const { rows: [{ c: outOfRange }] } = await query(
    `select count(*)::int c from dispense_log where dispensed_at < '2024-01-01' or dispensed_at > now()`)
  const bounded = await query(
    `select sum(quantity)::int s from dispense_log where dispensed_at >= '2024-01-01' and dispensed_at <= now()`)
  if (outOfRange > 0) {
    assert.equal(rows.reduce((s, r) => s + r.qty, 0), bounded.rows[0].s,
      'lifetime total must exclude out-of-range rows')
  }
})

dbTest('lifetime honours facility and section scope', async () => {
  const scoped = await LogService.getDispenseSummary(null, { groupBy: 'commodity,lifetime', facilityIds: [busiestFacility] })
  const all = await LogService.getDispenseSummary(null, { groupBy: 'commodity,lifetime' })
  assert.ok(scoped.reduce((s, r) => s + r.qty, 0) <= all.reduce((s, r) => s + r.qty, 0))
  assert.deepEqual(await LogService.getDispenseSummary(null, { groupBy: 'commodity,lifetime', facilityIds: [] }), [])

  const cats = SECTION_CATEGORIES.pharmacy
  const sect = await LogService.getDispenseSummary(null, { groupBy: 'commodity,lifetime', categories: cats })
  const ids = sect.map(r => r.commodity_id)
  if (ids.length) {
    const got = (await query('select distinct category from commodities where id = any($1)', [ids])).rows.map(r => r.category)
    assert.ok(got.every(c => cats.includes(c)), `section leaked: ${got}`)
  }
})

dbTest('weekly AMC math: qty / elapsed weeks * 4.33, clamped to one week', async () => {
  // Mirrors weeklyAmcMap in frontend/src/utils/helpers.js.
  const WEEKS_PER_MONTH = 4.33
  const rows = await LogService.getDispenseSummary(null, { groupBy: 'commodity,lifetime' })
  const now = new Date()
  for (const r of rows.slice(0, 25)) {
    const weeks = Math.max(1, (now - r.first_at) / (7 * 86400000))
    const amc = (r.qty / weeks) * WEEKS_PER_MONTH
    assert.ok(Number.isFinite(amc) && amc >= 0, `AMC not finite for ${r.commodity_id}`)
    // A month is 4.33 weeks, not 4 — using 4 would understate by ~8%, inflating
    // MOS and making genuinely low stock read as adequate.
    assert.ok(amc >= (r.qty / weeks) * 4, 'multiplier must not understate a month')
  }
})
