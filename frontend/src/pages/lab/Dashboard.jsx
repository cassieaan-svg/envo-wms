import { useEffect, useState } from 'react'
import { sb } from '../../lib/supabase'
import { useAppStore } from '../../store/appStore'
import { useStock } from '../../hooks/useStock'
import { Card, CardHeader, CardTitle } from '../../components/ui/Card'
import { MetricGrid, Metric } from '../../components/ui/Metric'
import { LoadingState, EmptyState } from '../../components/ui/Loading'
import { StockLevelsTable } from '../../components/StockLevelsTable'
import { SiteBreakdownModal } from '../../components/SiteBreakdownModal'
import { calcAMC, amcWindowStart, amcWindowEnd, getMOS, getStockStatus, groupStockByComm, SECTION_CATEGORIES } from '../../utils/helpers'

export function Dashboard() {
  const store            = useAppStore()
  const { loadStock }    = useStock()
  const commoditySection = store.commoditySection
  const sec = q => commoditySection ? q.eq('section', commoditySection) : q
  const [amcMap, setAmcMap]   = useState({})
  const [sdpMap, setSdpMap]   = useState({})
  const [search, setSearch]   = useState('')
  const [catFilter, setCat]   = useState('')
  const [stsFilter, setSts]   = useState('')
  const [drill, setDrill]     = useState(null)
  const [loading, setLoading] = useState(true)

  const fid = store.getEffectiveFacilityId()

  useEffect(() => {
    loadData()
  }, [fid])

  async function loadData() {
    setLoading(true)
    await loadStock()

    // Aggregate Service Delivery Point stock (lab has no dispensary/DSD)
    const sdpAgg = {}
    if (fid || store.currentFacility?.id) {
      const { data: sdpData } = await sb.from('sdp_stock')
        .select('commodity_id,quantity')
        .eq('facility_id', fid || store.currentFacility?.id)
      ;(sdpData || []).forEach(d => {
        sdpAgg[d.commodity_id] = (sdpAgg[d.commodity_id] || 0) + d.quantity
      })
    }
    setSdpMap(sdpAgg)

    // Load AMC = total dispensed in the completed 3-month period ÷ 2.
    const amcStart = amcWindowStart()
    const amcEnd = amcWindowEnd()
    const { data: dispData } = await sec(sb.from('dispense_log')
      .select('commodity_id,quantity,dispensed_at')
      .gte('dispensed_at', amcStart.toISOString())
      .lt('dispensed_at', amcEnd.toISOString())
      .eq('facility_id', fid || store.currentFacility?.id))

    const sums = {}
    ;(dispData || []).forEach(d => { sums[d.commodity_id] = (sums[d.commodity_id] || 0) + (d.quantity || 0) })
    const amc = {}
    Object.entries(sums).forEach(([id, total]) => { amc[id] = calcAMC(total) })
    setAmcMap(amc)
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
    }
  })
  const stockRows = groupedAll
    .filter(r => (!search || (r.commodities?.name||'').toLowerCase().includes(search.toLowerCase()))
              && (!catFilter || r.commodities?.category === catFilter))
    .map(r => {
      const amc = getAMC(r)
      return { ...r, _isLab: true, amc, status: getStockStatus(r.quantity, amc), mos: getMOS(r.quantity, amc) }
    })
    .filter(r => !stsFilter || r.status === stsFilter)
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

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-medium text-gray-100 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse inline-block" />
          Dashboard
        </h1>
        <p className="text-sm text-gray-500 mt-1">Real-time stock overview for your facility</p>
      </div>

      <MetricGrid>
        <Metric label="Commodities tracked" value={groupedAll.length} color="blue" onClick={()=>setSts('')} active={stsFilter===''} />
        <Metric label="Optimal stock"  value={groupedAll.filter(r=>getStatus(r)==='ok').length}   color="green" onClick={()=>setSts(s=>s==='ok'?'':'ok')}     active={stsFilter==='ok'} />
        <Metric label="Low stock"     value={groupedAll.filter(r=>getStatus(r)==='low').length}  color="amber" onClick={()=>setSts(s=>s==='low'?'':'low')}   active={stsFilter==='low'} />
        <Metric label="Out of stock"  value={groupedAll.filter(r=>getStatus(r)==='out').length}  color="red"   onClick={()=>setSts(s=>s==='out'?'':'out')}   active={stsFilter==='out'} />
        <Metric label="Overstock"     value={groupedAll.filter(r=>getStatus(r)==='over').length} color="blue"  onClick={()=>setSts(s=>s==='over'?'':'over')} active={stsFilter==='over'} />
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
        <SiteBreakdownModal commodity={drill.row} kind={drill.kind} fid={fid || store.currentFacility?.id} onClose={() => setDrill(null)} />
      )}
    </div>
  )
}
