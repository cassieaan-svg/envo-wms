import { useEffect, useState } from 'react'
import { useAppStore } from '../store/appStore'
import { listQueue, retryQueueEntry, discardQueueEntry, drainQueue } from '../lib/offlineQueue'
import { toast } from './ui/Toast'

const OP_LABEL = {
  dispense: 'Stock consumed',
  intake: 'Stock intake',
  adjustment: 'Adjustment',
  transferDispatch: 'Transfer dispatch',
  transferAccept: 'Transfer accept',
  warehouseRequest: 'Warehouse request',
}

const STATUS_STYLE = {
  pending: 'bg-blue-500/15 text-blue-400',
  syncing: 'bg-amber-500/15 text-amber-400',
  failed:  'bg-red-500/15 text-red-400',
}

function commodityName(id, commodities) {
  return commodities.find(c => c.id === id)?.name || null
}

// A one-line human summary of what's actually in the queued body — the operator
// should be able to tell what a stuck entry IS without opening devtools.
function summarize(entry, commodities) {
  const b = entry.body || {}
  switch (entry.operation) {
    case 'dispense':
    case 'intake':
      return `${b.quantity ?? '?'} × ${commodityName(b.commodity_id, commodities) || 'commodity'}`
    case 'adjustment': {
      const base = `${b.adjustment_type ?? ''} ${b.quantity ?? '?'} × ${commodityName(b.commodity_id, commodities) || 'commodity'}`
      return b.return_from_location_type ? `${base} (returned from ${b.return_from_location_type})` : base
    }
    case 'transferDispatch':
      return `Dispatch (qty ${b.quantity ?? '?'})`
    case 'transferAccept':
      return `Accept — received by ${b.received_by || '—'}`
    case 'warehouseRequest':
      return `${b.items?.length ?? 0} line item(s) — ${b.requestedBy || '—'}`
    default:
      return ''
  }
}

function relativeTime(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

export function OfflineQueuePanel({ onClose }) {
  const commodities = useAppStore(s => s.allCommodities) || []
  const [entries, setEntries] = useState([])
  const [busyId, setBusyId] = useState(null)
  const [syncingAll, setSyncingAll] = useState(false)

  async function refresh() {
    setEntries(await listQueue())
  }
  useEffect(() => { refresh() }, [])

  async function syncNow() {
    setSyncingAll(true)
    try {
      const { failed } = await drainQueue()
      if (failed > 0) toast(`${failed} entr${failed === 1 ? 'y' : 'ies'} could not sync — see details below`, 'amber')
      await refresh()
    } finally { setSyncingAll(false) }
  }

  async function retry(id) {
    setBusyId(id)
    try { await retryQueueEntry(id); await syncNow() } finally { setBusyId(null) }
  }

  async function discard(id) {
    if (!confirm('Discard this entry? It will never be sent — only do this if you\'re sure the work it describes is no longer needed.')) return
    setBusyId(id)
    try { await discardQueueEntry(id); await refresh() } finally { setBusyId(null) }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-white/10 rounded-2xl p-6 w-full max-w-lg max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-medium text-gray-100">Waiting to sync</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
        </div>

        {entries.length === 0 ? (
          <p className="text-sm text-gray-500 py-6 text-center">Nothing queued — everything has synced.</p>
        ) : (
          <>
            <div className="space-y-2 mb-4">
              {entries.map(e => (
                <div key={e.clientTxnId} className="bg-white/3 border border-white/8 rounded-lg p-3">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-sm font-medium text-gray-200">{OP_LABEL[e.operation] || e.operation}</span>
                    <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full ${STATUS_STYLE[e.status] || 'bg-gray-500/15 text-gray-400'}`}>
                      {e.status}
                    </span>
                  </div>
                  <p className="text-xs text-gray-400">{summarize(e, commodities)}</p>
                  <p className="text-[11px] text-gray-600 mt-1">Recorded {relativeTime(e.createdAt)}</p>
                  {e.status === 'failed' && (
                    <>
                      <p className="text-xs text-red-400 mt-2">{e.lastError || 'Could not sync.'}</p>
                      <div className="flex gap-2 mt-2">
                        <button
                          type="button"
                          onClick={() => retry(e.clientTxnId)}
                          disabled={busyId === e.clientTxnId}
                          className="px-2 py-1 rounded-md bg-white/10 hover:bg-white/15 disabled:opacity-50 text-xs transition-colors"
                        >
                          Retry
                        </button>
                        <button
                          type="button"
                          onClick={() => discard(e.clientTxnId)}
                          disabled={busyId === e.clientTxnId}
                          className="px-2 py-1 rounded-md bg-red-500/10 hover:bg-red-500/15 disabled:opacity-50 text-xs text-red-400 transition-colors"
                        >
                          Discard
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={syncNow}
              disabled={syncingAll}
              className="w-full px-3 py-2 rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
            >
              {syncingAll ? 'Syncing…' : 'Sync now'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
