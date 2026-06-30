import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { fmtDate, fmtStockQty } from '../utils/helpers'
import { LoadingState, EmptyState } from './ui/Loading'

// Drill-down modal: every recorded batch of a commodity (number + expiry +
// received qty) with an FEFO-estimated remaining quantity. EnVo doesn't track
// per-batch stock, so "remaining" is inferred: current stock on hand is filled
// into the latest-expiring batches first, so the soonest-expiry batches are
// treated as consumed first. When `fid` is set the view is for that one
// facility; when null (admin) batches are shown per facility, capped to each
// facility's own stock on hand.
export function BatchBreakdownModal({ commodity, fid, scopeIds = null, onClose }) {
  const [rows, setRows]       = useState([])
  const [loading, setLoading] = useState(true)
  const showFacility = !fid

  useEffect(() => {
    let active = true
    async function load() {
      setLoading(true)
      const cid = commodity.commodity_id
      const PAGE = 1000
      const fetchAll = async (fn, extra = {}) => {
        let out = []
        for (let offset = 0; ; offset += PAGE) {
          let data
          try {
            data = await fn({
              commodity_ids: [cid], commodity_id: cid,
              facility_id: fid || undefined,
              facility_ids: (!fid && scopeIds && scopeIds.length) ? scopeIds : undefined,
              limit: PAGE, offset, ...extra,
            })
          } catch { break }
          if (!data || !data.length) break
          out = out.concat(data)
          if (data.length < PAGE) break
        }
        return out
      }

      // All batches ever received for this commodity (any expiry), with qty > 0.
      const intake = await fetchAll(api.intake.history, { has_quantity: true })
      // Current stock on hand per facility: store + dispensary (/api/stock) + DSD + SDP.
      const [stockRows, dsdRows, sdpRows] = await Promise.all([
        fetchAll(api.stock.list),
        fetchAll(api.stock.dsd.list),
        fetchAll(api.stock.sdp.list),
      ])
      if (!active) return

      const sohByFac = {}
      const addSoh = (f, q) => { sohByFac[f] = (sohByFac[f] || 0) + (q || 0) }
      stockRows.forEach(s => addSoh(s.facility_id, s.quantity))
      dsdRows.forEach(d => addSoh(d.facility_id, d.quantity))
      sdpRows.forEach(s => addSoh(s.facility_id, s.quantity))

      // Aggregate intake into batches keyed by facility + batch number + expiry.
      const byFacBatch = {}
      intake.forEach(r => {
        const f = r.facility_id
        const key = `${f}|${r.batch_number || '—'}|${r.expiry_date || '—'}`
        const b = byFacBatch[key] || (byFacBatch[key] = {
          facility_id: f, facility: r.facilities?.name || '—',
          batch: r.batch_number || '—', expiry: r.expiry_date || null, received: 0,
        })
        b.received += r.quantity || 0
      })

      // FEFO allocation per facility: fill latest-expiry batches first so the
      // soonest-expiry deplete first; each batch's leftover is its remaining.
      const byFac = {}
      Object.values(byFacBatch).forEach(b => { (byFac[b.facility_id] ||= []).push(b) })
      const out = []
      Object.entries(byFac).forEach(([f, list]) => {
        let remaining = sohByFac[f] || 0
        const ordered = list.slice().sort((a, b) => new Date(b.expiry || 0) - new Date(a.expiry || 0))
        ordered.forEach(b => {
          const keep = Math.max(0, Math.min(b.received, remaining))
          remaining -= keep
          out.push({ ...b, remaining: keep })
        })
      })
      // Soonest-expiry first for display.
      out.sort((a, b) => new Date(a.expiry || '9999-12-31') - new Date(b.expiry || '9999-12-31'))
      setRows(out)
      setLoading(false)
    }
    load()
    return () => { active = false }
  }, [commodity.commodity_id, fid, scopeIds])

  const today = new Date()
  const urgency = expiry => {
    if (!expiry) return { label: '—', cls: 'text-gray-500' }
    const d = (new Date(expiry) - today) / 86400000
    if (d < 0)   return { label: 'Expired',  cls: 'text-red-500' }
    if (d <= 30) return { label: 'Critical', cls: 'text-red-400' }
    if (d <= 90) return { label: 'Warning',  cls: 'text-amber-400' }
    return { label: 'OK', cls: 'text-green-400' }
  }
  const totalRemaining = rows.reduce((s, r) => s + r.remaining, 0)

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-white/10 rounded-2xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-1 gap-4">
          <h3 className="font-medium text-gray-100">{commodity.commodities?.name || 'Commodity'} — stock by batch</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl leading-none">✕</button>
        </div>
        <p className="text-xs text-gray-500 mb-4">
          Remaining is FEFO-estimated (soonest-expiry consumed first){showFacility ? ', across all facilities in scope' : ''}.
        </p>

        {loading ? <LoadingState /> : rows.length === 0 ? <EmptyState message="No batches recorded for this commodity." /> : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/8 bg-white/2">
                {showFacility && <th className="text-left px-3 py-2 text-xs text-gray-500 uppercase tracking-wider font-medium">Facility</th>}
                {['Batch','Expiry','Received','Est. remaining','Status'].map(h => (
                  <th key={h} className="text-left px-3 py-2 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const u = urgency(r.expiry)
                return (
                  <tr key={i} className={`border-b border-white/5 ${r.remaining === 0 ? 'opacity-50' : ''}`}>
                    {showFacility && <td className="px-3 py-2.5 text-gray-300">{r.facility}</td>}
                    <td className="px-3 py-2.5 font-mono text-xs text-gray-300">{r.batch}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-gray-300">{r.expiry ? fmtDate(r.expiry) : '—'}</td>
                    <td className="px-3 py-2.5 font-mono text-gray-400">{fmtStockQty(r.received, commodity.commodities)}</td>
                    <td className="px-3 py-2.5 font-mono font-medium text-gray-100">{fmtStockQty(r.remaining, commodity.commodities)}</td>
                    <td className={`px-3 py-2.5 text-xs font-semibold ${u.cls}`}>{u.label}</td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-white/10">
                <td className="px-3 py-2.5 text-xs text-gray-400 uppercase tracking-wider" colSpan={showFacility ? 4 : 3}>Total remaining ({rows.length} {rows.length === 1 ? 'batch' : 'batches'})</td>
                <td className="px-3 py-2.5 font-mono font-medium text-gray-100" colSpan={2}>{fmtStockQty(totalRemaining, commodity.commodities)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  )
}
