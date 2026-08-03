// Read-only diagnostic for a bin card's opening balance. Dumps every raw movement
// for one facility + commodity (intakes, adjustments, dispenses, and transfers WITH
// their status), the current aggregate stock per bin, and reconciles the two — so
// you can see exactly what the bin card's opening-balance "plug" is absorbing.
//
// The bin card only counts transfers with status 'accepted', but a DISPATCHED
// transfer already decremented the sender's store, so an outbound transfer stuck
// in-transit/disputed removes stock without a row → a negative opening. This script
// flags those, and any consumption recorded before the first inflow.
//
//   cd C:\envo\app\backend
//   node scripts/bincard_diagnose.mjs "Ekpene Obom" "Alere Determine"

import { pool, query } from '../src/db.js'

const [facArg, commArg] = process.argv.slice(2)
if (!facArg || !commArg) { console.error('Usage: node scripts/bincard_diagnose.mjs "<facility name>" "<commodity name>"'); process.exit(1) }
const d = v => v ? new Date(v).toISOString().slice(0, 10) : '—'
const tag = (notes, t) => (new RegExp(`\\[${t}:\\s*([^\\]]+)\\]`, 'i').exec(notes || '')?.[1] || '').trim()
const site = notes => tag(notes, 'SDP') || tag(notes, 'DSD') || (/\[Internal:/i.test(notes || '') ? 'Dispensary' : '')

try {
  const fac = (await query(`select id, name from facilities where name ilike $1 order by name`, [`%${facArg}%`])).rows
  const comm = (await query(`select id, name, unit from commodities where name ilike $1 order by name`, [`%${commArg}%`])).rows
  if (fac.length !== 1) { console.log('Facility match is not unique — be more specific:', fac.map(f => f.name)); process.exit(1) }
  if (comm.length !== 1) { console.log('Commodity match is not unique — be more specific:', comm.map(c => c.name)); process.exit(1) }
  const F = fac[0].id, C = comm[0].id
  console.log(`\n═══ ${fac[0].name}  ·  ${comm[0].name} (${comm[0].unit || ''}) ═══\n`)

  // Current aggregate stock, per bin
  const store = (await query(`select location_type, quantity from stock where facility_id=$1 and commodity_id=$2`, [F, C])).rows
  const sdp   = (await query(`select sdp_name site, quantity from sdp_stock where facility_id=$1 and commodity_id=$2`, [F, C])).rows
  const dsd   = (await query(`select dsd_site_name site, quantity from dsd_stock where facility_id=$1 and commodity_id=$2`, [F, C])).rows
  console.log('── Current stock on hand (aggregate tables) ──')
  console.table([
    ...store.map(r => ({ bin: r.location_type, qty: r.quantity })),
    ...sdp.map(r => ({ bin: `sdp: ${r.site}`, qty: r.quantity })),
    ...dsd.map(r => ({ bin: `dsd: ${r.site}`, qty: r.quantity })),
  ])

  const intakes = (await query(`select received_at t, quantity q, batch_number b from intake_log where facility_id=$1 and commodity_id=$2 order by received_at`, [F, C])).rows
  const adjs    = (await query(`select adjusted_at t, adjustment_type ty, quantity q, reason from stock_adjustment_log where facility_id=$1 and commodity_id=$2 order by adjusted_at`, [F, C])).rows
  const disps   = (await query(`select dispensed_at t, quantity q, notes from dispense_log where facility_id=$1 and commodity_id=$2 order by dispensed_at`, [F, C])).rows
  const xfers   = (await query(`select coalesce(resolved_at, initiated_at) t, sending_facility_id sf, sending_facility_name sn,
                                       receiving_facility_id rf, receiving_facility_name rn, quantity q, status, notes
                                  from stock_transfer_log where commodity_id=$2 and (sending_facility_id=$1 or receiving_facility_id=$1)
                                 order by coalesce(resolved_at, initiated_at)`, [F, C])).rows

  console.log('\n── Intakes ──');    console.table(intakes.length ? intakes.map(r => ({ date: d(r.t), received: r.q, batch: r.b || '' })) : [{ note: 'none' }])
  console.log('── Adjustments ──');  console.table(adjs.length ? adjs.map(r => ({ date: d(r.t), type: r.ty, qty: r.q, reason: r.reason || '' })) : [{ note: 'none' }])
  console.log('── Consumption (dispense_log) ──'); console.table(disps.length ? disps.map(r => ({ date: d(r.t), issued: r.q, site: site(r.notes) || 'dispensary/store', note: (r.notes || '').slice(0, 40) })) : [{ note: 'none' }])
  console.log('── Transfers touching this facility (ALL statuses) ──')
  console.table(xfers.length ? xfers.map(r => ({
    date: d(r.t),
    direction: r.sf === F && (r.rf == null || r.rf === F) ? `internal → ${site(r.notes) || 'site'}` : r.sf === F ? `OUT → ${r.rn || '—'}` : `IN ← ${r.sn || '—'}`,
    qty: r.q, status: r.status,
  })) : [{ note: 'none' }])

  // Reconcile the STORE the way the bin card does (accepted transfers only) vs actual SOH.
  const storeSoh = store.find(r => r.location_type === 'store')?.quantity ?? 0
  const acc = xfers.filter(r => r.status === 'accepted')
  const inAcc       = acc.filter(r => r.rf === F && r.sf !== F).reduce((s, r) => s + r.q, 0)                 // external transfer IN
  const outAcc      = acc.filter(r => r.sf === F && r.rf != null && r.rf !== F).reduce((s, r) => s + r.q, 0) // external transfer OUT
  const internalOut = acc.filter(r => r.sf === F && (r.rf == null || r.rf === F)).reduce((s, r) => s + r.q, 0) // store → site
  const intakeSum = intakes.reduce((s, r) => s + r.q, 0)
  const adjSum = adjs.reduce((s, r) => s + (r.ty === 'Decrease' ? -r.q : r.q), 0)
  const binCardStoreNet = intakeSum + inAcc + adjSum - outAcc - internalOut
  console.log('\n── STORE reconciliation (as the bin card computes it) ──')
  console.table([{
    intakes: intakeSum, transfers_in_accepted: inAcc, adjustments_net: adjSum,
    transfers_out_accepted: outAcc + internalOut,
    '= bin card net': binCardStoreNet, actual_store_SOH: storeSoh,
    'OPENING PLUG (SOH − net)': storeSoh - binCardStoreNet,
  }])

  // The likely culprits: outbound transfers that already left the store but aren't 'accepted'.
  const nonAccOut = xfers.filter(r => r.sf === F && r.status !== 'accepted')
  if (nonAccOut.length) {
    console.log('⚠ Outbound transfers NOT in "accepted" status (dispatch already decremented the store,')
    console.log('  but the bin card skips these — a prime suspect for a negative opening):')
    console.table(nonAccOut.map(r => ({ date: d(r.t), to: r.rn || site(r.notes) || '—', qty: r.q, status: r.status })))
  }

  // "Consumed / issued before the first inflow" — answers how a bin dispensed with no intake yet.
  const firstInflow = Math.min(
    intakes[0] ? new Date(intakes[0].t).getTime() : Infinity,
    ...xfers.filter(r => r.rf === F && r.status === 'accepted').map(r => new Date(r.t).getTime()),
  )
  const earlyOut = disps.filter(r => new Date(r.t).getTime() < firstInflow)
  if (earlyOut.length) {
    console.log('\n⚠ Consumption recorded BEFORE the first intake/inflow into this facility:')
    console.table(earlyOut.map(r => ({ date: d(r.t), issued: r.q, site: site(r.notes) || 'dispensary/store' })))
    console.log('  → these draw down stock that has no recorded source, so the opening balance absorbs it.')
  }
} catch (e) {
  console.error('Diagnose failed:', e.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
