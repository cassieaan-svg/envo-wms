import { useEffect, useState } from 'react'
import { sb } from '../../lib/supabase'
import { useAppStore } from '../../store/appStore'
import { Card, CardHeader, CardTitle } from '../../components/ui/Card'
import { Metric } from '../../components/ui/Metric'
import { Badge, CatBadge } from '../../components/ui/Badge'
import { EmptyState } from '../../components/ui/Loading'
import { fmtStockQty, getCommodityDispenseUnit, isLabCategory, getStockStatus, getMOS } from '../../utils/helpers'

export function AllFacilities() {
  const store  = useAppStore()
  const [search, setSearch]         = useState('')
  const [commFilter, setCommFilter] = useState('')
  const [selected, setSelected]     = useState(null) // commodity_id being drilled into
  // Per-commodity SDP/DSD site stock (separate tables) across the admin's
  // facilities, so overview totals include them — not just the main store.
  const [siteByComm, setSiteByComm] = useState({ sdp: {}, dsd: {} })
  const [siteFilter, setSiteFilter] = useState('')   // breakdown card filter: '', low, out, over

  const agg = {}
  // Seed from every tracked commodity so zero-stock items and their
  // categories (e.g. Lab consumables) still appear in the list and filter.
  store.allCommodities.forEach(c => {
    agg[c.id] = { id:c.id, name:c.name, cat:c.category, comm:c, facMap:{} }
  })
  // Group by facility (summing location rows) and carry the facility's AMC so
  // status is MOS-based — matching the Dashboard — instead of a flat threshold.
  store.stockData.forEach(r => {
    const k = r.commodity_id
    if (!agg[k]) agg[k] = { id:k, name:r.commodities?.name, cat:r.commodities?.category, comm:r.commodities, facMap:{} }
    const fid = r.facility_id
    if (!agg[k].facMap[fid]) agg[k].facMap[fid] = { total:0, amc:0 }
    agg[k].facMap[fid].total += r.quantity
    if ((r.baseline_amc || 0) > agg[k].facMap[fid].amc) agg[k].facMap[fid].amc = r.baseline_amc || 0
  })
  // Fold in SDP (lab) and DSD (pharmacy) site stock so totals/status reflect
  // the full picture, not just the main store.
  Object.values(agg).forEach(c => {
    const siteMap = isLabCategory(c.cat) ? siteByComm.sdp[c.id] : siteByComm.dsd[c.id]
    if (!siteMap) return
    Object.entries(siteMap).forEach(([fid, qty]) => {
      if (!c.facMap[fid]) c.facMap[fid] = { total:0, amc:0 }
      c.facMap[fid].total += qty
    })
  })
  // Derive per-commodity totals + status-site counts (out / low / over).
  Object.values(agg).forEach(c => {
    const facs = Object.values(c.facMap)
    c.total = facs.reduce((s,f) => s + f.total, 0)
    c.facs  = facs.length
    c.low = 0; c.out = 0; c.over = 0
    facs.forEach(f => {
      const st = getStockStatus(f.total, f.amc)
      if (st === 'out')       c.out++
      else if (st === 'low')  c.low++
      else if (st === 'over') c.over++
    })
  })

  const commOpts = Object.entries(agg).sort((a,b)=>a[1].name?.localeCompare(b[1].name))
  const items = commOpts
    .filter(([,r]) => (!search||(r.name?.toLowerCase()||'').includes(search.toLowerCase())) && (!commFilter||r.cat===commFilter))
    .map(([,r])=>r)
    .sort((a,b)=>b.out-a.out||b.low-a.low)

  const categories = [...new Set(Object.values(agg).map(r=>r.cat).filter(Boolean))].sort()

  const selectedComm = selected ? agg[selected] : null
  const isLabSel = !!selectedComm && isLabCategory(selectedComm.cat)

  // Load all SDP / DSD site stock once (paginated, scoped to the admin's
  // facilities) so both the overview and the drill-down can include them.
  useEffect(() => {
    let active = true
    const facIds = store.isOverallAdmin() ? null : store.allFacilities.map(f => f.id)
    const fetchAll = async (table) => {
      const map = {}
      const PAGE = 1000
      for (let offset = 0; ; offset += PAGE) {
        let q = sb.from(table).select('commodity_id,facility_id,quantity').range(offset, offset + PAGE - 1)
        if (facIds && facIds.length) q = q.in('facility_id', facIds)
        const { data, error } = await q
        if (error || !data || !data.length) break
        data.forEach(d => {
          if (!map[d.commodity_id]) map[d.commodity_id] = {}
          map[d.commodity_id][d.facility_id] = (map[d.commodity_id][d.facility_id] || 0) + d.quantity
        })
        if (data.length < PAGE) break
      }
      return map
    }
    Promise.all([fetchAll('sdp_stock'), fetchAll('dsd_stock')]).then(([sdp, dsd]) => {
      if (active) setSiteByComm({ sdp, dsd })
    })
    return () => { active = false }
  }, [])

  // Reset the breakdown card filter when switching commodity.
  useEffect(() => { setSiteFilter('') }, [selected])

  // Drill-down: stock rows for the selected commodity, grouped by facility
  const facRows = selected
    ? store.stockData
        .filter(r => r.commodity_id === selected)
        .reduce((acc, r) => {
          const fid = r.facility_id
          if (!acc[fid]) acc[fid] = { name: r.facilities?.name||'—', state: r.facilities?.state||'—', lga: r.facilities?.lga||'—', store: 0, dispensary: 0, dsd: 0, sdp: 0, total: 0, amc: 0, comm: r.commodities }
          acc[fid][r.location_type === 'store' ? 'store' : r.location_type === 'dispensary' ? 'dispensary' : 'dsd'] += r.quantity
          if ((r.baseline_amc || 0) > acc[fid].amc) acc[fid].amc = r.baseline_amc || 0
          return acc
        }, {})
    : {}

  // Fold in the selected commodity's SDP (lab) / DSD (pharmacy) site stock,
  // including facilities that only have site stock (no store row).
  if (selected) {
    const ensure = fid => {
      if (!facRows[fid]) {
        const f = store.allFacilities.find(x => x.id === fid)
        facRows[fid] = { name: f?.name||'—', state: f?.state||'—', lga: f?.lga||'—', store: 0, dispensary: 0, dsd: 0, sdp: 0, total: 0, amc: 0, comm: selectedComm?.comm }
      }
      return facRows[fid]
    }
    const siteMap = isLabSel ? (siteByComm.sdp[selected] || {}) : (siteByComm.dsd[selected] || {})
    Object.entries(siteMap).forEach(([fid, qty]) => {
      const f = ensure(fid)
      if (isLabSel) f.sdp += qty
      else          f.dsd += qty
    })
  }

  // Totals: lab = store + SDP; pharmacy = store + dispensary + DSD
  Object.values(facRows).forEach(f => {
    f.total = isLabSel ? (f.store + (f.sdp || 0)) : (f.store + f.dispensary + f.dsd)
  })
  const facList = Object.values(facRows).sort((a,b) => b.total - a.total)
  const drillTotal = facList.reduce((s, f) => s + f.total, 0)
  const siteCounts = {
    low:  facList.filter(f => getStockStatus(f.total, f.amc) === 'low').length,
    out:  facList.filter(f => getStockStatus(f.total, f.amc) === 'out').length,
    over: facList.filter(f => getStockStatus(f.total, f.amc) === 'over').length,
  }
  // Clicking a status card filters the breakdown table to those sites.
  const shownFacs = siteFilter
    ? facList.filter(f => getStockStatus(f.total, f.amc) === siteFilter)
    : facList

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

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
          <Metric label="Total stock" value={fmtStockQty(drillTotal, selectedComm?.comm)} />
          <Metric label="Reporting sites" value={facList.length} color="blue" />
          <Metric label="Low stock sites" value={siteCounts.low} color="amber"
            onClick={() => setSiteFilter(siteFilter === 'low' ? '' : 'low')} active={siteFilter === 'low'} />
          <Metric label="Out of stock sites" value={siteCounts.out} color="red"
            onClick={() => setSiteFilter(siteFilter === 'out' ? '' : 'out')} active={siteFilter === 'out'} />
          <Metric label="Overstock sites" value={siteCounts.over} color="blue"
            onClick={() => setSiteFilter(siteFilter === 'over' ? '' : 'over')} active={siteFilter === 'over'} />
        </div>

        <Card>
          <CardHeader><CardTitle>Facility breakdown</CardTitle></CardHeader>
          {shownFacs.length === 0 ? <EmptyState message={siteFilter ? `No ${siteFilter === 'out' ? 'out-of-stock' : siteFilter === 'over' ? 'overstocked' : 'low-stock'} sites.` : 'No stock data.'}/> : (
            <div className="table-wrap"><table className="w-full text-sm">
              <thead><tr className="border-b border-white/8 bg-white/2">
                {(isLabSel
                  ? ['Facility','State','LGA','Store SOH','SDP SOH','Total SOH','MOS','Status']
                  : ['Facility','State','LGA','Store SOH','Dispensary SOH','DSD SOH','Total SOH','MOS','Status']
                ).map(h=>(
                  <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                ))}
              </tr></thead>
              <tbody>{shownFacs.map((f,i) => {
                const st = getStockStatus(f.total, f.amc)
                const statusLabel = { out:'Out of stock', low:'Low stock', ok:'In stock', over:'Overstock', unknown:'No AMC data' }[st] || st
                const mos = getMOS(f.total, f.amc)
                return (
                  <tr key={i} className="border-b border-white/5 hover:bg-white/2">
                    <td className="px-4 py-3 font-medium text-gray-100">{f.name}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">{f.state}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">{f.lga}</td>
                    <td className={`px-4 py-3 font-mono text-sm ${f.store===0?'text-gray-600':'text-gray-200'}`}>{fmtStockQty(f.store, f.comm)}</td>
                    {isLabSel ? (
                      <td className={`px-4 py-3 font-mono text-sm ${(f.sdp||0)===0?'text-gray-600':'text-blue-300'}`}>{fmtStockQty(f.sdp||0, f.comm)}</td>
                    ) : (
                      <>
                        <td className={`px-4 py-3 font-mono text-sm ${f.dispensary===0?'text-gray-600':'text-blue-300'}`}>{fmtStockQty(f.dispensary, f.comm)}</td>
                        <td className={`px-4 py-3 font-mono text-sm ${f.dsd===0?'text-gray-600':'text-purple-300'}`}>{fmtStockQty(f.dsd, f.comm)}</td>
                      </>
                    )}
                    <td className="px-4 py-3 font-mono text-sm font-semibold text-gray-100">{fmtStockQty(f.total, f.comm)}</td>
                    <td className="px-4 py-3 font-mono text-sm text-gray-400">{mos !== null ? `${mos}mo` : '—'}</td>
                    <td className="px-4 py-3"><Badge type={st}>{statusLabel}</Badge></td>
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
              {['Commodity','Category','Unit','Total stock','Reporting sites','Low stock sites','Out of stock sites','Overstock sites'].map(h=>(
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
                <td className="px-4 py-3">{r.over>0?<Badge type="over">{r.over}</Badge>:<span className="text-gray-600">0</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  )
}
