import { useEffect, useState } from 'react'
import { sb } from '../../lib/supabase'
import { useAppStore } from '../../store/appStore'
import { useStock } from '../../hooks/useStock'
import { Card, CardHeader, CardTitle } from '../../components/ui/Card'
import { MetricGrid, Metric } from '../../components/ui/Metric'
import { LoadingState, EmptyState } from '../../components/ui/Loading'
import { StockLevelsTable } from '../../components/StockLevelsTable'
import { calcAtypicalAMC, getMOS, getStockStatus, groupStockByComm, todayLagos, isLabCategory } from '../../utils/helpers'
import { FacilityPicker } from '../../components/ui/FacilityPicker'

export function Dashboard() {
  const store            = useAppStore()
  const { loadStock }    = useStock()
  const commoditySection = store.commoditySection
  const sec = q => commoditySection ? q.eq('section', commoditySection) : q
  const [amcMap, setAmcMap]   = useState({})
  const [search, setSearch]   = useState('')
  const [catFilter, setCat]   = useState('')
  const [todayCount, setTodayCount] = useState('—')
  const [sdpMap, setSdpMap]   = useState({})
  const [dsdMap, setDsdMap]   = useState({})
  const [loading, setLoading] = useState(true)

  const fid = store.getEffectiveFacilityId()

  useEffect(() => {
    loadData()
  }, [fid])

  async function loadData() {
    setLoading(true)
    await loadStock()

    // Aggregate DSD (pharmacy) and SDP (lab) stock by commodity
    const facId = fid || store.currentFacility?.id
    const sdpAgg = {}, dsdAgg = {}
    if (facId) {
      const [{ data: dsdData }, { data: sdpData }] = await Promise.all([
        sb.from('dsd_stock').select('commodity_id,quantity').eq('facility_id', facId),
        sb.from('sdp_stock').select('commodity_id,quantity').eq('facility_id', facId),
      ])
      ;(dsdData || []).forEach(d => { dsdAgg[d.commodity_id] = (dsdAgg[d.commodity_id] || 0) + d.quantity })
      ;(sdpData || []).forEach(d => { sdpAgg[d.commodity_id] = (sdpAgg[d.commodity_id] || 0) + d.quantity })
    }
    setDsdMap(dsdAgg)
    setSdpMap(sdpAgg)

    // Load AMC
    const threeMonthsAgo = new Date()
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3)
    const { data: dispData } = await sec(sb.from('dispense_log')
      .select('commodity_id,quantity,dispensed_at')
      .gte('dispensed_at', threeMonthsAgo.toISOString())
      .eq('facility_id', fid || store.currentFacility?.id))

    const grouped = {}
    ;(dispData || []).forEach(d => {
      const month = d.dispensed_at.slice(0, 7)
      if (!grouped[d.commodity_id]) grouped[d.commodity_id] = {}
      grouped[d.commodity_id][month] = (grouped[d.commodity_id][month] || 0) + d.quantity
    })
    const amc = {}
    Object.entries(grouped).forEach(([id, months]) => {
      amc[id] = calcAtypicalAMC(Object.entries(months).map(([k,v]) => ({ dispensed_at: k+'-01', quantity: v })))
    })
    setAmcMap(amc)

    // Today's dispense count
    const today = todayLagos()
    const { count } = await sec(sb.from('dispense_log')
      .select('*', { count: 'exact', head: true })
      .gte('dispensed_at', today + 'T00:00:00')
      .eq('facility_id', fid || store.currentFacility?.id))
    setTodayCount(count || 0)
    setLoading(false)
  }

  const getAMC = r => amcMap[r.commodity_id] && amcMap[r.commodity_id] > 0 ? amcMap[r.commodity_id] : (r.baseline_amc || 0)

  // Lab total = store + SDP; pharmacy total = store + dispensary + DSD
  const enrichedAll = groupStockByComm(store.stockData).map(r => {
    const lab      = isLabCategory(r.commodities?.category)
    const dsdQty   = dsdMap[r.commodity_id] || 0
    const sdpQty   = sdpMap[r.commodity_id] || 0
    const quantity = lab ? (r.storeQty + sdpQty) : (r.storeQty + r.dispensaryQty + dsdQty)
    const amc      = getAMC(r)
    return { ...r, dsdQty, sdpQty, _isLab: lab, quantity, amc, mos: getMOS(quantity, amc), status: getStockStatus(quantity, amc) }
  })

  const statusOrder = { out:0, low:1, unknown:2, ok:3, over:4 }
  const stockRows = enrichedAll
    .filter(r => (!search || (r.commodities?.name||'').toLowerCase().includes(search.toLowerCase()))
              && (!catFilter || r.commodities?.category === catFilter))
    .sort((a, b) => (statusOrder[a.status] - statusOrder[b.status])
                 || (a.commodities?.name||'').localeCompare(b.commodities?.name||''))

  // Group by category to mirror the Stock Levels arrangement
  const byCategory = {}
  stockRows.forEach(r => {
    const cat = r.commodities?.category || 'Other'
    if (!byCategory[cat]) byCategory[cat] = []
    byCategory[cat].push(r)
  })
  const availableCats = [...new Set(enrichedAll.map(r => r.commodities?.category).filter(Boolean))].sort()

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

      <MetricGrid>
        <Metric label="Commodities tracked" value={enrichedAll.length} color="blue" />
        <Metric label="Well stocked"  value={enrichedAll.filter(r=>r.status==='ok').length}   color="green" />
        <Metric label="Low stock"     value={enrichedAll.filter(r=>r.status==='low').length}  color="amber" />
        <Metric label="Out of stock"  value={enrichedAll.filter(r=>r.status==='out').length}  color="red" />
        <Metric label="Stock consumed today" value={todayCount} />
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
        Object.entries(byCategory).sort().map(([cat, items]) => (
          <Card key={cat}>
            <CardHeader>
              <CardTitle>{cat}</CardTitle>
              <span className="text-xs text-gray-500">{items.length} commodities</span>
            </CardHeader>
            <div className="table-wrap">
              <StockLevelsTable items={items} />
            </div>
          </Card>
        ))
      )}
    </div>
  )
}
