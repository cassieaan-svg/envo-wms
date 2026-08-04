// Read-only, network-wide audit of bin-card OPENING BALANCES. For every
// (facility, commodity, bin) it computes opening = current SOH − Σ(recorded
// movements) — the same "plug" the bin card shows. A non-zero opening means the
// recorded movements don't reconcile with the stock on hand: a positive opening
// silently INCREASES the bin's stock (a seed/baseline or receipts that outran
// records), a negative one REDUCES it (consumption/dispatch the card doesn't count).
//
// Opening is a pure quantity, independent of batch/FEFO, so this is exact.
//
//   cd C:\envo\app\backend
//   node scripts/audit_opening_balances.mjs                 # all bins with |opening| >= 1
//   node scripts/audit_opening_balances.mjs --min 10        # only |opening| >= 10
//   node scripts/audit_opening_balances.mjs --csv audit.csv # also write a CSV
//
// Transfer accounting mirrors the (fixed) bin card: a store OUT counts once
// dispatched (in_transit/dispatched/accepted); everything received (store IN,
// dispensary, site) counts on 'accepted'.

import { pool, query } from '../src/db.js'
import fs from 'node:fs'

const argv = process.argv.slice(2)
const min = (() => { const i = argv.indexOf('--min'); return i >= 0 ? Math.abs(parseInt(argv[i + 1])) || 1 : 1 })()
const csvPath = (() => { const i = argv.indexOf('--csv'); return i >= 0 ? argv[i + 1] : null })()
const OUT_STATUSES = new Set(['in_transit', 'dispatched', 'accepted'])  // store OUT: dispatched leaves the store
const key = (...a) => a.join('|')
const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v)

try {
  // ---- Aggregate movements & SOH (all facilities/commodities) ----
  const intakes = new Map()   // fac|comm -> sum
  for (const r of (await query(`select facility_id f, commodity_id c, sum(quantity)::int q from intake_log group by 1,2`)).rows) add(intakes, key(r.f, r.c), r.q)

  const adj = new Map()       // fac|comm -> signed sum
  for (const r of (await query(`select facility_id f, commodity_id c, sum(case when adjustment_type='Decrease' then -quantity else quantity end)::int q from stock_adjustment_log group by 1,2`)).rows) add(adj, key(r.f, r.c), r.q)

  // Dispenses, split per destination bin via the notes site tag.
  const issued = new Map()    // fac|comm|bin -> sum   (bin: 'dispensary' | 'sdp:site' | 'dsd:site')
  for (const r of (await query(`
    select facility_id f, commodity_id c, sum(quantity)::int q,
      case when notes ~* '\\[SDP:' then 'sdp:'||btrim(substring(notes from '\\[SDP:\\s*([^\\]]+)\\]'))
           when notes ~* '\\[DSD:' then 'dsd:'||btrim(substring(notes from '\\[DSD:\\s*([^\\]]+)\\]'))
           else 'dispensary' end bin
    from dispense_log group by 1,2,4`)).rows) add(issued, key(r.f, r.c, r.bin), r.q)

  // Transfers → store OUT (dispatched), store IN + dispensary/site receipts (accepted).
  const storeOut = new Map(), storeIn = new Map(), recv = new Map()  // recv: fac|comm|bin -> sum
  for (const r of (await query(`
    select sending_facility_id sf, receiving_facility_id rf, commodity_id c, quantity q, status,
      case when notes ~* '\\[SDP:' then 'sdp:'||btrim(substring(notes from '\\[SDP:\\s*([^\\]]+)\\]'))
           when notes ~* '\\[DSD:' then 'dsd:'||btrim(substring(notes from '\\[DSD:\\s*([^\\]]+)\\]'))
           else 'dispensary' end dest
    from stock_transfer_log`)).rows) {
    const internal = r.sf && (r.rf == null || r.rf === r.sf)
    if (r.sf && OUT_STATUSES.has(r.status)) add(storeOut, key(r.sf, r.c), r.q)        // store issued at dispatch
    if (r.status === 'accepted') {
      if (internal) add(recv, key(r.sf, r.c, r.dest), r.q)                            // dispensary/site receives
      else if (r.rf) add(storeIn, key(r.rf, r.c), r.q)                                // external transfer in
    }
  }

  // Current SOH per bin.
  const storeSoh = new Map(), dispSoh = new Map(), siteSoh = new Map()  // siteSoh: fac|comm|bin
  for (const r of (await query(`select facility_id f, commodity_id c, location_type lt, quantity q from stock where location_type in ('store','dispensary')`)).rows)
    (r.lt === 'store' ? storeSoh : dispSoh).set(key(r.f, r.c), r.q)
  for (const r of (await query(`select facility_id f, commodity_id c, sdp_name s, quantity q from sdp_stock`)).rows) siteSoh.set(key(r.f, r.c, `sdp:${r.s}`), r.q)
  for (const r of (await query(`select facility_id f, commodity_id c, dsd_site_name s, quantity q from dsd_stock`)).rows) siteSoh.set(key(r.f, r.c, `dsd:${r.s}`), r.q)

  // Names for reporting.
  const facName = new Map((await query(`select id, name, lga, state from facilities`)).rows.map(r => [r.id, r]))
  const commName = new Map((await query(`select id, name from commodities`)).rows.map(r => [r.id, r.name]))

  // ---- Compute opening per bin = SOH − net movements ----
  const findings = []
  const push = (f, c, bin, soh, net) => { const op = soh - net; if (Math.abs(op) >= min) findings.push({ f, c, bin, soh, opening: op }) }

  // STORE: net = intakes + adj + storeIn − storeOut
  for (const k of new Set([...storeSoh.keys(), ...intakes.keys(), ...adj.keys(), ...storeIn.keys(), ...storeOut.keys()])) {
    const [f, c] = k.split('|')
    const soh = storeSoh.get(k) || 0
    const net = (intakes.get(k) || 0) + (adj.get(k) || 0) + (storeIn.get(k) || 0) - (storeOut.get(k) || 0)
    push(f, c, 'store', soh, net)
  }
  // DISPENSARY + SITES: net = received − issued. Canonicalize every source to a
  // single 'fac|comm|bin' key so a bin is never counted twice.
  const binKeys = new Set([...siteSoh.keys(), ...recv.keys(), ...issued.keys()])
  for (const k of dispSoh.keys()) binKeys.add(`${k}|dispensary`)
  for (const kk of binKeys) {
    const [f, c, bin] = kk.split('|')
    const soh = bin === 'dispensary' ? (dispSoh.get(key(f, c)) || 0) : (siteSoh.get(kk) || 0)
    const net = (recv.get(kk) || 0) - (issued.get(kk) || 0)
    push(f, c, bin, soh, net)
  }

  findings.sort((a, b) => Math.abs(b.opening) - Math.abs(a.opening))
  const rows = findings.map(x => ({
    facility: facName.get(x.f)?.name || x.f.slice(0, 8), lga: facName.get(x.f)?.lga || '',
    commodity: commName.get(x.c) || x.c.slice(0, 8), bin: x.bin, SOH: x.soh,
    opening: x.opening, effect: x.opening > 0 ? 'INCREASES stock' : 'REDUCES stock',
  }))

  console.log(`\n${findings.length} bin(s) with a non-zero opening balance (|opening| >= ${min}), worst first:\n`)
  console.table(rows.slice(0, 60))
  if (rows.length > 60) console.log(`…and ${rows.length - 60} more (use --csv to get them all).`)
  const inc = rows.filter(r => r.opening > 0), dec = rows.filter(r => r.opening < 0)
  console.log(`\nSummary: ${inc.length} bins with a POSITIVE opening (phantom/baseline inflating stock), ${dec.length} with NEGATIVE (unaccounted outflow).`)

  if (csvPath) {
    const hdr = ['Facility', 'LGA', 'Commodity', 'Bin', 'SOH', 'Opening', 'Effect']
    const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    fs.writeFileSync(csvPath, [hdr.join(','), ...rows.map(r => [r.facility, r.lga, r.commodity, r.bin, r.SOH, r.opening, r.effect].map(esc).join(','))].join('\r\n'))
    console.log(`\nWrote ${rows.length} rows to ${csvPath}`)
  }
} catch (err) {
  console.error('Audit failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
