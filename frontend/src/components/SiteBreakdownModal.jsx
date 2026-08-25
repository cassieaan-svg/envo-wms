import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { fmtStockQty } from '../utils/helpers'
import { LoadingState, EmptyState } from './ui/Loading'
import { BatchBreakdownModal } from './BatchBreakdownModal'

// Drill-down modal: given an aggregated DSD/SDP SOH cell, fetch and show the
// per-site stock levels that make up that total for a single commodity.
//   kind 'dsd' → dsd_stock (dsd_site_name)
//   kind 'sdp' → sdp_stock (sdp_name)
// When `fid` is set the breakdown is per-site for that one facility. When it is
// null (an admin viewing all facilities) the breakdown also shows which
// facility each site belongs to, scoped to `scopeIds` if provided.
export function SiteBreakdownModal({ commodity, kind, fid, scopeIds = null, onClose }) {
  const [rows, setRows]       = useState([])
  const [loading, setLoading] = useState(true)
  const [batchSite, setBatchSite] = useState(null)  // site row drilled into for batches

  const table     = kind === 'sdp' ? 'sdp_stock' : 'dsd_stock'
  const siteCol   = kind === 'sdp' ? 'sdp_name'  : 'dsd_site_name'
  const kindLabel = kind === 'sdp' ? 'Service Delivery Point' : 'DSD site'
  const showFacility = !fid

  useEffect(() => {
    let active = true
    async function load() {
      setLoading(true)
      const listFn = kind === 'sdp' ? api.stock.sdp.list : api.stock.dsd.list
      const PAGE = 1000
      let raw = []
      for (let offset = 0; ; offset += PAGE) {
        let data
        try {
          data = await listFn({
            commodity_id: commodity.commodity_id,
            facility_id: fid || undefined,
            facility_ids: (!fid && scopeIds && scopeIds.length) ? scopeIds : undefined,
            limit: PAGE, offset,
          })
        } catch { break }
        if (!data || !data.length) break
        raw = raw.concat(data)
        if (data.length < PAGE) break
      }
      if (!active) return
      const cleaned = raw
        // facility_id is carried so the batch drill can pin to the right facility
        // when an admin is viewing sites across several of them.
        .map(r => ({ facility_id: r.facility_id, facility: r.facilities?.name || '—', site: r[siteCol] || '—', quantity: r.quantity || 0 }))
        .filter(r => r.quantity > 0)
        .sort((a, b) => b.quantity - a.quantity)
      setRows(cleaned)
      setLoading(false)
    }
    load()
    return () => { active = false }
  }, [table, siteCol, fid, scopeIds, commodity.commodity_id])

  const total = rows.reduce((s, r) => s + r.quantity, 0)


  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-white/10 rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-1 gap-4">
          <h3 className="font-medium text-gray-100">{commodity.commodities?.name || 'Commodity'}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl leading-none">✕</button>
        </div>
        <p className="text-xs text-gray-500 mb-4">Stock on hand per {kindLabel}{showFacility ? ' across all facilities' : ''}</p>

        {loading ? <LoadingState /> : rows.length === 0 ? <EmptyState message={`No ${kindLabel} stock for this commodity.`} /> : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/8 bg-white/2">
                {showFacility && <th className="text-left px-3 py-2 text-xs text-gray-500 uppercase tracking-wider font-medium">Facility</th>}
                <th className="text-left px-3 py-2 text-xs text-gray-500 uppercase tracking-wider font-medium">{kindLabel}</th>
                <th className="text-right px-3 py-2 text-xs text-gray-500 uppercase tracking-wider font-medium">Stock on Hand</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-white/5">
                  {showFacility && <td className="px-3 py-2.5 text-gray-300">{r.facility}</td>}
                  <td className="px-3 py-2.5">
                    {/* Site name opens that site's batches. Kept as a second step
                        rather than replacing this view: "which site holds it" and
                        "which batch is it" are different questions, and the site
                        totals here come from dsd_stock/sdp_stock, not the lot ledger. */}
                    <button type="button" onClick={() => setBatchSite(r)}
                      title={`View batches at ${r.site}`}
                      className="text-gray-100 hover:text-white underline decoration-dotted underline-offset-2 hover:decoration-solid text-left">
                      {r.site}<span className="text-gray-600 ml-1">›</span>
                    </button>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-gray-200">{fmtStockQty(r.quantity, commodity.commodities)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-white/10">
                <td className="px-3 py-2.5 text-xs text-gray-400 uppercase tracking-wider" colSpan={showFacility ? 2 : 1}>Total ({rows.length} {rows.length === 1 ? 'entry' : 'entries'})</td>
                <td className="px-3 py-2.5 text-right font-mono font-medium text-gray-100">{fmtStockQty(total, commodity.commodities)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      {batchSite && (
        <BatchBreakdownModal
          commodity={commodity}
          fid={batchSite.facility_id || fid}
          locationType={kind}
          siteName={batchSite.site}
          onClose={() => setBatchSite(null)}
        />
      )}
    </div>
  )
}
