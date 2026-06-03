import { useEffect, useState } from 'react'
import { sb } from '../lib/supabase'
import { fmtStockQty } from '../utils/helpers'
import { LoadingState, EmptyState } from './ui/Loading'

// Drill-down modal: given an aggregated DSD/SDP SOH cell, fetch and show the
// per-site stock levels that make up that total for a single commodity.
//   kind 'dsd' → dsd_stock (dsd_site_name)
//   kind 'sdp' → sdp_stock (sdp_name)
export function SiteBreakdownModal({ commodity, kind, fid, onClose }) {
  const [rows, setRows]       = useState([])
  const [loading, setLoading] = useState(true)

  const table    = kind === 'sdp' ? 'sdp_stock' : 'dsd_stock'
  const siteCol  = kind === 'sdp' ? 'sdp_name'  : 'dsd_site_name'
  const kindLabel = kind === 'sdp' ? 'Service Delivery Point' : 'DSD site'

  useEffect(() => {
    let active = true
    async function load() {
      setLoading(true)
      const { data } = await sb.from(table)
        .select(`${siteCol},quantity`)
        .eq('facility_id', fid)
        .eq('commodity_id', commodity.commodity_id)
      if (!active) return
      const cleaned = (data || [])
        .map(r => ({ site: r[siteCol] || '—', quantity: r.quantity || 0 }))
        .filter(r => r.quantity > 0)
        .sort((a, b) => b.quantity - a.quantity)
      setRows(cleaned)
      setLoading(false)
    }
    load()
    return () => { active = false }
  }, [table, siteCol, fid, commodity.commodity_id])

  const total = rows.reduce((s, r) => s + r.quantity, 0)

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-white/10 rounded-2xl p-6 w-full max-w-md max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-1 gap-4">
          <h3 className="font-medium text-gray-100">{commodity.commodities?.name || 'Commodity'}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl leading-none">✕</button>
        </div>
        <p className="text-xs text-gray-500 mb-4">Stock on hand per {kindLabel}</p>

        {loading ? <LoadingState /> : rows.length === 0 ? <EmptyState message={`No ${kindLabel} stock for this commodity.`} /> : (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/8 bg-white/2">
                  <th className="text-left px-3 py-2 text-xs text-gray-500 uppercase tracking-wider font-medium">{kindLabel}</th>
                  <th className="text-right px-3 py-2 text-xs text-gray-500 uppercase tracking-wider font-medium">Stock on Hand</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-b border-white/5">
                    <td className="px-3 py-2.5 text-gray-100">{r.site}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-gray-200">{fmtStockQty(r.quantity, commodity.commodities)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-white/10">
                  <td className="px-3 py-2.5 text-xs text-gray-400 uppercase tracking-wider">Total ({rows.length} {rows.length === 1 ? 'site' : 'sites'})</td>
                  <td className="px-3 py-2.5 text-right font-mono font-medium text-gray-100">{fmtStockQty(total, commodity.commodities)}</td>
                </tr>
              </tfoot>
            </table>
          </>
        )}
      </div>
    </div>
  )
}
