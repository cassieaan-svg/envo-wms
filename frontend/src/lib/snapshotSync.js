// Keeps the cached facility snapshot (catalogue/prices/stock) current: an automatic
// background pull whenever online, plus a manual "sync now" trigger — the same pair
// of mechanisms the WMS already uses for its own outbox
// (docs/ESSENTIAL_COMMODITIES_OFFLINE_DESIGN.md, open question 3).
//
// Essential-module, facility-tier only. HIV never calls any of this.

import { api } from './api'
import { putSnapshot, getSnapshot } from './offlineDb'

const AUTO_PULL_MS = 5 * 60 * 1000   // 5 minutes — frequent enough to stay current,
                                       // rare enough not to matter on a metered line.

let pulling = false
let listeners = []

/** Subscribe to "the cached snapshot changed". Returns an unsubscribe function. */
export function onSnapshotUpdated(fn) {
  listeners.push(fn)
  return () => { listeners = listeners.filter(f => f !== fn) }
}

function notify(snapshot) {
  for (const fn of listeners) fn(snapshot)
}

/** Pull the latest snapshot from the server and cache it. Throws on failure (network
 * or otherwise) — callers that just want "best effort" should catch. */
export async function pullSnapshot(facilityId) {
  if (pulling) return null
  pulling = true
  try {
    const envelope = await api.facilitySnapshot.get()
    await putSnapshot(facilityId, envelope)
    notify(envelope)
    return envelope
  } finally {
    pulling = false
  }
}

/** The last-cached snapshot for this facility, or null if none has ever been pulled. */
export async function cachedSnapshot(facilityId) {
  return getSnapshot(facilityId)
}

let autoTimer = null
let onlineHandler = null

/**
 * Start the automatic background pull: once immediately (if online), then on the
 * `online` browser event and on a periodic timer. Call once per session, scoped to
 * an Essential facility login; stop() undoes it on sign-out/module switch.
 */
export function startAutoSync(facilityId) {
  stopAutoSync()
  const attempt = () => { if (navigator.onLine) pullSnapshot(facilityId).catch(() => {}) }
  attempt()
  onlineHandler = attempt
  window.addEventListener('online', onlineHandler)
  autoTimer = setInterval(attempt, AUTO_PULL_MS)
}

export function stopAutoSync() {
  if (autoTimer) clearInterval(autoTimer)
  if (onlineHandler) window.removeEventListener('online', onlineHandler)
  autoTimer = null
  onlineHandler = null
}
