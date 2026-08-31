import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import dotenv from 'dotenv'
import { performance } from 'node:perf_hooks'
import { DIAG, track, trackQuery } from './diag.js'

// Resolved from this file, not the working directory. A bare dotenv.config() silently
// finds nothing when the process is started from the repo root (e.g.
// `npm run dev --prefix backend`), and the pool then falls back to its defaults and
// connects to the wrong database — which fails much later, as confusing "relation does
// not exist" errors rather than a connection error.
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') })

// A DATE column is a calendar day, not an instant, so hand it to the app as the plain
// 'YYYY-MM-DD' string Postgres stores. node-postgres otherwise builds a JS Date at LOCAL
// midnight, which serialises to the previous day in UTC once it is JSON-encoded: an
// expiry of 2026-11-30 leaves the server as "2026-11-29T23:00:00.000Z" in Lagos (UTC+1).
//
// That is not merely cosmetic. Anything that renders through fmtDate converts back to
// Lagos and is right, but the edit dialogs prefill their date input by slicing the ISO
// string — so opening an intake/adjustment/lot editor and saving WITHOUT touching the
// expiry silently rewrote it one day earlier, every time.
//
// 1082 = DATE. Timestamps are left alone: they really are instants.
pg.types.setTypeParser(1082, v => v)

// Local Postgres connection pool — replaces the Supabase client for all data
// access. Reads standard PG* env vars (see backend/.env). On the VM these point
// at the VM's local Postgres; in dev they point at the locally-restored `envo` DB.
export const pool = new pg.Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT) || 5432,
  database: process.env.PGDATABASE || 'envo',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD,
  max: Number(process.env.PG_POOL_MAX) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
})

pool.on('error', err => console.error('[db] idle client error:', err.message))

// Thin query helper. Use parameterized queries everywhere ($1, $2, …).
//
// With ENVO_DIAG=1 it acquires the connection EXPLICITLY so the time spent
// waiting for the pool can be separated from the time Postgres spends executing.
// That split is the only way to tell a slow query from a saturated pool: a
// request queued here has no PostgreSQL session yet, so pg_stat_activity shows
// nothing at all. Off by default — the plain path is unchanged.
export const query = async (text, params) => {
  if (!DIAG) return pool.query(text, params)
  const t0 = performance.now()
  const client = await pool.connect()
  const t1 = performance.now()
  try {
    const result = await client.query(text, params)
    const dbMs = performance.now() - t1
    track('pool_wait', t1 - t0)
    track('db', dbMs)
    track('n', 1)
    trackQuery(text, dbMs, t1 - t0)
    return result
  } finally {
    client.release()
  }
}

// Run `fn` inside a single transaction. `fn` receives an `exec(text, params)`
// bound to a dedicated pooled client; every query it issues runs on that one
// connection so BEGIN/COMMIT cover them all. Rolls back and rethrows on error.
// Pass `exec` down to any service method that should join the transaction.
export async function withTransaction(fn) {
  const client = await pool.connect()
  const exec = (text, params) => client.query(text, params)
  try {
    await client.query('BEGIN')
    const result = await fn(exec)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* ignore rollback failure */ }
    throw err
  } finally {
    client.release()
  }
}
