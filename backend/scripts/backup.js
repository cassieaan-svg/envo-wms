// Snapshot the database to timestamped JSON files — run this before a
// destructive wipe so the data can be restored if needed.
//
// Uses the service-role client (bypasses RLS) and paginates past the 1000-row
// PostgREST cap. Output: backend/backups/backup_<timestamp>/<table>.json plus a
// manifest.json with row counts.
//
//   npm run backup            (from backend/)
//
// Restore a snapshot with: npm run restore -- backups/backup_<timestamp>
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sbAdmin } from '../src/supabase.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Reference tables first, then balances, then the activity logs. Restore walks
// this same order so foreign keys resolve (commodities/facilities before rows
// that reference them).
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

const PAGE = 1000

async function dumpTable(table) {
  let all = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await sbAdmin.from(table).select('*').range(offset, offset + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    if (!data || !data.length) break
    all = all.concat(data)
    if (data.length < PAGE) break
  }
  return all
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = join(__dirname, '..', 'backups', `backup_${stamp}`)
  await mkdir(outDir, { recursive: true })

  const manifest = { createdAt: new Date().toISOString(), tables: {} }
  for (const table of TABLES) {
    process.stdout.write(`  ${table} … `)
    const rows = await dumpTable(table)
    await writeFile(join(outDir, `${table}.json`), JSON.stringify(rows, null, 2))
    manifest.tables[table] = rows.length
    console.log(`${rows.length} rows`)
  }
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(`\n✓ Backup written to ${outDir}`)
  console.table(manifest.tables)
}

main().catch(err => {
  console.error('\n✗ Backup failed:', err.message)
  if (/Invalid API key|JWT|service_role/i.test(err.message)) {
    console.error('  The SUPABASE_SERVICE_KEY in backend/.env is missing, revoked, or wrong.')
    console.error('  Grab a fresh service_role key from Supabase → Settings → API.')
  }
  process.exitCode = 1
})
