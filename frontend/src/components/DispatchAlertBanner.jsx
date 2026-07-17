import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { subscribeRealtime } from '../lib/realtime'
import { useAppStore } from '../store/appStore'

// Prominent dashboard alert for a facility that an admin has assigned external
// redistribution request(s) to fulfil. After the admin assigns a source, the
// transfer sits as an OUTGOING 'pending' row (sending_facility_id = this
// facility) awaiting dispatch — easy to miss inside the Redistribution page, so
// surface it loudly on the dashboard. Facility users only (admins don't dispatch).
export function DispatchAlertBanner() {
  const accessLevel      = useAppStore(s => s.accessLevel)
  const fid              = useAppStore(s => s.currentFacility?.id)
  const commoditySection = useAppStore(s => s.commoditySection)
  const setPage          = useAppStore(s => s.setCurrentPage)
  const [count, setCount] = useState(0)

  const isFacility = accessLevel === 'facility'

  useEffect(() => {
    if (!isFacility || !fid) { setCount(0); return }
    let active = true
    const load = async () => {
      // Outgoing + status 'pending' = external redistributions an admin assigned
      // to us, awaiting our dispatch (internal/DSD sit at 'pending_approval').
      const data = await api.transfers.list({
        facility_id: fid, direction: 'outgoing', status: 'pending',
        section: commoditySection || undefined,
      }).catch(() => [])
      if (active) setCount(data?.length || 0)
    }
    load()
    const unsub = subscribeRealtime(['stock_transfer_log'], load)
    return () => { active = false; unsub?.() }
  }, [isFacility, fid, commoditySection])

  if (!isFacility || count === 0) return null

  return (
    <button onClick={() => setPage('transfers')}
      className="w-full mb-5 flex items-center gap-3 rounded-xl border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-left hover:bg-amber-500/20 transition-colors">
      <span className="text-2xl leading-none">🚚</span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-amber-600 dark:text-amber-300">
          {count} redistribution {count === 1 ? 'request' : 'requests'} assigned to your facility — dispatch pending
        </div>
        <div className="text-xs text-amber-700/80 dark:text-amber-200/70 mt-0.5">
          An admin assigned your facility as the source. Click to review and dispatch the stock.
        </div>
      </div>
      <span className="text-xs font-medium text-amber-700 dark:text-amber-200 border border-amber-500/50 rounded-lg px-3 py-1.5 whitespace-nowrap">
        Go to Redistribution →
      </span>
    </button>
  )
}
