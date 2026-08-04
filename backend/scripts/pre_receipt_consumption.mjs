// Consumption recorded BEFORE the bin ever received anything.
//
// A bin cannot issue stock it never got. Where a dispense predates the bin's first
// receipt, the records show more leaving than ever arrived, and the bin card absorbs
// the difference as a positive opening balance (Ikot Ebok's dispensary opens at +473
// on exactly this pattern).
//
// First receipt per bin:
//   store               earliest intake, or external transfer in (accepted)
//   dispensary / site   earliest internal redistribution INTO that bin (accepted)
//
// READ THIS BEFORE --apply. A pre-receipt dispense means one of two things and the
// script cannot tell them apart:
//   1. Training or go-live data entered before the facility was live — deleting is
//      correct, the event never happened.
//   2. The facility genuinely held stock at go-live and really did dispense it. Then
//      the consumption is REAL and what is missing is an opening balance, not the
//      dispense. Deleting it erases real consumption and understates AMC for that
//      period.
// The gap column helps: a dispense weeks before the first receipt, or one dated
// before the facility went live, reads as (1). One a day or two before a receipt
// that plainly restocked it reads as (2).
//
// Deleting dispenses CHANGES CONSUMPTION REPORTING — AMC, CRRF and monitoring for
// those months will move. Back up first: node scripts/backup_tables.mjs
//
//   node scripts/pre_receipt_consumption.mjs                      # dry run, all bins
//   node scripts/pre_receipt_consumption.mjs "Ikot Ebok"          # one facility
//   node scripts/pre_receipt_consumption.mjs --before 2026-07-01  # only before go-live
//   node scripts/pre_receipt_consumption.mjs --csv pre.csv        # rows to CSV
//   node scripts/pre_receipt_consumption.mjs --apply              # DELETE them

import { pool, query, withTransaction } from '../src/db.js'
import fs from 'node:fs'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const flag = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
const csvPath = flag('--csv')
const before = flag('--before')          // extra safety: only rows dated before this
const facArg = argv.filter((a, i) => !a.startsWith('--') && !['--csv', '--before'].includes(argv[i - 1]))[0] || null
const d = v => (v ? new Date(v).toISOString().slice(0, 10) : '')
const TAG = `case when notes ~* '\\[SDP:' then 'sdp:'||btrim(substring(notes from '\\[SDP:\\s*([^\\]]+)\\]'))
                  when notes ~* '\\[DSD:' then 'dsd:'||btrim(substring(notes from '\\[DSD:\\s*([^\\]]+)\\]'))
                  else 'dispensary' end`

try {
  const facName = new Map((await query(`select id, name from facilities`)).rows.map(r => [r.id, r.name]))
  const commName = new Map((await query(`select id, name from commodities`)).rows.map(r => [r.id, r.name]))
  const key = (...a) => a.join('|')

  // First receipt per bin.
  const firstRecv = new Map()
  const note = (m, k, t) => { if (!t) return; const p = m.get(k); if (!p || new Date(t) < new Date(p)) m.set(k, t) }
  for (const r of (await query(`select facility_id f, commodity_id c, min(received_at) t from intake_log group by 1,2`)).rows)
    note(firstRecv, key(r.f, r.c, 'store'), r.t)
  for (const r of (await query(`
    select sending_facility_id sf, receiving_facility_id rf, commodity_id c,
           coalesce(resolved_at, initiated_at) t, ${TAG} dest
      from stock_transfer_log where status='accepted'`)).rows) {
    const internal = r.sf && (r.rf == null || r.rf === r.sf)
    if (internal) note(firstRecv, key(r.sf, r.c, r.dest), r.t)          // dispensary/site receipt
    else if (r.rf) note(firstRecv, key(r.rf, r.c, 'store'), r.t)        // store receipt
  }

  // Every dispense, with the bin it came out of.
  const rows = (await query(`
    select l.id, l.facility_id f, l.commodity_id c, l.quantity, l.dispensed_at t,
           coalesce(l.dispensed_by,'') who, coalesce(l.notes,'') notes, ${TAG.replace(/notes/g, 'l.notes')} bin
      from dispense_log l`)).rows

  const hits = []
  for (const r of rows) {
    const recv = firstRecv.get(key(r.f, r.c, r.bin))
    // No receipt at all, or the dispense predates it.
    if (recv && new Date(r.t) >= new Date(recv)) continue
    if (before && new Date(r.t) >= new Date(before)) continue
    if (facArg && !(facName.get(r.f) || '').toLowerCase().includes(facArg.toLowerCase())) continue
    hits.push({
      id: r.id, facility: facName.get(r.f) || r.f, commodity: commName.get(r.c) || r.c, bin: r.bin,
      dispensed: d(r.t), qty: r.quantity, by: r.who,
      first_receipt: recv ? d(recv) : 'NEVER RECEIVED',
      days_before: recv ? Math.round((new Date(recv) - new Date(r.t)) / 86400000) : null,
    })
  }
  hits.sort((a, b) => b.qty - a.qty)

  if (!hits.length) { console.log('\nNo consumption predates its bin\'s first receipt.'); process.exit(0) }

  const bins = new Set(hits.map(h => `${h.facility}|${h.commodity}|${h.bin}`))
  console.log(`\n${hits.length} dispense row(s) recorded before their bin ever received stock`)
  console.log(`across ${bins.size} bin(s) and ${new Set(hits.map(h => h.facility)).size} facilities, ${hits.reduce((s, h) => s + h.qty, 0)} units.\n`)
  console.table(hits.slice(0, 50))
  if (hits.length > 50) console.log(`…and ${hits.length - 50} more (use --csv for all).`)

  const never = hits.filter(h => h.first_receipt === 'NEVER RECEIVED')
  console.log(`\n${never.length} of these are in bins that have NEVER received anything — those cannot be real.`)
  const far = hits.filter(h => h.days_before != null && h.days_before > 7)
  console.log(`${far.length} predate the first receipt by more than a week (reads as training/go-live data).`)
  const near = hits.filter(h => h.days_before != null && h.days_before <= 7)
  console.log(`${near.length} fall within a week of it — check these individually: the facility may genuinely`)
  console.log(`have held stock at go-live, in which case the consumption is REAL and an opening`)
  console.log(`balance is what is missing (record one with fix_opening_balance.mjs instead).`)

  if (csvPath) {
    const hdr = ['Id', 'Facility', 'Commodity', 'Bin', 'Dispensed', 'Qty', 'By', 'FirstReceipt', 'DaysBefore']
    const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    fs.writeFileSync(csvPath, [hdr.join(','), ...hits.map(h => [h.id, h.facility, h.commodity, h.bin, h.dispensed, h.qty, h.by, h.first_receipt, h.days_before].map(esc).join(','))].join('\r\n'))
    console.log(`\nWrote ${hits.length} rows to ${csvPath}`)
  }

  if (!apply) { console.log('\nDRY RUN — nothing deleted. Re-run with --apply once you have reviewed the rows.'); process.exit(0) }

  console.log('\nDeleting. Stock on hand is NOT changed — only the impossible records go.')
  await withTransaction(async exec => {
    await exec(`delete from dispense_log where id = any($1::uuid[])`, [hits.map(h => h.id)])
  })
  console.log(`✓ Deleted ${hits.length} dispense row(s). Re-run audit_opening_balances.mjs to see the effect.`)
  console.log('Consumption reporting (AMC / CRRF / monitoring) for those months has changed.')
} catch (err) {
  console.error('Failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
