// Admin access to the Essential Commodities module.
//
// Two rules are pinned here, both of which the module got wrong before:
//
//  1. GRANT. Essential is gated on a per-login `essential: true` flag. That gate used
//     to sit BELOW the admin bypass in enforceModuleAccess, so every state/LGA/cluster
//     admin reached Essential endpoints without ever being granted the module — the
//     flag only ever constrained facility logins. The negative assertions are the ones
//     that matter: an ungranted admin must be refused.
//
//  2. OVERSIGHT ONLY. A granted admin reads; it never writes. state_admin holds
//     cross-facility WRITE on stock / transfers / amc_settings for HIV, and without an
//     explicit rule that carried straight into Essential. HIV must be unaffected — the
//     tests assert both sides so a future change can't quietly trade one for the other.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  attachScope, enforceModuleAccess, enforceFacilityWrite, isEssentialOversight,
} from '../src/middleware/scope.js'
import { pool } from '../src/db.js'

// A res double that records what the guard did, instead of writing to a socket.
function resDouble() {
  const out = { status: null, body: null }
  return {
    out,
    status(code) { out.status = code; return { json: (b) => { out.body = b } } },
    json(b) { out.body = b },
  }
}

// Build a req with scope attached, for a given login metadata + active module.
function reqFor(meta, module = 'essential') {
  const req = { user: { user_metadata: meta }, get: (h) => (h === 'x-envo-module' ? module : null), query: {} }
  attachScope(req, resDouble(), () => {})
  return req
}

const stateAdmin = (extra = {}) => ({ access_level: 'state_admin', admin_state: 'Akwa Ibom', ...extra })
const lgaAdmin   = (extra = {}) => ({ access_level: 'lga_admin', admin_lga: 'Ibeno', ...extra })
const overall    = (extra = {}) => ({ access_level: 'overall_admin', ...extra })
const facility   = (extra = {}) => ({
  access_level: 'facility', facility_id: 'f1', facility_name: 'Ibeno Cottage Hospital',
  facility_role: 'store_manager', commodity_section: 'pharmacy', ...extra,
})

test('an admin without the grant is refused Essential', async () => {
  for (const [name, meta] of [['state_admin', stateAdmin()], ['lga_admin', lgaAdmin()], ['overall_admin', overall()]]) {
    const req = reqFor(meta), res = resDouble()
    const allowed = await enforceModuleAccess(req, res)
    assert.equal(allowed, false, `${name} must not reach Essential without the grant`)
    assert.equal(res.out.status, 403)
    assert.match(res.out.body.error, /not enabled for Essential/i)
  }
})

test('an admin WITH the grant reaches Essential', async () => {
  for (const [name, meta] of [
    ['state_admin', stateAdmin({ essential: true })],
    ['lga_admin',   lgaAdmin({ essential: true })],
    ['overall_admin', overall({ essential: true })],
  ]) {
    const req = reqFor(meta), res = resDouble()
    assert.equal(await enforceModuleAccess(req, res), true, `granted ${name} must reach Essential`)
    assert.equal(res.out.status, null, 'nothing should have been refused')
  }
})

test('the grant does not gate HIV — an ungranted admin still works there', async () => {
  for (const meta of [stateAdmin(), lgaAdmin(), overall()]) {
    const req = reqFor(meta, 'hiv'), res = resDouble()
    assert.equal(await enforceModuleAccess(req, res), true)
    assert.equal(res.out.status, null)
  }
})

test('the pharmacy-section rule does not lock admins out', async () => {
  // An admin's `section` is null, meaning "sees both". The pharmacy-only rule is for
  // facility logins (it keeps lab accounts out); applying it to admins would refuse
  // every one of them, since null !== 'pharmacy'.
  const req = reqFor(stateAdmin({ essential: true }))
  assert.equal(req.scope.section, null, 'admin section should be null (sees both)')
  assert.equal(await enforceModuleAccess(req, resDouble()), true)
})

test('Essential is oversight-only: a granted state_admin cannot write', async () => {
  // stock/transfers/amc_settings are exactly the tables where state_admin DOES hold
  // cross-facility write for HIV, so they are the ones at risk of leaking across.
  for (const table of ['stock', 'transfers', 'amc_settings']) {
    const req = reqFor(stateAdmin({ essential: true })), res = resDouble()
    const allowed = await enforceFacilityWrite(req, res, 'some-facility-id', table)
    assert.equal(allowed, false, `state_admin must not write ${table} in Essential`)
    assert.equal(res.out.status, 403)
    assert.match(res.out.body.error, /oversight-only/i)
  }
})

test('the same state_admin still writes those tables in HIV', async () => {
  // The guard must not have made state_admin read-only everywhere.
  for (const table of ['stock', 'transfers', 'amc_settings']) {
    const req = reqFor(stateAdmin({ essential: true }), 'hiv'), res = resDouble()
    // adminState is set, so narrowing runs a query; a facility outside the state is
    // refused for the ordinary reason (jurisdiction), not by the Essential rule.
    const allowed = await enforceFacilityWrite(req, res, 'some-facility-id', table)
    if (!allowed) {
      assert.ok(!/oversight-only/i.test(res.out.body.error),
        `${table} in HIV must not be refused by the Essential oversight rule, got: ${res.out.body.error}`)
    }
  }
})

test('a facility store manager still writes in Essential', async () => {
  // The oversight rule keys off admin tiers, so a facility login must be untouched —
  // otherwise the module would have no one able to record anything.
  const req = reqFor(facility({ essential: true })), res = resDouble()
  assert.equal(isEssentialOversight(req.scope), false)
  assert.equal(await enforceFacilityWrite(req, res, 'f1', 'stock'), true)
})

test('isEssentialOversight is true only for admins in Essential', () => {
  assert.equal(isEssentialOversight(reqFor(stateAdmin({ essential: true })).scope), true)
  assert.equal(isEssentialOversight(reqFor(stateAdmin({ essential: true }), 'hiv').scope), false)
  assert.equal(isEssentialOversight(reqFor(facility({ essential: true })).scope), false)
})

test.after(() => pool.end())
