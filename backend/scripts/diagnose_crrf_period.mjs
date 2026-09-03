// READ-ONLY. Reproduces the CRRF page's Beginning/Ending Balance rewind directly in
// SQL, broken into its components, for one facility + commodity + bi-monthly period.
//
// The CRRF page (frontend/src/pages/pharmacy/CRRF.jsx) computes:
//   Ending balance   = current total SOH  -  net movement AFTER the period closed
//   Beginning balance = that Ending balance  -  net movement DURING the period
// where "net movement" = intake - dispense + signed adjustment + signed external
// transfer, and the day a movement falls on is its LAGOS calendar day (matching
// ymdLagos on the frontend), not the raw UTC date.
//
// This prints the SAME numbers the page would compute, one line per source, so a
// negative or surprising Beginning Balance can be traced to a concrete cause —
// e.g. a facility whose opening stock was set directly (a script, a count
// correction) rather than through an intake record: the rewind can only account
// for movements that were actually logged, so stock that entered the ledger any
// other way reads as a shortfall here.
//
// Nothing is written. Safe to run against production.
//
//   node scripts/diagnose_crrf_period.mjs --facility "<exact facility name>" \
//                                         --commodity "<exact commodity name>" \
//                                         --year 2026 --period "Jul-Aug"
//
// --period accepts Jan-Feb / Mar-Apr / May-Jun / Jul-Aug / Sep-Oct / Nov-Dec.

import { pool } from '../src/db.js'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined
}
const FACILITY = flag('facility')
const COMMODITY = flag('commodity')
const YEAR = Number(flag('year')) || new Date().getFullYear()

const PERIODS = {
  'jan-feb': ['01', '02'], 'mar-apr': ['03', '04'], 'may-jun': ['05', '06'],
  'jul-aug': ['07', '08'], 'sep-oct': ['09', '10'], 'nov-dec': ['11', '12'],
}
const periodKey = (flag('period') || '').toLowerCase().replace(/\s+/g, '')
const period = PERIODS[periodKey]

if (!FACILITY || !COMMODITY || !period) {
  console.error('Usage: node scripts/diagnose_crrf_period.mjs --facility "<name>" --commodity "<name>" --year 2026 --period "Jul-Aug"')
  process.exitCode = 1
} else {
  main()
}

const LAGOS_DAY = (col) => `(${col} at time zone 'utc' at time zone 'Africa/Lagos')::date`

async function main() {
  const { rows: [f] } = await pool.query(`select id, name, state from facilities where name = $1`, [FACILITY])
  if (!f) { console.error(`No facility named exactly "${FACILITY}"`); process.exitCode = 1; return }
  const { rows: [c] } = await pool.query(`select id, name, category from commodities where name = $1`, [COMMODITY])
  if (!c) { console.error(`No commodity named exactly "${COMMODITY}"`); process.exitCode = 1; return }

  const [m1, m2] = period
  const from = `${YEAR}-${m1}-01`
  const lastDay = new Date(YEAR, Number(m2), 0).getDate()
  const to = `${YEAR}-${m2}-${String(lastDay).padStart(2, '0')}`
  // Lagos "today" — matches todayLagos() in the page. DATE parses as a plain
  // 'YYYY-MM-DD' string (see db.js's type parser), not a JS Date.
  const { rows: [{ today }] } = await pool.query(
    `select (now() at time zone 'Africa/Lagos')::date as today`)

  console.log(`${c.name} @ ${f.name} (${f.state})`)
  console.log(`period ${from} .. ${to}   today (Lagos) = ${today}\n`)

  const soh = (await pool.query(`
    select coalesce((select sum(quantity) from stock     where facility_id=$1 and commodity_id=$2),0) store,
           coalesce((select sum(quantity) from dsd_stock where facility_id=$1 and commodity_id=$2),0) dsd,
           coalesce((select sum(quantity) from sdp_stock where facility_id=$1 and commodity_id=$2),0) sdp
  `, [f.id, c.id])).rows[0]
  const sohTotal = Number(soh.store) + Number(soh.dsd) + Number(soh.sdp)
  console.log(`current total SOH = ${sohTotal}  (store ${soh.store} + dsd ${soh.dsd} + sdp ${soh.sdp})\n`)

  // One window's breakdown: intake / dispense / adjustment / transfer, each with a
  // row count so a suspiciously round or absent figure is visible, not just the net.
  async function window(label, lo, hi, cmp) {
    const intake = await pool.query(`
      select count(*)::int n, coalesce(sum(quantity),0)::int q
      from intake_log where facility_id=$1 and commodity_id=$2
        and ${LAGOS_DAY('received_at')} ${cmp[0]} $3 and ${LAGOS_DAY('received_at')} ${cmp[1]} $4`,
      [f.id, c.id, lo, hi])
    const disp = await pool.query(`
      select count(*)::int n, coalesce(sum(quantity),0)::int q
      from dispense_log where facility_id=$1 and commodity_id=$2
        and ${LAGOS_DAY('dispensed_at')} ${cmp[0]} $3 and ${LAGOS_DAY('dispensed_at')} ${cmp[1]} $4`,
      [f.id, c.id, lo, hi])
    const adj = await pool.query(`
      select count(*)::int n,
             coalesce(sum(case when adjustment_type='Decrease' then -quantity else quantity end),0)::int net,
             coalesce(sum(quantity) filter (where adjustment_type='Increase'),0)::int inc,
             coalesce(sum(quantity) filter (where adjustment_type='Decrease'),0)::int dec,
             string_agg(distinct reason, ', ') reasons
      from stock_adjustment_log where facility_id=$1 and commodity_id=$2
        and ${LAGOS_DAY('adjusted_at')} ${cmp[0]} $3 and ${LAGOS_DAY('adjusted_at')} ${cmp[1]} $4`,
      [f.id, c.id, lo, hi])
    const trans = await pool.query(`
      select count(*)::int n,
             coalesce(sum(case when receiving_facility_id=$1 then quantity else -quantity end),0)::int net
      from stock_transfer_log
      where commodity_id=$2 and status='accepted'
        and sending_facility_id is not null and receiving_facility_id is not null
        and sending_facility_id <> receiving_facility_id
        and (sending_facility_id=$1 or receiving_facility_id=$1)
        and ${LAGOS_DAY('resolved_at')} ${cmp[0]} $3 and ${LAGOS_DAY('resolved_at')} ${cmp[1]} $4`,
      [f.id, c.id, lo, hi])

    const i = intake.rows[0], d = disp.rows[0], a = adj.rows[0], t = trans.rows[0]
    const net = Number(i.q) - Number(d.q) + Number(a.net) + Number(t.net)
    console.log(`${label} (${lo} .. ${hi}):`)
    console.log(`  intake      ${String(i.n).padStart(5)} rows   +${i.q}`)
    console.log(`  dispense    ${String(d.n).padStart(5)} rows   -${d.q}`)
    console.log(`  adjustment  ${String(a.n).padStart(5)} rows   +${a.inc} / -${a.dec}  net ${a.net >= 0 ? '+' : ''}${a.net}  [${a.reasons || '-'}]`)
    console.log(`  transfer    ${String(t.n).padStart(5)} rows   net ${t.net >= 0 ? '+' : ''}${t.net}`)
    console.log(`  => net movement this window: ${net >= 0 ? '+' : ''}${net}\n`)
    return net
  }

  const netAfter = await window('AFTER the period', to, today, ['>', '<='])
  const netWithin = await window('WITHIN the period', from, to, ['>=', '<='])

  const E = sohTotal - netAfter
  const A = E - netWithin

  console.log('─'.repeat(60))
  console.log(`Ending balance   (close of ${to}) = SOH ${sohTotal} - after(${netAfter}) = ${E}`)
  console.log(`Beginning balance (open of ${from}) = ${E} - within(${netWithin}) = ${A}`)
  if (A < 0) {
    console.log(`\nBeginning balance is negative: more went OUT since ${from} than the ledger shows`)
    console.log(`coming IN, given today's stock. This is not a display bug — it means either:`)
    console.log(`  - stock entered this facility's ledger some way OTHER than intake/adjustment/`)
    console.log(`    transfer (e.g. an opening balance set directly by a script), which this`)
    console.log(`    rewind cannot see because there is no logged movement to account for it, or`)
    console.log(`  - a real gap: dispensing recorded without a matching intake ever being logged.`)
    console.log(`Check this facility/commodity against opening_balance_plan.mjs / the intake`)
    console.log(`history directly before treating the figure as final.`)
  }
  await pool.end()
}
