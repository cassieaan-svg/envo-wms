import { useState, useEffect, useRef } from 'react'
import { api } from '../../lib/api'
import { fmtDate } from '../../utils/helpers'

// Batch picker for dispensing, sourced from the LOT LEDGER — the real per-batch
// balances of one bin (dispensary, or a DSD/SDP site), not an estimate.
//
// The default option ("Select batch") means no explicit choice: the server draws
// FEFO — soonest-expiry-first across lots, skipping expired — exactly like today.
// Picking a specific batch makes it a hard constraint: the server dispenses only
// that batch and blocks if it's short. Expired lots are not offered (they can't be
// dispensed; they're cleared via an adjustment).
//
// bin = { facilityId, commodityId, locationType ('dispensary'|'dsd'|'sdp'|'store'),
// siteName? }. Reports the choice up via
// onSelect({ key, batch_number, expiry_date, remaining }) for a specific batch, or
// onSelect(null) for FEFO / when the bin has no ledger lots.
const FEFO = '__fefo__'

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
        const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0)
        const opts = (lots || [])
          .filter(l => !(l.expiry_date && new Date(l.expiry_date) < startOfToday))   // hide expired — not dispensable
          .map(l => ({
            key: `${l.batch_number || ''}|${l.expiry_date || ''}`,
            batch_number: l.batch_number || '',
            expiry_date: l.expiry_date || null,
            remaining: l.quantity || 0,
          }))
        setOptions(opts)
        onSelectRef.current?.(null)   // default to FEFO (automatic)
      })
      .catch(() => { if (!cancelled) { setOptions([]); onSelectRef.current?.(null) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [facilityId, commodityId, locationType, siteName])

  const cls = className || 'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500'

  if (loading) return <div className="text-xs text-gray-500 px-1 py-2">Loading batches…</div>

  const label = o => `${o.batch_number || '(no batch)'} · exp ${o.expiry_date ? fmtDate(o.expiry_date) : '—'} (${o.remaining} left)`
  return (
    <select value={value || FEFO} onChange={e => onSelect?.(e.target.value === FEFO ? null : options.find(o => o.key === e.target.value) || null)} className={cls}>
      <option value={FEFO}>Select batch</option>
      {options.map(o => <option key={o.key} value={o.key}>{label(o)}</option>)}
    </select>
  )
}
