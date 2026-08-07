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
//   node scripts/enforcement_readiness.mjs --csv worklist.csv # per-facility worklist
//   node scripts/enforcement_readiness.mjs "Etim Ekpo"        # one facility's list

import { pool, query } from '../src/db.js'
import fs from 'node:fs'

const argv = process.argv.slice(2)
const flag = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
const days = parseInt(flag('--days')) || 14
const csvPath = flag('--csv')
const facArg = argv.filter((a, i) => !a.startsWith('--') && !['--days', '--csv'].includes(argv[i - 1]))[0] || null

const rx = (n, t) => new RegExp(`\\[${t}:\\s*([^\\]]+)\\]`, 'i').exec(n || '')?.[1]?.trim()
const binOf = n => { const d = rx(n, 'DSD'), s = rx(n, 'SDP'); return d ? `dsd:${d}` : s ? `sdp:${s}` : 'dispensary' }
const label = b => b === 'dispensary' ? 'Dispensary' : b.startsWith('dsd:') ? `DSD — ${b.slice(4)}` : b.startsWith('sdp:') ? `SDP — ${b.slice(4)}` : 'Main Store'

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

  // Group the shortfalls by location: what is there, what people tried to draw.
  const bins = new Map()
  for (const d of disp) {
    const bin = binOf(d.notes)
    const have = soh.get(K(d.f, d.c, bin)) ?? 0
    if (have >= d.quantity) continue                      // would pass
    const k = `${d.fac}||${d.comm}||${bin}`
    const v = bins.get(k) || { fac: d.fac, comm: d.comm, bin, unit: d.unit, have, refusals: 0, biggest: 0 }
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
    console.table(rows.map(r => ({ location: label(r.bin), commodity: r.comm.slice(0, 32), 'EnVo balance': r.have, 'largest draw attempted': r.biggest, 'records blocked': r.refusals })))
  } else {
    const byFac = {}
    for (const r of rows) { const v = byFac[r.fac] = byFac[r.fac] || { locations: 0, blocked: 0 }; v.locations++; v.blocked += r.refusals }
    console.log('Worst facilities — send each one its list with --csv, or run this with the facility name:\n')
    console.table(Object.entries(byFac).sort((a, b) => b[1].blocked - a[1].blocked).slice(0, 20)
      .map(([f, v]) => ({ facility: f.slice(0, 44), locations: v.locations, 'records blocked': v.blocked })))
  }

  if (csvPath) {
    const hdr = ['Facility', 'Location', 'Commodity', 'Unit', 'EnVoBalance', 'LargestDrawAttempted', 'RecordsBlocked', 'ActionNeeded']
    const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    fs.writeFileSync(csvPath, [hdr.join(','), ...rows.map(r => [r.fac, label(r.bin), r.comm, r.unit || '', r.have, r.biggest, r.refusals,
      r.bin === 'store' ? 'Record the intake that brought this stock in' : 'Record the store→location redistribution'].map(esc).join(','))].join('\r\n'))
    console.log(`\nWrote ${rows.length} rows to ${csvPath}`)
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
