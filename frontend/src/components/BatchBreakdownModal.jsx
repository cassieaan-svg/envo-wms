import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { fmtDate, fmtStockQty } from '../utils/helpers'
import { LoadingState, EmptyState } from './ui/Loading'

// Drill-down modal: the on-hand batches of a commodity (number + expiry +
// quantity on hand + status) straight from the AUTHORITATIVE lot ledger — the
// same source the dispense picker uses. This matches what's actually dispatchable
// and, crucially, still shows batches that are already EXPIRED (they physically
// remain on the shelf until adjusted out); the old intake-history estimate
// inferred those away. When `fid` is set the view is for that one facility; when
// null (admin) batches are shown per facility across the caller's scope.
// `locationType` narrows to ONE bin (store / dispensary / dsd / sdp). Without it the
// ledger merges every bin into a single per-batch figure, which cannot answer "what
// batches does the dispensary hold" — the question the Stock Levels cells now ask.
// For dsd/sdp a Site column appears, since those bins are per-site.
const BIN_LABEL = { store: 'store', dispensary: 'dispensary', dsd: 'DSD sites', sdp: 'SDPs' }

export function BatchBreakdownModal({ commodity, fid, scopeIds = null, locationType = null, siteName = null, onClose }) {
  const [rows, setRows]       = useState([])
  const [loading, setLoading] = useState(true)
  const showFacility = !fid
  const showSite = (locationType === 'dsd' || locationType === 'sdp') && !siteName

  useEffect(() => {
    let active = true
    async function load() {
      setLoading(true)
      const cid = commodity.commodity_id
      let data = []
      try {
        data = await api.stock.lotsExpiry({
          commodity_ids: [cid],
          facility_id: fid || undefined,
          facility_ids: (!fid && scopeIds && scopeIds.length) ? scopeIds : undefined,
          include_unknown: 1,   // also list null-expiry ("unknown") lots on hand
          location_type: locationType || undefined,
          site_name: siteName || undefined,
        })
      } catch { data = [] }
      if (!active) return

      // The ledger already returns one summed row per (facility, batch, expiry) on
      // hand — no FEFO estimation needed. Soonest-expiry first (expired at the top).
      const out = (data || []).map(r => ({
        facility_id: r.facility_id,
        facility: r.facilities?.name || '—',
        batch: r.batch_number || '(no batch)',
        expiry: r.expiry_date || null,
        onHand: r.quantity || 0,
        site: r.site_name || '—',
      })).sort((a, b) => new Date(a.expiry || '9999-12-31') - new Date(b.expiry || '9999-12-31'))
      setRows(out)
      setLoading(false)
    }
    load()
    return () => { active = false }
  }, [commodity.commodity_id, fid, scopeIds, locationType, siteName])

  const today = new Date()
  const urgency = expiry => {
    if (!expiry) return { label: '—', cls: 'text-gray-500' }
    const d = (new Date(expiry) - today) / 86400000
    if (d < 0)   return { label: 'Expired',  cls: 'text-red-500' }
    if (d <= 30) return { label: 'Critical', cls: 'text-red-400' }
    if (d <= 90) return { label: 'Warning',  cls: 'text-amber-400' }
    return { label: 'OK', cls: 'text-green-400' }
  }
  const totalOnHand = rows.reduce((s, r) => s + r.onHand, 0)

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-white/10 rounded-2xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-1 gap-4">
          <h3 className="font-medium text-gray-100">
            {commodity.commodities?.name || 'Commodity'} — stock by batch
            {locationType && <span className="text-gray-400"> · {siteName || BIN_LABEL[locationType] || locationType}</span>}
          </h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl leading-none">✕</button>
        </div>
        <p className="text-xs text-gray-500 mb-4">
          On-hand per-batch balances from the lot ledger{locationType ? ` for the ${siteName || BIN_LABEL[locationType] || locationType}` : ''}{showFacility ? ', across all facilities in scope' : ''}. Expired batches are shown — they remain on the shelf until adjusted out.
        </p>

        {loading ? <LoadingState /> : rows.length === 0 ? <EmptyState message={locationType ? `No batches on hand in the ${siteName || BIN_LABEL[locationType] || locationType}.` : "No batches on hand for this commodity."} /> : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/8 bg-white/2">
                {showFacility && <th className="text-left px-3 py-2 text-xs text-gray-500 uppercase tracking-wider font-medium">Facility</th>}
                {showSite && <th className="text-left px-3 py-2 text-xs text-gray-500 uppercase tracking-wider font-medium">Site</th>}
                {['Batch','Expiry','On hand','Status'].map(h => (
                  <th key={h} className="text-left px-3 py-2 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const u = urgency(r.expiry)
                return (
                  <tr key={i} className="border-b border-white/5">
                    {showFacility && <td className="px-3 py-2.5 text-gray-300">{r.facility}</td>}
                    {showSite && <td className="px-3 py-2.5 text-xs text-gray-400">{r.site}</td>}
                    <td className="px-3 py-2.5 font-mono text-xs text-gray-300">{r.batch}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-gray-300">{r.expiry ? fmtDate(r.expiry) : '—'}</td>
                    <td className="px-3 py-2.5 font-mono font-medium text-gray-100">{fmtStockQty(r.onHand, commodity.commodities)}</td>
                    <td className={`px-3 py-2.5 text-xs font-semibold ${u.cls}`}>{u.label}</td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-white/10">
                <td className="px-3 py-2.5 text-xs text-gray-400 uppercase tracking-wider" colSpan={2 + (showFacility?1:0) + (showSite?1:0)}>Total on hand ({rows.length} {rows.length === 1 ? 'batch' : 'batches'})</td>
                <td className="px-3 py-2.5 font-mono font-medium text-gray-100" colSpan={2}>{fmtStockQty(totalOnHand, commodity.commodities)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  )
}
