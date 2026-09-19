// Module-aware offline write wrappers. HIV pages call api.dispense.record (etc.)
// directly and are completely untouched by this file — these wrappers are opt-in,
// used only by the Essential-module screens that have been wired for offline
// (see docs/ESSENTIAL_COMMODITIES_OFFLINE_DESIGN.md in the envo-wms sibling
// project: "module-aware so HIV stays untouched").
//
// Contract for a wired screen:
//   const result = await offlineDispense(body)
//   if (result.queued) { /* tell the user it's waiting to sync */ }
//   else { /* the normal, already-synced result — today's behaviour */ }
// A thrown error is a genuine rejection (bad data, a real conflict) — never queued,
// surfaced exactly as it always was.

import { api, getModule } from './api'
import { enqueue } from './offlineQueue'

async function offlineAware(operation, facilityId, liveBody, liveCall) {
  if (getModule() !== 'essential') {
    // HIV (or module not yet chosen): unchanged behaviour, no queueing.
    return liveCall()
  }
  if (navigator.onLine) {
    try {
      const data = await liveCall()
      return { ...data, queued: false }
    } catch (err) {
      // A real rejection from the server (validation, a genuine conflict) must not
      // be silently swallowed into a queue entry that will just fail again —
      // surface it exactly as the online-only path always has.
      if (typeof err?.status === 'number') throw err
      // Otherwise the fetch itself failed (DNS, timeout, connection reset) even
      // though navigator.onLine said we were up — fall through to queueing.
    }
  }
  const entry = await enqueue(operation, facilityId, liveBody)
  return { queued: true, clientTxnId: entry.clientTxnId }
}

export function offlineDispense(body) {
  return offlineAware('dispense', body.facility_id, body, () => api.dispense.record(body))
}

export function offlineIntake(body) {
  return offlineAware('intake', body.facility_id, body, () => api.intake.record(body))
}

export function offlineAdjustment(body) {
  return offlineAware('adjustment', body.facility_id, body, () => api.adjustments.record(body))
}
