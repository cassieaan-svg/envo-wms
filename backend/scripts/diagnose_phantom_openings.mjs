// READ-ONLY. Explains WHY a bin has a non-zero opening balance, by dumping every
// record behind it with a running net — so you can see which entries are wrong
// instead of guessing.
//
// Built for the bins in the opening-balance audit where SOH = 0 but the opening is
// POSITIVE. That combination means the recorded OUTFLOWS EXCEED THE INFLOWS: the
// bin card injects a phantom opening so the running balance can still land at 0.
// The usual cause is repeated 'Physical count correction' entries — staff typing
// the counted shelf figure ("200") into a field the backend applies as a delta
// ("remove 200 more"). Apapa General shows it plainly: -1766, -1746, -1723 are one
// shelf counted three times, not three losses.
//
// This is the evidence needed before ANY correction: fix_store_stock.mjs cannot
// touch these bins (it skips a negative record net by design), and no backfill into
// the new stock_count table is safe until real losses have been told apart from
// mis-entered counts.
//
//   cd C:\envo\app\backend
//   node scripts/diagnose_phantom_openings.mjs                       # all phantom bins
//   node scripts/diagnose_phantom_openings.mjs --min 100             # only big ones
//   node scripts/diagnose_phantom_openings.mjs "Apapa General"       # one facility
//   node scripts/diagnose_phantom_openings.mjs --csv phantom.csv     # detail to CSV

import { pool, query } from '../src/db.js'
import fs from 'node:fs'

const argv = process.argv.slice(2)
const min = (() => { const i = argv.indexOf('--min'); return i >= 0 ? Math.abs(parseInt(argv[i + 1])) || 1 : 1 })()
const csvPath = (() => { const i = argv.indexOf('--csv'); return i >= 0 ? argv[i + 1] : null })()
const facArg = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--min' && argv[i - 1] !== '--csv')[0] || null

const OUT_STATUSES = `('in_transit','dispatched','accepted')`   // store OUT counts at dispatch
const d = v => (v ? new Date(v).toISOString().slice(0, 10) : '')

try {
  // Store bins only: this pattern (SOH 0, positive opening) is overwhelmingly a
  // store-side stock-take problem, and the store is where the record net is
  // computable from the logs alone.
  const params = []
  let facCond = ''
  if (facArg) { params.push(`%${facArg}%`); facCond = ` and f.name ilike $${params.length}` }

  const bins = (await query(`
    with intake as (select facility_id f, commodity_id c, sum(quantity)::int q from intake_log group by 1,2),
    adj as (select facility_id f, commodity_id c, sum(case when adjustment_type='Decrease' then -quantity else quantity end)::int q from stock_adjustment_log group by 1,2),
    tin as (select receiving_facility_id f, commodity_id c, sum(quantity)::int q from stock_transfer_log where status='accepted' and receiving_facility_id is distinct from sending_facility_id group by 1,2),
    tout as (select sending_facility_id f, commodity_id c, sum(quantity)::int q from stock_transfer_log where status in ${OUT_STATUSES} group by 1,2)
    select s.facility_id, s.commodity_id, f.name facility, cm.name commodity, s.quantity soh,
           (coalesce(i.q,0)+coalesce(a.q,0)+coalesce(ti.q,0)-coalesce(to_.q,0)) record_net
      from stock s
      join facilities f on f.id = s.facility_id
      join commodities cm on cm.id = s.commodity_id
      left join intake i on i.f=s.facility_id and i.c=s.commodity_id
      left join adj a on a.f=s.facility_id and a.c=s.commodity_id
      left join tin ti on ti.f=s.facility_id and ti.c=s.commodity_id
      left join tout to_ on to_.f=s.facility_id and to_.c=s.commodity_id
     where s.location_type='store' and s.quantity = 0 ${facCond}
       and (coalesce(i.q,0)+coalesce(a.q,0)+coalesce(ti.q,0)-coalesce(to_.q,0)) < 0
     order by (coalesce(i.q,0)+coalesce(a.q,0)+coalesce(ti.q,0)-coalesce(to_.q,0)) asc`, params)).rows
    .map(r => ({ ...r, opening: r.soh - r.record_net }))
    .filter(r => Math.abs(r.opening) >= min)

  if (!bins.length) { console.log('\nNo phantom-opening store bins matched.'); process.exit(0) }

  console.log(`\n${bins.length} store bin(s) with SOH 0 and outflows exceeding inflows (|opening| >= ${min})\n`)
  console.table(bins.map(b => ({ facility: b.facility, commodity: b.commodity, SOH: b.soh, record_net: b.record_net, phantom_opening: b.opening })))

  const detail = []
  for (const b of bins) {
    const p = [b.facility_id, b.commodity_id]
    const rows = [
      ...(await query(`select received_at t, 'INTAKE' kind, quantity qty, coalesce(supplier_source,'') ref, coalesce(received_by,'') who, coalesce(notes,'') notes from intake_log where facility_id=$1 and commodity_id=$2`, p)).rows.map(r => ({ ...r, delta: r.qty })),
      ...(await query(`select adjusted_at t, 'ADJ ('||adjustment_type||')' kind, quantity qty, coalesce(reason,'') ref, coalesce(adjusted_by,'') who, coalesce(notes,'') notes, adjustment_type from stock_adjustment_log where facility_id=$1 and commodity_id=$2`, p)).rows.map(r => ({ ...r, delta: r.adjustment_type === 'Decrease' ? -r.qty : r.qty })),
      ...(await query(`select created_at t, 'TRANSFER OUT' kind, quantity qty, status ref, '' who, coalesce(notes,'') notes from stock_transfer_log where sending_facility_id=$1 and commodity_id=$2 and status in ${OUT_STATUSES}`, p)).rows.map(r => ({ ...r, delta: -r.qty })),
      ...(await query(`select created_at t, 'TRANSFER IN' kind, quantity qty, status ref, '' who, coalesce(notes,'') notes from stock_transfer_log where receiving_facility_id=$1 and commodity_id=$2 and status='accepted' and sending_facility_id is distinct from $1`, p)).rows.map(r => ({ ...r, delta: r.qty })),
    ].sort((x, y) => new Date(x.t) - new Date(y.t))

    let run = 0
    console.log(`\n${'='.repeat(100)}\n${b.facility} — ${b.commodity}   SOH ${b.soh}, record net ${b.record_net}, phantom opening ${b.opening}\n`)
    console.table(rows.map(r => {
      run += r.delta
      detail.push({ facility: b.facility, commodity: b.commodity, date: d(r.t), kind: r.kind, delta: r.delta, running: run, reason: r.ref, by: r.who, notes: r.notes })
      return { date: d(r.t), kind: r.kind, delta: r.delta, running: run, reason: r.ref, by: r.who, notes: (r.notes || '').slice(0, 45) }
    }))

    // The tell: several large Decreases under the same reason are almost always one
    // shelf counted repeatedly, each entered as a delta.
    const counts = rows.filter(r => /count/i.test(r.ref) && r.delta < 0)
    if (counts.length > 1) {
      console.log(`  ⚠ ${counts.length} count-style DECREASES totalling ${counts.reduce((s, r) => s + r.delta, 0)} — ` +
                  `likely the same shelf entered repeatedly as a delta. Under the new stock_count flow only the LAST would apply.`)
    }
  }

  if (csvPath) {
    const hdr = ['Facility', 'Commodity', 'Date', 'Kind', 'Delta', 'Running', 'Reason', 'By', 'Notes']
    const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    fs.writeFileSync(csvPath, [hdr.join(','), ...detail.map(r => [r.facility, r.commodity, r.date, r.kind, r.delta, r.running, r.reason, r.by, r.notes].map(esc).join(','))].join('\r\n'))
    console.log(`\nWrote ${detail.length} detail rows to ${csvPath}`)
  }
  console.log('\nREAD-ONLY — nothing was modified.')
} catch (err) {
  console.error('Diagnose failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
