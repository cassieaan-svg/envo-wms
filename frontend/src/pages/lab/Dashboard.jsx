import { useEffect, useState } from 'react'
import { sb } from '../../lib/supabase'
import { useAppStore } from '../../store/appStore'
import { useStock } from '../../hooks/useStock'
import { Card, CardHeader, CardTitle, CardBody } from '../../components/ui/Card'
import { MetricGrid, Metric } from '../../components/ui/Metric'
import { Badge, CatBadge } from '../../components/ui/Badge'
import { LoadingState, EmptyState } from '../../components/ui/Loading'
import { calcAtypicalAMC, getMOS, getStockStatus, fmtStockQty, groupStockByComm, todayLagos } from '../../utils/helpers'

export function Dashboard() {
  const store            = useAppStore()
  const { loadStock }    = useStock()
  const commoditySection = store.commoditySection
  const sec = q => commoditySection ? q.eq('section', commoditySection) : q
  const [amcMap, setAmcMap]   = useState({})
  const [sdpMap, setSdpMap]   = useState({})
  const [search, setSearch]   = useState('')
  const [catFilter, setCat]   = useState('')
  const [todayCount, setTodayCount] = useState('—')
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

  const getAMC  = r => amcMap[r.commodity_id] && amcMap[r.commodity_id] > 0 ? amcMap[r.commodity_id] : (r.baseline_amc || 0)
  const getStatus = r => getStockStatus(r.quantity, getAMC(r))

  // Lab total = store + SDP (no dispensary/DSD). Override quantity so status/MOS use it.
  const groupedAll = groupStockByComm(store.stockData).map(r => ({
    ...r,
    sdpQty: sdpMap[r.commodity_id] || 0,
    quantity: r.storeQty + (sdpMap[r.commodity_id] || 0),
  }))
  const stockRows = groupedAll
    .filter(r => (!search || (r.commodities?.name||'').toLowerCase().includes(search.toLowerCase()))
              && (!catFilter || r.commodities?.category === catFilter))
    .map(r => ({ ...r, _amc: getAMC(r), _status: getStatus(r), _mos: getMOS(r.quantity, getAMC(r)) }))
    .sort((a, b) => {
      const order = { out:0, low:1, unknown:2, ok:3, over:4 }
      return order[a._status] - order[b._status]
    })

  const statusBadge = { out:'out', low:'low', ok:'ok', over:'over', unknown:'unknown' }
  const statusLabel = { out:'Out of stock', low:'Low stock', ok:'In stock', over:'Overstock', unknown:'No data' }
  const mosColor    = { out:'text-red-400', low:'text-red-400', ok:'text-green-400', over:'text-blue-400', unknown:'text-gray-500' }

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
        <Metric label="Commodities tracked" value={groupedAll.length} color="blue" />
        <Metric label="Optimal stock"  value={groupedAll.filter(r=>getStatus(r)==='ok').length}   color="green" />
        <Metric label="Low stock"     value={groupedAll.filter(r=>getStatus(r)==='low').length}  color="amber" />
        <Metric label="Out of stock"  value={groupedAll.filter(r=>getStatus(r)==='out').length}  color="red" />
        <Metric label="Stock utilized today" value={todayCount} />
      </MetricGrid>

      <Card>
        <CardHeader>
          <CardTitle>Stock status — all commodities</CardTitle>
          <div className="flex gap-2 flex-wrap">
            <button onClick={loadData} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">Refresh</button>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search commodity…"
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 placeholder:text-gray-600 focus:outline-none focus:border-blue-500 w-48"
            />
            <select
              value={catFilter}
              onChange={e => setCat(e.target.value)}
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500"
            >
              <option value="">All categories</option>
              <option>RTKs</option>
              <option>Lab reagents</option>
              <option>Lab consumables</option>
            </select>
          </div>
        </CardHeader>
        {loading ? <LoadingState message="Loading stock…" /> : stockRows.length === 0 ? <EmptyState message="No stock records yet." /> : (
          <div className="table-wrap">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/8 bg-white/2">
                  {['Commodity','Category','Store SOH','SDP SOH','Total SOH','AMC','MOS','Status'].map(h => (
                    <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stockRows.map(r => (
                  <tr key={r.id} className="border-b border-white/5 hover:bg-white/2 transition-colors">
                    <td className="px-4 py-3 font-medium text-gray-100">{r.commodities?.name || '—'}</td>
                    <td className="px-4 py-3"><CatBadge>{r.commodities?.category || '—'}</CatBadge></td>
                    <td className={`px-4 py-3 font-mono text-sm ${r.storeQty===0?'text-gray-500':'text-gray-200'}`}>
                      {fmtStockQty(r.storeQty, r.commodities)}
                    </td>
                    <td className={`px-4 py-3 font-mono text-sm ${r.sdpQty===0?'text-gray-500':'text-blue-300'}`}>
                      {fmtStockQty(r.sdpQty, r.commodities)}
                    </td>
                    <td className="px-4 py-3 font-mono text-sm text-gray-200">
                      {fmtStockQty(r.quantity, r.commodities)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">{r._amc > 0 ? r._amc.toFixed(1) : '—'}</td>
                    <td className={`px-4 py-3 font-mono text-sm font-medium ${mosColor[r._status]}`}>
                      {r._mos !== null ? `${r._mos}mo` : '—'}
                    </td>
                    <td className="px-4 py-3"><Badge type={statusBadge[r._status]}>{statusLabel[r._status]}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
