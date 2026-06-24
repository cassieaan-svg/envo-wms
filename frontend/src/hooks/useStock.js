import { useEffect } from 'react'
import { api } from '../lib/api'
import { subscribeRealtime } from '../lib/realtime'
import { useAppStore } from '../store/appStore'

export function useStock() {
  const store = useAppStore()

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

    // One large page instead of many small ones. Offset pagination re-sorts the
    // whole table per page, so an overall admin (≈27k rows) used to make ~28
    // sequential round trips (~6s of "Loading stock…"); a single request sorts
    // once (~0.7s). PAGE stays a real cap, so if the dataset ever exceeds it the
    // loop still drains the rest (just in fewer, bigger pages).
    const PAGE = 50000
    let all = []
    try {
      for (let offset = 0; ; offset += PAGE) {
        const data = await api.stock.list({ facility_ids, commodity_ids, limit: PAGE, offset })
        if (!data || !data.length) break
        all = all.concat(data)
        if (data.length < PAGE) break
      }
      store.setStockData(all)
    } catch {
      // Leave the existing stock data in place on error (matches old behaviour).
    }
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
