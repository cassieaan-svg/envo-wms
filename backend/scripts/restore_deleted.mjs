// Put back rows removed by a --reverse or --ids delete, from the undo file those
// commands write before they touch anything.
//
// The correction scripts delete records: the count corrections that removed more than
// a location ever received, the dispenses drawn from a location that never received
// anything. Those judgements can be wrong, so every delete is reversible without
// restoring the whole database.
//
// Re-inserts each row exactly as it was, PRIMARY KEY INCLUDED, so anything that
// referenced it still lines up. A row that is already present is left alone rather
// than duplicated, which makes re-running this safe.
//
//   cd C:\envo\app\backend
//   node scripts/restore_deleted.mjs undo_2026-08-08T09-14-22-104Z.json
//   node scripts/restore_deleted.mjs undo_....json --apply
//
// Dry-run unless --apply, like everything else here.

import { pool, query, withTransaction } from '../src/db.js'
import fs from 'node:fs'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const file = argv.find(a => !a.startsWith('--'))

const ALLOWED = new Set(['stock_adjustment_log', 'dispense_log', 'intake_log'])

try {
  if (!file) { console.error('Usage: node scripts/restore_deleted.mjs <undo file.json> [--apply]'); process.exit(1) }
  if (!fs.existsSync(file)) { console.error(`Not found: ${file}`); process.exit(1) }

  const { table, deleted_at, rows } = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!ALLOWED.has(table)) { console.error(`Refusing to write to table "${table}".`); process.exit(1) }
  if (!Array.isArray(rows) || !rows.length) { console.log('Undo file contains no rows.'); process.exit(0) }

  const ids = rows.map(r => r.id)
  const present = new Set((await query(`select id from ${table} where id = any($1::uuid[])`, [ids])).rows.map(r => r.id))
  const todo = rows.filter(r => !present.has(r.id))

  console.log(`\n${file}`)
  console.log(`  table       : ${table}`)
  console.log(`  deleted at  : ${deleted_at}`)
  console.log(`  rows in file: ${rows.length}`)
  console.log(`  already back: ${present.size}`)
  console.log(`  to restore  : ${todo.length}\n`)
  if (!todo.length) { console.log('Nothing to do — every row is already present.'); process.exit(0) }

  console.table(todo.slice(0, 20).map(r => ({
    id8: String(r.id).slice(0, 8), quantity: r.quantity,
    type: r.adjustment_type || '', reason: (r.reason || '').slice(0, 26),
    when: String(r.adjusted_at || r.dispensed_at || r.received_at || '').slice(0, 10),
    by: (r.adjusted_by || r.dispensed_by || r.received_by || '').slice(0, 16),
  })))
  if (todo.length > 20) console.log(`…and ${todo.length - 20} more.`)

  if (!apply) { console.log('\nDRY RUN — re-run with --apply to put these rows back.'); process.exit(0) }

  // Insert by the columns present in the file, so this keeps working if the table
  // gains columns later. The id is included deliberately: restoring under a new id
  // would break anything that referenced the original.
  await withTransaction(async exec => {
    for (const r of todo) {
      const cols = Object.keys(r).filter(k => r[k] !== undefined)
      const ph = cols.map((_, i) => `$${i + 1}`).join(',')
      await exec(`insert into ${table} (${cols.map(c => `"${c}"`).join(',')}) values (${ph}) on conflict (id) do nothing`,
        cols.map(c => r[c]))
    }
  })
  console.log(`\n✓ Restored ${todo.length} row(s) to ${table}.`)
  console.log('Stock on hand was NOT changed by the delete, so nothing else needs undoing.')
  console.log('Re-run audit_opening_balances.mjs to confirm the opening is back where it was.')
} catch (err) {
  console.error('Restore failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
