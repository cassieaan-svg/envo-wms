// READ-ONLY. The same ledger dump diagnose_phantom_openings.mjs prints — every
// record behind a bin with a running net — but for ANY store bin you name, not only
// the ones that are currently at SOH 0.
//
// diagnose_phantom_openings.mjs is deliberately scoped to bins at SOH 0 (see its own
// header): that pattern isolates itself, since a bin sitting at 0 with a negative
// record net has nothing else going on to muddy the read. A commodity with real
// stock and years of activity can carry the exact same defect — outflows the ledger
// records exceeding inflows — it's just buried under everything since. This is that
// same read, generalised: no SOH filter, so it works on NIMR's TDF/3TC as readily as
// on a bin sitting at zero.
//
//   cd C:\envo\app\backend
//   node scripts/explain_bin_ledger.mjs --facility "Nigerian Institute" --commodity "TDF/3TC 300/300mg"
//   node scripts/explain_bin_ledger.mjs --facility "..." --commodity "..." --csv out.csv
//
// Partial, case-insensitive match on both — matches diagnose_phantom_openings.mjs's
// own facility-argument behaviour. Store bin only (location_type='store'), same as
// that script, so the reported SOH lines up with the record net on the same terms.

import { pool, query } from '../src/db.js'
import fs from 'node:fs'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined
}
const FAC = flag('facility')
const COMM = flag('commodity')
const csvPath = flag('csv')

if (!FAC || !COMM) {
  console.error('Usage: node scripts/explain_bin_ledger.mjs --facility "<partial name>" --commodity "<partial name>" [--csv out.csv]')
  process.exitCode = 1
} else {
  main()
}

const OUT_STATUSES = `('in_transit','dispatched','accepted')`   // store OUT counts at dispatch, matching diagnose_phantom_openings.mjs
const d = v => (v ? new Date(v).toISOString().slice(0, 10) : '')

async function main() {
  try {
    const bins = (await query(`
      select s.facility_id, s.commodity_id, f.name facility, cm.name commodity, s.quantity soh
        from stock s
        join facilities  f  on f.id = s.facility_id
        join commodities cm on cm.id = s.commodity_id
       where s.location_type = 'store'
         and f.name ilike $1 and cm.name ilike $2`,
      [`%${FAC}%`, `%${COMM}%`])).rows

    if (!bins.length) { console.log('\nNo matching store bin — check the facility/commodity spelling.'); return }
    if (bins.length > 1) {
      console.log(`\n${bins.length} matches — narrow --facility/--commodity to one:\n`)
      console.table(bins.map(b => ({ facility: b.facility, commodity: b.commodity, SOH: b.soh })))
      return
    }

    const b = bins[0]
    const p = [b.facility_id, b.commodity_id]
    const rows = [
      ...(await query(`select id, received_at t, 'INTAKE' kind, quantity qty, coalesce(supplier_source,'') ref, coalesce(received_by,'') who, coalesce(notes,'') notes from intake_log where facility_id=$1 and commodity_id=$2`, p)).rows.map(r => ({ ...r, delta: r.qty })),
      ...(await query(`select id, adjusted_at t, 'ADJ ('||adjustment_type||')' kind, quantity qty, coalesce(reason,'') ref, coalesce(adjusted_by,'') who, coalesce(notes,'') notes, adjustment_type from stock_adjustment_log where facility_id=$1 and commodity_id=$2`, p)).rows.map(r => ({ ...r, delta: r.adjustment_type === 'Decrease' ? -r.qty : r.qty })),
      ...(await query(`select id, coalesce(resolved_at, initiated_at) t, 'TRANSFER OUT' kind, quantity qty, status ref, coalesce(initiated_by,'') who, coalesce(notes,'') notes from stock_transfer_log where sending_facility_id=$1 and commodity_id=$2 and status in ${OUT_STATUSES}`, p)).rows.map(r => ({ ...r, delta: -r.qty })),
      ...(await query(`select id, coalesce(resolved_at, initiated_at) t, 'TRANSFER IN' kind, quantity qty, status ref, coalesce(initiated_by,'') who, coalesce(notes,'') notes from stock_transfer_log where receiving_facility_id=$1 and commodity_id=$2 and status='accepted' and sending_facility_id is distinct from $1`, p)).rows.map(r => ({ ...r, delta: r.qty })),
    ].sort((x, y) => new Date(x.t) - new Date(y.t))

    const recordNet = rows.reduce((s, r) => s + r.delta, 0)
    const opening = b.soh - recordNet

    console.log(`\n${b.facility} — ${b.commodity}   SOH ${b.soh}, record net ${recordNet}, implied opening ${opening}`)
    console.log(`(${rows.length} records, ${rows[0] ? d(rows[0].t) : '-'} .. ${rows.length ? d(rows[rows.length - 1].t) : '-'})\n`)

    let run = 0
    const detail = []
    console.table(rows.map(r => {
      run += r.delta
      detail.push({ id: r.id, date: d(r.t), kind: r.kind, delta: r.delta, running: run, reason: r.ref, by: r.who, notes: r.notes })
      return { id8: (r.id || '').slice(0, 8), date: d(r.t), kind: r.kind, delta: r.delta, running: run, reason: (r.ref || '').slice(0, 22), by: r.who, notes: (r.notes || '').slice(0, 30) }
    }))

    // Same tell diagnose_phantom_openings.mjs looks for: repeated count-style
    // decreases, usually one shelf counted more than once as a fresh delta each time.
    const counts = rows.filter(r => /count/i.test(r.ref) && r.delta < 0)
    if (counts.length > 1) {
      console.log(`\n⚠ ${counts.length} count-style DECREASES totalling ${counts.reduce((s, r) => s + r.delta, 0)} — ` +
                  `check whether these are the same shelf entered repeatedly as a delta rather than distinct losses.`)
      const byDay = {}
      for (const r of counts) (byDay[d(r.t)] = byDay[d(r.t)] || []).push(r)
      const extras = Object.values(byDay).filter(v => v.length > 1).flatMap(v => v.slice(1))
      if (extras.length) {
        console.log(`  same-day repeats; candidate ids (${extras.reduce((s, r) => s + r.delta, 0)} units):`)
        console.log(`    ${extras.map(r => r.id).join(',')}`)
      }
    }

    if (opening !== 0) {
      console.log(`\nImplied opening = ${opening}: the record net doesn't reconcile with current SOH. If it's negative, more`)
      console.log(`outflow is recorded than inflow can account for; if positive, stock exists that no record explains.`)
      console.log(`fix_opening_balance.mjs and opening_balance_plan.mjs are the next step once a specific bad entry, or`)
      console.log(`a real unrecorded baseline, is identified from the table above — this script only explains.`)
    } else {
      console.log(`\nOpening = 0 — this bin's ledger reconciles with its current stock.`)
    }

    if (csvPath) {
      const hdr = ['Id', 'Date', 'Kind', 'Delta', 'Running', 'Reason', 'By', 'Notes']
      const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
      fs.writeFileSync(csvPath, [hdr.join(','), ...detail.map(r => [r.id, r.date, r.kind, r.delta, r.running, r.reason, r.by, r.notes].map(esc).join(','))].join('\r\n'))
      console.log(`\nWrote ${detail.length} detail rows to ${csvPath}`)
    }
    console.log('\nREAD-ONLY — nothing was modified.')
  } finally {
    await pool.end()
  }
}
