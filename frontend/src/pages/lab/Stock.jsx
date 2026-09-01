import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/appStore'
import { Card, CardHeader, CardTitle } from '../../components/ui/Card'
import { LoadingState, EmptyState } from '../../components/ui/Loading'
import { FacilityPicker } from '../../components/ui/FacilityPicker'
import { StockLevelsTable } from '../../components/StockLevelsTable'
import { SiteBreakdownModal } from '../../components/SiteBreakdownModal'
import { BatchBreakdownModal } from '../../components/BatchBreakdownModal'
import { getMOS, getStockStatus, fmtStockQty, SECTION_CATEGORIES, allowedCategoriesFor, resolveAmcWindow, loadConsumptionAmcMap } from '../../utils/helpers'
import { AmcWindowEditor } from '../../components/AmcWindowEditor'

export function Stock() {
  const store         = useAppStore()
  const commoditySection = store.commoditySection
  const [rows, setRows]       = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch]   = useState('')
  const [catFilter, setCat]   = useState('')
  const [stsFilter, setSts]   = useState('')
  const [sortBy, setSortBy]   = useState('category')
  const [drill, setDrill]     = useState(null)
  const [batchDrill, setBatchDrill] = useState(null)

  const fid        = store.getEffectiveFacilityId() || store.currentFacility?.id
  const facilityRole = useAppStore(s => s.facilityRole)
  const accessLevel  = useAppStore(s => s.accessLevel)
  const sdpName      = useAppStore(s => s.sdpName)
  const dsdSiteName  = useAppStore(s => s.dsdSiteName)
  const isSDP = accessLevel === 'facility' && facilityRole === 'sdp'
  const isDSD = accessLevel === 'facility' && facilityRole === 'dsd'

  useEffect(() => { loadData() }, [fid, store.adminFilterState, store.adminFilterLGA])

  async function loadData() {
    setLoading(true)

    if (isSDP) {
      const data = await api.stock.sdp.list({ facility_id: fid, sdp_name: sdpName }).catch(() => [])
      setRows(data || [])
      setLoading(false)
      return
    }

    if (isDSD) {
      const data = await api.stock.dsd.list({ facility_id: fid, dsd_site_name: dsdSiteName }).catch(() => [])
      setRows(data || [])
      setLoading(false)
      return
    }

    // Scope the AMC the same way the stock is loaded (single facility, LGA/state,
    // or all): single facility → its custom window; multi-facility/admin scope →
    // the default window with consumption aggregated across the whole scope so the
    // AMC matches the summed stock below.
    const { fid: amcFid } = store.getAdminStockScope()

    // Per-commodity rollup for this scope (store + SDP totals and baseline AMC) in
    // one response, replacing the full stock-table download plus the SDP row dump
    // that was only summed per commodity here.
    //
    // Compact scope params, not an enumerated facility id list — see the Dashboard:
    // a large state's ids pushed that URL past the reverse proxy's query-string
    // limit and the request was rejected before it reached the API. This page sat
    // just under the same cliff. The server resolves state/lga against the token
    // scope, so the facility set is identical.
    const summary = await api.stock.summary(store.getAdminScopeParams()).catch(() => [])
    const gMap = {}
    ;(summary || []).forEach(r => { gMap[r.commodity_id] = r })

    const amcWin = resolveAmcWindow(amcFid ? store.amcWindows[amcFid] : null)
    const commIds = (summary || []).map(r => r.commodity_id)
    const amcMap = await loadConsumptionAmcMap({ commIds, scopeParams: store.getAdminScopeParams(), amcWin, section: commoditySection })

    // Essential: show only commodities the facility has taken in (has a stock record).
    // HIV: base the list on every tracked commodity (not just those with stock), so
    // zero-stock / out-of-stock items still appear — mirrors the admin view.
    const catalogue = store.module === 'essential'
      ? store.allCommodities.filter(c => gMap[c.id]?.has_stock)
      : store.allCommodities
    const enriched = catalogue.map(c => {
      const g        = gMap[c.id] || {}
      const comm     = c
      const storeQty = g.store_qty || 0
      // SDP stock counts at every grain. It used to be zeroed unless a single
      // facility was in view, which made a state or cluster login read store-only
      // while All Facilities — and the whole pharmacy section — counted SDP, so the
      // same commodity showed two different totals and a false low-stock badge.
      const sdpQty   = g.sdp_qty || 0
      const calcAmc  = amcMap[c.id]
      const amc      = calcAmc && calcAmc > 0 ? +calcAmc.toFixed(1) : +(g.baseline_amc || 0).toFixed(1)
      // Lab has no dispensary — total is store + SDP only
      const quantity = storeQty + sdpQty
      return {
        id: c.id, commodity_id: c.id, commodities: comm,
        storeQty, sdpQty, _isLab: true,
        amc, mos: getMOS(quantity, amc), status: getStockStatus(quantity, amc), quantity,
      }
    })
    setRows(enriched)
    setLoading(false)
  }

  const filtered = rows
    .filter(r => (!catFilter || r.commodities?.category === catFilter)
              && (!stsFilter || r.status === stsFilter)
              && (!search    || (r.commodities?.name||'').toLowerCase().includes(search.toLowerCase())))
    .sort((a, b) => {
      if (sortBy === 'name')  return (a.commodities?.name||'').localeCompare(b.commodities?.name||'')
      if (sortBy === 'qty')   return b.quantity - a.quantity
      if (sortBy === 'mos')   return (a.mos===null?999:a.mos) - (b.mos===null?999:b.mos)
      const c = (a.commodities?.category||'').localeCompare(b.commodities?.category||'')
      if (c !== 0) return c
      // In-stock commodities before out-of-stock ones within a category
      const aOut = a.quantity === 0, bOut = b.quantity === 0
      if (aOut !== bOut) return aOut ? 1 : -1
      return (a.commodities?.name||'').localeCompare(b.commodities?.name||'')
    })

  // Category options come from the rows the account can actually see, NOT a fixed
  // lab list: a hub store (state office / cluster store) handles lab consumables and
  // general consumables, so a hardcoded RTKs/reagents/consumables trio offered it two
  // categories it never holds while hiding General Consumables entirely. Matches how
  // Dashboard and the pharmacy Stock page already build theirs.
  const availableCats = [...new Set(rows.map(r => r.commodities?.category).filter(Boolean))].sort()

  // Group by category if sorting by category
  const byCategory = {}
  if (sortBy === 'category') {
    filtered.forEach(r => {
      const cat = r.commodities?.category || 'Other'
      if (!byCategory[cat]) byCategory[cat] = []
      byCategory[cat].push(r)
    })
  }

  // Order categories by the canonical section sequence (e.g. RTKs before
  // Lab reagents before Lab consumables), with any unknown category last.
  const catOrder = allowedCategoriesFor(commoditySection, store.currentFacility?.name)
    || SECTION_CATEGORIES[commoditySection] || []
  const orderedCats = Object.keys(byCategory).sort((a, b) => {
    const ia = catOrder.indexOf(a), ib = catOrder.indexOf(b)
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b)
  })

  if (isSDP || isDSD) {
    const sdpFiltered = rows.filter(r =>
      !search || (r.commodities?.name || '').toLowerCase().includes(search.toLowerCase())
    )
    return (
      <div>
        <div className="mb-6">
          <h1 className="text-xl font-medium text-gray-100">Stock Levels</h1>
          <p className="text-sm text-gray-500 mt-1">Stock on hand for {isSDP ? sdpName : dsdSiteName}</p>
        </div>
        <Card className="mb-4">
          <div className="px-4 py-3 flex gap-2 flex-wrap items-center">
            <button onClick={loadData} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">Refresh</button>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search commodity…"
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 placeholder:text-gray-600 focus:outline-none focus:border-blue-500 flex-1 min-w-[200px] max-w-xs" />
          </div>
        </Card>
        {loading ? <LoadingState /> : sdpFiltered.length === 0 ? <EmptyState message="No stock records found." /> : (
          <Card className="stick-cols">
            <div className="table-wrap">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/8 bg-white/2">
                    {['Commodity','Unit','Stock on Hand'].map(h => (
                      <th key={h} className="sticky top-0 z-10 bg-gray-900 text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sdpFiltered.map(r => (
                    <tr key={r.id} className="border-b border-white/5 hover:bg-white/2">
                      <td className="px-4 py-3 font-medium text-gray-100">{r.commodities?.name || '—'}</td>
                      <td className="px-4 py-3 text-xs text-gray-400">{r.commodities?.unit || '—'}</td>
                      <td className={`px-4 py-3 font-mono text-sm ${r.quantity === 0 ? 'text-gray-500' : 'text-gray-200'}`}>{r.quantity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-medium text-gray-100">Stock Levels</h1>
        <p className="text-sm text-gray-500 mt-1">Current stock on hand with months of stock</p>
      </div>

      <FacilityPicker />

      {store.canManageStock() && (
        fid
          ? <AmcWindowEditor facilityId={fid}
              facilityName={store.allFacilities.find(f => f.id === fid)?.name || store.currentFacility?.name}
              onSaved={loadData} />
          : <Card className="mb-4"><div className="px-4 py-3 text-xs text-gray-500">Select a single facility to configure its AMC window.</div></Card>
      )}

      <Card className="mb-4">
        <div className="px-4 py-3 flex gap-2 flex-wrap items-center">
          <button onClick={loadData} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">Refresh</button>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search commodity…"
            className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 placeholder:text-gray-600 focus:outline-none focus:border-blue-500 flex-1 min-w-[200px] max-w-xs" />
          {[
            [catFilter, setCat, 'All categories', [['','All categories'], ...availableCats.map(c => [c, c])]],
            [stsFilter, setSts, 'All statuses',   [['','All statuses'],['ok','Optimal'],['low','Low stock'],['out','Out of stock'],['over','Overstock']]],
            [sortBy, setSortBy, '', [['category','Sort by category'],['name','Sort by name'],['qty','Sort by qty'],['mos','Sort by MOS']]],
          ].map(([val, setter, , opts], i) => (
            <select key={i} value={val} onChange={e=>setter(e.target.value)}
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500">
              {opts.map(([v,l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          ))}
        </div>
      </Card>

      {loading ? <LoadingState /> : filtered.length === 0 ? <EmptyState message="No stock records match filters." /> :
        sortBy === 'category' ? (
          orderedCats.map(cat => (
            <Card key={cat} className="stick-cols">
              <CardHeader>
                <CardTitle>{cat}</CardTitle>
                <span className="text-xs text-gray-500">{byCategory[cat].length} commodities</span>
              </CardHeader>
              <div className="table-wrap">
                <StockLevelsTable items={byCategory[cat]} onDrill={(row, kind) => setDrill({ row, kind })} onBatchDrill={(row, bin = null) => setBatchDrill({ row, bin })} />
              </div>
            </Card>
          ))
        ) : (
          <Card className="stick-cols">
            <div className="table-wrap">
              <StockLevelsTable items={filtered} onDrill={(row, kind) => setDrill({ row, kind })} onBatchDrill={(row, bin = null) => setBatchDrill({ row, bin })} />
            </div>
          </Card>
        )
      }

      {drill && (
        <SiteBreakdownModal commodity={drill.row} kind={drill.kind} fid={fid} onClose={() => setDrill(null)} />
      )}

      {batchDrill && (
        <BatchBreakdownModal commodity={batchDrill.row} fid={fid}
          locationType={batchDrill.bin} onClose={() => setBatchDrill(null)} />
      )}
    </div>
  )
}
