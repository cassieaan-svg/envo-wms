import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/appStore'
import { Card, CardHeader, CardTitle } from '../../components/ui/Card'
import { MetricGrid, Metric } from '../../components/ui/Metric'
import { LoadingState, EmptyState } from '../../components/ui/Loading'
import { StockLevelsTable } from '../../components/StockLevelsTable'
import { SiteBreakdownModal } from '../../components/SiteBreakdownModal'
import { resolveAmcWindow, loadConsumptionAmcMap, getMOS, getStockStatus, isLabCategory, SECTION_CATEGORIES, essentialCommodities } from '../../utils/helpers'
import { FacilityPicker } from '../../components/ui/FacilityPicker'
import { DispatchAlertBanner } from '../../components/DispatchAlertBanner'
import { exportCsv, exportPdf } from '../../utils/download'

const STATUS_LABEL = { ok: 'Optimal', low: 'Low stock', out: 'Out of stock', over: 'Overstock', unknown: 'No AMC' }

export function Dashboard() {
  const store            = useAppStore()
  const commoditySection = store.commoditySection
  const [amcMap, setAmcMap]   = useState({})
  // Commodity ids ever transacted here (any intake/dispense, however old) — the
  // widest signal that a facility actually handles a commodity.
  const [transacted, setTransacted] = useState(new Set())
  const [search, setSearch]   = useState('')
  const [catFilter, setCat]   = useState('')
  const [stsFilter, setSts]   = useState('')
  // Sub-filter of the Out-of-stock view only: '' | 'inuse' | 'unused'. Cleared
  // whenever the status filter moves off 'out', so the two cards disappear with it.
  const [useFilter, setUseFilter] = useState('')
  // Per-commodity stock rollup from the server (store/dispensary/DSD/SDP totals,
  // baseline AMC, has_stock), keyed by commodity_id. Replaces downloading every
  // stock/DSD/SDP row and reducing them here.
  const [summary, setSummary] = useState(null)
  const [drill, setDrill]     = useState(null)
  const [loading, setLoading] = useState(true)
  // Set when the rollup request itself failed, so the page can say so instead of
  // rendering a confident zero for every commodity.
  const [stockError, setStockError] = useState(null)
  // Stock-derived status counts are meaningless until the rollup lands — an empty
  // map makes every commodity look out-of-stock.
  const stockPending = loading || !summary

  // Admin facility scope: a single facility, an LGA/state worth of facilities,
  // or all (resolved from the hierarchical filter). Facility users get their own.
  const { fid, scopeIds } = store.getAdminStockScope()

  useEffect(() => {
    loadData()
  }, [fid, store.adminFilterState, store.adminFilterLGA])

  // The in-use split belongs to the Out-of-stock view; drop it the moment the
  // status filter moves elsewhere, so the cards and their filter go together.
  useEffect(() => { if (stsFilter !== 'out') setUseFilter('') }, [stsFilter])

  async function loadData() {
    setLoading(true)

    // Stage 1 — everything the cards and the table need, fetched in PARALLEL.
    // These two are independent (the AMC window is derived from the scope, not
    // from the stock), so there is no reason to await them in sequence.
    //
    // The rollup replaces three downloads: the full stock table plus the DSD and
    // SDP row dumps that were only ever summed per commodity here. The server
    // does the same sums, so the response is one row per commodity.
    const amcWin = resolveAmcWindow(fid ? store.amcWindows[fid] : null)
    const commIds = store.allCommodities.map(c => c.id)

    // Compact scope params ({ facility_id } | { state, lga } | {}) instead of an
    // enumerated facility id list, and no commodity_ids. A state account listed
    // every facility id plus its whole section catalogue, which pushed this URL
    // past the reverse proxy's query-string limit: it answered 404 before the
    // request reached the API, and that failure then read as "no stock anywhere".
    //
    // Neither parameter narrowed anything. The server resolves state/lga against
    // the caller's token scope (the same facilities, never wider), and already
    // restricts the response to their section — while the table below only ever
    // looks rows up by ids in its own catalogue, so extra rows are ignored.
    const scopeParams = store.getAdminScopeParams()
    setStockError(null)
    try {
      const [rows, amc] = await Promise.all([
        api.stock.summary(scopeParams),
        loadConsumptionAmcMap({ commIds, scopeParams, amcWin, section: commoditySection }),
      ])
      const byComm = {}
      ;(rows || []).forEach(r => { byComm[r.commodity_id] = r })
      setSummary(byComm)
      setAmcMap(amc)
    } catch (err) {
      // Leave `summary` null rather than falling back to {}. Every status here is
      // derived from the rollup, so an empty map does not read as "failed" — it
      // reads as every commodity being out of stock, which is a number a user
      // would act on. Better to show nothing and say so.
      setStockError(err?.message || 'Could not load stock')
      setSummary(null)
    }
    // Cards and table are now complete — release them before the non-critical
    // fetch below, so the dashboard is usable while it lands.
    setLoading(false)

    // Stage 2 — non-critical. `transacted` only refines the in-use / not-in-use
    // split inside the Out-of-stock view (which the user has to click into), so
    // it must not gate the initial render.
    const everUsed = await api.commodities.transacted(store.getAdminScopeParams()).catch(() => [])
    setTransacted(new Set(everUsed || []))
  }

  const getAMC = r => amcMap[r.commodity_id] && amcMap[r.commodity_id] > 0 ? amcMap[r.commodity_id] : (r.baseline_amc || 0)

  const gMap = summary || {}

  // In the Essential Commodities module a facility only handles the items it has
  // taken in, so the dashboard shows just those (any commodity with a stock record).
  // The HIV module keeps the full catalogue so zero-stock items / categories appear.
  // `has_stock` is the server's equivalent of the old "a stock row exists" test.
  const catalogue = store.module === 'essential'
    ? essentialCommodities(store.allCommodities, id => gMap[id]?.has_stock)
    : store.allCommodities

  // Lab total = store + SDP; pharmacy total = store + dispensary + DSD.
  const enrichedAll = catalogue.map(c => {
    const g             = gMap[c.id] || {}
    const comm          = c
    const storeQty      = g.store_qty || 0
    const dispensaryQty = g.dispensary_qty || 0
    const lab           = isLabCategory(comm?.category)
    const dsdQty        = g.dsd_qty || 0
    const sdpQty        = g.sdp_qty || 0
    // Essential has no dispensary or DSD, total = store only.
    const quantity      = lab ? (storeQty + sdpQty)
      : store.module === 'essential' ? storeQty
      : (storeQty + dispensaryQty + dsdQty)
    const amc           = getAMC({ commodity_id: c.id, baseline_amc: g.baseline_amc || 0 })
    return {
      id: c.id, commodity_id: c.id, commodities: comm,
      storeQty, dispensaryQty, dsdQty, sdpQty, _isLab: lab,
      quantity, amc, mos: getMOS(quantity, amc), status: getStockStatus(quantity, amc),
      // "In use here" = this facility has ever handled the commodity: any intake
      // or dispense record however old, or it holds (or once held) stock, or has
      // consumption in the AMC window. Everything else is tracked network-wide but
      // never used or reported here, so its zero balance is not a real stockout.
      inUse: !!gMap[c.id]?.has_stock || (amcMap[c.id] || 0) > 0 || transacted.has(c.id),
    }
  })

  const stockRows = enrichedAll
    .filter(r => (!search || (r.commodities?.name||'').toLowerCase().includes(search.toLowerCase()))
              && (!catFilter || r.commodities?.category === catFilter)
              && (!stsFilter || r.status === stsFilter)
              && (stsFilter !== 'out' || !useFilter || (useFilter === 'inuse' ? r.inUse : !r.inUse)))
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

      {/* The rollup failed. Say so plainly: the alternative is six cards and a
          full table of zeros, which looks like a network-wide stockout. */}
      {stockError && (
        <div className="mb-6 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3">
          <p className="text-sm text-red-300 font-medium">Stock figures could not be loaded</p>
          <p className="text-xs text-red-400/80 mt-1">
            The numbers below are incomplete — do not act on them. {stockError}
          </p>
          <button onClick={loadData} className="text-xs text-red-200 underline mt-2">Try again</button>
        </div>
      )}

      <MetricGrid>
        <Metric label="Commodities tracked" value={enrichedAll.length} color="blue" onClick={()=>setSts('')} active={stsFilter===''} />
        <Metric label="Optimal stock"  value={enrichedAll.filter(r=>r.status==='ok').length}   color="green" loading={stockPending} onClick={()=>setSts(s=>s==='ok'?'':'ok')}     active={stsFilter==='ok'} />
        <Metric label="Low stock"     value={enrichedAll.filter(r=>r.status==='low').length}  color="amber" loading={stockPending} onClick={()=>setSts(s=>s==='low'?'':'low')}   active={stsFilter==='low'} />
        <Metric label="Out of stock"  value={enrichedAll.filter(r=>r.status==='out').length}  color="red"   loading={stockPending} onClick={()=>setSts(s=>s==='out'?'':'out')}   active={stsFilter==='out'} />
        <Metric label="Overstock"     value={enrichedAll.filter(r=>r.status==='over').length} color="blue"  loading={stockPending} onClick={()=>setSts(s=>s==='over'?'':'over')} active={stsFilter==='over'} />
        {/* Commodities holding stock but with no consumption on record, so no AMC
            and therefore no MOS or status. Not a stockout — an unmeasurable one. */}
        <Metric label="No AMC" value={enrichedAll.filter(r=>r.status==='unknown').length} loading={stockPending} onClick={()=>setSts(s=>s==='unknown'?'':'unknown')} active={stsFilter==='unknown'} />
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
            <Metric label="Out of stock · in use" value={enrichedAll.filter(r=>r.status==='out' && r.inUse).length}
              color="red" loading={stockPending}
              onClick={()=>setUseFilter(v=>v==='inuse'?'':'inuse')} active={useFilter==='inuse'} />
            <Metric label="Out of stock · not in use" value={enrichedAll.filter(r=>r.status==='out' && !r.inUse).length}
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
                <StockLevelsTable items={outInUse} essential={store.module === 'essential'} onDrill={(row, kind) => setDrill({ row, kind })} />
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
                <StockLevelsTable items={outNotInUse} essential={store.module === 'essential'} onDrill={(row, kind) => setDrill({ row, kind })} />
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
              <StockLevelsTable items={byCategory[cat]} essential={store.module === 'essential'} onDrill={(row, kind) => setDrill({ row, kind })} />
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
