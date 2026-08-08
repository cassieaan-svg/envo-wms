// READ-ONLY. Locations that cannot cover the size of draw their staff have been
// recording, split into the two very different reasons why.
//
// Enforcement refuses a consumption record only when it would take a location BELOW
// ZERO in EnVo. Dispensing exactly the balance always passes. So a location appears
// here when a recent draw was larger than what it holds today — meaning the NEXT
// draw of that size will be refused.
//
// That is not one problem, it is two, and they need opposite responses:
//
//   NEEDS RESTOCKING   the location's records reconcile perfectly (opening balance
//                      0). Nothing is wrong with the data: it has simply run down.
//                      The answer is a redistribution from the store, which is
//                      ordinary work, not a correction. On production this is 895 of
//                      934 locations — the overwhelming majority.
//
//   PAPERWORK MISSING  the location's records do NOT reconcile: more has been
//                      recorded out than ever went in. Something was never entered,
//                      and restocking alone will leave the discrepancy in place.
//                      39 locations, 2,596 units unexplained.
//
// The distinction matters because sending every store manager the same instruction
// would have 218 facilities hunting for paperwork that, in 96% of cases, does not
// exist.
//
// Nothing here is a claim about the physical shelf. It is purely EnVo's numbers.
//
//   cd C:\envo\app\backend
//   node scripts/enforcement_readiness.mjs                     # summary + worst facilities
//   node scripts/enforcement_readiness.mjs --gaps              # ONLY the paperwork gaps
//   node scripts/enforcement_readiness.mjs --days 30           # wider window (default 14)
//   node scripts/enforcement_readiness.mjs --csv worklist.csv  # one file, whole network
//   node scripts/enforcement_readiness.mjs --split worklists   # one file per facility
//   node scripts/enforcement_readiness.mjs "Etim Ekpo"         # one facility's list

import { pool, query } from '../src/db.js'
import fs from 'node:fs'

const argv = process.argv.slice(2)
const flag = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
const days = parseInt(flag('--days')) || 14
const csvPath = flag('--csv')
const splitDir = flag('--split')
const gapsOnly = argv.includes('--gaps')
const facArg = argv.filter((a, i) => !a.startsWith('--') && !['--days', '--csv', '--split'].includes(argv[i - 1]))[0] || null

const rx = (n, t) => new RegExp(`\\[${t}:\\s*([^\\]]+)\\]`, 'i').exec(n || '')?.[1]?.trim()
const binOf = n => { const d = rx(n, 'DSD'), s = rx(n, 'SDP'); return d ? `dsd:${d}` : s ? `sdp:${s}` : 'dispensary' }
// ASCII only: these files are opened in Excel by 218 store managers, and a UTF-8
// en-dash renders as mojibake unless every one of them picks the right encoding.
const label = b => b === 'dispensary' ? 'Dispensary' : b.startsWith('dsd:') ? `DSD - ${b.slice(4)}` : b.startsWith('sdp:') ? `SDP - ${b.slice(4)}` : 'Main Store'
const K = (f, c, b) => `${f}|${c}|${b}`
const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v)

try {
  // Current EnVo balance per location.
  const soh = new Map()
  for (const r of (await query(`select facility_id f, commodity_id c, location_type lt, quantity q from stock where location_type in ('store','dispensary')`)).rows) soh.set(K(r.f, r.c, r.lt), r.q)
  for (const r of (await query(`select facility_id f, commodity_id c, sdp_name s, quantity q from sdp_stock`)).rows) soh.set(K(r.f, r.c, `sdp:${r.s}`), r.q)
  for (const r of (await query(`select facility_id f, commodity_id c, dsd_site_name s, quantity q from dsd_stock`)).rows) soh.set(K(r.f, r.c, `dsd:${r.s}`), r.q)
  const storeSoh = new Map()
  for (const r of (await query(`select facility_id f, commodity_id c, quantity q from stock where location_type='store'`)).rows) storeSoh.set(`${r.f}|${r.c}`, r.q)

  // Movements per location, so a genuine paperwork gap can be told from a location
  // that has simply run down.
  const issued = new Map(), recv = new Map(), returns = new Map(), binAdj = new Map(), recorded = new Map()
  for (const r of (await query(`select facility_id f, commodity_id c, quantity, notes from dispense_log`)).rows) add(issued, K(r.f, r.c, binOf(r.notes)), r.quantity)
  for (const r of (await query(`select sending_facility_id sf, receiving_facility_id rf, commodity_id c, quantity, notes from stock_transfer_log where status='accepted'`)).rows)
    if (r.sf && (r.rf == null || r.rf === r.sf)) add(recv, K(r.sf, r.c, binOf(r.notes)), r.quantity)
  for (const r of (await query(`select facility_id f, commodity_id c, reason, quantity qty, notes from stock_adjustment_log where reason in ('Returned from Dispensary','Returned from DSD','Returned from SDP')`)).rows) {
    let bin
    if (r.reason === 'Returned from Dispensary') bin = 'dispensary'
    else { const s = /Returned from [^:]*:\s*([^—]+)/i.exec(r.notes || '')?.[1]?.trim(); if (!s) continue; bin = (r.reason === 'Returned from DSD' ? 'dsd:' : 'sdp:') + s }
    add(returns, K(r.f, r.c, bin), r.qty)
  }
  for (const r of (await query(`select facility_id f, commodity_id c, location_type lt, site_name s, sum(case when adjustment_type='Decrease' then -quantity else quantity end)::int q from stock_adjustment_log where coalesce(location_type,'store')<>'store' group by 1,2,3,4`)).rows)
    add(binAdj, K(r.f, r.c, r.lt === 'dispensary' ? 'dispensary' : `${r.lt}:${r.s}`), r.q)
  for (const r of (await query(`select facility_id f, commodity_id c, location_type lt, site_name s, quantity q from bin_opening`)).rows)
    add(recorded, K(r.f, r.c, (r.lt === 'store' || r.lt === 'dispensary') ? r.lt : `${r.lt}:${r.s}`), r.q)

  const disp = (await query(`
    select l.facility_id f, l.commodity_id c, l.quantity, l.notes, fa.name fac, cm.name comm, cm.unit
      from dispense_log l
      join facilities fa on fa.id = l.facility_id
      join commodities cm on cm.id = l.commodity_id
     where l.dispensed_at >= now() - interval '${days} days' and l.quantity > 0`)).rows

  // A location qualifies when a recent draw exceeded what it holds TODAY — i.e. the
  // next draw that size will be refused. Those records themselves already exist and
  // are not re-entered, so this is a forward-looking signal, not a count of blocked
  // work.
  const bins = new Map()
  for (const d of disp) {
    const bin = binOf(d.notes)
    const have = soh.get(K(d.f, d.c, bin)) ?? 0
    if (have >= d.quantity) continue
    const k = `${d.fac}||${d.comm}||${bin}`
    const v = bins.get(k) || { f: d.f, c: d.c, fac: d.fac, comm: d.comm, bin, unit: d.unit, have,
      store: storeSoh.get(`${d.f}|${d.c}`) ?? 0, biggest: 0 }
    v.biggest = Math.max(v.biggest, d.quantity)
    bins.set(k, v)
  }

  // opening = balance − recorded movements. 0 means the records reconcile and the
  // location has merely run down; anything else means something was never entered.
  for (const v of bins.values()) {
    const kk = K(v.f, v.c, v.bin)
    const net = (recv.get(kk) || 0) - (issued.get(kk) || 0) - (returns.get(kk) || 0) + (binAdj.get(kk) || 0) + (recorded.get(kk) || 0)
    v.opening = v.bin === 'store' ? null : v.have - net
    v.kind = v.opening === 0 || v.opening == null ? 'RESTOCK' : 'PAPERWORK'
  }

  let rows = [...bins.values()].sort((a, b) => (a.kind === b.kind ? b.biggest - a.biggest : a.kind === 'PAPERWORK' ? -1 : 1))
  if (facArg) rows = rows.filter(r => r.fac.toLowerCase().includes(facArg.toLowerCase()))
  if (gapsOnly) rows = rows.filter(r => r.kind === 'PAPERWORK')

  const gaps = rows.filter(r => r.kind === 'PAPERWORK'), restock = rows.filter(r => r.kind === 'RESTOCK')
  console.log(`\nWindow: last ${days} days — locations whose recent draws exceed what they now hold\n`)
  console.log(`  PAPERWORK MISSING : ${gaps.length}  (${gaps.reduce((s, r) => s + Math.abs(r.opening), 0)} units unexplained) — records do not reconcile`)
  console.log(`  NEEDS RESTOCKING  : ${restock.length}  — records reconcile perfectly; the location has simply run down`)
  console.log(`  facilities         : ${new Set(rows.map(r => r.fac)).size}\n`)

  if (facArg || gapsOnly) {
    console.table(rows.map(r => ({
      facility: facArg ? undefined : r.fac.slice(0, 26), location: label(r.bin), commodity: r.comm.slice(0, 26),
      here: r.have, 'in Main Store': r.bin === 'store' ? '-' : r.store, 'largest recent draw': r.biggest,
      why: r.kind === 'PAPERWORK' ? `PAPERWORK (opening ${r.opening})` : 'restock',
    })))
  } else {
    const byFac = {}
    for (const r of rows) { const v = byFac[r.fac] = byFac[r.fac] || { paperwork: 0, restock: 0 }; v[r.kind === 'PAPERWORK' ? 'paperwork' : 'restock']++ }
    console.log('Facilities with a PAPERWORK gap — these are the ones that need investigating:\n')
    console.table(Object.entries(byFac).filter(([, v]) => v.paperwork).sort((a, b) => b[1].paperwork - a[1].paperwork).slice(0, 25)
      .map(([f, v]) => ({ facility: f.slice(0, 44), 'paperwork gaps': v.paperwork, 'also low on stock': v.restock })))
  }

  const hdr = ['Facility', 'Location', 'Commodity', 'Unit', 'LocationBalance', 'MainStoreBalance', 'LargestRecentDraw', 'Issue', 'ActionNeeded']
  const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const action = r => {
    if (r.kind === 'PAPERWORK') return `Records do not reconcile (opening ${r.opening}) - a movement was never entered. Check the bin card before restocking.`
    if (r.bin === 'store') return 'Low stock - record the intake when the next delivery arrives'
    return r.store >= r.biggest - r.have
      ? 'Low stock - record a redistribution from Main Store to this location'
      : 'Low stock - the Main Store cannot cover it either; record the intake into the Main Store first'
  }
  const line = r => [r.fac, label(r.bin), r.comm, r.unit || '', r.have, r.bin === 'store' ? '' : r.store, r.biggest,
    r.kind === 'PAPERWORK' ? 'Paperwork missing' : 'Needs restocking', action(r)].map(esc).join(',')
  // Excel only detects UTF-8 from a byte-order mark; without it the file opens as
  // Windows-1252 and any non-ASCII character in a facility name is mangled.
  const BOM = '\uFEFF'

  if (csvPath) {
    fs.writeFileSync(csvPath, BOM + [hdr.join(','), ...rows.map(line)].join('\r\n'))
    console.log(`\nWrote ${rows.length} rows to ${csvPath}`)
  }

  if (splitDir) {
    fs.mkdirSync(splitDir, { recursive: true })
    const byFac = new Map()
    for (const r of rows) { const a = byFac.get(r.fac) || []; a.push(r); byFac.set(r.fac, a) }
    const used = new Set()
    for (const [fac, list] of byFac) {
      const base = fac.replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 90)
      let name = base, n = 2
      while (used.has(name.toLowerCase())) name = `${base} (${n++})`
      used.add(name.toLowerCase())
      list.sort((a, b) => (a.kind === b.kind ? b.biggest - a.biggest : a.kind === 'PAPERWORK' ? -1 : 1))
      fs.writeFileSync(`${splitDir}/${name}.csv`, BOM + [hdr.join(','), ...list.map(line)].join('\r\n'))
    }
    console.log(`\nWrote ${byFac.size} facility file(s) to ${splitDir}/`)
    console.log('Paperwork gaps are listed first in each file.')
  }

  console.log('\nEnforcement refuses a draw only when it would go below zero in EnVo.')
  console.log('Dispensing exactly the balance always passes, so a location with stock is never blocked.')
  console.log('READ-ONLY — nothing was modified.')
} catch (err) {
  console.error('Failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
