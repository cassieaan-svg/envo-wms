import { useState, useEffect, useRef } from 'react'
import { api } from '../../lib/api'
import { fmtDate } from '../../utils/helpers'

// Batch picker for dispensing, sourced from the LOT LEDGER — the real per-batch
// balances of one bin (dispensary, or a DSD/SDP site), not an estimate.
//
// The default option ("Select batch") means no explicit choice: the server draws
// FEFO — soonest-expiry-first across lots, skipping expired — exactly like today.
// Picking a specific batch makes it a hard constraint: the server dispenses only
// that batch and blocks if it's short. Expired lots ARE listed (labelled EXPIRED,
// sorted to the bottom) so the picker explains why there may be nothing good to
// dispatch instead of showing a mysteriously empty dropdown; the caller warns
// before sending expired stock (an adjustment is the proper route to clear it).
//
// bin = { facilityId, commodityId, locationType ('dispensary'|'dsd'|'sdp'|'store'),
// siteName? }. Reports the choice up via
// onSelect({ key, batch_number, expiry_date, remaining }) for a specific batch, or
// onSelect(null) for FEFO / when the bin has no ledger lots.
const FEFO = '__fefo__'

// `onLotsLoaded` reports the bin's raw lots (including expired / unknown-expiry
// ones the dropdown doesn't offer) so the page can prompt about gaps.
// `refreshToken` re-fetches when it changes — bump it after editing a lot.
export function BatchSelect({ facilityId, commodityId, locationType, siteName, value, onSelect, onLotsLoaded, refreshToken, className }) {
  const [options, setOptions] = useState([])
  const [loading, setLoading] = useState(false)
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const onLotsLoadedRef = useRef(onLotsLoaded)
  onLotsLoadedRef.current = onLotsLoaded

  useEffect(() => {
    let cancelled = false
    if (!facilityId || !commodityId || !locationType) { setOptions([]); onSelectRef.current?.(null); onLotsLoadedRef.current?.([]); return }
    setLoading(true)
    api.stock.lots({ facility_id: facilityId, commodity_id: commodityId, location_type: locationType, site_name: siteName || undefined })
      .then(lots => {
        if (cancelled) return
        const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0)
        const soonCut = new Date(startOfToday.getTime() + 30 * 86400000)   // ≤30 days = expiring soon
        const opts = (lots || [])
          .map(l => {
            const exp = l.expiry_date ? new Date(l.expiry_date) : null
            return {
              key: `${l.batch_number || ''}|${l.expiry_date || ''}`,
              batch_number: l.batch_number || '',
              expiry_date: l.expiry_date || null,
              remaining: l.quantity || 0,
              expired: !!(exp && exp < startOfToday),
              soon: !!(exp && exp >= startOfToday && exp < soonCut),
            }
          })
          // Valid batches first (usable), expired sunk to the bottom.
          .sort((a, b) => (a.expired === b.expired) ? 0 : (a.expired ? 1 : -1))
        setOptions(opts)
        onLotsLoadedRef.current?.(lots || [])
        onSelectRef.current?.(null)   // default to FEFO (automatic)
      })
      .catch(() => { if (!cancelled) { setOptions([]); onSelectRef.current?.(null); onLotsLoadedRef.current?.([]) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [facilityId, commodityId, locationType, siteName, refreshToken])

  const cls = className || 'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500'

  if (loading) return <div className="text-xs text-gray-500 px-1 py-2">Loading batches…</div>

  const label = o => `${o.batch_number || 'No batch no'} · exp ${o.expiry_date ? fmtDate(o.expiry_date) : '—'} (${o.remaining} left)${o.expired ? ' — EXPIRED' : o.soon ? ' — expiring soon' : ''}`
  return (
    <select value={value || FEFO} onChange={e => onSelect?.(e.target.value === FEFO ? null : options.find(o => o.key === e.target.value) || null)} className={cls}>
      <option value={FEFO}>Select batch</option>
      {options.map(o => <option key={o.key} value={o.key}>{label(o)}</option>)}
    </select>
  )
}
