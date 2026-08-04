// Snapshot the tables that stock corrections can touch, to a single JSON file.
//
// A safety net for fix_opening_balance.mjs / fix_store_stock.mjs / fix_sdp_stock.mjs,
// which write to stock, stock_adjustment_log, stock_lot and the site-stock tables.
// Uses db.js, so it needs no PATH entry, no password prompt and no pg_dump — the
// usual reasons a backup gets skipped on the VM.
//
// Not a substitute for pg_dump when you want the whole cluster; it is a targeted
// snapshot of what these scripts can modify.
//
//   cd C:\envo\app\backend
//   node scripts/backup_tables.mjs                          # -> ../backup_<date>.json
//   node scripts/backup_tables.mjs C:/envo/backup.json      # explicit path

import { pool, query } from '../src/db.js'
import fs from 'node:fs'

const TABLES = ['stock', 'stock_adjustment_log', 'stock_lot', 'sdp_stock', 'dsd_stock', 'stock_count']
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const outPath = process.argv[2] || `../backup_${stamp}.json`

try {
  const out = { _meta: { taken_at: new Date().toISOString(), tables: TABLES } }
  for (const t of TABLES) {
    // stock_count may not exist yet if the migration hasn't run — not fatal.
    const exists = (await query(`select to_regclass($1) r`, [t])).rows[0].r
    if (!exists) { console.log(`  ${t.padEnd(22)} (table not present, skipped)`); out[t] = null; continue }
    out[t] = (await query(`select * from ${t}`)).rows
    console.log(`  ${t.padEnd(22)} ${out[t].length} rows`)
  }
  fs.writeFileSync(outPath, JSON.stringify(out))
  const mb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(2)
  console.log(`\n✓ Saved ${outPath} (${mb} MB)`)
  console.log('Keep this until the corrections are confirmed good.')
} catch (err) {
  console.error('Backup failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
