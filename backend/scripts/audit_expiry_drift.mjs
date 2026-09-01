// READ-ONLY review list for expiry dates that a record edit may have walked backwards.
//
// THE BUG (fixed in "Hand DATE columns over as the day they are, not an instant"):
// node-postgres turned a DATE into a JS Date at LOCAL midnight, which JSON-encodes as
// the previous day in UTC — 2026-11-30 left the server as "2026-11-29T23:00:00.000Z"
// in Lagos. Views that render through fmtDate converted back and were right, but the
// intake / adjustment / lot editors prefill their date input by SLICING that string:
//
//     useState(record.expiry_date?.slice(0,10))   ->  "2026-11-29"
//
// so opening one of those dialogs and saving — even without touching the expiry —
// stored the day before. Every subsequent save moved it another day.
//
// The fix stops the drift; it does not undo what already drifted. This script finds
// candidates. It NEVER writes: expiry drives FEFO and the expiry alerts, so a blind
// mass correction could do more damage than the original bug.
//
//   node scripts/audit_expiry_drift.mjs             # summary + the top candidates
//   node scripts/audit_expiry_drift.mjs --all       # every candidate, not just a sample
//   node scripts/audit_expiry_drift.mjs --csv out.csv
//
// CONFIDENCE TIERS — read these before correcting anything:
//
//   CONFIRMED  another record of the SAME commodity+batch holds exactly this record's
//              expiry + N days, where N is the number of times this record was edited.
//              Two independent facts agreeing; the batch-mate never went through an
//              editor, so it kept the true date.
//
//   LIKELY     no batch-mate to compare against, but expiry + N lands on a month end
//              or the 1st. Real expiries cluster hard on those days (about 60% of all
//              expiries in the database), so landing just below one after N edits is
//              the shape this bug produces.
//
//   REVIEW     the record was edited and carries an expiry, so it is inside the blast
//              radius, but nothing corroborates a shift. Most of these are probably
//              fine. Listed so the exposure is countable, not so it can be bulk-fixed.
//
// N is an UPPER BOUND: edit_history logs quantity edits, and not every edit
// necessarily passed through a dialog that rewrote the expiry. Treat the suggested
// date as a question, not an answer — check it against the physical stock or the
// delivery paperwork before changing anything.

import fs from 'node:fs'
import { pool } from '../src/db.js'

const argv = process.argv.slice(2)
const ALL = argv.includes('--all')
const CSV = (() => { const i = argv.indexOf('--csv'); return i !== -1 ? (argv[i + 1] || 'expiry_drift.csv') : null })()
const SAMPLE = 25

const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }

// One row per edited record that carries an expiry, with:
//   edits      how many times it was edited  = the most days it could have drifted
//   suggested  expiry + edits, the date it would have held if every edit shifted it
//   mate       a batch-mate's expiry that equals `suggested` (the corroboration)
const SQL = `
with recs as (
  select 'intake'::text     as kind, i.id, i.facility_id, i.commodity_id,
         btrim(coalesce(i.batch_number,'')) as batch, i.expiry_date
    from intake_log i where i.expiry_date is not null
  union all
  select 'adjustment', a.id, a.facility_id, a.commodity_id,
         btrim(coalesce(a.batch_number,'')), a.expiry_date
    from stock_adjustment_log a where a.expiry_date is not null
),
edits as (
  select record_id, count(*)::int n, max(created_at) as last_edit
    from edit_history group by 1
),
exposed as (
  select r.*, e.n as edits, e.last_edit
    from recs r join edits e on e.record_id = r.id
),
-- A batch-mate holding exactly expiry + edits days: the strong evidence.
-- Placeholder batch strings ('00000', '0', '-') are excluded: they are shared by
-- unrelated deliveries, so agreeing on them proves nothing.
mate as (
  select x.id, max(o.expiry_date) as mate_expiry
    from exposed x
    join recs o
      on o.commodity_id = x.commodity_id
     and o.batch = x.batch
     and length(x.batch) > 2
     and btrim(x.batch, '0-') <> ''
     and o.id <> x.id
     and o.expiry_date = x.expiry_date + x.edits
   group by x.id
)
select x.kind, x.id, x.edits, x.expiry_date, (x.expiry_date + x.edits) as suggested,
       m.mate_expiry, x.batch, c.name as commodity, f.name as facility, f.state,
       to_char(x.last_edit,'YYYY-MM-DD') as last_edit
  from exposed x
  left join mate m on m.id = x.id
  left join commodities c on c.id = x.commodity_id
  left join facilities  f on f.id = x.facility_id
 order by (m.mate_expiry is not null) desc, x.edits desc, f.state, f.name`

// Month end / 1st: where real expiries cluster, so where a drifted one came from.
function isBoundary(d) {
  const day = d.getUTCDate()
  if (day === 1) return true
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), day + 1))
  return next.getUTCMonth() !== d.getUTCMonth()   // nothing after it in this month
}

const ymd = v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10))

async function main() {
  const { rows } = await pool.query(SQL)
  if (!rows.length) {
    console.log('No edited records carry an expiry date — nothing could have drifted.')
    return
  }

  for (const r of rows) {
    r.expiry   = ymd(r.expiry_date)
    r.suggest  = ymd(r.suggested)
    r.boundary = isBoundary(new Date(`${r.suggest}T00:00:00Z`))
    r.tier = r.mate_expiry ? 'CONFIRMED' : r.boundary ? 'LIKELY' : 'REVIEW'
  }

  const by = t => rows.filter(r => r.tier === t)
  const confirmed = by('CONFIRMED'), likely = by('LIKELY'), review = by('REVIEW')

  console.log(`\nExpiry drift review — ${rows.length} edited records carry an expiry date\n`)
  console.log(`  CONFIRMED  ${String(confirmed.length).padStart(5)}   a batch-mate holds exactly expiry + edits`)
  console.log(`  LIKELY     ${String(likely.length).padStart(5)}   expiry + edits lands on a month end / the 1st`)
  console.log(`  REVIEW     ${String(review.length).padStart(5)}   edited, but nothing corroborates a shift`)

  // The subset with BOTH kinds of evidence: a batch-mate agrees, and the recovered
  // date lands where real expiries actually cluster. Start here.
  const strongest = confirmed.filter(r => r.boundary)
  console.log(`\n  of the CONFIRMED, ${strongest.length} also land on a month end / the 1st — start with those`)

  const worst = rows.reduce((m, r) => Math.max(m, r.edits), 0)
  console.log(`  worst case: ${worst} edits on one record = up to ${worst} days early`)

  const show = ALL ? [...confirmed, ...likely] : [...confirmed, ...likely].slice(0, SAMPLE)
  if (show.length) {
    console.log(`\n${ALL ? 'All' : `First ${show.length}`} CONFIRMED/LIKELY candidates:\n`)
    console.log('  TIER       STORED      -> SUGGESTED   ED  BATCH            COMMODITY / FACILITY')
    for (const r of show) {
      console.log(`  ${r.tier.padEnd(9)}  ${r.expiry}  -> ${r.suggest}  ${String(r.edits).padStart(2)}  ` +
                  `${(r.batch || '(none)').slice(0, 15).padEnd(15)}  ${(r.commodity || '?').slice(0, 28)} / ${(r.facility || '?').slice(0, 30)}`)
    }
    if (!ALL && confirmed.length + likely.length > show.length) {
      console.log(`\n  … ${confirmed.length + likely.length - show.length} more. Use --all, or --csv to export.`)
    }
  }

  if (CSV) {
    const head = ['tier','lands_on_month_boundary','kind','record_id','state','facility','commodity','batch','stored_expiry','suggested_expiry','edits','last_edit']
    const out = [head, ...rows.map(r => [r.tier, r.boundary ? 'yes' : 'no', r.kind, r.id, r.state, r.facility, r.commodity, r.batch,
                                         r.expiry, r.suggest, r.edits, r.last_edit])]
    fs.writeFileSync(CSV, out.map(r => r.map(csvCell).join(',')).join('\r\n'))
    console.log(`\nFull list written to: ${CSV}`)
  }

  console.log('\nNothing was changed. Confirm against the physical stock or the delivery')
  console.log('paperwork before correcting any of these.')
}

main()
  .catch(err => { console.error(err); process.exitCode = 1 })
  .finally(() => pool.end())
