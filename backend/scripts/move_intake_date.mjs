// Move the received date of matching intake_log rows to a single target date.
//
// Built for: stock physically received in one CRRF period but recorded in the next
// because the intake date used to be locked to "today". Re-dating those receipts to
// the last day of the right period puts them back in the correct CRRF cycle.
//
// DRY-RUN BY DEFAULT. It only writes when you pass --apply, and every write records the
// row's original received_at to an undo file first, so a mistaken run can be reversed.
//
//   cd C:\envo\app\backend
//   # review what matches (no changes):
//   node scripts/move_intake_date.mjs --state Lagos --supplier ghsc \
//        --received-from 2026-09-01 --received-to 2026-09-30 --to 2026-08-31
//   # apply it:
//   node scripts/move_intake_date.mjs --state Lagos --supplier ghsc \
//        --received-from 2026-09-01 --received-to 2026-09-30 --to 2026-08-31 --apply
//
// Reverse a run:  node scripts/move_intake_date.mjs --undo scripts/move_intake_<ts>.undo.json
//
// Match filters (all optional except --to, and --undo replaces them):
//   --state        facility state (exact)
//   --facility     facility name (partial, case-insensitive)
//   --supplier     ghsc | other   (ghsc = supplier_source ~ ghsc/psm; other = the rest)
//   --commodity    commodity name (partial, case-insensitive)
//   --received-from / --received-to   Lagos calendar-day range the row currently falls in
//   --to           REQUIRED: the target date (YYYY-MM-DD). Rows are re-stamped to noon
//                  Africa/Lagos on this day, so the Lagos calendar day is exactly --to.

import fs from 'node:fs'
import { pool } from '../src/db.js'

const argv = process.argv.slice(2)
const flag = n => { const i = argv.indexOf(`--${n}`); return i !== -1 && argv[i+1] && !argv[i+1].startsWith('--') ? argv[i+1] : undefined }
const has  = n => argv.includes(`--${n}`)

const LD = c => `(${c} at time zone 'utc' at time zone 'Africa/Lagos')::date`

async function undo(path) {
  const entries = JSON.parse(fs.readFileSync(path, 'utf8'))
  console.log(`Reversing ${entries.length} row(s) from ${path}…`)
  const c = await pool.connect()
  try {
    await c.query('begin')
    let n = 0
    for (const e of entries) {
      const r = await c.query('update intake_log set received_at = $2 where id = $1', [e.id, e.original_received_at])
      n += r.rowCount
    }
    await c.query('commit')
    console.log(`Restored ${n} row(s) to their original received_at.`)
  } catch (err) { await c.query('rollback'); throw err } finally { c.release() }
}

async function main() {
  const undoPath = flag('undo')
  if (undoPath) { await undo(undoPath); return }

  const TO = flag('to')
  if (!TO || !/^\d{4}-\d{2}-\d{2}$/.test(TO)) {
    console.error('--to <YYYY-MM-DD> is required (the target date).'); process.exitCode = 1; return
  }
  const APPLY = has('apply')

  // Build the match.
  const params = []
  const conds = []
  const state = flag('state');       if (state)     { params.push(state);            conds.push(`f.state = $${params.length}`) }
  const facN  = flag('facility');    if (facN)      { params.push(`%${facN}%`);      conds.push(`f.name ilike $${params.length}`) }
  const commN = flag('commodity');   if (commN)     { params.push(`%${commN}%`);     conds.push(`c.name ilike $${params.length}`) }
  const rFrom = flag('received-from');if (rFrom)    { params.push(rFrom);            conds.push(`${LD('i.received_at')} >= $${params.length}`) }
  const rTo   = flag('received-to');  if (rTo)      { params.push(rTo);              conds.push(`${LD('i.received_at')} <= $${params.length}`) }
  const supplier = flag('supplier')
  if (supplier === 'ghsc')       conds.push(`i.supplier_source ~* 'ghsc|psm'`)
  else if (supplier === 'other') conds.push(`(i.supplier_source is null or i.supplier_source !~* 'ghsc|psm')`)
  else if (supplier)             { console.error("--supplier must be 'ghsc' or 'other'."); process.exitCode = 1; return }

  if (!conds.length) { console.error('Refusing to match EVERY intake row — add at least one filter.'); process.exitCode = 1; return }

  const where = conds.join(' and ')
  const { rows } = await pool.query(`
    select i.id, i.received_at, ${LD('i.received_at')} d, i.quantity,
           f.name facility, c.name commodity, coalesce(i.supplier_source,'') supplier, i.received_by
    from intake_log i
    join facilities f on f.id = i.facility_id
    join commodities c on c.id = i.commodity_id
    where ${where}
    order by d, f.name`, params)

  if (!rows.length) { console.log('No intake rows match — nothing to move.'); return }

  console.log(`${rows.length} intake row(s) match — would move to ${TO} (noon Africa/Lagos):\n`)
  for (const r of rows.slice(0, 50)) {
    console.log(`  ${r.d}  ${String(r.quantity).padStart(6)}  ${(r.facility||'').slice(0,30).padEnd(30)} ${(r.commodity||'').slice(0,26).padEnd(26)} ${r.supplier.slice(0,12)}`)
  }
  if (rows.length > 50) console.log(`  … ${rows.length - 50} more`)
  console.log(`\ntotal ${rows.reduce((s,r)=>s+r.quantity,0).toLocaleString()} units, ${new Set(rows.map(r=>r.facility)).size} facilities`)

  if (!APPLY) {
    console.log('\nDRY-RUN — nothing changed. Re-run with --apply to move these, an undo file will be written first.')
    return
  }

  // Write the undo file BEFORE mutating.
  const ts = new Date().toISOString().replace(/[:.]/g,'-')
  const undoFile = `scripts/move_intake_${ts}.undo.json`
  fs.writeFileSync(undoFile, JSON.stringify(rows.map(r => ({ id: r.id, original_received_at: r.received_at })), null, 0))
  console.log(`\nUndo file written: ${undoFile}`)

  const c = await pool.connect()
  try {
    await c.query('begin')
    // Noon Lagos on the target day, so the Lagos calendar day is exactly --to.
    const r = await c.query(
      `update intake_log set received_at = ($2 || ' 12:00:00')::timestamp at time zone 'Africa/Lagos'
       where id = any($1)`,
      [rows.map(r => r.id), TO])
    await c.query('commit')
    console.log(`Moved ${r.rowCount} row(s) to ${TO}. Reverse with:  node scripts/move_intake_date.mjs --undo ${undoFile}`)
  } catch (err) { await c.query('rollback'); throw err } finally { c.release() }
}

main().catch(e => { console.error(e); process.exitCode = 1 }).finally(() => pool.end())
