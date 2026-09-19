// The local write queue: pending → syncing → synced (deleted) / failed, with retry.
// Same shape as the WMS's own outbox worker, just running in the browser instead of
// a Node process (see docs/ESSENTIAL_COMMODITIES_OFFLINE_DESIGN.md in the envo-wms
// sibling project).
//
// One entry per queued write. `operation` names which api.js call replays it —
// dispense/intake/adjustment/transferDispatch/transferAccept — so the drain loop
// doesn't need to know anything about the write itself, only how to replay it.
//
// A queued write is always a LEDGER ENTRY (see the design doc's hard rule), so two
// devices queuing independently for the same facility is safe — nothing here needs a
// single-device assumption.

import { putQueueEntry, getQueueEntry, deleteQueueEntry, listQueueEntries } from './offlineDb'
import { api } from './api'

// A device offline this long (or with this many entries stuck) is past "normal" —
// the design doc's own comparison point is the WMS outbox's "stuck" threshold.
export const STUCK_AGE_MS = 24 * 60 * 60 * 1000   // 24h
export const STUCK_COUNT = 20

// Registry: operation name -> how to replay it against the API. Each queued entry's
// `body` already carries its own client_txn_id (set at enqueue time), so replaying is
// just calling the same api.js method the online path would have called.
const REPLAY = {
  dispense:        (body) => api.dispense.record(body),
  intake:          (body) => api.intake.record(body),
  adjustment:      (body) => api.adjustments.record(body),
  transferDispatch: ({ id, ...body }) => api.transfers.dispatch(id, body),
  transferAccept:   ({ id, ...body }) => api.transfers.accept(id, body),
}

function makeClientTxnId() {
  // Matches the backend's IdempotencyService.VALID_ID (/^[A-Za-z0-9_-]{8,64}$/) —
  // a UUID's hyphens are allowed, its length (36) is well inside range.
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * Queue a write for later. `body` is whatever the live call would have sent (already
 * missing its client_txn_id — this assigns one). Returns the queued entry, so the
 * caller can show "queued, will sync" immediately.
 */
export async function enqueue(operation, facilityId, body) {
  if (!REPLAY[operation]) throw new Error(`Unknown offline operation: ${operation}`)
  const clientTxnId = makeClientTxnId()
  const entry = {
    clientTxnId,
    operation,
    facilityId,
    body: { ...body, client_txn_id: clientTxnId },
    status: 'pending',
    attempts: 0,
    createdAt: new Date().toISOString(),
    lastAttemptAt: null,
    lastError: null,
  }
  await putQueueEntry(entry)
  return entry
}

/** Every queued entry, oldest first. */
export async function listQueue() {
  return listQueueEntries()
}

/**
 * A cheap summary for the status bar: how many are waiting, how many failed
 * permanently, and whether the device has been stuck long enough to warn about.
 */
export async function queueHealth() {
  const entries = await listQueueEntries()
  const pending = entries.filter(e => e.status === 'pending' || e.status === 'syncing')
  const failed = entries.filter(e => e.status === 'failed')
  const oldest = entries[0]
  const oldestAgeMs = oldest ? Date.now() - new Date(oldest.createdAt).getTime() : 0
  return {
    pendingCount: pending.length,
    failedCount: failed.length,
    totalCount: entries.length,
    oldestAgeMs,
    isStuck: entries.length > 0 && (oldestAgeMs > STUCK_AGE_MS || entries.length > STUCK_COUNT),
  }
}

let draining = false

/**
 * Walk the queue once: replay every pending/failed entry, in order. A network
 * failure (no `err.status` — the request never reached the server) leaves the entry
 * queued for the next drain. A real rejection from the server (err.status set — bad
 * data, a genuine conflict) is NOT retried forever; it's marked failed and surfaced,
 * matching the WMS outbox's own distinction between "try again" and "something is
 * wrong with this entry."
 *
 * Re-entrant-safe: a drain already in progress is a no-op, so the `online` event and
 * the periodic timer firing at once don't double-replay the same entries.
 */
export async function drainQueue() {
  if (draining) return { drained: 0, failed: 0 }
  draining = true
  let drained = 0, failed = 0
  try {
    const entries = await listQueueEntries()
    for (const entry of entries) {
      if (entry.status === 'synced') continue
      try {
        await putQueueEntry({ ...entry, status: 'syncing', lastAttemptAt: new Date().toISOString() })
        await REPLAY[entry.operation](entry.body)
        await deleteQueueEntry(entry.clientTxnId)
        drained += 1
      } catch (err) {
        const isServerRejection = typeof err?.status === 'number'
        await putQueueEntry({
          ...entry,
          status: isServerRejection ? 'failed' : 'pending',
          attempts: entry.attempts + 1,
          lastAttemptAt: new Date().toISOString(),
          lastError: err?.message || 'Unknown error',
        })
        if (isServerRejection) failed += 1
        // A network failure stops the drain here — later entries would fail the same
        // way, and trying them out of order risks a later write landing before an
        // earlier one for the same commodity.
        if (!isServerRejection) break
      }
    }
  } finally {
    draining = false
  }
  return { drained, failed }
}

/** Discard one permanently-failed entry (the operator has looked at it and decided
 * it can't be replayed — e.g. the facility no longer holds that batch). */
export async function discardQueueEntry(clientTxnId) {
  await deleteQueueEntry(clientTxnId)
}

/** Re-queue a failed entry for another attempt (operator fixed the underlying issue,
 * or believes it was transient). */
export async function retryQueueEntry(clientTxnId) {
  const entry = await getQueueEntry(clientTxnId)
  if (!entry) return
  await putQueueEntry({ ...entry, status: 'pending', lastError: null })
}

// ── the drain loop ────────────────────────────────────────────────────────────
// On the `online` browser event and on a periodic timer, matching the WMS outbox
// worker's own shape (there: every 15s against Postgres; here: every 15s against
// IndexedDB). Call once per session, scoped to an Essential facility login.

const DRAIN_INTERVAL_MS = 15 * 1000

let drainTimer = null
let drainOnlineHandler = null

export function startDrainLoop() {
  stopDrainLoop()
  const attempt = () => { if (navigator.onLine) drainQueue().catch(() => {}) }
  attempt()
  drainOnlineHandler = attempt
  window.addEventListener('online', drainOnlineHandler)
  drainTimer = setInterval(attempt, DRAIN_INTERVAL_MS)
}

export function stopDrainLoop() {
  if (drainTimer) clearInterval(drainTimer)
  if (drainOnlineHandler) window.removeEventListener('online', drainOnlineHandler)
  drainTimer = null
  drainOnlineHandler = null
}
