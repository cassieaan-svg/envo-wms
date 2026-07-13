import { useState, useEffect, useRef } from 'react'
import { api } from '../lib/api'
import { subscribeRealtime } from '../lib/realtime'
import { useAppStore } from '../store/appStore'
import { Card, CardHeader, CardTitle } from './ui/Card'
import { Badge } from './ui/Badge'
import { LoadingState, EmptyState, Spinner } from './ui/Loading'
import { fmtDateTime, fmtDispenseQty } from '../utils/helpers'

// Read-only activity log for a single SDP/DSD site login. Shows the site's own
// consumption (dispenses tagged "[SDP: name]" / "[DSD: name]") plus the internal
// redistributions that involve this site. Editing stays with the facility store
// manager (this view has no Edit action by design).
export function SiteActivityLog() {
  const store = useAppStore()
  const fid   = store.currentFacility?.id
  const isDSD = store.isDSD()
  const siteName = isDSD ? store.dsdSiteName : store.sdpName
  const commoditySection = store.commoditySection

  const [typeFilter, setTypeFilter] = useState('')
  const [period, setPeriod]         = useState(0)   // 0 = all time; else days back
  const [records, setRecords]       = useState([])
  const [loading, setLoading]       = useState(true)

  async function loadAll() {
    if (!fid || !siteName) { setRecords([]); setLoading(false); return }
    setLoading(true)
    const from = period ? new Date(Date.now() - period * 86400000).toISOString() : undefined
    const rowLimit = period ? 500 : 100
    // Dispense history filters server-side on the site's notes tag.
    const siteFilter = isDSD ? { dsd_site_name: siteName } : { sdp_name: siteName }
    const [disp, transfers] = await Promise.all([
      (!typeFilter || typeFilter === 'dispense')
        ? api.dispense.history({ facility_id: fid, ...siteFilter, from, limit: rowLimit }).catch(() => []) : [],
      (!typeFilter || typeFilter === 'transfer')
        ? api.transfers.list({ facility_id: fid, section: commoditySection || undefined, date_field: from ? 'initiated_at' : undefined, from, limit: rowLimit }).catch(() => []) : [],
    ])
    // Transfers aren't filterable by site server-side, so narrow to this site's
    // internal redistributions via the same notes tag convention.
    const tag = isDSD ? `[DSD: ${siteName}]` : `[SDP: ${siteName}]`
    const siteTransfers = (transfers || []).filter(t => (t.notes || '').includes(tag))
    const merged = [
      ...disp.map(r => ({ ...r, _type: 'dispense', _time: r.dispensed_at })),
      ...siteTransfers.map(r => ({ ...r, _type: 'transfer', _time: r.resolved_at || r.initiated_at })),
    ].sort((a, b) => new Date(b._time) - new Date(a._time)).slice(0, period ? 500 : 100)
    setRecords(merged)
    setLoading(false)
  }

  useEffect(() => { loadAll() }, [fid, siteName, typeFilter, period])

  // Live refresh when a dispense or transfer changes in this site's scope.
  const loadRef = useRef(loadAll)
  loadRef.current = loadAll
  useEffect(() => subscribeRealtime(['dispense_log', 'stock_transfer_log'], () => loadRef.current()), [])

  const typeBadge = { dispense: 'out', transfer: 'low' }
  const typeLabel = { dispense: 'Consumption', transfer: 'Transfer' }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-medium text-gray-100">Activity Log</h1>
        <p className="text-sm text-gray-500 mt-1">
          Consumption and redistribution history for {siteName || 'this site'}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
          <div className="flex gap-2 flex-wrap">
            <select value={period} onChange={e => setPeriod(parseInt(e.target.value))}
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500">
              <option value={0}>All time</option>
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={180}>Last 6 months</option>
            </select>
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500">
              <option value="">All activity</option>
              <option value="dispense">Stock consumed</option>
              <option value="transfer">Transfers</option>
            </select>
            <button onClick={loadAll} disabled={loading}
              className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5 disabled:opacity-60 inline-flex items-center gap-1.5">
              {loading && <Spinner size="sm" />}{loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </CardHeader>
        {loading && records.length === 0 ? <LoadingState /> : records.length === 0 ? <EmptyState message="No activity recorded yet." /> : (
          <div className="table-wrap"><table className="w-full text-sm">
            <thead><tr className="border-b border-white/8 bg-white/2">
              {['Date', 'Type', 'Commodity', 'Qty', 'Details'].map((h, i) => (
                <th key={i} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
              ))}
            </tr></thead>
            <tbody>{records.map(r => {
              let qty = '', details = ''
              if (r._type === 'dispense') {
                qty = <span className="font-mono text-sm text-red-400">-{fmtDispenseQty(r.quantity, r.commodities)}</span>
                details = r.dispensed_by ? `By: ${r.dispensed_by}` : '—'
              } else {
                const route = `${r.sending_facility_name || '—'} → ${r.receiving_facility_name || '—'}`
                qty = <span className="font-mono text-sm text-blue-400">{r.quantity} {r.commodities?.unit || ''}</span>
                details = r.status ? `${route} · ${r.status}` : route
              }
              return (
                <tr key={r.id} className="border-b border-white/5 hover:bg-white/2">
                  <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDateTime(r._time)}</td>
                  <td className="px-4 py-3"><Badge type={typeBadge[r._type]}>{typeLabel[r._type]}</Badge></td>
                  <td className="px-4 py-3 font-medium text-gray-100">{r.commodities?.name || '—'}</td>
                  <td className="px-4 py-3">{qty}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">{details}</td>
                </tr>
              )
            })}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  )
}
