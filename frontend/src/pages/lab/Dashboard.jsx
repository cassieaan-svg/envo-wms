import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/appStore'
import { useStock } from '../../hooks/useStock'
import { Card, CardHeader, CardTitle } from '../../components/ui/Card'
import { MetricGrid, Metric } from '../../components/ui/Metric'
import { LoadingState, EmptyState } from '../../components/ui/Loading'
import { StockLevelsTable } from '../../components/StockLevelsTable'
import { SiteBreakdownModal } from '../../components/SiteBreakdownModal'
import { FacilityPicker } from '../../components/ui/FacilityPicker'
import { DispatchAlertBanner } from '../../components/DispatchAlertBanner'
import { resolveAmcWindow, loadConsumptionAmcMap, getMOS, getStockStatus, groupStockByComm, SECTION_CATEGORIES } from '../../utils/helpers'
import { exportCsv, exportPdf } from '../../utils/download'

const STATUS_LABEL = { ok: 'Optimal', low: 'Low stock', out: 'Out of stock', over: 'Overstock' }

export function Dashboard() {
  const store            = useAppStore()
  const { loadStock }    = useStock()
  const commoditySection = store.commoditySection
  const [amcMap, setAmcMap]   = useState({})
  // Commodity ids ever transacted here (any intake/dispense, however old) — the
  // widest signal that a facility actually handles a commodity.
  const [transacted, setTransacted] = useState(new Set())
  const [sdpMap, setSdpMap]   = useState({})
  const [search, setSearch]   = useState('')
  const [catFilter, setCat]   = useState('')
  const [stsFilter, setSts]   = useState('')
  // Sub-filter of the Out-of-stock view only: '' | 'inuse' | 'unused'. Cleared
  // whenever the status filter moves off 'out', so the two cards go with it.
  const [useFilter, setUseFilter] = useState('')
  const [drill, setDrill]     = useState(null)
  const [loading, setLoading] = useState(true)
  // Stock-derived status counts are meaningless until the stock payload lands —
  // an empty stockData makes every commodity look out-of-stock.
  const stockPending = loading || !store.stockLoaded

  const fid = store.getEffectiveFacilityId()

  useEffect(() => {
    loadData()
  }, [fid, store.adminFilterState, store.adminFilterLGA])

  // The in-use split belongs to the Out-of-stock view; drop it the moment the
  // status filter moves elsewhere, so the cards and their filter go together.
  useEffect(() => { if (stsFilter !== 'out') setUseFilter('') }, [stsFilter])

  async function loadData() {
    setLoading(true)
    await loadStock()

    // Aggregate Service Delivery Point stock (lab has no dispensary/DSD)
    const sdpAgg = {}
    if (fid || store.currentFacility?.id) {
      const sdpData = await api.stock.sdp.list({ facility_id: fid || store.currentFacility?.id }).catch(() => [])
      ;(sdpData || []).forEach(d => {
        sdpAgg[d.commodity_id] = (sdpAgg[d.commodity_id] || 0) + d.quantity
      })
    }
    setSdpMap(sdpAgg)

    // Scope the AMC the same way the stock was loaded: single facility → its
    // custom window; multi-facility/admin scope → the default window with
    // consumption aggregated across the whole scope so the AMC (and the status
    // counts in the cards above) matches the summed stock.
    const { fid: amcFid, scopeIds } = store.getAdminStockScope()
    const amcWin = resolveAmcWindow(amcFid ? store.amcWindows[amcFid] : null)
    const commIds = store.allCommodities.map(c => c.id)
    const amc = await loadConsumptionAmcMap({ commIds, scopeParams: store.getAdminScopeParams(), amcWin, section: commoditySection })
    setAmcMap(amc)
    const everUsed = await api.commodities.transacted(store.getAdminScopeParams()).catch(() => [])
    setTransacted(new Set(everUsed || []))
    setLoading(false)
  }

  const getAMC  = r => amcMap[r.commodity_id] && amcMap[r.commodity_id] > 0 ? amcMap[r.commodity_id] : (r.baseline_amc || 0)
  const getStatus = r => getStockStatus(r.quantity, getAMC(r))

  const grouped = groupStockByComm(store.stockData)
  const gMap = {}
  grouped.forEach(g => { gMap[g.commodity_id] = g })

  // Base on every tracked commodity so zero-stock / out-of-stock items appear.
  // Lab total = store + SDP (no dispensary/DSD).
  const groupedAll = store.allCommodities.map(c => {
    const g        = gMap[c.id] || {}
    const comm     = g.commodities || c
    const storeQty = g.storeQty || 0
    const sdpQty   = sdpMap[c.id] || 0
    const quantity = storeQty + sdpQty
    return {
      id: c.id, commodity_id: c.id, commodities: comm,
      storeQty, sdpQty, quantity, baseline_amc: g.baseline_amc || 0,
      // "In use here" = this facility has ever handled the commodity: any intake
      // or dispense record however old, or it holds (or once held) stock, or has
      // consumption in the AMC window. Anything else is tracked network-wide but
      // never used or reported here, so its zero balance is not a real stockout.
      inUse: !!gMap[c.id] || (amcMap[c.id] || 0) > 0 || transacted.has(c.id),
    }
  })
  const stockRows = groupedAll
    .filter(r => (!search || (r.commodities?.name||'').toLowerCase().includes(search.toLowerCase()))
              && (!catFilter || r.commodities?.category === catFilter))
    .map(r => {
      const amc = getAMC(r)
      return { ...r, _isLab: true, amc, status: getStockStatus(r.quantity, amc), mos: getMOS(r.quantity, amc) }
    })
    .filter(r => (!stsFilter || r.status === stsFilter)
              && (stsFilter !== 'out' || !useFilter || (useFilter === 'inuse' ? r.inUse : !r.inUse)))
    .sort((a, b) => {
      // In-stock commodities before out-of-stock ones, then by name
      const aOut = a.quantity === 0, bOut = b.quantity === 0
      if (aOut !== bOut) return aOut ? 1 : -1
      return (a.commodities?.name||'').localeCompare(b.commodities?.name||'')
    })

  // Group by category to mirror the pharmacy Dashboard / Stock Levels arrangement
  const byCategory = {}
  stockRows.forEach(r => {
    const cat = r.commodities?.category || 'Other'
    if (!byCategory[cat]) byCategory[cat] = []
    byCategory[cat].push(r)
  })
  const availableCats = [...new Set(groupedAll.map(r => r.commodities?.category).filter(Boolean))].sort()

  // Order categories by the canonical section sequence (RTKs before Lab
  // reagents before Lab consumables), with any unknown category last.
  const catOrder = SECTION_CATEGORIES[commoditySection] || []
  const orderedCats = Object.keys(byCategory).sort((a, b) => {
    const ia = catOrder.indexOf(a), ib = catOrder.indexOf(b)
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b)
  })

  // Out-of-stock view is arranged by usage instead of category: in-use (real
  // stockouts, all categories) on top, not-in-use below. stockRows is already
  // narrowed by the in-use/not-in-use card filter, so an unpicked side is empty.
  const outInUse    = stockRows.filter(r => r.inUse)
  const outNotInUse = stockRows.filter(r => !r.inUse)

  // Export mirrors the filtered table (WYSIWYG). Active filters are recorded in
  // the file name + PDF subtitle so each download is self-documenting.
  const activeFilters = [
    catFilter,
    stsFilter && (STATUS_LABEL[stsFilter] || stsFilter),
    search && `search "${search}"`,
  ].filter(Boolean).join(', ')
  const exportHeaders = ['Category', 'Commodity', 'Unit', 'Store SOH', 'SDP SOH', 'Total SOH', 'AMC', 'MOS (months)', 'Status']
  const exportData = stockRows.map(r => [
    r.commodities?.category || '', r.commodities?.name || '', r.commodities?.unit || '',
    r.storeQty || 0, r.sdpQty || 0, r.quantity || 0,
    r.amc || 0, r.mos != null ? Number(r.mos).toFixed(1) : '', STATUS_LABEL[r.status] || r.status || '',
  ])
  const exportRight = new Set([3, 4, 5, 6, 7])
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
        <Metric label="Commodities tracked" value={groupedAll.length} color="blue" onClick={()=>setSts('')} active={stsFilter===''} />
        <Metric label="Optimal stock"  value={groupedAll.filter(r=>getStatus(r)==='ok').length}   color="green" loading={stockPending} onClick={()=>setSts(s=>s==='ok'?'':'ok')}     active={stsFilter==='ok'} />
        <Metric label="Low stock"     value={groupedAll.filter(r=>getStatus(r)==='low').length}  color="amber" loading={stockPending} onClick={()=>setSts(s=>s==='low'?'':'low')}   active={stsFilter==='low'} />
        <Metric label="Out of stock"  value={groupedAll.filter(r=>getStatus(r)==='out').length}  color="red"   loading={stockPending} onClick={()=>setSts(s=>s==='out'?'':'out')}   active={stsFilter==='out'} />
        <Metric label="Overstock"     value={groupedAll.filter(r=>getStatus(r)==='over').length} color="blue"  loading={stockPending} onClick={()=>setSts(s=>s==='over'?'':'over')} active={stsFilter==='over'} />
      </MetricGrid>

      {/* Out-of-stock only: split the zero balances into ones this facility
          actually uses (a real stockout) and ones it has never used or reported
          (tracked network-wide, so its zero is not a shortage). Disappears as
          soon as another status card is picked. */}
      {stsFilter === 'out' && (
        <div className="mb-6">
          {/* Plain (non-sticky) grid: this detail row sits under the sticky metric
              bar, so it must not be a second MetricGrid — two sticky bars would
              overlap at the same top offset. */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Metric label="Out of stock · in use" value={groupedAll.filter(r=>getStatus(r)==='out' && r.inUse).length}
              color="red" loading={stockPending}
              onClick={()=>setUseFilter(v=>v==='inuse'?'':'inuse')} active={useFilter==='inuse'} />
            <Metric label="Out of stock · not in use" value={groupedAll.filter(r=>getStatus(r)==='out' && !r.inUse).length}
              loading={stockPending}
              onClick={()=>setUseFilter(v=>v==='unused'?'':'unused')} active={useFilter==='unused'} />
          </div>
          <p className="text-xs text-gray-600 mt-2">
            “In use” = this facility has ever received or consumed it, or holds stock of it.
          </p>
        </div>
      )}

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

      {loading ? <LoadingState message="Loading stock…" /> : stockRows.length === 0 ? <EmptyState message="No stock records yet." /> : stsFilter === 'out' ? (
        // Out-of-stock: two usage divisions across all categories, in-use first.
        <>
          {outInUse.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>In use — out of stock</CardTitle>
                <span className="text-xs text-gray-500">{outInUse.length} commodities</span>
              </CardHeader>
              <div className="table-wrap">
                <StockLevelsTable items={outInUse} onDrill={(row, kind) => setDrill({ row, kind })} />
              </div>
            </Card>
          )}
          {outNotInUse.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Not in use — out of stock</CardTitle>
                <span className="text-xs text-gray-500">{outNotInUse.length} commodities</span>
              </CardHeader>
              <div className="table-wrap">
                <StockLevelsTable items={outNotInUse} onDrill={(row, kind) => setDrill({ row, kind })} />
              </div>
            </Card>
          )}
        </>
      ) : (
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
        <SiteBreakdownModal commodity={drill.row} kind={drill.kind} fid={fid || store.currentFacility?.id} onClose={() => setDrill(null)} />
      )}
    </div>
  )
}
