import { useEffect, useState } from 'react'
import { useAppStore } from '../../store/appStore'
import { Card, CardHeader, CardTitle } from '../../components/ui/Card'
import { Badge, CatBadge } from '../../components/ui/Badge'
import { EmptyState } from '../../components/ui/Loading'
import { fmtStockQty, getCommodityDispenseUnit } from '../../utils/helpers'

export function AllFacilities() {
  const store  = useAppStore()
  const [search, setSearch]         = useState('')
  const [commFilter, setCommFilter] = useState('')
  const [selected, setSelected]     = useState(null) // commodity_id being drilled into

  const agg = {}
  store.stockData.forEach(r => {
    const k = r.commodity_id
    if (!agg[k]) agg[k] = { id:k, name:r.commodities?.name, cat:r.commodities?.category, comm:r.commodities, total:0, facs:0, low:0, out:0 }
    agg[k].total += r.quantity; agg[k].facs++
    if (r.quantity === 0) agg[k].out++
    else if (r.quantity < 10) agg[k].low++
  })

  const commOpts = Object.entries(agg).sort((a,b)=>a[1].name?.localeCompare(b[1].name))
  const items = commOpts
    .filter(([,r]) => (!search||(r.name?.toLowerCase()||'').includes(search.toLowerCase())) && (!commFilter||r.cat===commFilter))
    .map(([,r])=>r)
    .sort((a,b)=>b.out-a.out||b.low-a.low)

  const categories = [...new Set(Object.values(agg).map(r=>r.cat).filter(Boolean))].sort()

  // Drill-down: all stock rows for selected commodity, grouped by facility
  const facRows = selected
    ? store.stockData
        .filter(r => r.commodity_id === selected)
        .reduce((acc, r) => {
          const fid = r.facility_id
          if (!acc[fid]) acc[fid] = { name: r.facilities?.name||'—', state: r.facilities?.state||'—', lga: r.facilities?.lga||'—', store: 0, dispensary: 0, dsd: 0, total: 0, comm: r.commodities }
          acc[fid][r.location_type === 'store' ? 'store' : r.location_type === 'dispensary' ? 'dispensary' : 'dsd'] += r.quantity
          acc[fid].total += r.quantity
          return acc
        }, {})
    : {}
  const facList = Object.values(facRows).sort((a,b) => b.total - a.total)

  const selectedComm = selected ? agg[selected] : null

  if (selected) {
    return (
      <div>
        <div className="mb-6">
          <button onClick={() => setSelected(null)} className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1 mb-3">
            ← Back to all commodities
          </button>
          <h1 className="text-xl font-medium text-gray-100 flex items-center gap-2">
            {selectedComm?.name}
            <CatBadge>{selectedComm?.cat}</CatBadge>
          </h1>
          <p className="text-sm text-gray-500 mt-1">Stock by facility — {facList.length} reporting sites</p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          {[
            { label: 'Total stock', value: fmtStockQty(selectedComm?.total, selectedComm?.comm), color: 'text-gray-100' },
            { label: 'Reporting sites', value: facList.length, color: 'text-blue-400' },
            { label: 'Low stock sites', value: facList.filter(f=>f.total>0&&f.total<10).length, color: 'text-amber-400' },
            { label: 'Out of stock sites', value: facList.filter(f=>f.total===0).length, color: 'text-red-400' },
          ].map(m => (
            <div key={m.label} className="bg-white/3 border border-white/8 rounded-xl px-4 py-3">
              <div className="text-xs text-gray-500 uppercase tracking-widest mb-1">{m.label}</div>
              <div className={`text-xl font-bold font-mono ${m.color}`}>{m.value}</div>
            </div>
          ))}
        </div>

        <Card>
          <CardHeader><CardTitle>Facility breakdown</CardTitle></CardHeader>
          {facList.length === 0 ? <EmptyState message="No stock data."/> : (
            <div className="table-wrap"><table className="w-full text-sm">
              <thead><tr className="border-b border-white/8 bg-white/2">
                {['Facility','State','LGA','Store SOH','Dispensary SOH','DSD SOH','Total SOH','Status'].map(h=>(
                  <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                ))}
              </tr></thead>
              <tbody>{facList.map((f,i) => {
                const status = f.total === 0 ? { label:'Out of stock', type:'out' } : f.total < 10 ? { label:'Low stock', type:'low' } : { label:'In stock', type:'ok' }
                return (
                  <tr key={i} className="border-b border-white/5 hover:bg-white/2">
                    <td className="px-4 py-3 font-medium text-gray-100">{f.name}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">{f.state}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">{f.lga}</td>
                    <td className={`px-4 py-3 font-mono text-sm ${f.store===0?'text-gray-600':'text-gray-200'}`}>{fmtStockQty(f.store, f.comm)}</td>
                    <td className={`px-4 py-3 font-mono text-sm ${f.dispensary===0?'text-gray-600':'text-blue-300'}`}>{fmtStockQty(f.dispensary, f.comm)}</td>
                    <td className={`px-4 py-3 font-mono text-sm ${f.dsd===0?'text-gray-600':'text-purple-300'}`}>{fmtStockQty(f.dsd, f.comm)}</td>
                    <td className="px-4 py-3 font-mono text-sm font-semibold text-gray-100">{fmtStockQty(f.total, f.comm)}</td>
                    <td className="px-4 py-3"><Badge type={status.type}>{status.label}</Badge></td>
                  </tr>
                )
              })}</tbody>
            </table></div>
          )}
        </Card>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-medium text-gray-100 flex items-center gap-2">
          All Facilities Overview <span className="text-xs bg-purple-500/20 text-purple-400 border border-purple-500/30 rounded px-2 py-0.5">Admin</span>
        </h1>
        <p className="text-sm text-gray-500 mt-1">Tap a commodity to see stock by facility</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Stock by commodity — all facilities</CardTitle>
          <div className="flex gap-2 flex-wrap">
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search commodity…"
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 placeholder:text-gray-600 focus:outline-none focus:border-blue-500 w-48"/>
            <select value={commFilter} onChange={e=>setCommFilter(e.target.value)}
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500">
              <option value="">All categories</option>
              {categories.map(c=><option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </CardHeader>
        {items.length===0 ? <EmptyState message="No stock data yet."/> : (
          <div className="table-wrap"><table className="w-full text-sm">
            <thead><tr className="border-b border-white/8 bg-white/2">
              {['Commodity','Category','Unit','Total stock','Reporting sites','Low stock sites','Out of stock sites'].map(h=>(
                <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
              ))}
            </tr></thead>
            <tbody>{items.map((r,i)=>(
              <tr key={i} onClick={()=>setSelected(r.id)}
                className="border-b border-white/5 hover:bg-white/5 cursor-pointer transition-colors">
                <td className="px-4 py-3 font-medium text-blue-400 hover:text-blue-300">{r.name}</td>
                <td className="px-4 py-3"><CatBadge>{r.cat}</CatBadge></td>
                <td className="px-4 py-3 text-xs text-gray-500">{getCommodityDispenseUnit(r.comm)||'—'}</td>
                <td className="px-4 py-3 font-mono text-sm text-gray-200">{fmtStockQty(r.total,r.comm)}</td>
                <td className="px-4 py-3 text-gray-400">{r.facs}</td>
                <td className="px-4 py-3">{r.low>0?<Badge type="low">{r.low}</Badge>:<span className="text-gray-600">0</span>}</td>
                <td className="px-4 py-3">{r.out>0?<Badge type="out">{r.out}</Badge>:<span className="text-gray-600">0</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  )
}
