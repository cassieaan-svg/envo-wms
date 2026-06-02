import { useEffect, useState } from 'react'
import { sb } from '../../lib/supabase'
import { useAppStore } from '../../store/appStore'
import { useStock } from '../../hooks/useStock'
import { Card, CardHeader, CardTitle } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { LoadingState, EmptyState } from '../../components/ui/Loading'
import { calcAtypicalAMC, getMOS, getStockStatus, fmtStockQty, groupStockByComm } from '../../utils/helpers'
import { FacilityPicker } from '../../components/ui/FacilityPicker'

export function Stock() {
  const store         = useAppStore()
  const { loadStock } = useStock()
  const commoditySection = store.commoditySection
  const sec = q => commoditySection ? q.eq('section', commoditySection) : q
  const [rows, setRows]       = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch]   = useState('')
  const [catFilter, setCat]   = useState('')
  const [stsFilter, setSts]   = useState('')
  const [sortBy, setSortBy]   = useState('category')

  const fid = store.getEffectiveFacilityId() || store.currentFacility?.id
  const facilityRole = useAppStore(s => s.facilityRole)
  const accessLevel  = useAppStore(s => s.accessLevel)
  const dsdSiteName  = useAppStore(s => s.dsdSiteName)
  const isDSD = accessLevel === 'facility' && facilityRole === 'dsd'

  useEffect(() => { loadData() }, [fid, dsdSiteName])

  async function loadData() {
    setLoading(true)

    if (isDSD) {
      if (!fid || !dsdSiteName) { setRows([]); setLoading(false); return }
      const { data } = await sb.from('dsd_stock')
        .select('*, commodities(name,unit,category)')
        .eq('facility_id', fid)
        .eq('dsd_site_name', dsdSiteName)
        .order('commodities(name)')
      setRows(data || [])
      setLoading(false)
      return
    }

    await loadStock()

    const threeMonthsAgo = new Date()
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3)
    const commIds = store.stockData.map(r => r.commodity_id)

    let amcMap = {}
    if (commIds.length && fid) {
      const { data } = await sec(sb.from('dispense_log')
        .select('commodity_id,quantity,dispensed_at')
        .gte('dispensed_at', threeMonthsAgo.toISOString())
        .in('commodity_id', commIds)
        .eq('facility_id', fid))

      const grouped = {}
      ;(data || []).forEach(d => {
        const month = d.dispensed_at.slice(0, 7)
        if (!grouped[d.commodity_id]) grouped[d.commodity_id] = {}
        grouped[d.commodity_id][month] = (grouped[d.commodity_id][month] || 0) + d.quantity
      })
      Object.entries(grouped).forEach(([id, months]) => {
        const vals = Object.values(months).sort((a,b) => b-a)
        amcMap[id] = vals.length >= 2 ? (vals[0]+vals[1])/2 : vals[0] || 0
      })
    }

    // Fetch DSD stock data and aggregate by commodity
    let dsdMap = {}
    if (fid) {
      const { data: dsdData } = await sb.from('dsd_stock')
        .select('commodity_id,quantity')
        .eq('facility_id', fid)
      ;(dsdData || []).forEach(d => {
        dsdMap[d.commodity_id] = (dsdMap[d.commodity_id] || 0) + d.quantity
      })
    }

    const grouped = groupStockByComm(store.stockData)
    const enriched = grouped.map(r => {
      const calcAmc = amcMap[r.commodity_id]
      const amc     = calcAmc && calcAmc > 0 ? +calcAmc.toFixed(1) : +(r.baseline_amc || 0).toFixed(1)
      const mos     = getMOS(r.quantity, amc)
      const status  = getStockStatus(r.quantity, amc)
      // Use dsdMap to populate dsdQty from dsd_stock table instead of stock table location_type
      return { ...r, dsdQty: dsdMap[r.commodity_id] || 0, amc, mos, status, quantity: r.storeQty + r.dispensaryQty + (dsdMap[r.commodity_id] || 0) }
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
      return c !== 0 ? c : (a.commodities?.name||'').localeCompare(b.commodities?.name||'')
    })

  const statusBadge = { out:'out', low:'low', ok:'ok', over:'over', unknown:'unknown' }
  const statusLabel = { out:'Out of stock', low:'Low stock', ok:'In stock', over:'Overstock', unknown:'No AMC data' }
  const mosColor    = { out:'text-red-400', low:'text-red-400', ok:'text-green-400', over:'text-blue-400', unknown:'text-gray-500' }

  // Group by category if sorting by category
  const byCategory = {}
  if (sortBy === 'category') {
    filtered.forEach(r => {
      const cat = r.commodities?.category || 'Other'
      if (!byCategory[cat]) byCategory[cat] = []
      byCategory[cat].push(r)
    })
  }

  const TableRows = ({ items }) => items.map(r => (
    <tr key={r.id} className="border-b border-white/5 hover:bg-white/2">
      <td className="px-4 py-3 font-medium text-gray-100">{r.commodities?.name||'—'}</td>
      <td className="px-4 py-3 text-xs text-gray-400">{r.commodities?.unit||'—'}</td>
      <td className={`px-4 py-3 font-mono text-sm ${r.storeQty===0?'text-gray-500':'text-gray-200'}`}>
        {fmtStockQty(r.storeQty, r.commodities)}
      </td>
      <td className={`px-4 py-3 font-mono text-sm ${r.dispensaryQty===0?'text-gray-500':'text-blue-300'}`}>
        {fmtStockQty(r.dispensaryQty, r.commodities)}
      </td>
      <td className={`px-4 py-3 font-mono text-sm ${r.dsdQty===0?'text-gray-500':'text-purple-300'}`}>
        {fmtStockQty(r.dsdQty, r.commodities)}
      </td>
      <td className="px-4 py-3 font-mono text-sm text-gray-200">
        {fmtStockQty(r.quantity, r.commodities)}
      </td>
      <td className="px-4 py-3 font-mono text-xs text-gray-500">{r.amc > 0 ? r.amc : '—'}</td>
      <td className={`px-4 py-3 font-mono text-sm font-medium ${mosColor[r.status]}`}>
        {r.mos !== null ? `${r.mos}mo` : '—'}
      </td>
      <td className="px-4 py-3"><Badge type={statusBadge[r.status]}>{statusLabel[r.status]}</Badge></td>
    </tr>
  ))

  const THead = () => (
    <thead>
      <tr className="border-b border-white/8 bg-white/2">
        {['Commodity','Unit','Store SOH','Dispensary SOH','DSD SOH','Total SOH','AMC','MOS','Status'].map(h => (
          <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
        ))}
      </tr>
    </thead>
  )

  if (isDSD) {
    const dsdFiltered = rows.filter(r =>
      !search || (r.commodities?.name || '').toLowerCase().includes(search.toLowerCase())
    )
    return (
      <div>
        <div className="mb-6">
          <h1 className="text-xl font-medium text-gray-100">Stock Levels</h1>
          <p className="text-sm text-gray-500 mt-1">Stock on hand for {dsdSiteName}</p>
        </div>
        <Card className="mb-4">
          <div className="px-4 py-3 flex gap-2 flex-wrap items-center">
            <button onClick={loadData} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">Refresh</button>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search commodity…"
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 placeholder:text-gray-600 focus:outline-none focus:border-blue-500 flex-1 min-w-[200px] max-w-xs" />
          </div>
        </Card>
        {loading ? <LoadingState /> : dsdFiltered.length === 0 ? <EmptyState message="No stock records found." /> : (
          <Card>
            <div className="table-wrap">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/8 bg-white/2">
                    {['Commodity','Unit','Stock on Hand'].map(h => (
                      <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dsdFiltered.map(r => (
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

      <Card className="mb-4">
        <div className="px-4 py-3 flex gap-2 flex-wrap items-center">
          <button onClick={loadData} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">Refresh</button>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search commodity…"
            className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 placeholder:text-gray-600 focus:outline-none focus:border-blue-500 flex-1 min-w-[200px] max-w-xs" />
          {[
            [catFilter, setCat, 'All categories', [['','All categories'],['Pharmacy drugs','Pharmacy drugs'],['Medical supplies','Medical supplies']]],
            [stsFilter, setSts, 'All statuses',   [['','All statuses'],['out','Out of stock'],['low','Low stock'],['ok','OK'],['over','Overstock']]],
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
          Object.entries(byCategory).sort().map(([cat, items]) => (
            <Card key={cat}>
              <CardHeader>
                <CardTitle>{cat}</CardTitle>
                <span className="text-xs text-gray-500">{items.length} commodities</span>
              </CardHeader>
              <div className="table-wrap">
                <table className="w-full text-sm"><THead /><tbody><TableRows items={items} /></tbody></table>
              </div>
            </Card>
          ))
        ) : (
          <Card>
            <div className="table-wrap">
              <table className="w-full text-sm"><THead /><tbody><TableRows items={filtered} /></tbody></table>
            </div>
          </Card>
        )
      }
    </div>
  )
}
