// READ-ONLY. Which stock locations would refuse consumption once ENFORCE_BIN_STOCK
// is on, and what each store manager needs to record to clear it.
//
// Enforcement refuses a dispense only when it would take a location BELOW ZERO in
// EnVo. Dispensing exactly the balance always passes. So every row here is a place
// where staff have been recording more consumption than the location's EnVo balance
// supports — the paperwork that would justify it (an intake, or a store→location
// redistribution) has not been entered.
//
// Nothing here is a claim about the physical shelf. It is purely EnVo's numbers.
//
// Run it before enabling enforcement to size the impact and hand each facility its
// list; run it again afterwards to watch the number fall.
//
//   cd C:\envo\app\backend
//   node scripts/enforcement_readiness.mjs                    # summary + worst facilities
//   node scripts/enforcement_readiness.mjs --days 30          # wider window (default 14)
//   node scripts/enforcement_readiness.mjs --csv worklist.csv # one file, whole network
//   node scripts/enforcement_readiness.mjs --split worklists  # ONE FILE PER FACILITY
//   node scripts/enforcement_readiness.mjs "Etim Ekpo"        # one facility's list

import { pool, query } from '../src/db.js'
import fs from 'node:fs'

const argv = process.argv.slice(2)
const flag = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
const days = parseInt(flag('--days')) || 14
const csvPath = flag('--csv')
const splitDir = flag('--split')
const facArg = argv.filter((a, i) => !a.startsWith('--') && !['--days', '--csv', '--split'].includes(argv[i - 1]))[0] || null

const rx = (n, t) => new RegExp(`\\[${t}:\\s*([^\\]]+)\\]`, 'i').exec(n || '')?.[1]?.trim()
const binOf = n => { const d = rx(n, 'DSD'), s = rx(n, 'SDP'); return d ? `dsd:${d}` : s ? `sdp:${s}` : 'dispensary' }
// ASCII only: these files are opened in Excel by 218 store managers, and a UTF-8
// en-dash renders as mojibake unless every one of them picks the right encoding.
const label = b => b === 'dispensary' ? 'Dispensary' : b.startsWith('dsd:') ? `DSD - ${b.slice(4)}` : b.startsWith('sdp:') ? `SDP - ${b.slice(4)}` : 'Main Store'

try {
  // Current EnVo balance per location.
  const soh = new Map()
  const K = (f, c, b) => `${f}|${c}|${b}`
  for (const r of (await query(`select facility_id f, commodity_id c, location_type lt, quantity q from stock where location_type in ('store','dispensary')`)).rows)
    soh.set(K(r.f, r.c, r.lt), r.q)
  for (const r of (await query(`select facility_id f, commodity_id c, sdp_name s, quantity q from sdp_stock`)).rows) soh.set(K(r.f, r.c, `sdp:${r.s}`), r.q)
  for (const r of (await query(`select facility_id f, commodity_id c, dsd_site_name s, quantity q from dsd_stock`)).rows) soh.set(K(r.f, r.c, `dsd:${r.s}`), r.q)

  const disp = (await query(`
    select l.facility_id f, l.commodity_id c, l.quantity, l.notes, fa.name fac, cm.name comm, cm.unit
      from dispense_log l
      join facilities fa on fa.id = l.facility_id
      join commodities cm on cm.id = l.commodity_id
     where l.dispensed_at >= now() - interval '${days} days' and l.quantity > 0`)).rows

  // The store's balance for the same commodity. A site can only be restocked from
  // its store, so where the store cannot cover the gap either, recording the
  // redistribution is not the fix — it will be refused (the transfer path checks the
  // store and throws 409). The missing record is further up: the intake that brought
  // the stock into the facility. 405 of 950 blocked locations are in that position.
  const storeSoh = new Map()
  for (const r of (await query(`select facility_id f, commodity_id c, quantity q from stock where location_type='store'`)).rows)
    storeSoh.set(`${r.f}|${r.c}`, r.q)

  // Group the shortfalls by location: what is there, what people tried to draw.
  const bins = new Map()
  for (const d of disp) {
    const bin = binOf(d.notes)
    const have = soh.get(K(d.f, d.c, bin)) ?? 0
    if (have >= d.quantity) continue                      // would pass
    const k = `${d.fac}||${d.comm}||${bin}`
    const v = bins.get(k) || { fac: d.fac, comm: d.comm, bin, unit: d.unit, have, refusals: 0, biggest: 0,
      store: storeSoh.get(`${d.f}|${d.c}`) ?? 0 }
    v.refusals++; v.biggest = Math.max(v.biggest, d.quantity)
    bins.set(k, v)
  }

  let rows = [...bins.values()].sort((a, b) => b.refusals - a.refusals)
  if (facArg) rows = rows.filter(r => r.fac.toLowerCase().includes(facArg.toLowerCase()))

  const totalDisp = facArg ? disp.filter(d => d.fac.toLowerCase().includes(facArg.toLowerCase())).length : disp.length
  const totalRef = rows.reduce((s, r) => s + r.refusals, 0)
  console.log(`\nWindow: last ${days} days`)
  console.log(`consumption records          : ${totalDisp}`)
  console.log(`would be refused             : ${totalRef}${totalDisp ? `  (${(totalRef / totalDisp * 100).toFixed(1)}%)` : ''}`)
  console.log(`locations needing paperwork  : ${rows.length}`)
  console.log(`facilities involved          : ${new Set(rows.map(r => r.fac)).size}\n`)

  if (facArg) {
    console.log(`${rows.length ? rows[0].fac : facArg} — record a redistribution (or intake) into these locations:\n`)
    console.table(rows.map(r => ({ location: label(r.bin), commodity: r.comm.slice(0, 28), 'here': r.have, 'in Main Store': r.bin === 'store' ? '—' : r.store,
      'largest draw': r.biggest, blocked: r.refusals, 'intake needed first': r.bin !== 'store' && r.store < (r.biggest - r.have) ? 'YES' : '' })))
  } else {
    const byFac = {}
    for (const r of rows) { const v = byFac[r.fac] = byFac[r.fac] || { locations: 0, blocked: 0 }; v.locations++; v.blocked += r.refusals }
    console.log('Worst facilities — send each one its list with --csv, or run this with the facility name:\n')
    console.table(Object.entries(byFac).sort((a, b) => b[1].blocked - a[1].blocked).slice(0, 20)
      .map(([f, v]) => ({ facility: f.slice(0, 44), locations: v.locations, 'records blocked': v.blocked })))
  }

  const hdr = ['Facility', 'Location', 'Commodity', 'Unit', 'LocationBalance', 'MainStoreBalance', 'LargestDrawAttempted', 'RecordsBlocked', 'ActionNeeded']
  const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  // Two different instructions, and sending the wrong one wastes a store manager's
  // time: a redistribution out of a store that cannot cover it is refused outright.
  const action = r => r.bin === 'store' ? 'Record the intake that brought this stock in'
    : (r.store >= r.biggest - r.have)
      ? 'Record the redistribution from Main Store to this location'
      : 'FIRST record the intake into the Main Store, THEN the redistribution to this location (the Main Store cannot cover this yet)'
  const line = r => [r.fac, label(r.bin), r.comm, r.unit || '', r.have, r.store, r.biggest, r.refusals, action(r)].map(esc).join(',')

  // Excel only detects UTF-8 from a byte-order mark. Without it the file opens as
  // Windows-1252 and every non-ASCII character is mangled — which is how a store
  // manager ends up reading "storeâ€ 'location" where an instruction should be.
  const BOM = '﻿'

  if (csvPath) {
    fs.writeFileSync(csvPath, BOM + [hdr.join(','), ...rows.map(line)].join('\r\n'))
    console.log(`\nWrote ${rows.length} rows to ${csvPath}`)
  }

  // One file per facility. A single 1,000-row sheet is not actionable when ~218
  // different store managers each need only their own handful of lines; this is a
  // folder you can attach from.
  if (splitDir) {
    fs.mkdirSync(splitDir, { recursive: true })
    const byFac = new Map()
    for (const r of rows) { const a = byFac.get(r.fac) || []; a.push(r); byFac.set(r.fac, a) }
    // Windows-safe filename; keep it recognisable so the right sheet reaches the
    // right person. Collisions get a counter rather than silently overwriting.
    const used = new Set()
    for (const [fac, list] of byFac) {
      let base = fac.replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 90)
      let name = base; let n = 2
      while (used.has(name.toLowerCase())) name = `${base} (${n++})`
      used.add(name.toLowerCase())
      list.sort((a, b) => b.refusals - a.refusals)
      fs.writeFileSync(`${splitDir}/${name}.csv`, BOM + [hdr.join(','), ...list.map(line)].join('\r\n'))
    }
    console.log(`\nWrote ${byFac.size} facility file(s) to ${splitDir}/`)
    console.log('Each contains only that facility\'s locations, worst first.')
  }
  console.log('\nEnforcement refuses a draw only when it would go below zero in EnVo.')
  console.log('Dispensing exactly the balance always passes.')
  console.log('READ-ONLY — nothing was modified.')
} catch (err) {
  console.error('Failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
