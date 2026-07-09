import { useEffect } from 'react'
import { api } from '../lib/api'
import { subscribeRealtime } from '../lib/realtime'
import { useAppStore } from '../store/appStore'

// Dedupe concurrent stock loads. On mount the app-level realtime hook and the
// page that just opened both call loadStock for the same scope at nearly the same
// instant, which fires the (large, ~4.5 MB for an admin) /api/stock request
// twice. Share one in-flight request per scope so the set downloads once. A
// different scope (e.g. the admin changes the LGA filter) still starts its own.
let inFlight = null
let inFlightKey = null

export function useStock() {
  const loadStock = async () => {
    const state = useAppStore.getState()
    const { allCommodities, commoditySection } = state
    const { fid, scopeIds } = state.getAdminStockScope()

    // Facility view-filter: a single selected facility, an LGA/state subset, or
    // (overall admin, no filter) none — in which case the server returns the
    // caller's full token scope. The server intersects this with that scope.
    const facility_ids = fid ? [fid] : (scopeIds && scopeIds.length ? scopeIds : undefined)
    // Commodity section: the ids are already the section-filtered catalogue.
    const commodity_ids = commoditySection ? allCommodities.map(c => c.id) : undefined

    const key = `${fid || (facility_ids ? facility_ids.join(',') : 'all')}|${commoditySection || ''}`
    // A caller with the same scope while a load is already running rides that one.
    if (inFlight && inFlightKey === key) return inFlight

    // One large page instead of many small ones. Offset pagination re-sorts the
    // whole table per page, so an overall admin (≈27k rows) would make many
    // sequential round trips; a single request sorts once. PAGE stays a real cap,
    // so if the dataset ever exceeds it the loop still drains the rest.
    const run = (async () => {
      const PAGE = 50000
      let all = []
      for (let offset = 0; ; offset += PAGE) {
        const data = await api.stock.list({ facility_ids, commodity_ids, limit: PAGE, offset })
        if (!data || !data.length) break
        all = all.concat(data)
        if (data.length < PAGE) break
      }
      state.setStockData(all)
    })()

    inFlight = run
    inFlightKey = key
    try {
      await run
    } catch {
      // Leave the existing stock data in place on error (matches old behaviour).
    } finally {
      if (inFlightKey === key) { inFlight = null; inFlightKey = null }
    }
    return run
  }

  return { loadStock }
}

export function useRealtimeStock() {
  const { loadStock } = useStock()

  useEffect(() => {
    loadStock()
    return subscribeRealtime(['stock'], loadStock)
  }, [])
}
