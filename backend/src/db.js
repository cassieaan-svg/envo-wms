import pg from 'pg'
import dotenv from 'dotenv'

dotenv.config()

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
export const query = (text, params) => pool.query(text, params)

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
