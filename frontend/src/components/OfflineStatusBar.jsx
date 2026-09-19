import { useEffect, useState } from 'react'
import { queueHealth, drainQueue } from '../lib/offlineQueue'

// Honest status, in the same operational language the WMS's own connection bar
// uses ("work is being recorded and held") — see
// docs/ESSENTIAL_COMMODITIES_OFFLINE_DESIGN.md in the envo-wms sibling project.
// Silent when there's nothing queued — a bar that's always there is a bar nobody
// reads.
const POLL_MS = 5000

export function OfflineStatusBar() {
  const [health, setHealth] = useState(null)
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    let alive = true
    const poll = () => queueHealth().then(h => { if (alive) setHealth(h) }).catch(() => {})
    poll()
    const t = setInterval(poll, POLL_MS)
    return () => { alive = false; clearInterval(t) }
  }, [])

  if (!health || health.totalCount === 0) return null

  async function syncNow() {
    setSyncing(true)
    try { await drainQueue() } finally { setSyncing(false) }
  }

  const { pendingCount, failedCount, isStuck } = health

  return (
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
      {pendingCount > 0 && (
        <button
          type="button"
          onClick={syncNow}
          disabled={syncing}
          className="shrink-0 px-2 py-1 rounded-md bg-white/10 hover:bg-white/15 disabled:opacity-50 transition-colors"
        >
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      )}
    </div>
  )
}
