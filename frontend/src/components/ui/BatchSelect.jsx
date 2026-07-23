import { useState, useEffect, useRef } from 'react'
import { api } from '../../lib/api'
import { fmtDate } from '../../utils/helpers'

// Batch picker for dispensing, sourced from the LOT LEDGER — the real per-batch
// balances of one bin (dispensary, or a DSD/SDP site), not an estimate. The top
// option is the FEFO pick (soonest expiry), pre-selected, so leaving it alone
// keeps the system default and the user overrides only when they mean to.
//
// bin = { facilityId, commodityId, locationType ('dispensary'|'dsd'|'sdp'|'store'),
// siteName? }. Reports the choice up via
// onSelect({ batch_number, expiry_date, remaining }) or onSelect(null) when the
// bin has no ledger lots yet (dispense then falls back to FEFO on the server).
export function BatchSelect({ facilityId, commodityId, locationType, siteName, value, onSelect, className }) {
  const [options, setOptions] = useState([])
  const [loading, setLoading] = useState(false)
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  useEffect(() => {
    let cancelled = false
    if (!facilityId || !commodityId || !locationType) { setOptions([]); onSelectRef.current?.(null); return }
    setLoading(true)
    api.stock.lots({ facility_id: facilityId, commodity_id: commodityId, location_type: locationType, site_name: siteName || undefined })
      .then(lots => {
        if (cancelled) return
        const opts = (lots || []).map(l => ({
          key: `${l.batch_number || ''}|${l.expiry_date || ''}`,
          batch_number: l.batch_number || '',
          expiry_date: l.expiry_date || null,
          remaining: l.quantity || 0,
        }))
        setOptions(opts)
        onSelectRef.current?.(opts[0] || null)   // ledger returns soonest-expiry first → FEFO default
      })
      .catch(() => { if (!cancelled) { setOptions([]); onSelectRef.current?.(null) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [facilityId, commodityId, locationType, siteName])

  const cls = className || 'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500'

  if (loading) return <div className="text-xs text-gray-500 px-1 py-2">Loading batches…</div>
  if (!options.length) return <div className="text-xs text-gray-500 px-1 py-2">No batch on record — will use FEFO</div>

  const label = o => `${o.batch_number || '(no batch)'} · exp ${o.expiry_date ? fmtDate(o.expiry_date) : '—'} (${o.remaining} left)`
  return (
    <select value={value || ''} onChange={e => onSelect?.(options.find(o => o.key === e.target.value) || null)} className={cls}>
      {options.map((o, i) => (
        <option key={o.key} value={o.key}>{label(o)}{i === 0 ? ' · FEFO' : ''}</option>
      ))}
    </select>
  )
}
