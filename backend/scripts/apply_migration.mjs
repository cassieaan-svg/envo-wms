// Apply one or more SQL migration files from db/migrations.
//
// Migrations never auto-run in this project, and the usual workaround — a long
// `node -e "..."` one-liner — is unreliable in PowerShell, which mangles the inner
// quotes before node ever sees them. A script file sidesteps quoting entirely:
// arguments are plain filenames.
//
// Each file runs inside its own transaction, so a failed migration leaves nothing
// half-applied. Files are expected to be idempotent (create ... if not exists,
// drop constraint if exists), so re-running is safe.
//
//   cd C:\envo\app\backend
//   node scripts/apply_migration.mjs 20260804_stock_count.sql
//   node scripts/apply_migration.mjs 20260804_stock_count.sql 20260804_opening_balance_reason.sql
//   node scripts/apply_migration.mjs --list        # show what's available

import { pool, withTransaction } from '../src/db.js'
import fs from 'node:fs'
import path from 'node:path'

const DIR = path.resolve('../db/migrations')
const args = process.argv.slice(2)

try {
  if (!fs.existsSync(DIR)) throw new Error(`No migrations directory at ${DIR} — run this from backend/`)

  if (!args.length || args.includes('--list')) {
    console.log(`\nMigrations in ${DIR}:\n`)
    for (const f of fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()) console.log('  ' + f)
    console.log('\nUsage: node scripts/apply_migration.mjs <file.sql> [more.sql ...]')
    process.exit(0)
  }

  for (const name of args) {
    const file = path.join(DIR, name)
    if (!fs.existsSync(file)) { console.error(`✗ Not found: ${name}`); process.exitCode = 1; continue }
    const sql = fs.readFileSync(file, 'utf8')
    await withTransaction(async exec => { await exec(sql) })
    console.log(`✓ applied  ${name}`)
  }
  console.log('\nDone.')
} catch (err) {
  console.error('Migration failed:', err.message)
  console.error('Nothing from the failing file was applied (it ran in a transaction).')
  process.exitCode = 1
} finally {
  await pool.end()
}
