// Request-boundary diagnostics, OFF unless ENVO_DIAG=1.
//
// Exists to settle one question with measurement instead of inference: when a
// 6 kB response takes 30 seconds, is the time spent waiting for a pg connection,
// waiting for Postgres to execute, or somewhere else entirely?
//
// pg_stat_activity cannot answer it. A request queued in the Node pool has no
// PostgreSQL session yet, so it is invisible there — the database looks idle
// while every request stalls. These counters live on the Node side of that
// boundary, which is exactly where the blind spot is.
//
// Enable on the VM for one page load, read /api/_diag/pool, then disable:
//   pm2 set ... ENVO_DIAG=1   (or add to backend/.env), restart, load the page,
//   GET /api/_diag/pool, then remove it and restart again.

import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'

export const DIAG = process.env.ENVO_DIAG === '1'

// Per-request accumulator: how long this request spent waiting for a pooled
// connection vs. actually executing SQL, across every query it made.
export const reqStore = new AsyncLocalStorage()

export function track(kind, ms) {
  const s = reqStore.getStore()
  if (s) s[kind] = (s[kind] || 0) + ms
}

// Record the SQL itself when a single statement is slow, so the EXPLAIN target is
// identified by measurement rather than picked by guesswork.
export function trackQuery(sql, ms, waitMs) {
  if (ms < 500) return
  slowQueries.push({ ms: +ms.toFixed(0), pool_wait: +waitMs.toFixed(0),
                     sql: String(sql).replace(/\s+/g, ' ').trim().slice(0, 400),
                     at: new Date().toISOString() })
  slowQueries.sort((a, b) => b.ms - a.ms)
  if (slowQueries.length > 15) slowQueries.length = 15
}

// Rolling snapshots so a slow load can be inspected after the fact rather than
// requiring someone to poll at exactly the wrong moment.
const peak = { waiting: 0, total: 0, at: null }
const slowest = []            // the 25 slowest requests seen since start
const slowQueries = []        // individual SQL statements over 500 ms
let sampler = null

export function poolSnapshot(pool) {
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }
}

export function startSampler(pool) {
  if (!DIAG || sampler) return
  // 100 ms is fine: we are looking for multi-second stalls, not microbursts.
  sampler = setInterval(() => {
    const s = poolSnapshot(pool)
    if (s.waiting > peak.waiting) { peak.waiting = s.waiting; peak.total = s.total; peak.at = new Date().toISOString() }
  }, 100)
  sampler.unref()
}

/**
 * Adds a Server-Timing header to every JSON response:
 *   pool  — total ms this request spent waiting to ACQUIRE a connection
 *   db    — total ms spent executing SQL once acquired
 *   rest  — everything else (handler logic, serialization, middleware)
 *   qn    — how many queries the request made
 *
 * pool vs db is the whole point: it separates hypothesis 1 (query/plan) from
 * hypothesis 2 (pool exhaustion) inside a single number the browser can show.
 */
export function diagMiddleware(pool) {
  return (req, res, next) => {
    if (!DIAG) return next()
    const t0 = performance.now()
    const store = {}
    const origJson = res.json.bind(res)
    res.json = (body) => {
      const total = performance.now() - t0
      const pw = store.pool_wait || 0, db = store.db || 0
      res.setHeader('Server-Timing',
        `pool;dur=${pw.toFixed(1)}, db;dur=${db.toFixed(1)}, ` +
        `rest;dur=${Math.max(0, total - pw - db).toFixed(1)}, total;dur=${total.toFixed(1)}`)
      res.setHeader('X-Diag-Queries', String(store.n || 0))
      if (total > 1000) {
        slowest.push({
          path: req.originalUrl.slice(0, 120), total: +total.toFixed(0),
          pool_wait: +pw.toFixed(0), db: +db.toFixed(0),
          rest: +Math.max(0, total - pw - db).toFixed(0), queries: store.n || 0,
          poolAtFinish: poolSnapshot(pool), at: new Date().toISOString(),
        })
        slowest.sort((a, b) => b.total - a.total)
        if (slowest.length > 25) slowest.length = 25
      }
      return origJson(body)
    }
    reqStore.run(store, next)
  }
}

// Dev-only readout. Admin-gated by the caller; returns live counters, the peak
// waiting count seen since start, and the slowest requests with their split.
export function diagHandler(pool) {
  return (req, res) => {
    res.json({
      enabled: DIAG,
      pool: { ...poolSnapshot(pool), max: Number(process.env.PG_POOL_MAX) || 10 },
      peakWaiting: peak,
      slowQueries,
      slowestRequests: slowest,
      note: 'pool.waiting > 0 means requests are queued in Node BEFORE reaching Postgres. '
          + 'A high db with waiting≈0 points at the query/plan instead.',
    })
  }
}
