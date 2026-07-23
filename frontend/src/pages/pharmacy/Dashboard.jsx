import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/appStore'
import { useStock } from '../../hooks/useStock'
import { Card, CardHeader, CardTitle } from '../../components/ui/Card'
import { MetricGrid, Metric } from '../../components/ui/Metric'
import { LoadingState, EmptyState } from '../../components/ui/Loading'
import { StockLevelsTable } from '../../components/StockLevelsTable'
import { SiteBreakdownModal } from '../../components/SiteBreakdownModal'
import { resolveAmcWindow, loadConsumptionAmcMap, getMOS, getStockStatus, groupStockByComm, isLabCategory, SECTION_CATEGORIES } from '../../utils/helpers'
import { FacilityPicker } from '../../components/ui/FacilityPicker'
import { DispatchAlertBanner } from '../../components/DispatchAlertBanner'
import { exportCsv, exportPdf } from '../../utils/download'

const STATUS_LABEL = { ok: 'Optimal', low: 'Low stock', out: 'Out of stock', over: 'Overstock' }

export function Dashboard() {
  const store            = useAppStore()
  const { loadStock }    = useStock()
  const commoditySection = store.commoditySection
  const [amcMap, setAmcMap]   = useState({})
  const [search, setSearch]   = useState('')
  const [catFilter, setCat]   = useState('')
  const [stsFilter, setSts]   = useState('')
  const [sdpMap, setSdpMap]   = useState({})
  const [dsdMap, setDsdMap]   = useState({})
  const [drill, setDrill]     = useState(null)
  const [loading, setLoading] = useState(true)
  // Stock-derived status counts are meaningless until the stock payload lands —
  // an empty stockData makes every commodity look out-of-stock.
  const stockPending = loading || !store.stockLoaded

  // Admin facility scope: a single facility, an LGA/state worth of facilities,
  // or all (resolved from the hierarchical filter). Facility users get their own.
  const { fid, scopeIds } = store.getAdminStockScope()

  useEffect(() => {
    loadData()
  }, [fid, store.adminFilterState, store.adminFilterLGA])

  async function loadData() {
    setLoading(true)
    await loadStock()

    // Aggregate DSD (pharmacy) and SDP (lab) stock by commodity. With a facility
    // scoped, use it; for an admin viewing all facilities, aggregate across the
    // whole scope (paginated past the 1000-row cap).
    const aggSiteStock = async (listFn) => {
      const map = {}
      for (let offset = 0; ; offset += 1000) {
        let data
        try {
          data = await listFn({
            facility_id: fid || undefined,
            facility_ids: (!fid && scopeIds && scopeIds.length) ? scopeIds : undefined,
            limit: 1000, offset,
          })
        } catch { break }
        if (!data || !data.length) break
        data.forEach(d => { map[d.commodity_id] = (map[d.commodity_id] || 0) + d.quantity })
        if (data.length < 1000) break
      }
      return map
    }
    const [dsdAgg, sdpAgg] = await Promise.all([aggSiteStock(api.stock.dsd.list), aggSiteStock(api.stock.sdp.list)])
    setDsdMap(dsdAgg)
    setSdpMap(sdpAgg)

    // Single facility → its custom window; multi-facility/admin scope → the
    // default window with consumption aggregated across the whole scope so the
    // AMC (and the status counts in the cards above) matches the summed stock.
    const amcWin = resolveAmcWindow(fid ? store.amcWindows[fid] : null)
    const commIds = store.allCommodities.map(c => c.id)
    const amc = await loadConsumptionAmcMap({ commIds, scopeParams: store.getAdminScopeParams(), amcWin, section: commoditySection })
    setAmcMap(amc)
    setLoading(false)
  }

  const getAMC = r => amcMap[r.commodity_id] && amcMap[r.commodity_id] > 0 ? amcMap[r.commodity_id] : (r.baseline_amc || 0)

  const grouped = groupStockByComm(store.stockData)
  const gMap = {}
  grouped.forEach(g => { gMap[g.commodity_id] = g })

  // Base on every tracked commodity so zero-stock items / categories appear.
  // Lab total = store + SDP; pharmacy total = store + dispensary + DSD.
  const enrichedAll = store.allCommodities.map(c => {
    const g             = gMap[c.id] || {}
    const comm          = g.commodities || c
    const storeQty      = g.storeQty || 0
    const dispensaryQty = g.dispensaryQty || 0
    const lab           = isLabCategory(comm?.category)
    const dsdQty        = dsdMap[c.id] || 0
    const sdpQty        = sdpMap[c.id] || 0
    const quantity      = lab ? (storeQty + sdpQty) : (storeQty + dispensaryQty + dsdQty)
    const amc           = getAMC({ commodity_id: c.id, baseline_amc: g.baseline_amc || 0 })
    return {
      id: c.id, commodity_id: c.id, commodities: comm,
      storeQty, dispensaryQty, dsdQty, sdpQty, _isLab: lab,
      quantity, amc, mos: getMOS(quantity, amc), status: getStockStatus(quantity, amc),
    }
  })

  const stockRows = enrichedAll
    .filter(r => (!search || (r.commodities?.name||'').toLowerCase().includes(search.toLowerCase()))
              && (!catFilter || r.commodities?.category === catFilter)
              && (!stsFilter || r.status === stsFilter))
    .sort((a, b) => {
      // In-stock commodities before out-of-stock ones, then by name
      const aOut = a.quantity === 0, bOut = b.quantity === 0
      if (aOut !== bOut) return aOut ? 1 : -1
      return (a.commodities?.name||'').localeCompare(b.commodities?.name||'')
    })

  // Group by category to mirror the Stock Levels arrangement
  const byCategory = {}
  stockRows.forEach(r => {
    const cat = r.commodities?.category || 'Other'
    if (!byCategory[cat]) byCategory[cat] = []
    byCategory[cat].push(r)
  })
  const availableCats = [...new Set(enrichedAll.map(r => r.commodities?.category).filter(Boolean))].sort()

  // Order categories by the canonical section sequence (Pharmacy drugs before
  // Medical supplies), with any unknown category last. Admins have no section,
  // so use the combined pharmacy→lab order.
  const catOrder = commoditySection
    ? (SECTION_CATEGORIES[commoditySection] || [])
    : [...SECTION_CATEGORIES.pharmacy, ...SECTION_CATEGORIES.lab]
  const orderedCats = Object.keys(byCategory).sort((a, b) => {
    const ia = catOrder.indexOf(a), ib = catOrder.indexOf(b)
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b)
  })

  // Export mirrors the filtered table (WYSIWYG). Active filters are recorded in
  // the file name + PDF subtitle so each download is self-documenting.
  const activeFilters = [
    catFilter,
    stsFilter && (STATUS_LABEL[stsFilter] || stsFilter),
    search && `search "${search}"`,
  ].filter(Boolean).join(', ')
  const exportHeaders = ['Category', 'Commodity', 'Unit', 'Store SOH', 'Dispensary SOH', 'DSD SOH', 'SDP SOH', 'Total SOH', 'AMC', 'MOS (months)', 'Status']
  const exportData = stockRows.map(r => [
    r.commodities?.category || '', r.commodities?.name || '', r.commodities?.unit || '',
    r.storeQty || 0, r.dispensaryQty || 0, r.dsdQty || 0, r.sdpQty || 0, r.quantity || 0,
    r.amc || 0, r.mos != null ? Number(r.mos).toFixed(1) : '', STATUS_LABEL[r.status] || r.status || '',
  ])
  const exportRight = new Set([3, 4, 5, 6, 7, 8, 9])
  const facLabel = store.currentFacility?.name || 'All facilities in scope'
  const exportSubtitle = activeFilters ? `${facLabel} — filtered: ${activeFilters}` : facLabel
  const filterSlug = activeFilters ? '-' + activeFilters.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') : ''
  const exportBase = `stock-dashboard${filterSlug}-${new Date().toISOString().slice(0, 10)}`
  const doCsv = () => exportCsv(`${exportBase}.csv`, exportHeaders, exportData)
  const doPdf = () => exportPdf('Stock Dashboard', exportSubtitle, exportHeaders, exportData, exportRight)

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-medium text-gray-100 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse inline-block" />
          Dashboard
        </h1>
        <p className="text-sm text-gray-500 mt-1">Real-time stock overview for your facility</p>
      </div>

      <FacilityPicker />

      <DispatchAlertBanner />

      <MetricGrid>
        <Metric label="Commodities tracked" value={enrichedAll.length} color="blue" onClick={()=>setSts('')} active={stsFilter===''} />
        <Metric label="Optimal stock"  value={enrichedAll.filter(r=>r.status==='ok').length}   color="green" loading={stockPending} onClick={()=>setSts(s=>s==='ok'?'':'ok')}     active={stsFilter==='ok'} />
        <Metric label="Low stock"     value={enrichedAll.filter(r=>r.status==='low').length}  color="amber" loading={stockPending} onClick={()=>setSts(s=>s==='low'?'':'low')}   active={stsFilter==='low'} />
        <Metric label="Out of stock"  value={enrichedAll.filter(r=>r.status==='out').length}  color="red"   loading={stockPending} onClick={()=>setSts(s=>s==='out'?'':'out')}   active={stsFilter==='out'} />
        <Metric label="Overstock"     value={enrichedAll.filter(r=>r.status==='over').length} color="blue"  loading={stockPending} onClick={()=>setSts(s=>s==='over'?'':'over')} active={stsFilter==='over'} />
      </MetricGrid>

      <Card className="mb-4">
        <div className="px-4 py-3 flex gap-2 flex-wrap items-center">
          <button onClick={loadData} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">Refresh</button>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search commodity…"
            className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 placeholder:text-gray-600 focus:outline-none focus:border-blue-500 flex-1 min-w-[200px] max-w-xs"
          />
          <select
            value={catFilter}
            onChange={e => setCat(e.target.value)}
            className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500"
          >
            <option value="">All categories</option>
            {availableCats.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <div className="flex gap-2 ml-auto">
            <button onClick={doCsv} disabled={!stockRows.length}
              className="text-xs text-gray-300 hover:text-white border border-white/10 rounded px-3 py-1.5 disabled:opacity-50">Download CSV</button>
            <button onClick={doPdf} disabled={!stockRows.length}
              className="text-xs text-gray-300 hover:text-white border border-white/10 rounded px-3 py-1.5 disabled:opacity-50">Print / Save as PDF</button>
          </div>
        </div>
      </Card>

      {loading ? <LoadingState message="Loading stock…" /> : stockRows.length === 0 ? <EmptyState message="No stock records yet." /> : (
        orderedCats.map(cat => (
          <Card key={cat}>
            <CardHeader>
              <CardTitle>{cat}</CardTitle>
              <span className="text-xs text-gray-500">{byCategory[cat].length} commodities</span>
            </CardHeader>
            <div className="table-wrap">
              <StockLevelsTable items={byCategory[cat]} onDrill={(row, kind) => setDrill({ row, kind })} />
            </div>
          </Card>
        ))
      )}

      {drill && (
        <SiteBreakdownModal commodity={drill.row} kind={drill.kind} fid={fid} scopeIds={scopeIds} onClose={() => setDrill(null)} />
      )}
    </div>
  )
}
