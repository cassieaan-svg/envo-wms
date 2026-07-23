// Seed the lot ledger (stock_lot) from current holdings — phase 1.
//
// For every bin with stock (facility store, dispensary, each DSD/SDP site) it
// asks BinCardService.residualLots for the batch/expiry breakdown of what's on
// hand — the same FEFO reconstruction the bin card already shows — then reconciles
// that to the bin's ACTUAL quantity so the lots sum exactly:
//   residual < actual  → add an "unknown" lot (null batch/expiry) for the shortfall
//                        (the small coverage gap; a null expiry never passes an
//                        expiry check, so it surfaces for a later fix)
//   residual > actual  → trim the excess soonest-expiry-first (that stock is the
//                        most likely to have already gone)
//   equal              → use as-is
//
// Rebuild semantics: truncates stock_lot and repopulates, so it is safe to re-run
// while the ledger is still in shadow (nothing reads it yet). Do NOT run once the
// ledger is live and authoritative.
//
// Run AFTER applying 20260724_stock_lot.sql, on the VM from the backend dir:
//   cd C:\envo\app\backend
//   node scripts/seed_stock_lots.mjs

import { pool, query, withTransaction } from '../src/db.js'
import { BinCardService } from '../src/services/binCardService.js'
import { ymd } from '../src/services/lotService.js'

const fmt = n => Number(n || 0).toLocaleString()

// Every bin with stock, as { facility_id, commodity_id, location_type, site_name,
// section, location(for residualLots), qty }.
async function allBins() {
  const bins = []
  for (const r of (await query(
    `select facility_id, commodity_id, location_type, quantity
       from stock where quantity > 0 and location_type in ('store','dispensary')`)).rows) {
    bins.push({ ...r, site_name: null, section: null, location: r.location_type, qty: Number(r.quantity) })
  }
  for (const r of (await query(
    `select facility_id, commodity_id, dsd_site_name site, quantity from dsd_stock where quantity > 0`)).rows) {
    bins.push({ facility_id: r.facility_id, commodity_id: r.commodity_id, location_type: 'dsd',
      site_name: r.site, section: null, location: `dsd:${r.site}`, qty: Number(r.quantity) })
  }
  for (const r of (await query(
    `select facility_id, commodity_id, sdp_name site, quantity from sdp_stock where quantity > 0`)).rows) {
    bins.push({ facility_id: r.facility_id, commodity_id: r.commodity_id, location_type: 'sdp',
      site_name: r.site, section: null, location: `sdp:${r.site}`, qty: Number(r.quantity) })
  }
  return bins
}

// Reconcile the FEFO residuals to the bin's actual quantity (see header).
function reconcile(residuals, actual) {
  const lots = residuals.map(l => ({ batch: l.batch, expiry: l.expiry, qty: l.qty })).filter(l => l.qty > 0)
  let total = lots.reduce((s, l) => s + l.qty, 0)
  if (total < actual) {
    lots.push({ batch: null, expiry: null, qty: actual - total })         // unknown shortfall
  } else if (total > actual) {
    let excess = total - actual
    for (const l of lots) {                                               // trim soonest-expiry first
      if (excess <= 0) break
      const t = Math.min(l.qty, excess); l.qty -= t; excess -= t
    }
  }
  return lots.filter(l => l.qty > 0)
}

try {
  const bins = await allBins()
  console.log(`\nSeeding lot ledger from ${fmt(bins.length)} bins with stock…\n`)

  let inserted = 0, unknownUnits = 0, trimmedBins = 0, shortfallBins = 0, done = 0
  await withTransaction(async exec => {
    await exec('truncate stock_lot')
    for (const b of bins) {
      const residuals = await BinCardService.residualLots(b.facility_id, b.commodity_id, b.location)
      const before = residuals.reduce((s, l) => s + l.qty, 0)
      const lots = reconcile(residuals, b.qty)
      if (before < b.qty) { shortfallBins++; unknownUnits += (b.qty - before) }
      if (before > b.qty) trimmedBins++

      for (const l of lots) {
        await exec(
          `insert into stock_lot (facility_id, commodity_id, location_type, site_name, batch_number, expiry_date, quantity, section)
           values ($1,$2,$3,$4,$5,$6,$7,$8)
           on conflict (facility_id, commodity_id, location_type,
                        coalesce(site_name,''), coalesce(batch_number,''), coalesce(expiry_date,'0001-01-01'::date))
           do update set quantity = stock_lot.quantity + excluded.quantity, updated_at = now()`,
          [b.facility_id, b.commodity_id, b.location_type, b.site_name, l.batch, ymd(l.expiry), l.qty, b.section]
        )
        inserted++
      }
      if (++done % 500 === 0) console.log(`  …${fmt(done)}/${fmt(bins.length)} bins`)
    }
  })

  console.log('\n══════════ SEED COMPLETE ══════════')
  console.log(`bins seeded            : ${fmt(bins.length)}`)
  console.log(`lot rows written       : ${fmt(inserted)}`)
  console.log(`bins with a shortfall  : ${fmt(shortfallBins)}  (→ ${fmt(unknownUnits)} units in unknown-expiry lots)`)
  console.log(`bins trimmed (excess)  : ${fmt(trimmedBins)}`)
  console.log('\nRun scripts/verify_stock_lots.mjs to confirm sum(lots) == every bin total.\n')
} catch (err) {
  console.error('Seed failed (rolled back):', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
