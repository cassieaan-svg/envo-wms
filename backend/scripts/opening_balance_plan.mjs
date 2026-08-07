// READ-ONLY. A per-location decision list for clearing non-zero opening balances.
//
// An opening balance is EnVo disagreeing with itself: stock now minus every recorded
// movement should be 0, and where it is not, that difference is unexplained. Nothing
// here concerns the physical shelf.
//
// Only two things move an opening, and the choice between them is a judgement about
// what actually happened:
//
//   REVERSE   a record says something happened that did not. Deleting it changes the
//             movement sum, so the opening falls. Use where the evidence is plain:
//             the same count correction entered twice on one day by one person, or a
//             draw from a location that has never received anything.
//
//   BASELINE  the location genuinely held stock before its records begin (go-live
//             seeding, training data, an intake recorded without the stock figure).
//             Recording that baseline explains the gap WITHOUT deleting anyone's
//             consumption, and the opening becomes 0.
//
// Baselining a location whose real problem is a duplicate record would bury the
// evidence and assert stock that never arrived — hence the classification rather
// than a bulk apply. Nothing here runs anything; it proposes.
//
//   cd C:\envo\app\backend
//   node scripts/opening_balance_plan.mjs                     # the whole plan
//   node scripts/opening_balance_plan.mjs --min 20            # material ones only
//   node scripts/opening_balance_plan.mjs "Apapa General"     # one facility
//   node scripts/opening_balance_plan.mjs --csv plan.csv      # with the command per row

import { pool, query } from '../src/db.js'
import fs from 'node:fs'

const argv = process.argv.slice(2)
const flag = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
const min = Math.abs(parseInt(flag('--min'))) || 1
const csvPath = flag('--csv')
const facArg = argv.filter((a, i) => !a.startsWith('--') && !['--min', '--csv'].includes(argv[i - 1]))[0] || null

const rxn = (n, t) => new RegExp(`\\[${t}:\\s*([^\\]]+)\\]`, 'i').exec(n || '')?.[1]?.trim()
const binOf = n => { const d = rxn(n, 'DSD'), s = rxn(n, 'SDP'); return d ? `dsd:${d}` : s ? `sdp:${s}` : 'dispensary' }
const label = b => b === 'store' ? 'Main Store' : b === 'dispensary' ? 'Dispensary'
  : b.startsWith('dsd:') ? `DSD — ${b.slice(4)}` : `SDP — ${b.slice(4)}`
const day = t => new Date(t).toISOString().slice(0, 10)
const q = s => `"${String(s).replace(/"/g, '')}"`

try {
  const K = (f, c, b) => `${f}|${c}|${b}`
  const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v)
  const facName = new Map((await query(`select id, name from facilities`)).rows.map(r => [r.id, r.name]))
  const commName = new Map((await query(`select id, name from commodities`)).rows.map(r => [r.id, r.name]))

  // ---- movements, mirroring audit_opening_balances ----
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
  for (const r of (await query(`select sending_facility_id sf, receiving_facility_id rf, commodity_id c, quantity, status, notes from stock_transfer_log`)).rows) {
    const internal = r.sf && (r.rf == null || r.rf === r.sf)
    if (r.sf && ['in_transit', 'dispatched', 'accepted'].includes(r.status)) add(storeOut, `${r.sf}|${r.c}`, r.quantity)
    if (r.status === 'accepted') { if (internal) add(recv, K(r.sf, r.c, binOf(r.notes)), r.quantity); else if (r.rf) add(storeIn, `${r.rf}|${r.c}`, r.quantity) }
  }
  for (const r of (await query(`select facility_id f, commodity_id c, location_type lt, site_name s, quantity q from bin_opening`)).rows)
    add(recorded, K(r.f, r.c, (r.lt === 'store' || r.lt === 'dispensary') ? r.lt : `${r.lt}:${r.s}`), r.q)

  const storeSoh = new Map(), dispSoh = new Map(), siteSoh = new Map()
  for (const r of (await query(`select facility_id f, commodity_id c, location_type lt, quantity q from stock where location_type in ('store','dispensary')`)).rows) (r.lt === 'store' ? storeSoh : dispSoh).set(`${r.f}|${r.c}`, r.q)
  for (const r of (await query(`select facility_id f, commodity_id c, sdp_name s, quantity q from sdp_stock`)).rows) siteSoh.set(K(r.f, r.c, `sdp:${r.s}`), r.q)
  for (const r of (await query(`select facility_id f, commodity_id c, dsd_site_name s, quantity q from dsd_stock`)).rows) siteSoh.set(K(r.f, r.c, `dsd:${r.s}`), r.q)

  const bins = []
  for (const k of new Set([...storeSoh.keys(), ...intakes.keys(), ...adjStore.keys(), ...storeIn.keys(), ...storeOut.keys()])) {
    const [f, c] = k.split('|')
    const soh = storeSoh.get(k) || 0
    const net = (intakes.get(k) || 0) + (adjStore.get(k) || 0) + (storeIn.get(k) || 0) - (storeOut.get(k) || 0) + (recorded.get(K(f, c, 'store')) || 0)
    if (Math.abs(soh - net) >= min) bins.push({ f, c, bin: 'store', soh, op: soh - net })
  }
  const keys = new Set([...siteSoh.keys(), ...recv.keys(), ...issued.keys(), ...returns.keys(), ...binAdj.keys()])
  for (const k of dispSoh.keys()) keys.add(`${k}|dispensary`)
  for (const kk of keys) {
    const [f, c, bin] = kk.split('|')
    const soh = bin === 'dispensary' ? (dispSoh.get(`${f}|${c}`) || 0) : (siteSoh.get(kk) || 0)
    const net = (recv.get(kk) || 0) - (issued.get(kk) || 0) - (returns.get(kk) || 0) + (binAdj.get(kk) || 0) + (recorded.get(kk) || 0)
    if (Math.abs(soh - net) >= min) bins.push({ f, c, bin, soh, op: soh - net })
  }

  // ---- classify ----
  const plan = []
  for (const b of bins) {
    const fac = facName.get(b.f) || b.f, comm = commName.get(b.c) || b.c
    if (facArg && !fac.toLowerCase().includes(facArg.toLowerCase())) continue

    // (a) the same count correction entered more than once on one day
    const decs = (await query(
      `select id, adjusted_at, quantity, adjusted_by from stock_adjustment_log
        where facility_id=$1 and commodity_id=$2 and adjustment_type='Decrease' and reason ilike '%count%'
          and coalesce(location_type,'store') = $3`,
      [b.f, b.c, b.bin.startsWith('sdp:') ? 'sdp' : b.bin.startsWith('dsd:') ? 'dsd' : b.bin])).rows
    const byDay = {}
    for (const d of decs) (byDay[day(d.adjusted_at)] = byDay[day(d.adjusted_at)] || []).push(d)
    const extras = Object.values(byDay).filter(v => v.length > 1).flatMap(v => v.slice(1))

    // (b) a draw from a location that has never received anything
    const everRecv = (recv.get(K(b.f, b.c, b.bin)) || 0) + (b.bin === 'store' ? (intakes.get(`${b.f}|${b.c}`) || 0) + (storeIn.get(`${b.f}|${b.c}`) || 0) : 0)
    const drew = issued.get(K(b.f, b.c, b.bin)) || 0
    const phantomDraw = everRecv === 0 && drew > 0

    // Same-day repetition alone does NOT prove duplication — a store manager working
    // through a reconciliation legitimately posts several corrections in one sitting,
    // each offsetting a return they had just credited (Ikot Eko Ibon: +149 then -150,
    // +50 then -25). Reversing those would leave the credits standing with nothing
    // against them and assert stock that arrived and never left.
    //
    // What does prove it is impossibility: corrections that remove more than the
    // location has EVER received. Apapa took in 3,736 and its corrections remove
    // 5,692, so at least 1,956 of that cannot have happened. That is the test.
    const everIn = (b.bin === 'store'
      ? (intakes.get(`${b.f}|${b.c}`) || 0) + (storeIn.get(`${b.f}|${b.c}`) || 0)
      : (recv.get(K(b.f, b.c, b.bin)) || 0))
      + Math.max(0, (b.bin === 'store' ? (adjStore.get(`${b.f}|${b.c}`) || 0) : (binAdj.get(K(b.f, b.c, b.bin)) || 0)) + decs.reduce((s, d) => s + d.quantity, 0))
    const removed = decs.reduce((s, d) => s + d.quantity, 0)
    const impossible = removed > everIn

    let action, why, cmd, after = 0
    if (extras.length && b.op > 0 && impossible) {
      const gain = -extras.reduce((s, r) => s + r.quantity * -1, 0)   // extras are Decreases
      action = 'REVERSE'
      why = `corrections remove ${removed} from a location that ever received ${everIn} — ${extras.length + 1} on one day by ${[...new Set(extras.map(e => e.adjusted_by))].join('/')}`
      cmd = `node scripts/fix_opening_balance.mjs --reverse ${extras.map(e => e.id).join(',')}`
      after = b.op - extras.reduce((s, e) => s + e.quantity, 0)
    } else if (phantomDraw && b.op > 0) {
      action = 'REVERSE'
      why = `${drew} drawn from a location that has never received anything`
      cmd = `node scripts/pre_receipt_consumption.mjs ${q(fac)}   # review, then delete those rows`
      after = b.op - drew
    } else {
      action = 'BASELINE'
      why = b.op > 0 ? 'stock present that the records do not explain' : 'records account for more than the location holds'
      const site = b.bin.includes(':') ? ` --site ${q(b.bin.split(':').slice(1).join(':'))}` : ''
      const kind = b.bin.startsWith('sdp:') ? 'sdp' : b.bin.startsWith('dsd:') ? 'dsd' : b.bin
      cmd = `node scripts/fix_opening_balance.mjs ${q(fac)} ${q(comm)} --bin ${kind}${site}`
    }
    plan.push({ fac, comm, bin: b.bin, soh: b.soh, op: b.op, action, why, cmd, after })
  }
  plan.sort((a, b) => Math.abs(b.op) - Math.abs(a.op))

  const rev = plan.filter(p => p.action === 'REVERSE'), base = plan.filter(p => p.action === 'BASELINE')
  console.log(`\n${plan.length} location(s) with a non-zero opening (|opening| >= ${min})`)
  console.log(`  REVERSE  : ${rev.length}  (${rev.reduce((s, p) => s + Math.abs(p.op), 0)} units) — a record says something that did not happen`)
  console.log(`  BASELINE : ${base.length}  (${base.reduce((s, p) => s + Math.abs(p.op), 0)} units) — record what the location started with\n`)
  console.table(plan.slice(0, 40).map(p => ({
    facility: p.fac.slice(0, 30), commodity: p.comm.slice(0, 22), location: label(p.bin).slice(0, 18),
    SOH: p.soh, opening: p.op, action: p.action, 'opening after': p.action === 'REVERSE' ? p.after : 0,
  })))
  if (plan.length > 40) console.log(`…and ${plan.length - 40} more (use --csv for all).`)

  if (rev.length) {
    console.log('\nREVERSE — evidence-based, do these first:\n')
    for (const p of rev) console.log(`  ${p.fac} — ${p.comm} [${label(p.bin)}]  opening ${p.op} → ${p.after}\n    ${p.why}\n    ${p.cmd}\n`)
  }

  if (csvPath) {
    const hdr = ['Facility', 'Location', 'Commodity', 'SOH', 'Opening', 'Action', 'OpeningAfter', 'Why', 'Command']
    const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    fs.writeFileSync(csvPath, [hdr.join(','), ...plan.map(p => [p.fac, label(p.bin), p.comm, p.soh, p.op, p.action, p.action === 'REVERSE' ? p.after : 0, p.why, p.cmd].map(esc).join(','))].join('\r\n'))
    console.log(`\nWrote ${plan.length} rows to ${csvPath}`)
  }
  console.log('\nEvery command dry-runs first; add --apply once you have read its output.')
  console.log('READ-ONLY — nothing was modified.')
} catch (err) {
  console.error('Failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
