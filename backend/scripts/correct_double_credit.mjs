// Correct stock that a double-credited transfer left overstated.
//
// Posts a Physical count correction (Decrease) on the affected location, through the
// same service the app uses — so it is a real, transactional movement with a reason,
// a name and a note saying which transfer was duplicated. Because the correction is
// itself a movement, the opening balance lands on 0 without any baseline.
//
// Do NOT baseline these locations. A baseline asserts "this location began with N",
// which is false here: it began with nothing and a receipt was credited twice. The
// stock figure is what is wrong, and the facility is left believing it holds double —
// the direction that causes a stockout, because nobody reorders against a healthy
// looking number.
//
// SAFETY. Defaults to the STRONG cases only: those where the stock figure last moved
// on the same day as the matching transfer. --all includes the weaker matches, which
// should be checked against the bin card first. A location whose records justify a
// NEGATIVE figure is reported and skipped: stock cannot go below zero, so it has
// another fault on top of this one and needs looking at individually.
//
//   cd C:\envo\app\backend
//   node scripts/correct_double_credit.mjs --by "Your Name"
//   node scripts/correct_double_credit.mjs --by "Your Name" --apply
//   node scripts/correct_double_credit.mjs --by "Your Name" --all --apply
//   node scripts/correct_double_credit.mjs "Ikpe Annang General" --by "Your Name" --apply

import { pool, query } from '../src/db.js'
import { LogService } from '../src/services/logService.js'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const all = argv.includes('--all')
const flag = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
const by = flag('--by')
const facArg = argv.filter((a, i) => !a.startsWith('--') && !['--by'].includes(argv[i - 1]))[0] || null

const rxn = (n, t) => new RegExp(`\\[${t}:\\s*([^\\]]+)\\]`, 'i').exec(n || '')?.[1]?.trim()
const binOf = n => { const d = rxn(n, 'DSD'), s = rxn(n, 'SDP'); return d ? `dsd:${d}` : s ? `sdp:${s}` : 'dispensary' }
const label = b => b === 'store' ? 'Main Store' : b === 'dispensary' ? 'Dispensary'
  : b.startsWith('dsd:') ? `DSD — ${b.slice(4)}` : `SDP — ${b.slice(4)}`
const K = (f, c, b) => `${f}|${c}|${b}`
const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v)

try {
  if (!by) { console.error('--by "Your Name" is required: the correction is recorded against whoever made it.'); process.exit(1) }

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
  for (const r of (await query(`select sending_facility_id sf, commodity_id c, quantity, status from stock_transfer_log`)).rows)
    if (r.sf && ['in_transit', 'dispatched', 'accepted'].includes(r.status)) add(storeOut, `${r.sf}|${r.c}`, r.quantity)
  const receipts = new Map()
  for (const r of (await query(`select id, sending_facility_id sf, receiving_facility_id rf, commodity_id c, quantity, notes, coalesce(resolved_at,initiated_at) t_at from stock_transfer_log where status='accepted'`)).rows) {
    const internal = r.sf && (r.rf == null || r.rf === r.sf)
    const k = internal ? K(r.sf, r.c, binOf(r.notes)) : (r.rf ? K(r.rf, r.c, 'store') : null)
    if (!k) continue
    const a = receipts.get(k) || []; a.push(r); receipts.set(k, a)
    if (internal) add(recv, k, r.quantity); else add(storeIn, `${r.rf}|${r.c}`, r.quantity)
  }
  for (const r of (await query(`select facility_id f, commodity_id c, location_type lt, site_name s, quantity q from bin_opening`)).rows)
    add(recorded, K(r.f, r.c, (r.lt === 'store' || r.lt === 'dispensary') ? r.lt : `${r.lt}:${r.s}`), r.q)

  const soh = new Map()
  for (const r of (await query(`select facility_id f, commodity_id c, location_type lt, quantity q, updated_at from stock where location_type in ('store','dispensary')`)).rows) soh.set(K(r.f, r.c, r.lt), { q: r.q, at: r.updated_at })
  for (const r of (await query(`select facility_id f, commodity_id c, sdp_name s, quantity q, updated_at from sdp_stock`)).rows) soh.set(K(r.f, r.c, `sdp:${r.s}`), { q: r.q, at: r.updated_at })
  for (const r of (await query(`select facility_id f, commodity_id c, dsd_site_name s, quantity q, updated_at from dsd_stock`)).rows) soh.set(K(r.f, r.c, `dsd:${r.s}`), { q: r.q, at: r.updated_at })

  const hits = [], skipped = []
  const consider = (f, c, bin, net) => {
    const s = soh.get(K(f, c, bin)); if (!s) return
    const op = s.q - net; if (op < 1) return
    const match = (receipts.get(K(f, c, bin)) || []).find(r => r.quantity === op); if (!match) return
    const sameDay = String(match.t_at).slice(0, 10) === String(s.at).slice(0, 10)
    const row = { f, c, bin, fac: facName.get(f) || f, comm: commName.get(c) || c, soh: s.q, op, net, sameDay,
      when: String(match.t_at).slice(0, 10), tid: match.id }
    // Stock cannot go below zero, so a location whose records justify a negative
    // figure has a second fault on top of the double credit. Report, do not touch.
    if (net < 0) { skipped.push({ ...row, why: `records justify ${net} — cannot decrease below zero; another fault here` }); return }
    if (!sameDay && !all) { skipped.push({ ...row, why: 'weaker match (stock moved on a different day) — use --all after checking the bin card' }); return }
    hits.push(row)
  }
  for (const k of new Set([...intakes.keys(), ...storeIn.keys(), ...adjStore.keys()])) {
    const [f, c] = k.split('|')
    consider(f, c, 'store', (intakes.get(k) || 0) + (adjStore.get(k) || 0) + (storeIn.get(k) || 0) - (storeOut.get(k) || 0) + (recorded.get(K(f, c, 'store')) || 0))
  }
  for (const kk of new Set([...recv.keys(), ...issued.keys()])) {
    const [f, c, bin] = kk.split('|')
    consider(f, c, bin, (recv.get(kk) || 0) - (issued.get(kk) || 0) - (returns.get(kk) || 0) + (binAdj.get(kk) || 0) + (recorded.get(kk) || 0))
  }
  const keep = r => !facArg || r.fac.toLowerCase().includes(facArg.toLowerCase())
  const todo = hits.filter(keep), skip = skipped.filter(keep)
  todo.sort((a, b) => b.op - a.op)

  console.log(`\n${todo.length} location(s) to correct — ${todo.reduce((s, r) => s + r.op, 0)} units of overstated stock\n`)
  if (todo.length) console.table(todo.map(r => ({
    facility: r.fac.slice(0, 30), commodity: r.comm.slice(0, 22), location: label(r.bin).slice(0, 16),
    'EnVo says': r.soh, 'decrease by': r.op, '→ leaves': r.soh - r.op, 'transfer on': r.when,
  })))
  if (skip.length) {
    console.log(`\n${skip.length} skipped — look at these individually:\n`)
    console.table(skip.map(r => ({ facility: r.fac.slice(0, 28), commodity: r.comm.slice(0, 20), location: label(r.bin).slice(0, 14), 'EnVo says': r.soh, opening: r.op, why: r.why.slice(0, 56) })))
  }
  if (!todo.length) { console.log('Nothing to correct with the current filters.'); process.exit(0) }
  if (!apply) { console.log('\nDRY RUN — re-run with --apply to post these corrections.'); process.exit(0) }

  let n = 0, failed = 0
  for (const r of todo) {
    try {
      await LogService.recordAdjustment({
        facility_id: r.f, commodity_id: r.c, quantity: r.op, adjustment_type: 'Decrease',
        reason: 'Physical count correction', adjusted_by: by,
        location_type: r.bin.startsWith('sdp:') ? 'sdp' : r.bin.startsWith('dsd:') ? 'dsd' : r.bin,
        site_name: r.bin.includes(':') ? r.bin.split(':').slice(1).join(':') : null,
        notes: `Transfer of ${r.op} accepted ${r.when} was credited twice; removing the duplicate. Stock ${r.soh} → ${r.soh - r.op}, which is what the records support.`,
      })
      n++
    } catch (e) { failed++; console.error(`  ✗ ${r.fac} — ${r.comm}: ${e.message}`) }
  }
  console.log(`\n✓ Posted ${n} correction(s)${failed ? `, ${failed} failed` : ''}.`)
  console.log('Each is a Physical count correction on its location, with a note naming the transfer.')
  console.log('Re-run audit_opening_balances.mjs — these locations should now read 0.')
} catch (err) {
  console.error('Failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
