import { getToken } from './api'

// Realtime change stream (replaces Supabase's sb.channel). Opens a single shared
// EventSource to the backend SSE endpoint and fans events out to subscribers by
// table name. Each event is { table, eventType, new, old } — mirroring the shape
// the old postgres_changes callbacks consumed — so callers refetch their scoped
// data (and transfer callbacks can still read new.status for their toasts).

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000'

const registry = new Map() // table -> Set<callback>
let es = null
let esToken = null

function ensureConnected() {
  const token = getToken()
  if (!token) return
  // Reuse the stream only if it's for the current token and not closed.
  if (es && esToken === token && es.readyState !== EventSource.CLOSED) return
  if (es) { try { es.close() } catch { /* ignore */ } }

  esToken = token
  es = new EventSource(`${BASE}/api/events?token=${encodeURIComponent(token)}`)
  es.onmessage = (e) => {
    let msg
    try { msg = JSON.parse(e.data) } catch { return }
    const cbs = registry.get(msg.table)
    if (!cbs || !cbs.size) return
    const payload = { table: msg.table, eventType: msg.op, new: msg.new || null, old: msg.old || null }
    for (const cb of cbs) { try { cb(payload) } catch (err) { console.error('[realtime] callback error:', err) } }
  }
  es.onerror = () => {
    // EventSource auto-reconnects on transient errors. If the user signed out,
    // stop retrying with the stale token.
    if (!getToken()) closeRealtime()
  }
}

// Subscribe to change events on one or more tables. Returns an unsubscribe fn.
export function subscribeRealtime(tables, callback) {
  const list = Array.isArray(tables) ? tables : [tables]
  for (const t of list) {
    if (!registry.has(t)) registry.set(t, new Set())
    registry.get(t).add(callback)
  }
  ensureConnected()
  return () => {
    for (const t of list) {
      const set = registry.get(t)
      if (set) { set.delete(callback); if (!set.size) registry.delete(t) }
    }
    if (registry.size === 0) closeRealtime()
  }
}

// Tear down the stream and clear all subscriptions (called on sign-out).
export function closeRealtime() {
  registry.clear()
  if (es) { try { es.close() } catch { /* ignore */ } es = null }
  esToken = null
}
