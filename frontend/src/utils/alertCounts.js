import { api } from '../lib/api'
import { resolveAmcWindow, amcMapFromRows, getStockStatus } from './helpers'

// Counts expiry / low-stock / overstock alerts for a single facility.
// Out-of-stock is intentionally excluded (by request). Mirrors the Alerts page
// computation but returns counts only and fetches its own data, so it can run
// from the nav without depending on any page being mounted.
export async function fetchFacilityAlertCounts({ fid, allCommodities, amcWindows = {}, commoditySection, expiryDays = 180 }) {
  const empty = { expiry: 0, low: 0, over: 0, total: 0 }
  if (!fid || !allCommodities?.length) return empty
  const commIds = allCommodities.map(c => c.id)

  // Per-commodity rollup for this facility: store + SDP totals and the baseline
  // AMC, in one response. This used to pull every stock row for the facility
  // (limit 50000) plus the SDP rows, purely to sum them per commodity here — for
  // a nav badge showing three numbers.
  const summary = await api.stock.summary({
    facility_id: fid,
    commodity_ids: commoditySection ? commIds : undefined,
  }).catch(() => [])
  const gMap = {}
  ;(summary || []).forEach(r => { gMap[r.commodity_id] = r })

  // Average monthly consumption window → AMC per commodity.
  const amcWin = resolveAmcWindow(amcWindows[fid])
  let amcMap = {}
  if (commIds.length) {
    const disp = await api.dispense.history({
      facility_id: fid, commodity_ids: commIds,
      from: amcWin.start.toISOString(), to: amcWin.end.toISOString(),
      section: commoditySection || undefined,
    }).catch(() => [])
    amcMap = amcMapFromRows(disp, amcWin)
  }

  let low = 0, over = 0
  allCommodities.forEach(c => {
    const g = gMap[c.id] || {}
    const quantity = (g.store_qty || 0) + (g.sdp_qty || 0)
    const amc = amcMap[c.id] && amcMap[c.id] > 0 ? amcMap[c.id] : (g.baseline_amc || 0)
    const status = getStockStatus(quantity, amc)
    if (status === 'low') low++
    else if (status === 'over') over++
    // 'out' excluded on purpose.
  })

  // Expiry — on-hand batches from the lot ledger, expiring within the window OR
  // already expired but still on the shelf. Ledger balances are the on-hand truth,
  // so this matches the Alerts page (no intake-history estimate to cap).
  const today  = new Date()
  const cutoff = new Date(today.getTime() + expiryDays * 86400000).toISOString().split('T')[0]
  const exp = await api.stock.lotsExpiry({
    facility_id: fid, commodity_ids: commIds,
    expiry_to: cutoff, section: commoditySection || undefined,
  }).catch(() => [])
  const expiry = (exp || []).length

  return { expiry, low, over, total: expiry + low + over }
}
