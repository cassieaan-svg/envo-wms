// READ-ONLY. The same ledger dump diagnose_phantom_openings.mjs prints — every
// record behind a bin with a running net — but for ANY bin you name, not only the
// store bins currently at SOH 0.
//
// diagnose_phantom_openings.mjs is deliberately scoped to store bins at SOH 0 (see
// its own header): that pattern isolates itself, since a bin sitting at 0 with a
// negative record net has nothing else going on to muddy the read. A commodity with
// real stock and years of activity can carry the exact same defect — outflows the
// ledger records exceeding inflows — it's just buried under everything since. This
// is that same read, generalised: no SOH filter, and a --bin dispensary mode, so it
// works on NIMR's TDF/3TC (store net can reconcile fine while the dispensary — where
// dispense_log actually draws from — is where the gap lives) as readily as on a bin
// sitting at zero.
//
//   cd C:\envo\app\backend
//   node scripts/explain_bin_ledger.mjs --facility "Nigerian Institute" --commodity "TDF/3TC 300/300mg"
//   node scripts/explain_bin_ledger.mjs --facility "..." --commodity "..." --bin dispensary
//   node scripts/explain_bin_ledger.mjs --facility "..." --commodity "..." --csv out.csv
//
// Partial, case-insensitive match on facility/commodity, matching
// diagnose_phantom_openings.mjs's own behaviour.
//
// --bin store (default): matches diagnose_phantom_openings.mjs exactly — intake,
//   every adjustment (adjustments have no bin column of their own before the
//   location_type backfill, so they belong to the store), and every transfer in/out
//   EXCEPT internal store-self redistribution, which is store OUTFLOW here — the
//   store handed it to the dispensary/DSD/SDP, it didn't leave the facility.
// --bin dispensary: mirrors binCardService.js's _dispensaryRows exactly — Received =
//   internal store→dispensary redistribution (untagged, i.e. not sent on to a DSD/SDP
//   site); Issued = dispensing not tagged [DSD:]/[SDP:], PLUS "Returned from
//   Dispensary" adjustments (those credit the STORE, so they must leave HERE or this
//   bin looks short by exactly the returned amount); Adjustment = stock_adjustment_log
//   rows recorded with location_type='dispensary' specifically.

import { pool, query } from '../src/db.js'
import fs from 'node:fs'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined
}
const FAC = flag('facility')
const COMM = flag('commodity')
const BIN = flag('bin') || 'store'
const SITE = flag('site')
const csvPath = flag('csv')

if (!FAC || !COMM || !['store', 'dispensary', 'dsd', 'sdp'].includes(BIN) || (['dsd', 'sdp'].includes(BIN) && !SITE)) {
  console.error('Usage: node scripts/explain_bin_ledger.mjs --facility "<partial name>" --commodity "<partial name>" [--bin store|dispensary|dsd|sdp] [--site "<exact DSD/SDP site name>"] [--csv out.csv]')
  process.exitCode = 1
} else {
  main()
}

const OUT_STATUSES = `('in_transit','dispatched','accepted')`
const isSiteTagged = notes => /\[(DSD|SDP):/i.test(notes || '')
const d = v => (v ? new Date(v).toISOString().slice(0, 10) : '')

async function storeRows(p) {
  return [
    ...(await query(`select id, received_at t, 'INTAKE' kind, quantity qty, coalesce(supplier_source,'') ref, coalesce(received_by,'') who, coalesce(notes,'') notes from intake_log where facility_id=$1 and commodity_id=$2`, p)).rows.map(r => ({ ...r, delta: r.qty })),
    ...(await query(`select id, adjusted_at t, 'ADJ ('||adjustment_type||')' kind, quantity qty, coalesce(reason,'') ref, coalesce(adjusted_by,'') who, coalesce(notes,'') notes, adjustment_type from stock_adjustment_log where facility_id=$1 and commodity_id=$2`, p)).rows.map(r => ({ ...r, delta: r.adjustment_type === 'Decrease' ? -r.qty : r.qty })),
    ...(await query(`select id, coalesce(resolved_at, initiated_at) t, 'TRANSFER OUT' kind, quantity qty, status ref, coalesce(initiated_by,'') who, coalesce(notes,'') notes from stock_transfer_log where sending_facility_id=$1 and commodity_id=$2 and status in ${OUT_STATUSES}`, p)).rows.map(r => ({ ...r, delta: -r.qty })),
    ...(await query(`select id, coalesce(resolved_at, initiated_at) t, 'TRANSFER IN' kind, quantity qty, status ref, coalesce(initiated_by,'') who, coalesce(notes,'') notes from stock_transfer_log where receiving_facility_id=$1 and commodity_id=$2 and status='accepted' and sending_facility_id is distinct from $1`, p)).rows.map(r => ({ ...r, delta: r.qty })),
  ]
}

async function dispensaryRows(p) {
  const internal = (await query(
    `select id, quantity, status, resolved_at, initiated_at, resolved_by, notes
       from stock_transfer_log
      where commodity_id=$2 and sending_facility_id=$1
        and (receiving_facility_id is null or receiving_facility_id=$1)`, p)).rows
    .filter(r => r.status === 'accepted')

  const dispenses = (await query(
    `select id, dispensed_at t, quantity, dispensed_to, dispensed_by, notes
       from dispense_log where facility_id=$1 and commodity_id=$2`, p)).rows

  const returned = (await query(
    `select id, adjusted_at t, quantity, reference_number, adjusted_by, notes
       from stock_adjustment_log
      where facility_id=$1 and commodity_id=$2 and reason='Returned from Dispensary'`, p)).rows

  const adj = (await query(
    `select id, adjusted_at t, quantity, adjustment_type, coalesce(reason,'') reason, adjusted_by, notes
       from stock_adjustment_log
      where facility_id=$1 and commodity_id=$2 and location_type='dispensary'`, p)).rows

  return [
    ...internal.filter(r => !isSiteTagged(r.notes)).map(r => ({
      id: r.id, t: r.resolved_at || r.initiated_at, kind: 'TRANSFER IN (from store)',
      delta: r.quantity, ref: r.status, who: r.resolved_by || '', notes: r.notes || '' })),
    ...dispenses.filter(r => !isSiteTagged(r.notes)).map(r => ({
      id: r.id, t: r.t, kind: 'DISPENSE', delta: -r.quantity, ref: r.dispensed_to || '', who: r.dispensed_by || '', notes: r.notes || '' })),
    ...returned.map(r => ({
      id: r.id, t: r.t, kind: 'RETURNED TO STORE', delta: -r.quantity,
      ref: r.reference_number || '', who: r.adjusted_by || '', notes: r.notes || '' })),
    ...adj.map(r => ({
      id: r.id, t: r.t, kind: `ADJ (${r.adjustment_type})`, delta: r.adjustment_type === 'Decrease' ? -r.quantity : r.quantity,
      ref: r.reason, who: r.adjusted_by || '', notes: r.notes || '' })),
  ]
}

async function siteRows(facilityId, commodityId, tag, site) {
  const rx = (notes, t) => new RegExp(`\\[${t}:\\s*([^\\]]+)\\]`, 'i').exec(notes || '')?.[1]?.trim()
  const tagMatches = (notes) => { const v = rx(notes, tag); return v != null && v.toLowerCase() === site.trim().toLowerCase() }
  const returnSite = notes => /Returned from [^:]*:\s*([^—]+)/i.exec(notes || '')?.[1]?.trim() || null

  const p = [facilityId, commodityId]
  const internal = (await query(
    `select id, quantity, status, resolved_at, initiated_at, resolved_by, notes
       from stock_transfer_log
      where commodity_id=$2 and sending_facility_id=$1
        and (receiving_facility_id is null or receiving_facility_id=$1)`, p)).rows
    .filter(r => r.status === 'accepted' && tagMatches(r.notes))

  const dispenses = (await query(
    `select id, dispensed_at t, quantity, dispensed_to, dispensed_by, notes
       from dispense_log where facility_id=$1 and commodity_id=$2`, p)).rows
    .filter(r => tagMatches(r.notes))

  const returned = (await query(
    `select id, adjusted_at t, quantity, reference_number, adjusted_by, notes
       from stock_adjustment_log
      where facility_id=$1 and commodity_id=$2 and reason in ('Returned from DSD','Returned from SDP')`, p)).rows
    .filter(r => { const rs = returnSite(r.notes); return rs && rs.toLowerCase() === site.trim().toLowerCase() })

  const adj = (await query(
    `select id, adjusted_at t, quantity, adjustment_type, coalesce(reason,'') reason, adjusted_by, notes
       from stock_adjustment_log
      where facility_id=$1 and commodity_id=$2 and location_type=$3
        and lower(btrim(coalesce(site_name,''))) = lower(btrim($4))`, [...p, tag.toLowerCase(), site])).rows

  return [
    ...internal.map(r => ({ id: r.id, t: r.resolved_at || r.initiated_at, kind: `TRANSFER IN (from store, ${tag}:${site})`,
      delta: r.quantity, ref: r.status, who: r.resolved_by || '', notes: r.notes || '' })),
    ...dispenses.map(r => ({ id: r.id, t: r.t, kind: 'DISPENSE', delta: -r.quantity, ref: r.dispensed_to || '', who: r.dispensed_by || '', notes: r.notes || '' })),
    ...returned.map(r => ({ id: r.id, t: r.t, kind: 'RETURNED TO STORE', delta: -r.quantity,
      ref: r.reference_number || '', who: r.adjusted_by || '', notes: r.notes || '' })),
    ...adj.map(r => ({ id: r.id, t: r.t, kind: `ADJ (${r.adjustment_type})`, delta: r.adjustment_type === 'Decrease' ? -r.quantity : r.quantity,
      ref: r.reason, who: r.adjusted_by || '', notes: r.notes || '' })),
  ]
}

async function main() {
  try {
    const table = BIN === 'dsd' ? 'dsd_stock' : BIN === 'sdp' ? 'sdp_stock' : 'stock'
    const siteCol = BIN === 'dsd' ? 'dsd_site_name' : BIN === 'sdp' ? 'sdp_name' : null
    const siteCond = siteCol ? ` and lower(btrim(${siteCol})) = lower(btrim($3))` : ` and location_type = $3`
    const params = siteCol ? [`%${FAC}%`, `%${COMM}%`, SITE] : [`%${FAC}%`, `%${COMM}%`, BIN]

    const bins = (await query(`
      select s.facility_id, s.commodity_id, f.name facility, cm.name commodity, s.quantity soh
        from ${table} s
        join facilities  f  on f.id = s.facility_id
        join commodities cm on cm.id = s.commodity_id
       where f.name ilike $1 and cm.name ilike $2${siteCond}`,
      params)).rows

    const label = siteCol ? `${BIN}:${SITE}` : BIN
    if (!bins.length) { console.log(`\nNo matching ${label} bin — check the facility/commodity/site spelling (site names must match exactly, unlike facility/commodity).`); return }
    if (bins.length > 1) {
      console.log(`\n${bins.length} matches — narrow --facility/--commodity to one:\n`)
      console.table(bins.map(b => ({ facility: b.facility, commodity: b.commodity, SOH: b.soh })))
      return
    }

    const b = bins[0]
    const p = [b.facility_id, b.commodity_id]
    const rows = (
      BIN === 'dispensary' ? await dispensaryRows(p)
      : (BIN === 'dsd' || BIN === 'sdp') ? await siteRows(b.facility_id, b.commodity_id, BIN.toUpperCase(), SITE)
      : await storeRows(p)
    ).sort((x, y) => new Date(x.t) - new Date(y.t))

    const recordNet = rows.reduce((s, r) => s + r.delta, 0)
    const opening = b.soh - recordNet

    console.log(`\n${b.facility} — ${b.commodity}  [${label} bin]   SOH ${b.soh}, record net ${recordNet}, implied opening ${opening}`)
    console.log(`(${rows.length} records, ${rows[0] ? d(rows[0].t) : '-'} .. ${rows.length ? d(rows[rows.length - 1].t) : '-'})\n`)

    let run = 0
    const detail = []
    console.table(rows.map(r => {
      run += r.delta
      detail.push({ id: r.id, date: d(r.t), kind: r.kind, delta: r.delta, running: run, reason: r.ref, by: r.who, notes: r.notes })
      return { id8: (r.id || '').slice(0, 8), date: d(r.t), kind: r.kind, delta: r.delta, running: run, reason: (r.ref || '').slice(0, 22), by: r.who, notes: (r.notes || '').slice(0, 30) }
    }))

    // Same tell diagnose_phantom_openings.mjs looks for: repeated count-style
    // decreases, usually one shelf counted more than once as a fresh delta each time.
    const counts = rows.filter(r => /count/i.test(r.ref) && r.delta < 0)
    if (counts.length > 1) {
      console.log(`\n⚠ ${counts.length} count-style DECREASES totalling ${counts.reduce((s, r) => s + r.delta, 0)} — ` +
                  `check whether these are the same shelf entered repeatedly as a delta rather than distinct losses.`)
      const byDay = {}
      for (const r of counts) (byDay[d(r.t)] = byDay[d(r.t)] || []).push(r)
      const extras = Object.values(byDay).filter(v => v.length > 1).flatMap(v => v.slice(1))
      if (extras.length) {
        console.log(`  same-day repeats; candidate ids (${extras.reduce((s, r) => s + r.delta, 0)} units):`)
        console.log(`    ${extras.map(r => r.id).join(',')}`)
      }
    }

    if (opening !== 0) {
      console.log(`\nImplied opening = ${opening}: the record net doesn't reconcile with current SOH. If it's negative, more`)
      console.log(`outflow is recorded than inflow can account for; if positive, stock exists that no record explains.`)
      console.log(`fix_opening_balance.mjs and opening_balance_plan.mjs are the next step once a specific bad entry, or`)
      console.log(`a real unrecorded baseline, is identified from the table above — this script only explains.`)
    } else {
      console.log(`\nOpening = 0 — this bin's ledger reconciles with its current stock.`)
    }

    if (csvPath) {
      const hdr = ['Id', 'Date', 'Kind', 'Delta', 'Running', 'Reason', 'By', 'Notes']
      const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
      fs.writeFileSync(csvPath, [hdr.join(','), ...detail.map(r => [r.id, r.date, r.kind, r.delta, r.running, r.reason, r.by, r.notes].map(esc).join(','))].join('\r\n'))
      console.log(`\nWrote ${detail.length} detail rows to ${csvPath}`)
    }
    console.log('\nREAD-ONLY — nothing was modified.')
  } finally {
    await pool.end()
  }
}
