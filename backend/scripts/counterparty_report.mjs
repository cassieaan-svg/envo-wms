// Read out the Phase 2K counterparty measurement.
//
//   node scripts/counterparty_report.mjs [days]     (default 30)
//
// Prints, for the window: how often scope.js evaluated the pending-transfer
// counterparty exception, how often it actually reached beyond the caller's own
// facility, and which facilities those were.
//
// HOW TO READ IT. The decision this measurement exists to settle is whether the
// exception can be removed. `widened` is an UPPER BOUND on the accesses that
// depend on it (see counterpartyProbe.js for why it is a bound and not exact):
//
//   widened = 0 everywhere   → nothing depended on the exception all cycle.
//   widened > 0 at 'single'  → a facility user was granted another facility's
//                              stock and the exception was the only rule that
//                              could have allowed it. Investigate before removing.
//   widened > 0 at 'list'    → a stock LIST was widened. Weaker evidence: the
//                              extra ids may never have been looked at.
//
// `observations = 0` for the whole window means the probe was never enabled, NOT
// that the exception is unused — check ENVO_COUNTERPARTY_PROBE on the server
// before concluding anything.

import { pool } from '../src/db.js'

const days = Number(process.argv[2]) || 30

const { rows: totals } = await pool.query(
  `select call_site,
          sum(observations)::bigint  observations,
          sum(widened)::bigint       widened,
          count(distinct facility_id)::int facilities,
          max(max_counterparties)::int max_reach
     from counterparty_probe
    where day >= current_date - $1::int
    group by call_site order by call_site`, [days])

const { rows: window } = await pool.query(
  `select min(day) from_day, max(day) to_day from counterparty_probe
    where day >= current_date - $1::int`, [days])

console.log(`\nCounterparty exception — last ${days} days`)
console.log(`Observed days: ${window[0].from_day || '(none)'} .. ${window[0].to_day || '(none)'}\n`)

if (!totals.length) {
  console.log('  No observations recorded.')
  console.log('  Confirm ENVO_COUNTERPARTY_PROBE=1 was set for the whole cycle before')
  console.log('  reading this as "the exception is unused".')
} else {
  for (const t of totals) {
    console.log(`  ${t.call_site.padEnd(8)}  evaluated ${String(t.observations).padStart(8)}`
      + `  widened ${String(t.widened).padStart(8)}`
      + `  facilities ${String(t.facilities).padStart(5)}`
      + `  max reach ${t.max_reach}`)
  }

  const { rows: who } = await pool.query(
    `select facility_id, call_site, sum(widened)::bigint widened
       from counterparty_probe
      where day >= current_date - $1::int and widened > 0
      group by 1, 2 order by 3 desc limit 25`, [days])

  if (!who.length) {
    console.log('\n  The exception never reached beyond the caller\'s own facility.')
  } else {
    console.log(`\n  Facilities whose access was widened (top ${who.length}):`)
    const { rows: names } = await pool.query(
      `select id, name from facilities where id = any($1::uuid[])`,
      [who.map(w => w.facility_id)])
    const byId = new Map(names.map(n => [n.id, n.name]))
    for (const w of who) {
      console.log(`    ${(byId.get(w.facility_id) || w.facility_id).padEnd(40)} ${w.call_site.padEnd(8)} ${w.widened}`)
    }
  }
}

console.log()
await pool.end()
