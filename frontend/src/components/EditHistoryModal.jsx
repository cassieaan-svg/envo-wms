import { useState, useEffect } from 'react'
import { api } from '../lib/api'
import { fmtDate } from '../utils/helpers'

// Read-only audit trail for a single log record (dispense / intake / adjustment).
// Opened from the "History" button next to each row's "Edit" button.
export function EditHistoryModal({ record, onClose }) {
  const [rows, setRows]       = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const data = await api.editHistory.byRecord(record.id)
        if (!active) return
        setRows(data || [])
      } catch (e) {
        if (!active) return
        setError(e.message)
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [record.id])

  const unit = record.commodities?.unit || ''

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-white/10 rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-medium text-gray-100">Edit history</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
        </div>
        <p className="text-xs text-gray-500 mb-4">{record.commodities?.name || 'Record'} — audit trail of changes</p>

        {loading ? (
          <div className="text-sm text-gray-500 py-8 text-center">Loading…</div>
        ) : error ? (
          <div className="text-sm text-red-400 py-8 text-center">Could not load history: {error}</div>
        ) : rows.length === 0 ? (
          <div className="text-sm text-gray-500 py-8 text-center">No edits recorded yet for this record.</div>
        ) : (
          <ol className="relative border-l border-white/10 ml-2 space-y-5">
            {rows.map(h => {
              const diff = Number(h.quantity_diff) || 0
              const increased = diff > 0
              // Wording + colour depend on the record type:
              //  - dispense: more consumed = stock down (red); less = returned (green)
              //  - intake:   more received = stock up (green); less = removed (red)
              //  - adjustment: neutral, just show the delta
              let label = '', good = false
              if (diff !== 0) {
                if (h.record_type === 'dispense') {
                  label = increased ? `+${diff} consumed` : `${diff} returned`
                  good = !increased
                } else if (h.record_type === 'intake') {
                  label = increased ? `+${diff} received` : `${diff} removed`
                  good = increased
                } else {
                  label = increased ? `+${diff}` : `${diff}`
                  good = increased
                }
              }
              return (
                <li key={h.id} className="ml-4">
                  <span className={`absolute -left-[7px] w-3.5 h-3.5 rounded-full border-2 border-gray-900 ${diff === 0 ? 'bg-gray-500' : good ? 'bg-green-500' : 'bg-red-500'}`} />
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-sm text-gray-400">{h.old_quantity}</span>
                    <span className="text-gray-500">→</span>
                    <span className="font-mono text-sm text-gray-100 font-medium">{h.new_quantity} {unit}</span>
                    {diff !== 0 && (
                      <span className={`text-xs font-semibold ${good ? 'text-green-400' : 'text-red-400'}`}>
                        {label}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    {h.edited_by || 'Unknown'} · {fmtDate(h.created_at)}
                  </div>
                  {h.note && <div className="text-xs text-gray-400 mt-1 italic">“{h.note}”</div>}
                </li>
              )
            })}
          </ol>
        )}

        <div className="mt-6">
          <button onClick={onClose} className="w-full border border-white/10 rounded-lg py-2.5 text-sm text-gray-300 hover:text-gray-100 transition-colors">Close</button>
        </div>
      </div>
    </div>
  )
}
