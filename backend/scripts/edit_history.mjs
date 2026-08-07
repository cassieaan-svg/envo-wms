// READ-ONLY. Edits made to a facility's log records, newest first.
//
// Editing a record adjusts the stock figure DIRECTLY (EditModal ->
// api.stock.update) without writing a matching movement row. So an edit changes
// stock on hand while the recorded movements stay put, and the difference lands in
// the bin card's opening balance. When a bin that previously reconciled starts
// showing an opening, an edit around that date is the first thing to check.
//
// quantity_diff is the size of the swing. Compare it with the opening that appeared:
// if they match, the edit is the explanation.
//
//   cd C:\envo\app\backend
//   node scripts/edit_history.mjs "Ikpe Annang"
//   node scripts/edit_history.mjs "Ikpe Annang" "ABC/3TC"
//   node scripts/edit_history.mjs "Ikpe Annang" --since 2026-08-01
//   node scripts/edit_history.mjs --all --since 2026-08-01     # network-wide

import { pool, query } from '../src/db.js'

const argv = process.argv.slice(2)
const flag = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
const since = flag('--since')
const all = argv.includes('--all')
const limit = parseInt(flag('--limit')) || 100
const pos = argv.filter((a, i) => !a.startsWith('--') && !['--since', '--limit'].includes(argv[i - 1]))
const [facArg, commArg] = pos

try {
  if (!facArg && !all) { console.error('Usage: node scripts/edit_history.mjs "<facility>" ["<commodity>"] [--since YYYY-MM-DD]\n       node scripts/edit_history.mjs --all --since YYYY-MM-DD'); process.exit(1) }

  const params = []
  const conds = []
  if (facArg) { params.push(`%${facArg}%`); conds.push(`f.name ilike $${params.length}`) }
  if (commArg) { params.push(`%${commArg}%`); conds.push(`c.name ilike $${params.length}`) }
  if (since) { params.push(since); conds.push(`e.created_at >= $${params.length}`) }
  params.push(limit)

  const rows = (await query(`
    select e.created_at, f.name facility, c.name commodity, e.record_type,
           e.old_quantity, e.new_quantity, e.quantity_diff, e.edited_by, coalesce(e.note,'') note
      from edit_history e
      left join facilities f on f.id = e.facility_id
      left join commodities c on c.id = e.commodity_id
     ${conds.length ? 'where ' + conds.join(' and ') : ''}
     order by e.created_at desc
     limit $${params.length}`, params)).rows

  if (!rows.length) { console.log('\nNo edits recorded for that filter.'); process.exit(0) }

  console.log(`\n${rows.length} edit(s), newest first:\n`)
  console.table(rows.map(r => ({
    when: r.created_at?.toISOString?.().slice(0, 16).replace('T', ' '),
    facility: (r.facility || '').slice(0, 28), commodity: (r.commodity || '').slice(0, 24),
    type: r.record_type, from: r.old_quantity, to: r.new_quantity,
    swing: r.quantity_diff, by: (r.edited_by || '').slice(0, 18), note: r.note.slice(0, 24),
  })))

  const net = rows.reduce((s, r) => s + Number(r.quantity_diff || 0), 0)
  console.log(`\nNet quantity swing across these edits: ${net}`)
  console.log('An edit moves stock on hand without writing a movement, so a swing here')
  console.log("that matches a bin's new opening balance is very likely its cause.")
  console.log('\nREAD-ONLY — nothing was modified.')
} catch (err) {
  console.error('Failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
