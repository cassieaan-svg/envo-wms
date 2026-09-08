// Audit finding B-1 — the ACL cutover's rollback path.
//
// The cutover gates require "a single flag returning authorization to legacy
// without a deploy, TESTED BEFORE CUTOVER, not after". This is that test. It is
// the one suite whose failure should stop a cutover outright, because everything
// else in the migration assumes that if the ACL turns out to be wrong in
// production, authority can be handed back immediately.
//
// WHAT IS ACTUALLY PROVEN HERE, in order of how much it matters:
//
//   1. Flipping to `enforce` really does change a live decision — otherwise the
//      flag is decorative and the rollback protects nothing.
//   2. Flipping back to `legacy` really does restore it, with no restart.
//   3. Every failure resolves to `legacy`, never to `enforce`.
//   4. The 403 a client receives is byte-identical in every mode.
//
// TEST ISOLATION. This suite mutates global state — the single authorization
// mode row — which every other suite reads. It restores `legacy` in a finally
// around each case AND in a test.after, and it asserts the restoration rather
// than assuming it. `npm test` runs files in parallel against one database, so a
// leak here would fail unrelated suites in ways that look nothing like the cause.
//
//   npm test --prefix backend

import test from 'node:test'
import assert from 'node:assert/strict'
import { query, pool } from '../src/db.js'
import {
  currentMode, setMode, invalidate, consultsAcl, MODES, CACHE_TTL_MS,
} from '../src/services/authorityMode.js'
import { attachScope, enforceFacilityRead, LEGACY } from '../src/middleware/scope.js'

// Restore the default no matter how a case ends, then confirm it.
async function inMode(mode, fn) {
  await setMode(mode, { note: 'authorityMode.test.js', changedBy: 'test' })
  invalidate()
  try { return await fn() } finally {
    await setMode('legacy', { note: 'restored by authorityMode.test.js', changedBy: 'test' })
    invalidate()
  }
}

test.after(async () => {
  await setMode('legacy', { note: 'suite teardown', changedBy: 'test' })
  const { rows } = await query(`select mode from authorization_mode where id = true`)
  assert.equal(rows[0].mode, 'legacy', 'the suite must not leave another mode live')
  await pool.end()
})

const reqFor = meta => {
  const r = { user: { user_metadata: meta, sub: null }, query: {} }
  attachScope(r, {}, () => {})
  return r
}
const resStub = () => {
  const captured = { status: null, body: null }
  const s = {
    status(c) { captured.status = c; return s },
    json(b) { captured.body = b; return s },
    captured,
  }
  return s
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. The default, and the shape of the switch
// ═════════════════════════════════════════════════════════════════════════════

test('the default is legacy — the mode a database gets with no one touching it', async () => {
  invalidate()
  assert.equal(await currentMode(), 'legacy')
  assert.deepEqual(MODES, ['legacy', 'shadow', 'enforce'])
  assert.equal(consultsAcl('legacy'), false, 'legacy must not even compute the resolver')
  assert.equal(consultsAcl('shadow'), true)
  assert.equal(consultsAcl('enforce'), true)
})

test('an invalid mode is refused rather than stored', async () => {
  await assert.rejects(() => setMode('acl'), /must be one of/)
  await assert.rejects(() => setMode(''), /must be one of/)
  assert.equal(await currentMode(), 'legacy', 'and nothing changed')
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. THE CENTRAL CLAIM — the flag changes a real decision, and takes it back
// ═════════════════════════════════════════════════════════════════════════════

test('enforce changes a live decision, and legacy restores it', async () => {
  // A case where the two authorities genuinely disagree, so the flip is
  // observable. The pending-transfer counterparty exception is exactly that: it
  // is accepted difference A-1, legacy allows it and the ACL has no way to
  // express it, and it is asserted as a permanent mismatch elsewhere.
  const { rows: u } = await query(`
    select u.id, u.raw_user_meta_data meta, ur.scope_id facility
      from user_roles ur join roles r on r.id = ur.role_id join users u on u.id = ur.user_id
     where r.name = 'facility' and ur.scope_id <> ''
       and u.email not like '%.invalid' and u.email not like 'probe.create.%'
     limit 1`)
  const me = u[0]
  const { rows: other } = await query(
    `select id from facilities where id <> $1 limit 1`, [me.facility])
  const counterparty = other[0].id

  await query(`insert into stock_transfer_log
      (sending_facility_id, sending_facility_name, receiving_facility_id, receiving_facility_name,
       commodity_id, commodity_name, quantity, status, initiated_at)
    select $1, 'test', $2, 'test', c.id, c.name, 1, 'pending', now() from commodities c limit 1`,
    [counterparty, me.facility])

  const req = () => { const r = reqFor(me.meta); r.user.sub = me.id; return r }
  try {
    // Baseline: legacy allows the counterparty read.
    invalidate()
    assert.equal(await enforceFacilityRead(req(), resStub(), counterparty, 'stock'), true,
      'legacy allows a pending-transfer counterparty read')

    // The ACL does not. Flipping authority must therefore flip the answer — this
    // single assertion is what makes the rollback meaningful.
    await inMode('enforce', async () => {
      const res = resStub()
      assert.equal(await enforceFacilityRead(req(), res, counterparty, 'stock'), false,
        'enforce hands the decision to the ACL, which refuses')

      // A DENIAL MUST ALWAYS PRODUCE A RESPONSE. This caught a real bug: the gate
      // replayed whatever legacy had captured, and here legacy ALLOWED, so it had
      // captured nothing — the guard returned false, the route returned, and the
      // response was never written. The client hangs until it times out. An ACL
      // denial that legacy would have allowed is the entire point of `enforce`,
      // so this is the path that must not be silent.
      assert.equal(res.captured.status, 403, 'the denial is a real 403, not a silent false')
      assert.deepEqual(res.captured.body,
        { success: false, error: 'Not authorized for this facility', code: 'FORBIDDEN' },
        'and it is indistinguishable from a legacy denial')
    })

    // ROLLBACK. No restart, no redeploy — the value changed back and so did the
    // decision. This is the assertion the cutover gate is actually asking for.
    invalidate()
    assert.equal(await currentMode(), 'legacy')
    assert.equal(await enforceFacilityRead(req(), resStub(), counterparty, 'stock'), true,
      'rolling back to legacy restores the original decision immediately')
  } finally {
    await query(
      `delete from stock_transfer_log where sending_facility_id = $1 and receiving_facility_id = $2
         and status = 'pending'`, [counterparty, me.facility])
  }
})

test('shadow does NOT change decisions — it only observes', async () => {
  // The distinction that makes shadow safe to leave on in production: it must be
  // behaviourally identical to legacy. If this ever fails, "turn on shadow to
  // gather data" stops being a free action.
  const { rows: u } = await query(`
    select u.id, u.raw_user_meta_data meta, ur.scope_id facility
      from user_roles ur join roles r on r.id = ur.role_id join users u on u.id = ur.user_id
     where r.name = 'facility' and ur.scope_id <> ''
       and u.email not like '%.invalid' and u.email not like 'probe.create.%'
     limit 1`)
  const me = u[0]
  const { rows: other } = await query(`select id from facilities where id <> $1 limit 1`, [me.facility])
  const req = () => { const r = reqFor(me.meta); r.user.sub = me.id; return r }

  for (const [facilityId, expected, what] of [
    [me.facility, true, 'own facility'],
    [other[0].id, false, 'another facility'],
  ]) {
    invalidate()
    const legacyAnswer = await enforceFacilityRead(req(), resStub(), facilityId, 'stock')
    assert.equal(legacyAnswer, expected, `${what}: legacy baseline`)
    await inMode('shadow', async () => {
      assert.equal(await enforceFacilityRead(req(), resStub(), facilityId, 'stock'), legacyAnswer,
        `${what}: shadow must return exactly what legacy returned`)
    })
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. FAIL-SAFE — every failure lands on legacy, never on enforce
// ═════════════════════════════════════════════════════════════════════════════

test('a garbage env override is ignored, not obeyed', async () => {
  const saved = process.env.ENVO_AUTH_MODE
  try {
    process.env.ENVO_AUTH_MODE = 'yes-please'
    invalidate()
    assert.equal(await currentMode(), 'legacy', 'an unparseable kill switch must not enable anything')
  } finally {
    if (saved === undefined) delete process.env.ENVO_AUTH_MODE
    else process.env.ENVO_AUTH_MODE = saved
    invalidate()
  }
})

test('the env override beats the table — the kill switch works when the DB does not', async () => {
  const saved = process.env.ENVO_AUTH_MODE
  try {
    await inMode('enforce', async () => {
      assert.equal(await currentMode(), 'enforce', 'the table says enforce')
      process.env.ENVO_AUTH_MODE = 'legacy'
      invalidate()
      assert.equal(await currentMode(), 'legacy',
        'and the env var overrides it — this is the rollback of last resort')
    })
  } finally {
    if (saved === undefined) delete process.env.ENVO_AUTH_MODE
    else process.env.ENVO_AUTH_MODE = saved
    invalidate()
  }
})

test('an unmapped table cannot be enforced — legacy decides it in every mode', async () => {
  // The ACL denies unknown permission keys (accepted difference A-2). If the gate
  // passed an unmapped table straight through to the resolver, `enforce` would
  // turn legacy's fail-open into a fail-CLOSED for every route whose table name
  // is not in the map — a self-inflicted outage on cutover. The gate must
  // recognise that the ACL cannot express the question and keep legacy.
  const { rows: u } = await query(`
    select u.id, u.raw_user_meta_data meta, ur.scope_id facility
      from user_roles ur join roles r on r.id = ur.role_id join users u on u.id = ur.user_id
     where r.name = 'facility' and ur.scope_id <> ''
       and u.email not like '%.invalid' and u.email not like 'probe.create.%'
     limit 1`)
  const me = u[0]
  const req = () => { const r = reqFor(me.meta); r.user.sub = me.id; return r }

  await inMode('enforce', async () => {
    assert.equal(
      await enforceFacilityRead(req(), resStub(), me.facility, 'some_table_nobody_declared'), true,
      'legacy stands where the ACL has nothing to say')
  })
})

test('a request with no authenticated subject falls back to legacy', async () => {
  // req.user.sub is what the resolver needs. Without it there is no ACL answer,
  // and `enforce` must not read that as a denial.
  const { rows: u } = await query(`
    select u.raw_user_meta_data meta, ur.scope_id facility
      from user_roles ur join roles r on r.id = ur.role_id join users u on u.id = ur.user_id
     where r.name = 'facility' and ur.scope_id <> ''
       and u.email not like '%.invalid' and u.email not like 'probe.create.%'
     limit 1`)
  await inMode('enforce', async () => {
    const r = reqFor(u[0].meta) // sub stays null
    assert.equal(await enforceFacilityRead(r, resStub(), u[0].facility, 'stock'), true,
      'no subject means no ACL answer, which means legacy')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. The response is identical in every mode
// ═════════════════════════════════════════════════════════════════════════════

test('the 403 body is byte-identical whichever authority denied', async () => {
  // The gate captures legacy's response and replays it. If a mode changed the
  // wording, clients and the tests that assert on it would break at cutover —
  // a rollback would be needed for a cosmetic reason.
  const { rows: u } = await query(`
    select u.id, u.raw_user_meta_data meta, ur.scope_id facility
      from user_roles ur join roles r on r.id = ur.role_id join users u on u.id = ur.user_id
     where r.name = 'facility' and ur.scope_id <> ''
       and u.email not like '%.invalid' and u.email not like 'probe.create.%'
     limit 1`)
  const me = u[0]
  const { rows: other } = await query(`select id from facilities where id <> $1 limit 1`, [me.facility])
  const req = () => { const r = reqFor(me.meta); r.user.sub = me.id; return r }

  invalidate()
  const legacyRes = resStub()
  await enforceFacilityRead(req(), legacyRes, other[0].id, 'stock')

  for (const mode of ['shadow', 'enforce']) {
    await inMode(mode, async () => {
      const res = resStub()
      await enforceFacilityRead(req(), res, other[0].id, 'stock')
      assert.deepEqual(res.captured, legacyRes.captured, `${mode}: same status and body`)
    })
  }
  assert.equal(legacyRes.captured.status, 403, 'non-vacuous — something really was denied')
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. Divergences are recorded, and bounded
// ═════════════════════════════════════════════════════════════════════════════

test('shadow records a divergence once per shape, however often it recurs', async () => {
  // Aggregation is what makes shadow mode safe to leave on: a systematically
  // divergent permission must cost one row, not one per request.
  const { rows: u } = await query(`
    select u.id, u.raw_user_meta_data meta, ur.scope_id facility
      from user_roles ur join roles r on r.id = ur.role_id join users u on u.id = ur.user_id
     where r.name = 'facility' and ur.scope_id <> ''
       and u.email not like '%.invalid' and u.email not like 'probe.create.%'
     limit 1`)
  const me = u[0]
  const { rows: other } = await query(`select id from facilities where id <> $1 limit 1`, [me.facility])
  const counterparty = other[0].id
  await query(`delete from authorization_divergence where user_id = $1`, [me.id])
  await query(`insert into stock_transfer_log
      (sending_facility_id, sending_facility_name, receiving_facility_id, receiving_facility_name,
       commodity_id, commodity_name, quantity, status, initiated_at)
    select $1, 'test', $2, 'test', c.id, c.name, 1, 'pending', now() from commodities c limit 1`,
    [counterparty, me.facility])
  const req = () => { const r = reqFor(me.meta); r.user.sub = me.id; return r }

  try {
    await inMode('shadow', async () => {
      for (let i = 0; i < 3; i++) {
        await enforceFacilityRead(req(), resStub(), counterparty, 'stock')
      }
    })
    const { rows } = await query(
      `select permission_key, legacy_allowed, acl_allowed, hits
         from authorization_divergence where user_id = $1`, [me.id])
    assert.equal(rows.length, 1, 'three identical divergences are ONE row')
    assert.equal(Number(rows[0].hits), 3, 'with a count')
    assert.equal(rows[0].permission_key, 'stock.read')
    assert.equal(rows[0].legacy_allowed, true)
    assert.equal(rows[0].acl_allowed, false, 'and it records which way they disagreed')
  } finally {
    await query(`delete from authorization_divergence where user_id = $1`, [me.id])
    await query(
      `delete from stock_transfer_log where sending_facility_id = $1 and receiving_facility_id = $2
         and status = 'pending'`, [counterparty, me.facility])
  }
})

test('legacy mode records nothing — the resolver is never consulted', async () => {
  const before = (await query(`select count(*)::int n from authorization_divergence`)).rows[0].n
  const { rows: u } = await query(`
    select u.id, u.raw_user_meta_data meta, ur.scope_id facility
      from user_roles ur join roles r on r.id = ur.role_id join users u on u.id = ur.user_id
     where r.name = 'facility' and ur.scope_id <> ''
       and u.email not like '%.invalid' and u.email not like 'probe.create.%'
     limit 1`)
  const { rows: other } = await query(`select id from facilities where id <> $1 limit 1`, [u[0].facility])
  invalidate()
  const r = reqFor(u[0].meta); r.user.sub = u[0].id
  await enforceFacilityRead(r, resStub(), other[0].id, 'stock')
  assert.equal((await query(`select count(*)::int n from authorization_divergence`)).rows[0].n, before,
    'legacy is the untouched fast path')
})

// ═════════════════════════════════════════════════════════════════════════════
// 6. The legacy implementations stay reachable
// ═════════════════════════════════════════════════════════════════════════════

test('LEGACY bypasses the gate, so the shadow suites measure authorities not modes', async () => {
  const { rows: u } = await query(`
    select u.id, u.raw_user_meta_data meta, ur.scope_id facility
      from user_roles ur join roles r on r.id = ur.role_id join users u on u.id = ur.user_id
     where r.name = 'facility' and ur.scope_id <> ''
       and u.email not like '%.invalid' and u.email not like 'probe.create.%'
     limit 1`)
  const me = u[0]
  const { rows: other } = await query(`select id from facilities where id <> $1 limit 1`, [me.facility])
  const counterparty = other[0].id
  await query(`insert into stock_transfer_log
      (sending_facility_id, sending_facility_name, receiving_facility_id, receiving_facility_name,
       commodity_id, commodity_name, quantity, status, initiated_at)
    select $1, 'test', $2, 'test', c.id, c.name, 1, 'pending', now() from commodities c limit 1`,
    [counterparty, me.facility])
  try {
    await inMode('enforce', async () => {
      const r = reqFor(me.meta); r.user.sub = me.id
      assert.equal(await LEGACY.enforceFacilityRead(r, resStub(), counterparty, 'stock'), true,
        'LEGACY answers as legacy even while enforce is live')
    })
  } finally {
    await query(
      `delete from stock_transfer_log where sending_facility_id = $1 and receiving_facility_id = $2
         and status = 'pending'`, [counterparty, me.facility])
  }
})

test('the cache TTL is short enough to be an incident response', async () => {
  // The rollback's actual latency. If this ever grows, "flip it back" stops
  // being immediate and the gate's promise weakens.
  assert.ok(CACHE_TTL_MS <= 10_000, `cache TTL is ${CACHE_TTL_MS}ms — too long to roll back behind`)
})
