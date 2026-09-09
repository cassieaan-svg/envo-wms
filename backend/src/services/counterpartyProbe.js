// Measurement of the pending-transfer counterparty exception. OFF unless
// ENVO_COUNTERPARTY_PROBE=1.
//
// WHY THIS SHAPE. The exception lives inside scope.js:
//
//   scope.js:131  pendingTransferCounterparties(facilityId)
//   scope.js:173    ← scopedReadFacilityIds  ('list')
//   scope.js:223    ← enforceFacilityRead    ('single')
//
// scope.js is the authoritative legacy authorizer and is not to be edited, so
// the observation point is db.js's `query` instead — the same place diag.js
// already watches from. The counterparty statement is textually unique in the
// codebase (`as fid` appears nowhere else), so it can be recognised without
// scope.js cooperating.
//
// This module therefore CANNOT change a decision even by accident: it never
// returns a value to scope.js, never throws out (every entry point is wrapped),
// and runs after the query has already resolved.
//
// WHAT 'sole reason' MEANS HERE, precisely:
//
//   'single' — enforceFacilityRead only reaches this query after the caller has
//              already failed the admin check AND the own-facility check. So
//              every observation at this site is a request the exception is the
//              ONLY remaining way to grant. `widened = 0` there proves the
//              exception granted nothing; `widened > 0` is an UPPER BOUND on
//              sole-reason grants, because db.js cannot see which facility was
//              being asked about — only whether the reach was non-empty.
//
//   'list'   — scopedReadFacilityIds runs the query unconditionally for facility
//              users on `stock`. `widened > 0` means the returned id list was
//              larger than the caller's own facility; it does not prove the
//              extra ids were used. Also an upper bound.
//
// An upper bound is enough for the decision this measurement exists to settle:
// if it is zero over a full reporting cycle, nothing depends on the exception.
// If it is not zero, the finer question ("was the widened id actually read?")
// becomes worth asking, and that is a later phase.
//
// COST. Aggregated in memory keyed by (day, call site, facility) and flushed on
// a timer, so a facility hitting the path a thousand times a day writes one row,
// not a thousand. The stack capture is bounded to 8 frames.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { pool } from '../db.js'

// Load .env from THIS file's location, exactly as diag.js does and for the same
// reason: ES module imports evaluate before the importing module's body, so
// db.js's own dotenv.config() has not run yet when this line executes. Reading
// process.env directly would leave the flag permanently false whenever it lives
// in backend/.env rather than the shell — which is how it is set on the VM.
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env') })

let enabled = process.env.ENVO_COUNTERPARTY_PROBE === '1'

export const probeEnabled = () => enabled

// Tests only. Production toggles the flag through the environment and a restart;
// there is deliberately no route or runtime switch, so nothing user-facing can
// turn measurement on.
export function setProbeEnabled(v) { enabled = !!v }

const FLUSH_MS = Number(process.env.ENVO_COUNTERPARTY_PROBE_FLUSH_MS) || 60_000

// key `${day}|${site}|${facilityId}` → counters
const buffer = new Map()
let timer = null

// Cheap reject first: `as fid` is unique to the counterparty statement. The
// stricter check then confirms it, so an unrelated query that happened to
// contain that fragment could not be miscounted.
function isCounterpartyQuery(sql) {
  if (typeof sql !== 'string' || !sql.includes('as fid')) return false
  const norm = sql.replace(/\s+/g, ' ')
  return norm.includes('select sending_facility_id as fid from stock_transfer_log')
      && norm.includes('receiving_facility_id = $1')
      && norm.includes("status = 'pending'")
}

// Which scope.js caller ran it. Function names are used rather than line numbers
// so the mapping does not silently rot the next time scope.js moves a line.
function callSite() {
  const limit = Error.stackTraceLimit
  Error.stackTraceLimit = 8
  const stack = new Error().stack || ''
  Error.stackTraceLimit = limit
  if (stack.includes('scopedReadFacilityIds')) return 'list'
  if (stack.includes('enforceFacilityRead')) return 'single'
  return 'unknown'
}

// The LOCAL calendar day, matching the database's `current_date` — not UTC.
//
// toISOString() gives the UTC day, and Lagos is UTC+1, so for one hour every
// night the probe would bucket into the previous day while `current_date` had
// already rolled over. A reporting cycle read with `day >= current_date - N`
// would then miss or double-count that hour's observations, and the
// "one row per day/site/facility" invariant would quietly break.
//
// en-CA formats as YYYY-MM-DD, which is what the date column wants. This is the
// same calendar-day-not-instant distinction db.js applies to DATE columns.
function today() {
  return new Date().toLocaleDateString('en-CA')
}

/**
 * Record one evaluation of the exception. Called from db.js for every query;
 * returns immediately for the ones that are not it.
 *
 * Pure bookkeeping — the caller ignores the return value and this never throws.
 *
 * @param {string} sql
 * @param {any[]|undefined} params  params[0] is the ACTING facility id
 * @param {{rows?: any[]}} result
 */
export function observeCounterpartyQuery(sql, params, result) {
  if (!enabled) return
  try {
    if (!isCounterpartyQuery(sql)) return
    const facilityId = params && params[0]
    if (!facilityId) return

    // The rows the exception would hand back, minus nulls — the same filter
    // scope.js applies, so `widened` matches what scope.js actually returned.
    const reach = (result?.rows || []).map(r => r.fid).filter(Boolean).length

    const site = callSite()
    const key = `${today()}|${site}|${facilityId}`
    const e = buffer.get(key) || { observations: 0, widened: 0, max: 0 }
    e.observations += 1
    if (reach > 0) e.widened += 1
    if (reach > e.max) e.max = reach
    buffer.set(key, e)

    if (!timer) {
      timer = setInterval(() => { flushCounterpartyProbe() }, FLUSH_MS)
      // Must not hold the process open — provisioning scripts and tests exit.
      timer.unref?.()
    }
  } catch {
    // A measurement must never affect the request that produced it.
  }
}

/**
 * Write the buffered counters out. Safe to call when the probe is disabled, when
 * nothing is buffered, or when the table has not been created yet.
 *
 * @returns {Promise<number>} rows written
 */
export async function flushCounterpartyProbe() {
  if (buffer.size === 0) return 0
  // Take the buffer first so concurrent observations accumulate into a fresh one
  // rather than being dropped by a clear() after the write.
  const pending = [...buffer.entries()]
  buffer.clear()
  try {
    for (const [key, e] of pending) {
      const [day, site, facilityId] = key.split('|')
      await pool.query(
        `insert into counterparty_probe
           (day, call_site, facility_id, observations, widened, max_counterparties, last_seen)
         values ($1, $2, $3::uuid, $4, $5, $6, now())
         on conflict (day, call_site, facility_id) do update
           set observations       = counterparty_probe.observations + excluded.observations,
               widened            = counterparty_probe.widened + excluded.widened,
               max_counterparties = greatest(counterparty_probe.max_counterparties,
                                             excluded.max_counterparties),
               last_seen          = now()`,
        [day, site, facilityId, e.observations, e.widened, e.max])
    }
    return pending.length
  } catch (err) {
    // Losing a flush loses counts, not correctness. Do not re-buffer: a failing
    // table would otherwise grow the buffer without bound.
    console.warn(`[counterparty-probe] flush skipped: ${err.message}`)
    return 0
  }
}

// Unflushed counters, for tests and for the reporting script.
export function counterpartyProbeSnapshot() {
  return [...buffer.entries()].map(([key, e]) => {
    const [day, call_site, facility_id] = key.split('|')
    return { day, call_site, facility_id, ...e }
  })
}

export function resetCounterpartyProbe() {
  buffer.clear()
  if (timer) { clearInterval(timer); timer = null }
}

// Exported for the tests that prove recognition is exact.
export const _internals = { isCounterpartyQuery, callSite }
