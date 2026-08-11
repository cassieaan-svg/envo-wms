import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';

// Resolved from this file rather than cwd, so scripts run from the repo root pick up the
// same .env as the server.
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

// A DATE has no time and no timezone, but node-postgres turns it into a JS Date at local
// midnight — so 2028-06-30 becomes 2028-06-29T23:00Z in WAT, and anything formatting it
// through toISOString() reports the day before. Expiry dates matter far too much for that.
// Keep DATE (oid 1082) as the literal 'YYYY-MM-DD' string it already is.
pg.types.setTypeParser(1082, (value) => value);

const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  max: Number(process.env.PG_POOL_MAX || 10),
});

export function query(text, params) {
  return pool.query(text, params);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export default pool;
