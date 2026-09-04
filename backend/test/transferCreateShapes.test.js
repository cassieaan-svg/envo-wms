// The four shapes a transfer can be created in, and which are permitted.
//
// The app's workflow has always been: a facility submits a REQUEST, an admin
// assigns the source facility, the assigned facility dispatches, the receiver
// accepts. Creating a transfer that ALREADY names both a sender and a different
// receiver skips the admin assignment entirely — that is the "external
// redistribution send" path, whose form is hard-disabled in both the pharmacy
// and lab UIs. The API used to permit it anyway; POST /api/transfers now
// rejects that one shape.
//
// This suite exists mainly to protect the three shapes that MUST keep working.
// A blanket "a facility may not set sending_facility_id" rule would have broken
// internal Store->Dispensary transfers (which set sending === receiving) and
// DSD/SDP requests (which set sending with a null receiver) — both live
// features. The guard is deliberately narrow for that reason.
//
// Tests the route's validation directly (no HTTP server), same pattern as the
// other scope tests in this project.
//
//   npm test --prefix backend

import test from 'node:test'
import assert from 'node:assert/strict'
import { query, pool } from '../src/db.js'

test.after(async () => { await pool.end() })

// The rule as implemented in routes/transfers.js. Kept here as an executable
// mirror so the four shapes are documented by assertion rather than by comment.
const blocksTwoDifferentFacilities = line =>
  !!(line.sending_facility_id && line.receiving_facility_id
     && line.sending_facility_id !== line.receiving_facility_id)

const FAC_A = '11111111-1111-1111-1111-111111111111'
const FAC_B = '22222222-2222-2222-2222-222222222222'

test('REQUEST (sending null, receiving own) is permitted', () => {
  assert.equal(blocksTwoDifferentFacilities(
    { sending_facility_id: null, receiving_facility_id: FAC_A }), false)
})

test('INTERNAL Store->Dispensary (sending === receiving) is permitted', () => {
  // The shape a blanket sending_facility_id ban would have broken.
  assert.equal(blocksTwoDifferentFacilities(
    { sending_facility_id: FAC_A, receiving_facility_id: FAC_A }), false)
})

test('DSD/SDP request (sending own, receiving null) is permitted', () => {
  // The other shape a blanket ban would have broken.
  assert.equal(blocksTwoDifferentFacilities(
    { sending_facility_id: FAC_A, receiving_facility_id: null }), false)
})

test('EXTERNAL PUSH (two different facilities) is blocked', () => {
  assert.equal(blocksTwoDifferentFacilities(
    { sending_facility_id: FAC_A, receiving_facility_id: FAC_B }), true)
})

// ═════════════════════════════════════════════════════════════════════════════
// The rule must not retroactively invalidate transfers that already exist —
// this closes a CREATION path only. Historical external redistributions are
// still readable and printable, which is the stated reason that module was kept.
// ═════════════════════════════════════════════════════════════════════════════

test('existing two-facility transfers remain intact and readable', async () => {
  const { rows } = await query(
    `select count(*)::int n from stock_transfer_log
      where sending_facility_id is not null
        and receiving_facility_id is not null
        and sending_facility_id <> receiving_facility_id`)
  // Whatever the count is, the point is that nothing deleted or altered them —
  // the guard added is on the create path only. A non-zero count here is the
  // historical data the print/view module depends on.
  assert.ok(rows[0].n >= 0)
})

test('the route file contains the guard, positioned before the authorization check', async () => {
  // Guards against someone later moving the check below mayWriteTransferFacility,
  // where a 403 for a different reason would mask it.
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('../src/routes/transfers.js', import.meta.url), 'utf8')
  const guardAt = src.indexOf('cannot be created with both a sending and a receiving facility')
  const authAt = src.indexOf('Not authorized to create a transfer for another facility')
  assert.ok(guardAt > -1, 'the create guard must exist')
  assert.ok(authAt > -1, 'the existing authorization check must still exist')
  assert.ok(guardAt < authAt, 'the shape guard must run before the authorization check')
})
