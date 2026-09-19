import { useEffect, useState } from 'react'
import { queueHealth, drainQueue } from '../lib/offlineQueue'
import { OfflineQueuePanel } from './OfflineQueuePanel'

// Honest status, in the same operational language the WMS's own connection bar
// uses ("work is being recorded and held") — see
// docs/ESSENTIAL_COMMODITIES_OFFLINE_DESIGN.md in the envo-wms sibling project.
// Silent when there's nothing queued — a bar that's always there is a bar nobody
// reads.
const POLL_MS = 5000

export function OfflineStatusBar() {
  const [health, setHealth] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [showPanel, setShowPanel] = useState(false)

  useEffect(() => {
    let alive = true
    const poll = () => queueHealth().then(h => { if (alive) setHealth(h) }).catch(() => {})
    poll()
    const t = setInterval(poll, POLL_MS)
    return () => { alive = false; clearInterval(t) }
  }, [])

  async function syncNow() {
    setSyncing(true)
    try { await drainQueue() } finally { setSyncing(false) }
  }

  // The panel can stay open (e.g. showing "nothing queued") even after the bar
  // itself has nothing left to say — it's only opened by an explicit click, so
  // closing it out from under the operator the moment the last entry syncs would
  // be a worse experience than just letting it show the empty state.
  if (!health || health.totalCount === 0) {
    return showPanel ? <OfflineQueuePanel onClose={() => setShowPanel(false)} /> : null
  }

  const { pendingCount, failedCount, isStuck } = health

  return (
    <>
      <div
        role={isStuck || failedCount > 0 ? 'alert' : 'status'}
        className={`text-xs px-4 py-2 flex items-center justify-between gap-3 border-b
          ${isStuck || failedCount > 0
            ? 'bg-amber-950/60 border-amber-900/60 text-amber-200'
            : 'bg-blue-950/40 border-blue-900/50 text-blue-200'}`}
      >
        <span>
          {pendingCount > 0 && (
            <>
              <strong>{pendingCount}</strong> {pendingCount === 1 ? 'entry' : 'entries'} recorded and held, waiting to sync.
            </>
          )}
          {failedCount > 0 && (
            <> {pendingCount > 0 ? '· ' : ''}<strong>{failedCount}</strong> could not sync and need a look.</>
          )}
          {isStuck && <> · This device has been offline a while — check its connection.</>}
        </span>
        <span className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setShowPanel(true)}
            className="px-2 py-1 rounded-md bg-white/10 hover:bg-white/15 transition-colors"
          >
            Details
          </button>
          {pendingCount > 0 && (
            <button
              type="button"
              onClick={syncNow}
              disabled={syncing}
              className="px-2 py-1 rounded-md bg-white/10 hover:bg-white/15 disabled:opacity-50 transition-colors"
            >
              {syncing ? 'Syncing…' : 'Sync now'}
            </button>
          )}
        </span>
      </div>
      {showPanel && <OfflineQueuePanel onClose={() => setShowPanel(false)} />}
    </>
  )
}
