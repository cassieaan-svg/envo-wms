// READ-ONLY. Locations whose opening balance exactly equals a receipt they accepted
// — the signature of a transfer credited twice.
//
// WHY THIS NEEDS ITS OWN LIST. Accepting a transfer used to credit the stock before
// setting the status, with no check on what the status already was, so a retried or
// double-clicked accept credited everything twice while the row was simply set to
// 'accepted' again. Nothing looks wrong afterwards: the transfer record is entirely
// normal, and the lot ledger doubled too, so stock and lots agree with each other and
// only disagree with the movement records.
//
// That is invisible to opening_balance_plan, which reads the records. It would
// classify these as BASELINE — asserting "this location began with N" when it began
// with nothing and was credited twice. That buries the fault and leaves the facility
// believing it holds double, which is the direction that causes a stockout, because
// nobody reorders against a number that looks healthy.
//
// The honest remedy is the opposite: the stock is overstated, so REDUCE it to what
// the records justify. Recorded as a Physical count correction (Decrease) on that
// location with a note naming the duplicated transfer, the correction is itself a
// movement, so the opening lands on 0 without any baseline.
//
// An exact match is strong evidence, not proof — a coincidence is possible where a
// location's genuine baseline happens to equal a later receipt. Check the transfer
// date against when the stock figure last moved before acting.
//
//   cd C:\envo\app\backend
//   node scripts/suspect_double_credit.mjs
//   node scripts/suspect_double_credit.mjs --csv suspects.csv
//   node scripts/suspect_double_credit.mjs --min 10

import { pool, query } from '../src/db.js'
import fs from 'node:fs'

const argv = process.argv.slice(2)
const flag = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
const min = Math.abs(parseInt(flag('--min'))) || 1
const csvPath = flag('--csv')

const rxn = (n, t) => new RegExp(`\\[${t}:\\s*([^\\]]+)\\]`, 'i').exec(n || '')?.[1]?.trim()
const binOf = n => { const d = rxn(n, 'DSD'), s = rxn(n, 'SDP'); return d ? `dsd:${d}` : s ? `sdp:${s}` : 'dispensary' }
const label = b => b === 'store' ? 'Main Store' : b === 'dispensary' ? 'Dispensary'
  : b.startsWith('dsd:') ? `DSD — ${b.slice(4)}` : `SDP — ${b.slice(4)}`
const K = (f, c, b) => `${f}|${c}|${b}`
const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v)

try {
  const facName = new Map((await query(`select id, name from facilities`)).rows.map(r => [r.id, r.name]))
  const commName = new Map((await query(`select id, name from commodities`)).rows.map(r => [r.id, r.name]))

  const intakes = new Map(), adjStore = new Map(), storeIn = new Map(), storeOut = new Map()
  const issued = new Map(), recv = new Map(), returns = new Map(), binAdj = new Map(), recorded = new Map()
  for (const r of (await query(`select facility_id f, commodity_id c, sum(quantity)::int q from intake_log group by 1,2`)).rows) add(intakes, `${r.f}|${r.c}`, r.q)
  for (const r of (await query(`select facility_id f, commodity_id c, sum(case when adjustment_type='Decrease' then -quantity else quantity end)::int q from stock_adjustment_log where coalesce(location_type,'store')='store' group by 1,2`)).rows) add(adjStore, `${r.f}|${r.c}`, r.q)
  for (const r of (await query(`select facility_id f, commodity_id c, location_type lt, site_name s, sum(case when adjustment_type='Decrease' then -quantity else quantity end)::int q from stock_adjustment_log where coalesce(location_type,'store')<>'store' group by 1,2,3,4`)).rows)
    add(binAdj, K(r.f, r.c, r.lt === 'dispensary' ? 'dispensary' : `${r.lt}:${r.s}`), r.q)
  for (const r of (await query(`select facility_id f, commodity_id c, reason, quantity qty, notes from stock_adjustment_log where reason in ('Returned from Dispensary','Returned from DSD','Returned from SDP')`)).rows) {
    let bin
    if (r.reason === 'Returned from Dispensary') bin = 'dispensary'
    else { const s = /Returned from [^:]*:\s*([^—]+)/i.exec(r.notes || '')?.[1]?.trim(); if (!s) continue; bin = (r.reason === 'Returned from DSD' ? 'dsd:' : 'sdp:') + s }
    add(returns, K(r.f, r.c, bin), r.qty)
  }
  for (const r of (await query(`select facility_id f, commodity_id c, quantity, notes from dispense_log`)).rows) add(issued, K(r.f, r.c, binOf(r.notes)), r.quantity)

  // Accepted receipts per location, kept individually so an opening can be matched
  // against a single transfer rather than a total.
  const receipts = new Map()
  const push = (k, v) => { const a = receipts.get(k) || []; a.push(v); receipts.set(k, a) }
  for (const r of (await query(`
    select t.id, t.sending_facility_id sf, t.receiving_facility_id rf, t.commodity_id c, t.quantity,
           t.notes, coalesce(t.resolved_at, t.initiated_at) t_at, t.resolved_by
      from stock_transfer_log t where t.status='accepted'`)).rows) {
    const internal = r.sf && (r.rf == null || r.rf === r.sf)
    if (r.sf && ['in_transit', 'dispatched', 'accepted'].includes('accepted')) add(storeOut, `${r.sf}|${r.c}`, 0)
    if (internal) push(K(r.sf, r.c, binOf(r.notes)), r)
    else if (r.rf) push(K(r.rf, r.c, 'store'), r)
  }
  for (const r of (await query(`select sending_facility_id sf, commodity_id c, quantity, status from stock_transfer_log`)).rows)
    if (r.sf && ['in_transit', 'dispatched', 'accepted'].includes(r.status)) add(storeOut, `${r.sf}|${r.c}`, r.quantity)
  for (const r of (await query(`select sending_facility_id sf, receiving_facility_id rf, commodity_id c, quantity, notes from stock_transfer_log where status='accepted'`)).rows) {
    const internal = r.sf && (r.rf == null || r.rf === r.sf)
    if (internal) add(recv, K(r.sf, r.c, binOf(r.notes)), r.quantity)
    else if (r.rf) add(storeIn, `${r.rf}|${r.c}`, r.quantity)
  }
  for (const r of (await query(`select facility_id f, commodity_id c, location_type lt, site_name s, quantity q from bin_opening`)).rows)
    add(recorded, K(r.f, r.c, (r.lt === 'store' || r.lt === 'dispensary') ? r.lt : `${r.lt}:${r.s}`), r.q)

  const storeSoh = new Map(), dispSoh = new Map(), siteSoh = new Map()
  for (const r of (await query(`select facility_id f, commodity_id c, location_type lt, quantity q, updated_at from stock where location_type in ('store','dispensary')`)).rows)
    (r.lt === 'store' ? storeSoh : dispSoh).set(`${r.f}|${r.c}`, { q: r.q, at: r.updated_at })
  for (const r of (await query(`select facility_id f, commodity_id c, sdp_name s, quantity q, updated_at from sdp_stock`)).rows) siteSoh.set(K(r.f, r.c, `sdp:${r.s}`), { q: r.q, at: r.updated_at })
  for (const r of (await query(`select facility_id f, commodity_id c, dsd_site_name s, quantity q, updated_at from dsd_stock`)).rows) siteSoh.set(K(r.f, r.c, `dsd:${r.s}`), { q: r.q, at: r.updated_at })

  const hits = []
  const consider = (f, c, bin, sohRec, net) => {
    if (!sohRec) return
    const op = sohRec.q - net
    if (op < min) return                                   // only OVERSTATED stock
    const list = receipts.get(K(f, c, bin)) || []
    const match = list.find(r => r.quantity === op)
    if (!match) return
    hits.push({
      fac: facName.get(f) || f, comm: commName.get(c) || c, bin, soh: sohRec.q, op,
      transfer: match.quantity, when: String(match.t_at).slice(0, 10), by: match.resolved_by || '',
      stockMoved: String(sohRec.at).slice(0, 10),
      sameDay: String(match.t_at).slice(0, 10) === String(sohRec.at).slice(0, 10),
    })
  }
  for (const k of new Set([...storeSoh.keys(), ...intakes.keys(), ...storeIn.keys()])) {
    const [f, c] = k.split('|')
    consider(f, c, 'store', storeSoh.get(k),
      (intakes.get(k) || 0) + (adjStore.get(k) || 0) + (storeIn.get(k) || 0) - (storeOut.get(k) || 0) + (recorded.get(K(f, c, 'store')) || 0))
  }
  const keys = new Set([...siteSoh.keys(), ...recv.keys(), ...issued.keys()])
  for (const k of dispSoh.keys()) keys.add(`${k}|dispensary`)
  for (const kk of keys) {
    const [f, c, bin] = kk.split('|')
    consider(f, c, bin, bin === 'dispensary' ? dispSoh.get(`${f}|${c}`) : siteSoh.get(kk),
      (recv.get(kk) || 0) - (issued.get(kk) || 0) - (returns.get(kk) || 0) + (binAdj.get(kk) || 0) + (recorded.get(kk) || 0))
  }
  hits.sort((a, b) => b.op - a.op)

  if (!hits.length) { console.log('\nNo location matches the double-credit signature.'); process.exit(0) }
  const strong = hits.filter(h => h.sameDay)
  console.log(`\n${hits.length} location(s) whose opening exactly equals an accepted receipt — ${hits.reduce((s, h) => s + h.op, 0)} units`)
  console.log(`${strong.length} of them also had the stock figure last change ON THE DAY of that receipt (strongest evidence).\n`)
  console.table(hits.map(h => ({
    facility: h.fac.slice(0, 30), commodity: h.comm.slice(0, 22), location: label(h.bin).slice(0, 16),
    'EnVo says': h.soh, 'records justify': h.soh - h.op, 'overstated by': h.op,
    'transfer on': h.when, 'stock last moved': h.stockMoved, evidence: h.sameDay ? 'STRONG' : 'check',
  })))

  console.log('\nFor each confirmed one, correct the stock — do NOT baseline it:')
  console.log('  Adjustment → the commodity → reason "Physical count correction", type Decrease,')
  console.log('  quantity = "overstated by", the location above, and a note naming the duplicated')
  console.log('  transfer. The adjustment is itself a movement, so the opening lands on 0.')
  console.log('\nIf a baseline was already recorded here, remove it first:')
  console.log('  node scripts/fix_opening_balance.mjs "<facility>" "<commodity>" --bin <bin> --clear --apply')

  if (csvPath) {
    const hdr = ['Facility', 'Location', 'Commodity', 'EnVoSays', 'RecordsJustify', 'OverstatedBy', 'TransferDate', 'StockLastMoved', 'Evidence']
    const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    fs.writeFileSync(csvPath, [hdr.join(','), ...hits.map(h => [h.fac, label(h.bin), h.comm, h.soh, h.soh - h.op, h.op, h.when, h.stockMoved, h.sameDay ? 'STRONG' : 'check'].map(esc).join(','))].join('\r\n'))
    console.log(`\nWrote ${hits.length} rows to ${csvPath}`)
  }
  console.log('\nREAD-ONLY — nothing was modified.')
} catch (err) {
  console.error('Failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
