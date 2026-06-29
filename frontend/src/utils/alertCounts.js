import { api } from '../lib/api'
import {
  groupStockByComm, resolveAmcWindow, amcMapFromRows,
  getStockStatus, capExpiryBatchesToStock,
} from './helpers'

// Counts expiry / low-stock / overstock alerts for a single facility.
// Out-of-stock is intentionally excluded (by request). Mirrors the Alerts page
// computation but returns counts only and fetches its own data, so it can run
// from the nav without depending on any page being mounted.
export async function fetchFacilityAlertCounts({ fid, allCommodities, amcWindows = {}, commoditySection, expiryDays = 180 }) {
  const empty = { expiry: 0, low: 0, over: 0, total: 0 }
  if (!fid || !allCommodities?.length) return empty
  const commIds = allCommodities.map(c => c.id)

  // Store stock for this facility (one big page).
  const stockData = await api.stock.list({
    facility_ids: [fid],
    commodity_ids: commoditySection ? commIds : undefined,
    limit: 50000,
  }).catch(() => [])

  // SDP site stock — facility total = store + SDP, matching the Dashboard.
  const sdpData = await api.stock.sdp.list({ facility_id: fid }).catch(() => [])
  const sdpMap = {}
  ;(sdpData || []).forEach(d => { sdpMap[d.commodity_id] = (sdpMap[d.commodity_id] || 0) + d.quantity })

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

  const gMap = {}
  groupStockByComm(stockData).forEach(g => { gMap[g.commodity_id] = g })

  let low = 0, over = 0
  allCommodities.forEach(c => {
    const g = gMap[c.id] || {}
    const quantity = (g.storeQty || 0) + (sdpMap[c.id] || 0)
    const amc = amcMap[c.id] && amcMap[c.id] > 0 ? amcMap[c.id] : (g.baseline_amc || 0)
    const status = getStockStatus(quantity, amc)
    if (status === 'low') low++
    else if (status === 'over') over++
    // 'out' excluded on purpose.
  })

  // Expiry — batches expiring within the window, capped to current SOH.
  const today  = new Date()
  const cutoff = new Date(today.getTime() + expiryDays * 86400000).toISOString().split('T')[0]
  const todayS = today.toISOString().split('T')[0]
  const exp = await api.intake.history({
    facility_id: fid, commodity_ids: commIds,
    expiry_from: todayS, expiry_to: cutoff, has_quantity: true,
    section: commoditySection || undefined,
  }).catch(() => [])
  const sohByComm = {}
  groupStockByComm(stockData).forEach(g => { sohByComm[g.commodity_id] = (g.storeQty || 0) + (sdpMap[g.commodity_id] || 0) })
  const expiry = (capExpiryBatchesToStock(exp || [], sohByComm) || []).length

  return { expiry, low, over, total: expiry + low + over }
}
