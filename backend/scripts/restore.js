// Restore a snapshot produced by backup.js. Upserts rows by primary key, so
// re-running is idempotent. Reference tables are restored before the rows that
// depend on them.
//
//   npm run restore -- backups/backup_<timestamp>
//
// ⚠️ This writes into the live database (service role, bypasses RLS). It does
// NOT delete rows that aren't in the snapshot — it only re-inserts/updates the
// snapshot's rows.
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sbAdmin } from '../src/supabase.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Same dependency-safe order as backup.js.
const TABLES = [
  'commodities',
  'facilities',
  'facility_amc_settings',
  'stock',
  'sdp_stock',
  'dsd_stock',
  'dispense_log',
  'intake_log',
  'stock_adjustment_log',
  'stock_transfer_log',
]

const CHUNK = 500

async function restoreTable(dir, table) {
  let rows
  try {
    rows = JSON.parse(await readFile(join(dir, `${table}.json`), 'utf8'))
  } catch {
    console.log(`  ${table} … (no file, skipped)`)
    return
  }
  if (!rows.length) { console.log(`  ${table} … 0 rows`); return }
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK)
    const { error } = await sbAdmin.from(table).upsert(batch)
    if (error) throw new Error(`${table}: ${error.message}`)
  }
  console.log(`  ${table} … ${rows.length} rows`)
}

async function main() {
  const arg = process.argv[2]
  if (!arg) {
    console.error('Usage: npm run restore -- backups/backup_<timestamp>')
    process.exit(1)
  }
  const dir = isAbsolute(arg) ? arg : join(__dirname, '..', arg)
  console.log(`Restoring from ${dir}\n`)
  for (const table of TABLES) await restoreTable(dir, table)
  console.log('\n✓ Restore complete')
}

main().catch(err => {
  console.error('\n✗ Restore failed:', err.message)
  if (/Invalid API key|JWT|service_role/i.test(err.message)) {
    console.error('  The SUPABASE_SERVICE_KEY in backend/.env is missing, revoked, or wrong.')
  }
  process.exitCode = 1
})
