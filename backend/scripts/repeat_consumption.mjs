// READ-ONLY by default. Consumption recorded more than once for what looks like a
// single event, with the location's opening balance beside it so you can see whether
// deleting a repeat would fix a discrepancy or create one.
//
// WHY THIS HAPPENED. Before enforcement, recording consumption from a location EnVo
// showed as empty still wrote the row, but the stock stayed at 0 because the
// decrement clamped. Nothing on screen changed, so it looked as though the entry had
// failed — and it was entered again. Sometimes four times.
//
// This is the one mechanism that OVERSTATES CONSUMPTION rather than stock, so it
// inflates AMC and drives over-ordering, and it is the most likely of the four to
// have already reached a report.
//
// IDENTICAL IS NOT THE SAME AS DUPLICATE. Two Cotrimoxazole records of 30 on one day
// by one person can easily be two genuine dispensing sessions. 121 recorded four
// times in a day cannot. The repeat count and the size carry the evidence, not the
// fact of matching — so this proposes and never sweeps.
//
// AND DELETING CAN MAKE THINGS WORSE. Where a location's records currently reconcile
// (opening 0), the repeat has already been absorbed by everything around it and
// removing it will push that location out of balance — the same trap that made a
// blanket pre-receipt delete so destructive. The Effect column says which way each
// one moves its location.
//
//   cd C:\envo\app\backend
//   node scripts/repeat_consumption.mjs                        # the review list
//   node scripts/repeat_consumption.mjs --min-qty 50           # material ones only
//   node scripts/repeat_consumption.mjs --times 3              # recorded 3+ times
//   node scripts/repeat_consumption.mjs --csv repeats.csv
//   node scripts/repeat_consumption.mjs --ids <uuid,uuid> --apply    # delete NAMED rows

import { pool, query, withTransaction } from '../src/db.js'
import fs from 'node:fs'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const flag = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
const minQty = parseInt(flag('--min-qty')) || 1
const minTimes = parseInt(flag('--times')) || 2
const csvPath = flag('--csv')
const onlyIds = (flag('--ids') || '').split(',').map(x => x.trim()).filter(Boolean)
const facArg = argv.filter((a, i) => !a.startsWith('--') && !['--min-qty', '--times', '--csv', '--ids'].includes(argv[i - 1]))[0] || null

const rx = (n, t) => new RegExp(`\\[${t}:\\s*([^\\]]+)\\]`, 'i').exec(n || '')?.[1]?.trim()
const binOf = n => { const d = rx(n, 'DSD'), s = rx(n, 'SDP'); return d ? `dsd:${d}` : s ? `sdp:${s}` : 'dispensary' }
const label = b => b === 'dispensary' ? 'Dispensary' : b.startsWith('dsd:') ? `DSD - ${b.slice(4)}` : `SDP - ${b.slice(4)}`
const K = (f, c, b) => `${f}|${c}|${b}`
const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v)

try {
  // Opening balance per location, so each repeat can be judged in context.
  const soh = new Map(), issued = new Map(), recv = new Map(), returns = new Map(), binAdj = new Map(), recorded = new Map()
  for (const r of (await query(`select facility_id f, commodity_id c, quantity q from stock where location_type='dispensary'`)).rows) soh.set(K(r.f, r.c, 'dispensary'), r.q)
  for (const r of (await query(`select facility_id f, commodity_id c, sdp_name s, quantity q from sdp_stock`)).rows) soh.set(K(r.f, r.c, `sdp:${r.s}`), r.q)
  for (const r of (await query(`select facility_id f, commodity_id c, dsd_site_name s, quantity q from dsd_stock`)).rows) soh.set(K(r.f, r.c, `dsd:${r.s}`), r.q)
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
  const openingOf = k => (soh.get(k) ?? 0) - ((recv.get(k) || 0) - (issued.get(k) || 0) - (returns.get(k) || 0) + (binAdj.get(k) || 0) + (recorded.get(k) || 0))

  // Every dispense, grouped by what a single event would look like.
  const all = (await query(`
    select l.id, l.facility_id f, l.commodity_id c, l.quantity, l.dispensed_at, l.notes,
           coalesce(l.dispensed_by,'') who, fa.name fac, cm.name comm
      from dispense_log l
      join facilities fa on fa.id = l.facility_id
      join commodities cm on cm.id = l.commodity_id
     where l.quantity > 0
     order by l.dispensed_at`)).rows

  const groups = new Map()
  for (const r of all) {
    const bin = binOf(r.notes)
    const g = `${r.f}|${r.c}|${bin}|${String(r.dispensed_at).slice(0, 10)}|${r.who.trim().toLowerCase()}|${r.quantity}`
    const v = groups.get(g) || { f: r.f, c: r.c, bin, fac: r.fac, comm: r.comm, who: r.who, qty: r.quantity,
      date: String(r.dispensed_at).slice(0, 10), ids: [] }
    v.ids.push(r.id)
    groups.set(g, v)
  }

  let rows = [...groups.values()].filter(g => g.ids.length >= minTimes && g.qty >= minQty)
  if (facArg) rows = rows.filter(r => r.fac.toLowerCase().includes(facArg.toLowerCase()))
  for (const r of rows) {
    r.times = r.ids.length
    r.extra = (r.times - 1) * r.qty          // units the repeats add
    r.opening = openingOf(K(r.f, r.c, r.bin))
    // Deleting a repeat raises the location's recorded net by `extra`, so its opening
    // FALLS by that amount. Good when the opening is positive; harmful when it is 0.
    r.after = r.opening - r.extra
    r.effect = r.opening === 0 ? 'WOULD BREAK a location that currently reconciles'
      : Math.abs(r.after) < Math.abs(r.opening) ? 'improves this location' : 'makes this location worse'
    r.dropIds = r.ids.slice(1)               // keep the first, drop the repeats
  }
  rows.sort((a, b) => b.extra - a.extra)

  if (!rows.length) { console.log('\nNo repeated consumption matched.'); process.exit(0) }
  const helpful = rows.filter(r => r.effect === 'improves this location')
  console.log(`\n${rows.length} group(s) recorded ${minTimes}+ times — ${rows.reduce((s, r) => s + r.extra, 0)} units of repeated consumption`)
  console.log(`${helpful.length} of them sit in a location whose opening would IMPROVE if the repeats went.`)
  console.log(`${rows.filter(r => r.opening === 0).length} sit in a location that currently reconciles — deleting there would break it.\n`)
  console.table(rows.slice(0, 30).map(r => ({
    facility: r.fac.slice(0, 26), commodity: r.comm.slice(0, 22), location: label(r.bin).slice(0, 14),
    date: r.date, qty: r.qty, times: r.times, 'extra units': r.extra,
    opening: r.opening, 'opening after': r.after, effect: r.effect.slice(0, 34),
  })))
  if (rows.length > 30) console.log(`…and ${rows.length - 30} more (use --csv for all).`)

  if (csvPath) {
    const hdr = ['Facility', 'Location', 'Commodity', 'Date', 'Quantity', 'TimesRecorded', 'ExtraUnits', 'By', 'LocationOpening', 'OpeningIfDeleted', 'Effect', 'IdsToDelete']
    const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    fs.writeFileSync(csvPath, '\uFEFF' + [hdr.join(','), ...rows.map(r => [r.fac, label(r.bin), r.comm, r.date, r.qty, r.times, r.extra, r.who,
      r.opening, r.after, r.effect, r.dropIds.join(' ')].map(esc).join(','))].join('\r\n'))
    console.log(`\nWrote ${rows.length} rows to ${csvPath}`)
  }

  // With --ids, show exactly what those ids resolve to. Reprinting the whole list
  // tells you nothing about what you are about to delete.
  if (onlyIds.length) {
    const picked = rows.filter(r => r.dropIds.some(i => onlyIds.includes(i)))
    const unknown = onlyIds.filter(i => !rows.some(r => r.dropIds.includes(i)))
    console.log(`\n--ids selects ${picked.length} group(s):\n`)
    console.table(picked.map(r => ({
      facility: r.fac.slice(0, 30), location: label(r.bin).slice(0, 16), commodity: r.comm.slice(0, 24),
      date: r.date, qty: r.qty, 'recorded': `${r.times}x`, 'deleting': onlyIds.filter(i => r.dropIds.includes(i)).length,
      opening: r.opening, '→ after': r.after,
    })))
    if (unknown.length) console.log(`NOT deletable (not a repeat, or the first of its group): ${unknown.join(', ')}`)
  }

  if (!apply) {
    console.log('\nDRY RUN — nothing deleted. Add --apply to remove the rows above.')
    if (!onlyIds.length) {
      console.log('Take the ids from IdsToDelete — the FIRST record of each group is always kept.')
    }
    process.exit(0)
  }

  // Named rows only. A sweep would delete from the many locations that currently
  // reconcile and break every one of them.
  if (!onlyIds.length) {
    console.log('\n✗ Refusing to delete without --ids. Identical is not the same as duplicate, and')
    console.log('  removing a repeat from a location that reconciles will push it out of balance.')
    process.exitCode = 1
    process.exit(1)
  }
  const valid = new Set(rows.flatMap(r => r.dropIds))
  const target = onlyIds.filter(i => valid.has(i))
  const rejected = onlyIds.filter(i => !valid.has(i))
  if (rejected.length) console.log(`\nNot deletable (not a repeat, or the first of its group): ${rejected.join(', ')}`)
  if (!target.length) { console.log('\nNothing to delete.'); process.exit(0) }

  const full = (await query(`select * from dispense_log where id = any($1::uuid[])`, [target])).rows
  const undo = `undo_${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  fs.writeFileSync(undo, JSON.stringify({ table: 'dispense_log', deleted_at: new Date().toISOString(), rows: full }, null, 2))
  console.log(`\nUndo file written: ${undo}`)
  console.log(`Restore with:  node scripts/restore_deleted.mjs ${undo}`)

  await withTransaction(async exec => { await exec(`delete from dispense_log where id = any($1::uuid[])`, [target]) })
  console.log(`\n✓ Deleted ${target.length} repeated consumption record(s).`)
  console.log('Consumption reporting (AMC / CRRF / monitoring) for those months has changed.')
} catch (err) {
  console.error('Failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
