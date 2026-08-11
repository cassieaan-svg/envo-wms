// Correct dispense_log rows whose dispensed_at year was mistyped into the future.
//
// These are real dispenses with a bad year: they sit outside every reporting
// window, so they are invisible in Monitoring, CRRF and bin cards, and they
// corrupt any "first record" calculation (the interim weekly AMC divides by the
// weeks since a commodity's first record — one stray 2029 row would stretch that
// span and drive the AMC toward zero, hiding a stockout).
//
// Mapping, as instructed (dates read DD/MM/YYYY, the app's en-GB house format):
//   month 04 / 05 / 06  →  July 2026, same day-of-month
//   month 11            →  11 July 2026
// The day-of-month and time-of-day are otherwise preserved. Any future row that
// matches NEITHER rule is reported and left alone rather than guessed at.
//
// NOT touched: the two rows dated before 2024 (0002-07-28 and 2022-07-24). They
// were not part of this instruction.
//
// Safety: dry-run by default — prints what it would do and changes nothing.
// `--apply` performs the update inside one transaction and writes an undo file
// first, so every original value can be restored.
//
//   node scripts/fix_future_dispense_dates.mjs            # preview
//   node scripts/fix_future_dispense_dates.mjs --apply    # commit
//   node scripts/fix_future_dispense_dates.mjs --undo <file>

import { writeFileSync, readFileSync } from 'node:fs'
import { query, pool, withTransaction } from '../src/db.js'

const APPLY = process.argv.includes('--apply')
const undoIdx = process.argv.indexOf('--undo')
const UNDO_FILE = undoIdx > -1 ? process.argv[undoIdx + 1] : null

// ── Undo path ────────────────────────────────────────────────────────────────
if (UNDO_FILE) {
  const entries = JSON.parse(readFileSync(UNDO_FILE, 'utf8'))
  console.log(`restoring ${entries.length} rows from ${UNDO_FILE}`)
  await withTransaction(async exec => {
    for (const e of entries) {
      await exec('update dispense_log set dispensed_at = $2 where id = $1', [e.id, e.old_dispensed_at])
    }
  })
  console.log('✔ restored')
  await pool.end()
  process.exit(0)
}

// ── Target the mistyped rows ─────────────────────────────────────────────────
const { rows } = await query(`
  select d.id,
         d.dispensed_at,
         to_char(d.dispensed_at, 'YYYY-MM-DD HH24:MI') as ts,
         extract(month from d.dispensed_at)::int       as mon,
         extract(day   from d.dispensed_at)::int       as day,
         to_char(d.dispensed_at, 'HH24:MI:SS')         as tod,
         d.quantity,
         c.name as commodity,
         f.name as facility
    from dispense_log d
    left join commodities c on c.id = d.commodity_id
    left join facilities  f on f.id = d.facility_id
   where d.dispensed_at > now()
   order by d.dispensed_at`)

if (!rows.length) {
  console.log('No future-dated dispense records found — nothing to do.')
  await pool.end()
  process.exit(0)
}

// month 04/05/06 → same day in July 2026;  month 11 → 11 July 2026
function targetDate(r) {
  if ([4, 5, 6].includes(r.mon)) return `2026-07-${String(r.day).padStart(2, '0')} ${r.tod}`
  if (r.mon === 11) return `2026-07-11 ${r.tod}`
  return null
}

const planned = [], skipped = []
for (const r of rows) {
  const to = targetDate(r)
  ;(to ? planned : skipped).push({ ...r, to })
}

console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN — nothing will change'}\n`)
console.log('  from              ->  to                 qty      commodity / facility')
console.log('  ' + '─'.repeat(96))
for (const p of planned) {
  console.log(`  ${p.ts}  ->  ${p.to.slice(0, 16)}  ${String(p.quantity).padStart(6)}  ` +
              `${(p.commodity || '?').slice(0, 26)} @ ${(p.facility || '?').slice(0, 30)}`)
}
if (skipped.length) {
  console.log('\n  LEFT ALONE (month matches no rule — decide these explicitly):')
  for (const s of skipped) {
    console.log(`  ${s.ts}  ${String(s.quantity).padStart(6)}  ${(s.commodity || '?').slice(0, 26)}`)
  }
}

// Every corrected row lands in a window the reports actually cover, so these
// quantities will start appearing in consumption figures. Say so explicitly.
const total = planned.reduce((s, p) => s + (p.quantity || 0), 0)
console.log(`\n  ${planned.length} row(s) to correct, ${skipped.length} left alone.`)
console.log(`  ${total} units will move into July 2026 and begin counting toward`)
console.log('  consumption, AMC, Monitoring, CRRF and bin cards.')

if (!APPLY) {
  console.log('\nRe-run with --apply to commit.')
  await pool.end()
  process.exit(0)
}

// ── Apply ────────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const undoPath = `undo_future_dispense_dates_${stamp}.json`
writeFileSync(undoPath, JSON.stringify(
  planned.map(p => ({ id: p.id, old_dispensed_at: p.dispensed_at })), null, 2))
console.log(`\nundo file written: ${undoPath}`)

await withTransaction(async exec => {
  for (const p of planned) {
    await exec('update dispense_log set dispensed_at = $2::timestamptz where id = $1', [p.id, p.to])
  }
})

const { rows: left } = await query('select count(*)::int c from dispense_log where dispensed_at > now()')
console.log(`✔ corrected ${planned.length} row(s). Future-dated rows remaining: ${left[0].c}`)
console.log(`  restore with:  node scripts/fix_future_dispense_dates.mjs --undo ${undoPath}`)
await pool.end()
