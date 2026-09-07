// Phase 2K — measurement of the pending-transfer counterparty exception.
//
// The exception grants a facility-level user READ access to another facility's
// `stock` when the two are parties to a pending transfer:
//
//   scope.js:173  scopedReadFacilityIds  ('list'   — widens the id list)
//   scope.js:223  enforceFacilityRead    ('single' — the only possible grant)
//
// scope.js is untouched. The probe watches from db.js and only counts. These
// tests exist to prove exactly four things, in order:
//
//   1. the legacy decision is identical with the probe on and off
//   2. the exception is detected, at the right call site
//   3. ordinary access is not counted as an exception
//   4. the probe can neither grant nor deny, even when it is broken
//
//   npm test --prefix backend

import test from 'node:test'
import assert from 'node:assert/strict'
import { query, pool } from '../src/db.js'
import { scopedReadFacilityIds, enforceFacilityRead } from '../src/middleware/scope.js'
import {
  observeCounterpartyQuery, flushCounterpartyProbe, counterpartyProbeSnapshot,
  resetCounterpartyProbe, setProbeEnabled, probeEnabled, _internals,
} from '../src/services/counterpartyProbe.js'

const wasEnabled = probeEnabled()
test.after(async () => {
  setProbeEnabled(wasEnabled)
  resetCounterpartyProbe()
  await query(`delete from counterparty_probe where facility_id = any($1::uuid[])`, [touched])
  await pool.end()
})

const touched = []

// A res double: the guards write a 403 through it and return false.
function fakeRes() {
  const r = { statusCode: null, body: null }
  r.status = c => { r.statusCode = c; return r }
  r.json = b => { r.body = b; return r }
  return r
}

const facilityReq = facilityId => ({
  scope: {
    accessLevel: 'facility', isAdmin: false, facilityId,
    facilityName: null, adminState: null, adminLga: null, adminCluster: null,
    section: 'pharmacy', sectionCategories: ['Pharmacy Drugs'], sectionCommodityNames: [],
  },
})

const adminReq = state => ({
  scope: {
    accessLevel: 'state_admin', isAdmin: false, facilityId: null,
    facilityName: null, adminState: state, adminLga: null, adminCluster: null,
    section: null, sectionCategories: null, sectionCommodityNames: [],
  },
})

// A real pending pair, so the exception has something to find.
async function pendingPair() {
  const { rows } = await query(
    `select sending_facility_id s, receiving_facility_id r
       from stock_transfer_log
      where status = 'pending' and sending_facility_id is not null
        and receiving_facility_id is not null
        and sending_facility_id <> receiving_facility_id
      limit 1`)
  if (!rows.length) throw new Error('no pending transfer pair in this database')
  touched.push(rows[0].s, rows[0].r)
  return rows[0]
}

// scope.js's own rule, re-implemented here ONLY so a test can check the world
// state at the moment it asserts. Never used to compute an expected decision —
// that always comes from scope.js itself.
async function pendingCounterparties(facilityId) {
  const { rows } = await query(
    `select sending_facility_id fid from stock_transfer_log
      where receiving_facility_id = $1 and status = 'pending'
     union
     select receiving_facility_id from stock_transfer_log
      where sending_facility_id = $1 and status = 'pending'`, [facilityId])
  return rows.map(r => r.fid).filter(Boolean)
}

// A facility that is party to NO pending transfer — the ordinary case.
async function quietFacility() {
  const { rows } = await query(
    `select f.id from facilities f
      where not exists (
        select 1 from stock_transfer_log t
         where t.status = 'pending'
           and (t.sending_facility_id = f.id or t.receiving_facility_id = f.id))
      limit 1`)
  if (!rows.length) throw new Error('every facility has a pending transfer')
  touched.push(rows[0].id)
  return rows[0].id
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. The legacy decision is unchanged
// ═════════════════════════════════════════════════════════════════════════════

test('every legacy decision is byte-identical with the probe off and on', async () => {
  const { s, r } = await pendingPair()
  const quiet = await quietFacility()

  // Each case: [label, fn(req) -> comparable value]
  const cases = [
    ['list: counterparty facility',
      () => scopedReadFacilityIds(facilityReq(s), 'stock')],
    ['list: quiet facility',
      () => scopedReadFacilityIds(facilityReq(quiet), 'stock')],
    ['list: non-stock table takes no exception',
      () => scopedReadFacilityIds(facilityReq(s), 'dispense_log')],
    ['single: counterparty is granted',
      () => enforceFacilityRead(facilityReq(s), fakeRes(), r, 'stock')],
    ['single: own facility is granted',
      () => enforceFacilityRead(facilityReq(s), fakeRes(), s, 'stock')],
    ['single: unrelated facility is refused',
      () => enforceFacilityRead(facilityReq(quiet), fakeRes(), r, 'stock')],
    ['single: the exception is stock-only',
      () => enforceFacilityRead(facilityReq(s), fakeRes(), r, 'dispense_log')],
  ]

  // aclShadowComparison.test.js runs CONCURRENTLY and deliberately inserts and
  // deletes a pending stock_transfer_log row against an arbitrary real facility,
  // so the counterparty set genuinely moves underneath this suite. Comparing a
  // probe-off pass against a later probe-on pass would then report the world
  // changing as the probe changing the decision.
  //
  // So each case is measured off / on / off and only judged when the two OFF
  // runs agree — that pins the dataset for the window the comparison covers.
  // Retried a few times rather than tolerated, so a case that never settles
  // fails loudly instead of being quietly skipped.
  const off = [], on = []
  for (const [label, fn] of cases) {
    let settled = false
    for (let attempt = 0; attempt < 5 && !settled; attempt++) {
      setProbeEnabled(false)
      const before = JSON.stringify(await fn())
      setProbeEnabled(true)
      resetCounterpartyProbe()
      const during = JSON.stringify(await fn())
      setProbeEnabled(false)
      resetCounterpartyProbe()
      const after = JSON.stringify(await fn())
      if (before === after) { off.push(before); on.push(during); settled = true }
    }
    assert.ok(settled, `${label}: the dataset never held still long enough to compare`)
  }

  for (let i = 0; i < cases.length; i++) {
    assert.equal(on[i], off[i], `${cases[i][0]}: measurement changed the decision`)
  }

  // Non-vacuous: this suite is worthless if every case returned the same thing.
  // The exception must actually be doing something in at least one of them.
  const counterpartyList = JSON.parse(off[0])
  assert.ok(counterpartyList.includes(r),
    'the pending counterparty must appear in the widened list, or nothing is being tested')
  assert.equal(JSON.parse(off[1])[0], quiet, 'the caller\'s own facility is always in scope')
  assert.equal(JSON.parse(off[3]), true, 'the counterparty read must be granted')
  assert.equal(JSON.parse(off[6]), false, 'dispense_log gets no counterparty exception')

  // The refusal case is only a refusal while `quiet` and `r` are genuinely not
  // counterparties, which a concurrent suite can change. Check the condition
  // rather than assume it, so this asserts scope.js's rule and not the clock.
  const stillUnrelated = !(await pendingCounterparties(quiet)).includes(r)
  assert.equal(JSON.parse(off[5]), !stillUnrelated,
    stillUnrelated ? 'an unrelated facility must be refused'
                   : 'a facility that became a counterparty must be granted')
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. The exception is detected, at the right call site
// ═════════════════════════════════════════════════════════════════════════════

test('the counterparty statement is recognised and no other statement is', async () => {
  const real = `select sending_facility_id as fid from stock_transfer_log
       where receiving_facility_id = $1 and status = 'pending'
     union
     select receiving_facility_id from stock_transfer_log
       where sending_facility_id = $1 and status = 'pending'`
  assert.equal(_internals.isCounterpartyQuery(real), true)

  for (const other of [
    'select id from facilities where state = $1',
    `select * from stock_transfer_log where status = 'pending'`,
    'select sending_facility_id as fid from transfers where receiving_facility_id = $1',
    'select count(*) from stock',
    null, undefined, 42, {},
  ]) {
    assert.equal(_internals.isCounterpartyQuery(other), false,
      `must not match: ${String(other).slice(0, 60)}`)
  }
})

test('the list call site is attributed to scopedReadFacilityIds', async () => {
  const { s } = await pendingPair()
  setProbeEnabled(true)
  resetCounterpartyProbe()
  try {
    const ids = await scopedReadFacilityIds(facilityReq(s), 'stock')
    const snap = counterpartyProbeSnapshot()
    assert.equal(snap.length, 1, 'exactly one observation')
    assert.equal(snap[0].call_site, 'list')
    assert.equal(snap[0].facility_id, s, 'records the ACTING facility, not the counterparty')
    assert.equal(snap[0].observations, 1)
    assert.equal(snap[0].widened, 1, 'the exception reached beyond the own facility')
    assert.equal(snap[0].max, ids.length - 1, 'max reach matches what scope.js returned')
    assert.ok(snap[0].max > 0, 'the pending pair must widen, or nothing is tested')
  } finally { setProbeEnabled(false); resetCounterpartyProbe() }
})

test('the single call site is attributed to enforceFacilityRead', async () => {
  const { s, r } = await pendingPair()
  setProbeEnabled(true)
  resetCounterpartyProbe()
  try {
    const allowed = await enforceFacilityRead(facilityReq(s), fakeRes(), r, 'stock')
    assert.equal(allowed, true)
    const snap = counterpartyProbeSnapshot()
    assert.equal(snap.length, 1)
    assert.equal(snap[0].call_site, 'single',
      'a sole-reason grant must be distinguishable from a widened list')
    assert.equal(snap[0].widened, 1)
  } finally { setProbeEnabled(false); resetCounterpartyProbe() }
})

test('an evaluation that reaches nothing is counted, but not as widened', async () => {
  const quiet = await quietFacility()
  setProbeEnabled(true)
  resetCounterpartyProbe()
  try {
    const ids = await scopedReadFacilityIds(facilityReq(quiet), 'stock')
    const snap = counterpartyProbeSnapshot()
    assert.equal(snap[0].observations, 1, 'the rule was evaluated')
    // Judged against what scope.js returned IN THIS CALL, not against the
    // pre-selection: a concurrent suite can make a quiet facility a counterparty
    // between the two, and the claim under test is that the probe agrees with
    // scope.js — not that this facility stayed quiet.
    assert.equal(snap[0].widened, ids.length > 1 ? 1 : 0,
      'widened must mean exactly "scope.js returned more than the own facility"')
    assert.equal(snap[0].max, ids.length - 1, 'max reach is the counterparty count')
    if (ids.length === 1) {
      assert.equal(snap[0].widened, 0, 'the "safe to remove" signal: evaluated, granted nothing')
    }
  } finally { setProbeEnabled(false); resetCounterpartyProbe() }
})

test('repeat evaluations aggregate into one buffered row', async () => {
  const { s } = await pendingPair()
  setProbeEnabled(true)
  resetCounterpartyProbe()
  try {
    let widened = 0
    for (let i = 0; i < 5; i++) {
      if ((await scopedReadFacilityIds(facilityReq(s), 'stock')).length > 1) widened++
    }
    const snap = counterpartyProbeSnapshot()
    assert.equal(snap.length, 1, 'five evaluations must not become five rows')
    assert.equal(snap[0].observations, 5)
    assert.equal(snap[0].widened, widened, 'counted against what scope.js actually returned each time')
    assert.ok(widened > 0, 'the pending pair must have widened at least once, or nothing is tested')
  } finally { setProbeEnabled(false); resetCounterpartyProbe() }
})

test('a flush writes the counters and re-flushing accumulates rather than duplicating', async () => {
  const { s } = await pendingPair()
  setProbeEnabled(true)
  resetCounterpartyProbe()
  try {
    await query(`delete from counterparty_probe where facility_id = $1`, [s])
    await scopedReadFacilityIds(facilityReq(s), 'stock')
    assert.equal(await flushCounterpartyProbe(), 1)
    assert.equal(counterpartyProbeSnapshot().length, 0, 'the buffer is drained by a flush')
    assert.equal(await flushCounterpartyProbe(), 0, 'an empty flush writes nothing')

    await scopedReadFacilityIds(facilityReq(s), 'stock')
    await flushCounterpartyProbe()

    const { rows } = await query(
      `select observations, widened from counterparty_probe
        where facility_id = $1 and call_site = 'list' and day = current_date`, [s])
    assert.equal(rows.length, 1, 'one row per day/site/facility, not one per flush')
    assert.equal(Number(rows[0].observations), 2, 'the second flush added to the first')
    assert.ok(Number(rows[0].widened) <= 2, 'widened can never exceed observations')
  } finally { setProbeEnabled(false); resetCounterpartyProbe() }
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. Ordinary access is not falsely counted
// ═════════════════════════════════════════════════════════════════════════════

test('reading your OWN facility records nothing — the exception is never reached', async () => {
  const { s } = await pendingPair()
  setProbeEnabled(true)
  resetCounterpartyProbe()
  try {
    const allowed = await enforceFacilityRead(facilityReq(s), fakeRes(), s, 'stock')
    assert.equal(allowed, true, 'granted by the own-facility rule')
    assert.deepEqual(counterpartyProbeSnapshot(), [],
      'scope.js returns before the exception, so there is nothing to count')
  } finally { setProbeEnabled(false); resetCounterpartyProbe() }
})

test('an admin reading across facilities records nothing', async () => {
  const { rows } = await query(`select id, state from facilities where state is not null limit 1`)
  setProbeEnabled(true)
  resetCounterpartyProbe()
  try {
    const req = adminReq(rows[0].state)
    assert.equal(await enforceFacilityRead(req, fakeRes(), rows[0].id, 'stock'), true)
    await scopedReadFacilityIds(adminReq(rows[0].state), 'stock')
    assert.deepEqual(counterpartyProbeSnapshot(), [],
      'admin access is granted by tier, not by the exception')
  } finally { setProbeEnabled(false); resetCounterpartyProbe() }
})

test('non-stock tables record nothing, even for a facility with pending transfers', async () => {
  const { s, r } = await pendingPair()
  setProbeEnabled(true)
  resetCounterpartyProbe()
  try {
    for (const table of ['dispense_log', 'intake_log', 'adjustment_log', 'transfers']) {
      await scopedReadFacilityIds(facilityReq(s), table)
      await enforceFacilityRead(facilityReq(s), fakeRes(), r, table)
    }
    assert.deepEqual(counterpartyProbeSnapshot(), [],
      'the exception is stock-only and must not be attributed to other tables')
  } finally { setProbeEnabled(false); resetCounterpartyProbe() }
})

test('ordinary application queries record nothing', async () => {
  setProbeEnabled(true)
  resetCounterpartyProbe()
  try {
    await query('select id from facilities limit 5')
    await query(`select count(*) from stock_transfer_log where status = 'pending'`)
    await query('select id from commodities limit 5')
    assert.deepEqual(counterpartyProbeSnapshot(), [])
  } finally { setProbeEnabled(false); resetCounterpartyProbe() }
})

test('the probe is inert while disabled', async () => {
  const { s } = await pendingPair()
  setProbeEnabled(false)
  resetCounterpartyProbe()
  await scopedReadFacilityIds(facilityReq(s), 'stock')
  assert.deepEqual(counterpartyProbeSnapshot(), [],
    'disabled means no buffer growth at all, not just no writes')
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. The instrumentation cannot grant or deny
// ═════════════════════════════════════════════════════════════════════════════

test('observe returns undefined and swallows every malformed input', async () => {
  setProbeEnabled(true)
  resetCounterpartyProbe()
  try {
    const real = `select sending_facility_id as fid from stock_transfer_log
         where receiving_facility_id = $1 and status = 'pending' union
       select receiving_facility_id from stock_transfer_log
         where sending_facility_id = $1 and status = 'pending'`
    for (const [sql, params, result] of [
      [real, undefined, undefined],
      [real, [], null],
      [real, [null], { rows: [] }],
      [real, ['x'], { rows: null }],
      [real, ['x'], {}],
      [null, null, null],
      [{}, 1, 'nonsense'],
    ]) {
      assert.equal(observeCounterpartyQuery(sql, params, result), undefined,
        'the observer must never return a value scope.js could act on')
    }
  } finally { setProbeEnabled(false); resetCounterpartyProbe() }
})

test('a broken probe table does not change any decision', async () => {
  const { s, r } = await pendingPair()
  setProbeEnabled(true)
  resetCounterpartyProbe()
  await query('alter table counterparty_probe rename to counterparty_probe_hidden')
  try {
    // Exactly the decisions from test 1, with the destination table missing.
    assert.equal(await enforceFacilityRead(facilityReq(s), fakeRes(), r, 'stock'), true)
    assert.ok((await scopedReadFacilityIds(facilityReq(s), 'stock')).includes(r))
    assert.equal(await flushCounterpartyProbe(), 0, 'the failed flush is swallowed')
  } finally {
    await query('alter table counterparty_probe_hidden rename to counterparty_probe')
    setProbeEnabled(false)
    resetCounterpartyProbe()
  }
})

test('a failed flush drops its counters instead of growing the buffer without bound', async () => {
  const { s } = await pendingPair()
  setProbeEnabled(true)
  resetCounterpartyProbe()
  await query('alter table counterparty_probe rename to counterparty_probe_hidden')
  try {
    await scopedReadFacilityIds(facilityReq(s), 'stock')
    await flushCounterpartyProbe()
    assert.deepEqual(counterpartyProbeSnapshot(), [],
      'losing counts is acceptable; an unbounded buffer on a long-lived server is not')
  } finally {
    await query('alter table counterparty_probe_hidden rename to counterparty_probe')
    setProbeEnabled(false)
    resetCounterpartyProbe()
  }
})

test('the probe holds no timer that would keep a process alive', async () => {
  const { s } = await pendingPair()
  setProbeEnabled(true)
  resetCounterpartyProbe()
  try {
    // A ref'd interval would hang every provisioning script and this suite on
    // exit rather than fail an assertion, so check the handle directly.
    // getActiveResourcesInfo lists only REFERENCED handles, and the test runner
    // owns some of its own — hence the before/after difference rather than an
    // absolute count.
    const count = () => (process.getActiveResourcesInfo?.() ?? []).filter(x => x === 'Timeout').length
    const before = count()
    await scopedReadFacilityIds(facilityReq(s), 'stock')
    assert.equal(count(), before, 'the flush timer must be unref\'d')
  } finally { setProbeEnabled(false); resetCounterpartyProbe() }
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. Nothing user-sensitive is stored
// ═════════════════════════════════════════════════════════════════════════════

test('the probe table holds no user, commodity, quantity or request data', async () => {
  const { rows } = await query(
    `select column_name from information_schema.columns
      where table_name = 'counterparty_probe' order by 1`)
  assert.deepEqual(rows.map(r => r.column_name), [
    'call_site', 'day', 'facility_id', 'last_seen', 'max_counterparties',
    'observations', 'widened',
  ], 'adding a column here is a privacy decision, so it must break this test')
})
