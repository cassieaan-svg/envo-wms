import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/appStore'
import { Card, CardHeader, CardTitle } from '../../components/ui/Card'
import { Metric } from '../../components/ui/Metric'
import { Badge, CatBadge } from '../../components/ui/Badge'
import { LoadingState, EmptyState } from '../../components/ui/Loading'
import { toast } from '../../components/ui/Toast'
import { FacilityPicker } from '../../components/ui/FacilityPicker'
import { useStock } from '../../hooks/useStock'
import { fmtStockQty, getCommodityDispenseUnit, isLabCategory, getStockStatus, getMOS } from '../../utils/helpers'

// Build a CSV from a header row + data rows and trigger a download. Fields with
// commas / quotes / newlines are quoted and internal quotes doubled.
function exportCsv(filename, headers, rows) {
  const esc = v => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = [headers, ...rows].map(r => r.map(esc).join(',')).join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
  toast('CSV exported', 'green')
}

// Build a printable HTML table and open the browser print dialog (Save as PDF).
// Matches the app's existing print-to-PDF pattern (CRRF / Transfers).
function exportPdf(title, subtitle, headers, rows, rightCols = new Set()) {
  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  const thead = `<tr>${headers.map((h, i) => `<th class="${rightCols.has(i) ? 'r' : ''}">${esc(h)}</th>`).join('')}</tr>`
  const tbody = rows.map(r => `<tr>${r.map((c, i) => `<td class="${rightCols.has(i) ? 'r' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')
  const styles = `
    *{font-family:Arial,Helvetica,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    h1{font-size:16px;margin:0 0 4px;} .sub{font-size:12px;color:#444;margin:0 0 2px;}
    .meta{font-size:10px;color:#888;margin:0 0 12px;}
    table{width:100%;border-collapse:collapse;font-size:11px;}
    th,td{border:1px solid #ccc;padding:5px 7px;text-align:left;}
    th{background:#f0f0f0;} td.r,th.r{text-align:right;} tr:nth-child(even) td{background:#fafafa;}
    @page{size:landscape;margin:12mm;}`
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${styles}</style></head>`
    + `<body><h1>${esc(title)}</h1>${subtitle ? `<p class="sub">${esc(subtitle)}</p>` : ''}`
    + `<p class="meta">Generated ${esc(new Date().toLocaleString('en-GB'))}</p>`
    + `<table><thead>${thead}</thead><tbody>${tbody}</tbody></table></body></html>`
  const url = URL.createObjectURL(new Blob([doc], { type: 'text/html' }))
  const win = window.open(url, '_blank')
  if (win) {
    win.onload = () => { win.focus(); win.print(); URL.revokeObjectURL(url); win.onafterprint = () => win.close() }
  } else {
    URL.revokeObjectURL(url)
    toast('Allow pop-ups to download the PDF', 'red')
  }
}

export function AllFacilities() {
  const store  = useAppStore()
  const [search, setSearch]         = useState('')
  const [commFilter, setCommFilter] = useState('')
  const [selected, setSelected]     = useState(null) // commodity_id being drilled into
  // Per-commodity SDP/DSD site stock (separate tables) across the admin's
  // facilities, so overview totals include them — not just the main store.
  const [siteByComm, setSiteByComm] = useState({ sdp: {}, dsd: {} })
  // Per-commodity set of facility ids that consumed it in the last 12 months,
  // so a site with a consumption track record counts as reporting even at 0 stock.
  const [consByComm, setConsByComm] = useState({})
  const [siteFilter, setSiteFilter] = useState('')   // breakdown card filter: '', low, out, over
  const [facSearch, setFacSearch]   = useState('')   // breakdown table: facility name search
  const [refreshKey, setRefreshKey] = useState(0)    // bumps to re-fetch site/consumption data
  const [stockLoading, setStockLoading] = useState(true) // main store stock for this scope
  const { loadStock } = useStock()

  // Admin location scope (State → LGA → Facility via the shared FacilityPicker,
  // which sets the global admin filter that getAdminStockScope resolves).
  const { fid: scopeFid, scopeIds: scopeIdList } = store.getAdminStockScope()
  const scopeSet = scopeFid ? new Set([scopeFid]) : (scopeIdList ? new Set(scopeIdList) : null)
  const inScope  = fId => !scopeSet || scopeSet.has(fId)

  // Load the store stock for this scope and gate the table until it's in. This
  // page used to only read whatever stock was already loaded elsewhere, so landing
  // here before the app-wide load finished (or after a scope change) rendered every
  // commodity at 0. loadStock is deduped, so this rides an in-flight load.
  useEffect(() => {
    let active = true
    setStockLoading(true)
    Promise.resolve(loadStock()).finally(() => { if (active) setStockLoading(false) })
    return () => { active = false }
  }, [scopeFid, store.adminFilterState, store.adminFilterLGA])

  const agg = {}
  // Seed from every tracked commodity so zero-stock items and their
  // categories (e.g. Lab consumables) still appear in the list and filter.
  store.allCommodities.forEach(c => {
    agg[c.id] = { id:c.id, name:c.name, cat:c.category, comm:c, facMap:{} }
  })
  // Group by facility (summing location rows) and carry the facility's AMC so
  // status is MOS-based — matching the Dashboard — instead of a flat threshold.
  store.stockData.forEach(r => {
    if (!inScope(r.facility_id)) return
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
      if (!inScope(fid)) return
      if (!c.facMap[fid]) c.facMap[fid] = { total:0, amc:0 }
      c.facMap[fid].total += qty
    })
  })
  // A facility that consumed this commodity in the last 12 months counts as a
  // reporting site even with no current stock row.
  Object.values(agg).forEach(c => {
    const consSet = consByComm[c.id]
    if (consSet) consSet.forEach(fid => { if (inScope(fid) && !c.facMap[fid]) c.facMap[fid] = { total:0, amc:0 } })
  })
  // Reporting sites = facilities that either currently hold stock (total > 0) or
  // have consumed the commodity in the last 12 months. Provisioned-but-idle
  // 0-stock rows are excluded. Totals and status counts use this reporting set,
  // so "out of stock sites" = reporting sites now sitting at zero.
  Object.values(agg).forEach(c => {
    const consSet = consByComm[c.id]
    const reporting = Object.entries(c.facMap).filter(([fid, f]) => f.total > 0 || (consSet && consSet.has(fid)))
    c.total = reporting.reduce((s, [, f]) => s + f.total, 0)
    c.facs  = reporting.length
    c.low = 0; c.out = 0; c.over = 0
    reporting.forEach(([, f]) => {
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
    const fetchAll = async (listFn) => {
      const map = {}
      const PAGE = 1000
      for (let offset = 0; ; offset += PAGE) {
        let data
        try {
          data = await listFn({ facility_ids: (facIds && facIds.length) ? facIds : undefined, limit: PAGE, offset })
        } catch { break }
        if (!data || !data.length) break
        data.forEach(d => {
          if (!map[d.commodity_id]) map[d.commodity_id] = {}
          map[d.commodity_id][d.facility_id] = (map[d.commodity_id][d.facility_id] || 0) + d.quantity
        })
        if (data.length < PAGE) break
      }
      return map
    }
    // Distinct (commodity → facilities that dispensed it) over the last 12
    // months. The server groups it: this used to download every dispense row in
    // the window — ~10,900 rows over 12 sequential requests locally — purely to
    // dedupe them into sets here. The aggregate returns one row per
    // (commodity, facility) pair that has any consumption, which IS the set.
    const fetchConsumption = async () => {
      const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 12)
      const rows = await api.dispense.summary({
        facility_ids: (facIds && facIds.length) ? facIds : undefined,
        from: cutoff.toISOString(),
        group_by: 'commodity,facility',
      }).catch(() => [])
      const map = {}
      ;(rows || []).forEach(r => {
        if (!map[r.commodity_id]) map[r.commodity_id] = new Set()
        map[r.commodity_id].add(r.facility_id)
      })
      return map
    }
    Promise.all([fetchAll(api.stock.sdp.list), fetchAll(api.stock.dsd.list), fetchConsumption()]).then(([sdp, dsd, cons]) => {
      if (active) { setSiteByComm({ sdp, dsd }); setConsByComm(cons) }
    })
    return () => { active = false }
  }, [refreshKey])

  // Reset the breakdown filters when switching commodity.
  useEffect(() => { setSiteFilter(''); setFacSearch('') }, [selected])

  // Drill-down: stock rows for the selected commodity, grouped by facility
  const facRows = selected
    ? store.stockData
        .filter(r => r.commodity_id === selected && inScope(r.facility_id))
        .reduce((acc, r) => {
          const fid = r.facility_id
          if (!acc[fid]) acc[fid] = { id: fid, name: r.facilities?.name||'—', state: r.facilities?.state||'—', lga: r.facilities?.lga||'—', store: 0, dispensary: 0, dsd: 0, sdp: 0, total: 0, amc: 0, comm: r.commodities }
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
        facRows[fid] = { id: fid, name: f?.name||'—', state: f?.state||'—', lga: f?.lga||'—', store: 0, dispensary: 0, dsd: 0, sdp: 0, total: 0, amc: 0, comm: selectedComm?.comm }
      }
      return facRows[fid]
    }
    const siteMap = isLabSel ? (siteByComm.sdp[selected] || {}) : (siteByComm.dsd[selected] || {})
    Object.entries(siteMap).forEach(([fid, qty]) => {
      if (!inScope(fid)) return
      const f = ensure(fid)
      if (isLabSel) f.sdp += qty
      else          f.dsd += qty
    })
    // Include facilities that consumed this commodity in the last 12 months even
    // with no stock row, so they appear as out-of-stock reporting sites.
    if (consByComm[selected]) consByComm[selected].forEach(fid => { if (inScope(fid)) ensure(fid) })
  }

  // Totals: lab = store + SDP; pharmacy = store + dispensary + DSD
  Object.values(facRows).forEach(f => {
    f.total = isLabSel ? (f.store + (f.sdp || 0)) : (f.store + f.dispensary + f.dsd)
  })
  // Reporting sites only: currently in stock, or consumed in the last 12 months.
  const consSel = selected ? consByComm[selected] : null
  const facList = Object.values(facRows)
    .filter(f => f.total > 0 || (consSel && consSel.has(f.id)))
    .sort((a,b) => b.total - a.total)
  const drillTotal = facList.reduce((s, f) => s + f.total, 0)
  const siteCounts = {
    low:  facList.filter(f => getStockStatus(f.total, f.amc) === 'low').length,
    out:  facList.filter(f => getStockStatus(f.total, f.amc) === 'out').length,
    over: facList.filter(f => getStockStatus(f.total, f.amc) === 'over').length,
  }
  // Breakdown table filters: status card + facility name search. Location narrowing
  // (State/LGA/Facility) comes from the page's FacilityPicker via inScope, applied above.
  const facQuery = facSearch.trim().toLowerCase()
  const shownFacs = facList.filter(f =>
    (!siteFilter || getStockStatus(f.total, f.amc) === siteFilter) &&
    (!facQuery   || (f.name || '').toLowerCase().includes(facQuery))
  )

  const statusLabels = { out:'Out of stock', low:'Low stock', ok:'Optimal', over:'Overstock', unknown:'No AMC' }

  // Export the commodity overview (one row per commodity).
  const commodityHeaders = ['Commodity','Category','Unit','Total stock','Reporting sites','Low stock sites','Out of stock sites','Overstock sites']
  const commodityRows = () => items.map(r => [r.name, r.cat, getCommodityDispenseUnit(r.comm) || '', r.total, r.facs, r.low, r.out, r.over])
  function downloadCommoditiesCsv() {
    exportCsv('stock-by-commodity_all-facilities.csv', commodityHeaders, commodityRows())
  }
  function downloadCommoditiesPdf() {
    exportPdf('Stock by commodity — all facilities', `${items.length} commodities`, commodityHeaders, commodityRows(), new Set([3,4,5,6,7]))
  }

  // Export the selected commodity's facility breakdown (the rows currently shown,
  // honouring the status-card filter).
  const facilityHeaders = isLabSel
    ? ['Facility','State','LGA','Store SOH','SDP SOH','Total SOH','MOS','Status']
    : ['Facility','State','LGA','Store SOH','Dispensary SOH','DSD SOH','Total SOH','MOS','Status']
  const facilityRowsFor = forPdf => shownFacs.map(f => {
    const st = getStockStatus(f.total, f.amc)
    const mos = getMOS(f.total, f.amc)
    const locs = isLabSel ? [f.sdp || 0] : [f.dispensary, f.dsd]
    const mosCell = mos != null ? (forPdf ? `${mos}mo` : mos) : (forPdf ? '—' : '')
    return [f.name, f.state, f.lga, f.store, ...locs, f.total, mosCell, statusLabels[st] || st]
  })
  const facilityFileBase = () => (selectedComm?.name || 'commodity').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '')
  function downloadFacilityCsv() {
    exportCsv(`${facilityFileBase()}_facility-breakdown.csv`, facilityHeaders, facilityRowsFor(false))
  }
  function downloadFacilityPdf() {
    const subtitle = `${selectedComm?.name || ''} · ${selectedComm?.cat || ''} — ${shownFacs.length} reporting sites`
    const rightCols = isLabSel ? new Set([3,4,5,6]) : new Set([3,4,5,6,7])
    exportPdf(`${selectedComm?.name || 'Commodity'} — facility breakdown`, subtitle, facilityHeaders, facilityRowsFor(true), rightCols)
  }

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

        <FacilityPicker />

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

        <Card className="stick-cols">
          <CardHeader>
            <CardTitle>Facility breakdown</CardTitle>
            <div className="flex gap-2 flex-wrap">
              <input value={facSearch} onChange={e=>setFacSearch(e.target.value)} placeholder="Search facility…"
                className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 placeholder:text-gray-600 focus:outline-none focus:border-blue-500 w-48"/>
              <button onClick={downloadFacilityCsv} disabled={shownFacs.length === 0}
                className="text-xs text-gray-400 hover:text-gray-200 border border-white/10 rounded px-3 py-1.5 disabled:opacity-40 disabled:hover:text-gray-400">
                ↓ CSV
              </button>
              <button onClick={downloadFacilityPdf} disabled={shownFacs.length === 0}
                className="text-xs text-gray-400 hover:text-gray-200 border border-white/10 rounded px-3 py-1.5 disabled:opacity-40 disabled:hover:text-gray-400">
                ↓ PDF
              </button>
            </div>
          </CardHeader>
          {shownFacs.length === 0 ? <EmptyState message={facQuery ? 'No sites match these filters.' : siteFilter ? `No ${siteFilter === 'out' ? 'out-of-stock' : siteFilter === 'over' ? 'overstocked' : 'low-stock'} sites.` : 'No stock data.'}/> : (
            <div className="table-wrap"><table className="w-full text-sm">
              <thead><tr className="border-b border-white/8 bg-white/2">
                {(isLabSel
                  ? ['Facility','State','LGA','Store SOH','SDP SOH','Total SOH','MOS','Status']
                  : ['Facility','State','LGA','Store SOH','Dispensary SOH','DSD SOH','Total SOH','MOS','Status']
                ).map(h=>(
                  <th key={h} className="sticky top-0 z-10 bg-gray-900 text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                ))}
              </tr></thead>
              <tbody>{shownFacs.map((f,i) => {
                const st = getStockStatus(f.total, f.amc)
                const statusLabel = { out:'Out of stock', low:'Low stock', ok:'Optimal', over:'Overstock', unknown:'No AMC' }[st] || st
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

      <FacilityPicker />

      <Card className="stick-cols">
        <CardHeader>
          <CardTitle>Stock by commodity — all facilities</CardTitle>
          <div className="flex gap-2 flex-wrap">
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search commodity…"
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 placeholder:text-gray-600 focus:outline-none focus:border-blue-500 w-48"/>
            <button onClick={()=>{ loadStock(); setRefreshKey(k=>k+1) }} className="text-xs text-gray-400 hover:text-gray-200 border border-white/10 rounded px-3 py-1.5 inline-flex items-center gap-1.5">↻ Refresh</button>
            <select value={commFilter} onChange={e=>setCommFilter(e.target.value)}
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500">
              <option value="">All categories</option>
              {categories.map(c=><option key={c} value={c}>{c}</option>)}
            </select>
            {items.length > 0 && (
              <>
                <button onClick={downloadCommoditiesCsv}
                  className="text-xs text-gray-400 hover:text-gray-200 border border-white/10 rounded px-3 py-1.5">
                  ↓ CSV
                </button>
                <button onClick={downloadCommoditiesPdf}
                  className="text-xs text-gray-400 hover:text-gray-200 border border-white/10 rounded px-3 py-1.5">
                  ↓ PDF
                </button>
              </>
            )}
          </div>
        </CardHeader>
        {stockLoading ? <LoadingState message="Loading stock…" /> : items.length===0 ? <EmptyState message="No stock data yet."/> : (
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
