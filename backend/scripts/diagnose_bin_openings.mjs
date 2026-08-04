// READ-ONLY. Explains WHY any bin has a non-zero opening balance, by dumping every
// record behind it with a running net and the row ids needed to correct it.
//
// Generalises diagnose_phantom_openings.mjs, which only ever looked at STORE bins
// that were empty AND over-deducted — 34 of the 171 bins in the last audit. The
// other 137 (46 stores with stock on hand or a negative opening, 17 dispensary,
// 74 SDP) had no diagnostic at all, and the negatives concentrate in exactly the
// site bins that consumption enforcement will start refusing.
//
// Movement accounting matches audit_opening_balances.mjs and the bin card:
//   store       intakes + adjustments + transfers in(accepted, external)
//               − transfers out(in_transit/dispatched/accepted)
//   dispensary  internal transfers in(accepted) − dispenses(untagged)
//               − "Returned from Dispensary" adjustments
//   sdp / dsd    internal transfers in(accepted, tagged) − dispenses(tagged)
//               − "Returned from SDP/DSD: <site>" adjustments
//
//   cd C:\envo\app\backend
//   node scripts/diagnose_bin_openings.mjs                      # every bin, worst first
//   node scripts/diagnose_bin_openings.mjs --min 50             # only material ones
//   node scripts/diagnose_bin_openings.mjs --bin sdp            # one bin type
//   node scripts/diagnose_bin_openings.mjs "Ikot Ebok"          # one facility
//   node scripts/diagnose_bin_openings.mjs --csv bins.csv       # detail to CSV
//   node scripts/diagnose_bin_openings.mjs --summary            # no per-bin detail

import { pool, query } from '../src/db.js'
import fs from 'node:fs'

const argv = process.argv.slice(2)
const flag = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
const min = Math.abs(parseInt(flag('--min'))) || 1
const csvPath = flag('--csv')
const binFilter = flag('--bin')
const summaryOnly = argv.includes('--summary')
const facArg = argv.filter((a, i) => !a.startsWith('--') && !['--min', '--csv', '--bin'].includes(argv[i - 1]))[0] || null
const maxDetail = parseInt(flag('--limit')) || 40

const OUT = `('in_transit','dispatched','accepted')`
const d = v => (v ? new Date(v).toISOString().slice(0, 10) : '')
// Site tag inside a dispense/transfer note, e.g. "[SDP: Main Lab]".
const TAG = `case when notes ~* '\\[SDP:' then 'sdp:'||btrim(substring(notes from '\\[SDP:\\s*([^\\]]+)\\]'))
                  when notes ~* '\\[DSD:' then 'dsd:'||btrim(substring(notes from '\\[DSD:\\s*([^\\]]+)\\]'))
                  else 'dispensary' end`

try {
  // ---- 1. Openings for every bin (same arithmetic as the audit) ----
  const key = (...a) => a.join('|')
  const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v)
  const intakes = new Map(), adj = new Map(), storeIn = new Map(), storeOut = new Map()
  const issued = new Map(), recv = new Map(), returns = new Map()

  for (const r of (await query(`select facility_id f, commodity_id c, sum(quantity)::int q from intake_log group by 1,2`)).rows) add(intakes, key(r.f, r.c), r.q)
  for (const r of (await query(`select facility_id f, commodity_id c, sum(case when adjustment_type='Decrease' then -quantity else quantity end)::int q from stock_adjustment_log group by 1,2`)).rows) add(adj, key(r.f, r.c), r.q)
  for (const r of (await query(`select facility_id f, commodity_id c, reason, quantity q, notes from stock_adjustment_log where reason in ('Returned from Dispensary','Returned from DSD','Returned from SDP')`)).rows) {
    let bin
    if (r.reason === 'Returned from Dispensary') bin = 'dispensary'
    else { const s = /Returned from [^:]*:\s*([^—]+)/i.exec(r.notes || '')?.[1]?.trim(); if (!s) continue; bin = (r.reason === 'Returned from DSD' ? 'dsd:' : 'sdp:') + s }
    add(returns, key(r.f, r.c, bin), r.q)
  }
  for (const r of (await query(`select facility_id f, commodity_id c, sum(quantity)::int q, ${TAG} bin from dispense_log group by 1,2,4`)).rows) add(issued, key(r.f, r.c, r.bin), r.q)
  for (const r of (await query(`select sending_facility_id sf, receiving_facility_id rf, commodity_id c, quantity q, status, ${TAG} dest from stock_transfer_log`)).rows) {
    const internal = r.sf && (r.rf == null || r.rf === r.sf)
    if (r.sf && ['in_transit', 'dispatched', 'accepted'].includes(r.status)) add(storeOut, key(r.sf, r.c), r.q)
    if (r.status === 'accepted') {
      if (internal) add(recv, key(r.sf, r.c, r.dest), r.q)
      else if (r.rf) add(storeIn, key(r.rf, r.c), r.q)
    }
  }
  const storeSoh = new Map(), dispSoh = new Map(), siteSoh = new Map()
  for (const r of (await query(`select facility_id f, commodity_id c, location_type lt, quantity q from stock where location_type in ('store','dispensary')`)).rows)
    (r.lt === 'store' ? storeSoh : dispSoh).set(key(r.f, r.c), r.q)
  for (const r of (await query(`select facility_id f, commodity_id c, sdp_name s, quantity q from sdp_stock`)).rows) siteSoh.set(key(r.f, r.c, `sdp:${r.s}`), r.q)
  for (const r of (await query(`select facility_id f, commodity_id c, dsd_site_name s, quantity q from dsd_stock`)).rows) siteSoh.set(key(r.f, r.c, `dsd:${r.s}`), r.q)

  const facName = new Map((await query(`select id, name, lga from facilities`)).rows.map(r => [r.id, r]))
  const commName = new Map((await query(`select id, name from commodities`)).rows.map(r => [r.id, r.name]))

  const found = []
  for (const k of new Set([...storeSoh.keys(), ...intakes.keys(), ...adj.keys(), ...storeIn.keys(), ...storeOut.keys()])) {
    const [f, c] = k.split('|')
    const soh = storeSoh.get(k) || 0
    const net = (intakes.get(k) || 0) + (adj.get(k) || 0) + (storeIn.get(k) || 0) - (storeOut.get(k) || 0)
    if (Math.abs(soh - net) >= min) found.push({ f, c, bin: 'store', soh, opening: soh - net })
  }
  const binKeys = new Set([...siteSoh.keys(), ...recv.keys(), ...issued.keys(), ...returns.keys()])
  for (const k of dispSoh.keys()) binKeys.add(`${k}|dispensary`)
  for (const kk of binKeys) {
    const [f, c, bin] = kk.split('|')
    const soh = bin === 'dispensary' ? (dispSoh.get(key(f, c)) || 0) : (siteSoh.get(kk) || 0)
    const net = (recv.get(kk) || 0) - (issued.get(kk) || 0) - (returns.get(kk) || 0)
    if (Math.abs(soh - net) >= min) found.push({ f, c, bin, soh, opening: soh - net })
  }

  let bins = found
    .filter(b => !facArg || (facName.get(b.f)?.name || '').toLowerCase().includes(facArg.toLowerCase()))
    .filter(b => !binFilter || (binFilter === 'store' || binFilter === 'dispensary' ? b.bin === binFilter : b.bin.startsWith(binFilter + ':')))
    .sort((a, b) => Math.abs(b.opening) - Math.abs(a.opening))

  if (!bins.length) { console.log('\nNo bins matched.'); process.exit(0) }

  const table = bins.map(b => ({
    facility: (facName.get(b.f)?.name || b.f).slice(0, 34), commodity: (commName.get(b.c) || b.c).slice(0, 28),
    bin: b.bin, SOH: b.soh, opening: b.opening, effect: b.opening > 0 ? 'INCREASES' : 'REDUCES',
  }))
  console.log(`\n${bins.length} bin(s) with |opening| >= ${min}, worst first:\n`)
  console.table(table.slice(0, 60))
  const kind = b => b.startsWith('sdp:') ? 'sdp' : b.startsWith('dsd:') ? 'dsd' : b
  const g = {}
  for (const b of bins) { const k = kind(b.bin); g[k] = g[k] || { bins: 0, positive: 0, negative: 0, units: 0 }; g[k].bins++; g[k][b.opening > 0 ? 'positive' : 'negative']++; g[k].units += Math.abs(b.opening) }
  console.log('\nBy bin type:'); console.table(g)

  // ---- 2. Per-bin detail with row ids ----
  const detail = []
  if (!summaryOnly) for (const b of bins.slice(0, maxDetail)) {
    const p = [b.f, b.c]
    const fname = facName.get(b.f)?.name || b.f, cname = commName.get(b.c) || b.c
    let rows = []
    if (b.bin === 'store') {
      rows = [
        ...(await query(`select id, received_at t, 'INTAKE' kind, quantity qty, coalesce(supplier_source,'') ref, coalesce(received_by,'') who, coalesce(notes,'') notes from intake_log where facility_id=$1 and commodity_id=$2`, p)).rows.map(r => ({ ...r, delta: r.qty })),
        ...(await query(`select id, adjusted_at t, 'ADJ ('||adjustment_type||')' kind, quantity qty, coalesce(reason,'') ref, coalesce(adjusted_by,'') who, coalesce(notes,'') notes, adjustment_type from stock_adjustment_log where facility_id=$1 and commodity_id=$2`, p)).rows.map(r => ({ ...r, delta: r.adjustment_type === 'Decrease' ? -r.qty : r.qty })),
        ...(await query(`select id, coalesce(resolved_at,initiated_at) t, 'TRANSFER OUT' kind, quantity qty, status ref, coalesce(initiated_by,'') who, coalesce(notes,'') notes from stock_transfer_log where sending_facility_id=$1 and commodity_id=$2 and status in ${OUT}`, p)).rows.map(r => ({ ...r, delta: -r.qty })),
        ...(await query(`select id, coalesce(resolved_at,initiated_at) t, 'TRANSFER IN' kind, quantity qty, status ref, coalesce(initiated_by,'') who, coalesce(notes,'') notes from stock_transfer_log where receiving_facility_id=$1 and commodity_id=$2 and status='accepted' and sending_facility_id is distinct from $1`, p)).rows.map(r => ({ ...r, delta: r.qty })),
      ]
    } else {
      // Dispensary / site bin: what it received from the store, what it issued, and
      // what it returned. Matched on the same notes tag the bin card uses.
      const isDisp = b.bin === 'dispensary'
      const site = isDisp ? null : b.bin.split(':').slice(1).join(':')
      const tagLike = isDisp ? null : `%[${b.bin.startsWith('sdp:') ? 'SDP' : 'DSD'}: ${site}]%`
      const dispCond = isDisp ? `and notes !~* '\\[SDP:' and notes !~* '\\[DSD:'` : `and notes ilike $3`
      const pp = isDisp ? p : [...p, tagLike]
      rows = [
        ...(await query(`select id, coalesce(resolved_at,initiated_at) t, 'RECEIVED from store' kind, quantity qty, status ref, coalesce(initiated_by,'') who, coalesce(notes,'') notes from stock_transfer_log where sending_facility_id=$1 and commodity_id=$2 and status='accepted' and (receiving_facility_id is null or receiving_facility_id=$1) ${dispCond}`, pp)).rows.map(r => ({ ...r, delta: r.qty })),
        ...(await query(`select id, dispensed_at t, 'DISPENSED' kind, quantity qty, '' ref, coalesce(dispensed_by,'') who, coalesce(notes,'') notes from dispense_log where facility_id=$1 and commodity_id=$2 ${dispCond}`, pp)).rows.map(r => ({ ...r, delta: -r.qty })),
        ...(await query(`select id, adjusted_at t, 'RETURNED to store' kind, quantity qty, reason ref, coalesce(adjusted_by,'') who, coalesce(notes,'') notes from stock_adjustment_log where facility_id=$1 and commodity_id=$2 and reason in ('Returned from Dispensary','Returned from DSD','Returned from SDP') ${isDisp ? `and reason='Returned from Dispensary'` : `and notes ilike '%'||$3||'%'`}`,
          isDisp ? p : [...p, site])).rows.map(r => ({ ...r, delta: -r.qty })),
      ]
    }
    rows.sort((x, y) => new Date(x.t) - new Date(y.t))

    let run = 0
    console.log(`\n${'='.repeat(100)}\n${fname} — ${cname} [${b.bin}]   SOH ${b.soh}, opening ${b.opening}\n`)
    console.table(rows.map(r => {
      run += r.delta
      detail.push({ id: r.id, facility: fname, commodity: cname, bin: b.bin, date: d(r.t), kind: r.kind, delta: r.delta, running: run, reason: r.ref, by: r.who, notes: r.notes })
      return { id8: (r.id || '').slice(0, 8), date: d(r.t), kind: r.kind, delta: r.delta, running: run, reason: r.ref, by: r.who, notes: (r.notes || '').slice(0, 34) }
    }))

    // Same-day repeated count decreases: one shelf entered more than once.
    const counts = rows.filter(r => /count/i.test(r.ref) && r.delta < 0)
    if (counts.length > 1) {
      const byDay = {}
      for (const r of counts) (byDay[d(r.t)] = byDay[d(r.t)] || []).push(r)
      const extras = Object.values(byDay).filter(v => v.length > 1).flatMap(v => v.slice(1))
      if (extras.length) {
        console.log(`  → same-day repeated count decreases; candidate ids to reverse (${extras.reduce((s, r) => s + r.delta, 0)} units):`)
        console.log(`    ${extras.map(r => r.id).join(',')}`)
      }
    }
  }
  if (!summaryOnly && bins.length > maxDetail) console.log(`\n…detail shown for the worst ${maxDetail}; use --limit N for more.`)

  if (csvPath) {
    const hdr = ['Id', 'Facility', 'Commodity', 'Bin', 'Date', 'Kind', 'Delta', 'Running', 'Reason', 'By', 'Notes']
    const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    fs.writeFileSync(csvPath, [hdr.join(','), ...detail.map(r => [r.id, r.facility, r.commodity, r.bin, r.date, r.kind, r.delta, r.running, r.reason, r.by, r.notes].map(esc).join(','))].join('\r\n'))
    console.log(`\nWrote ${detail.length} detail rows to ${csvPath}`)
  }
  console.log('\nREAD-ONLY — nothing was modified.')
} catch (err) {
  console.error('Diagnose failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
