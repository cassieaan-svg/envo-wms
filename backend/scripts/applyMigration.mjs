// Applies a .sql migration through the backend's own Postgres pool.
//
// Migrations do NOT auto-run in EnVo and the VM has no psql, so this is the
// supported way to apply one: it reuses backend/src/db.js, which means it picks up
// backend/.env and therefore always targets the SAME database the API talks to —
// no chance of applying to the wrong host by mistyping a connection string.
//
// Usage (from backend/):
//   node scripts/applyMigration.mjs ../db/migrations/20260811_stock_summary_index.sql
//   node scripts/applyMigration.mjs <file> --dry-run    # print the SQL, apply nothing
//
// Notes:
//  - The file is executed as ONE statement batch. Migrations here are written to be
//    idempotent (`create index if not exists`, `add column if not exists`), so a
//    re-run is a no-op rather than an error.
//  - NOT wrapped in an explicit transaction: `create index concurrently` cannot run
//    inside one. node-postgres already sends the batch as a single implicit
//    transaction for statements that allow it.
//  - Indexes created are reported afterwards so you can confirm without psql.

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { query, pool } from '../src/db.js'

const file = process.argv[2]
const dryRun = process.argv.includes('--dry-run')

if (!file) {
  console.error('Usage: node scripts/applyMigration.mjs <path-to-migration.sql> [--dry-run]')
  process.exit(1)
}

const path = resolve(process.cwd(), file)
let sql
try {
  sql = await readFile(path, 'utf8')
} catch (err) {
  console.error(`Cannot read migration: ${err.message}`)
  process.exit(1)
}

// Report which database this will actually touch, so the target is never a guess.
try {
  const { rows } = await query(
    'select current_database() as db, inet_server_addr()::text as host, inet_server_port() as port')
  const { db, host, port } = rows[0]
  console.log(`target database : ${db} @ ${host || 'localhost'}:${port}`)
} catch (err) {
  console.error(`Cannot connect to Postgres: ${err.message}`)
  console.error('Check backend/.env (PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD).')
  await pool.end().catch(() => {})
  process.exit(1)
}

console.log(`migration      : ${path}`)
console.log('─'.repeat(64))
console.log(sql.trim())
console.log('─'.repeat(64))

if (dryRun) {
  console.log('--dry-run: nothing applied.')
  await pool.end()
  process.exit(0)
}

// Index names mentioned in the file, so we can confirm they exist afterwards.
const named = [...sql.matchAll(/create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([a-z0-9_]+)/gi)]
  .map(m => m[1])

const started = Date.now()
try {
  await query(sql)
  console.log(`\n✔ applied in ${Date.now() - started} ms`)
} catch (err) {
  console.error(`\n✖ migration FAILED after ${Date.now() - started} ms`)
  console.error(`  ${err.message}`)
  if (err.hint) console.error(`  hint: ${err.hint}`)
  await pool.end().catch(() => {})
  process.exit(1)
}

if (named.length) {
  const { rows } = await query(
    'select indexname, tablename from pg_indexes where indexname = any($1) order by indexname', [named])
  console.log('\nindexes now present:')
  for (const name of named) {
    const found = rows.find(r => r.indexname === name)
    console.log(`  ${found ? '✔' : '✖'} ${name}${found ? ` on ${found.tablename}` : ' — NOT FOUND'}`)
  }
  // Refresh planner statistics on the touched tables — a new index is not used
  // well until the planner has current stats.
  for (const t of [...new Set(rows.map(r => r.tablename))]) {
    await query(`analyze ${t}`)
    console.log(`  analyzed ${t}`)
  }
}

await pool.end()
