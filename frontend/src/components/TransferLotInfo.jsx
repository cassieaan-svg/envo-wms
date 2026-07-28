import { fmtDate } from '../utils/helpers'

// Batch + expiry of the stock a transfer is carrying, surfaced on the receiver's
// Accept / Confirm-receipt view so they can see what they're taking in — and get
// warned before accepting stock that's already expired.
//
// Two sources, in order: the structured `lots` array the dispatch drew (DSD/SDP
// and dispatched facility transfers record it there), else a single [Batch:] /
// [Expiry:] pair a sender stamped into the notes (external redistribution).
// Urgency buckets match the Monitoring expiry view: expired <0d, critical <=30d,
// warning <=90d.
function rxNote(notes, tag) {
  const m = new RegExp(`\\[${tag}:\\s*([^\\]]*)\\]`, 'i').exec(notes || '')
  return m ? m[1].trim() : ''
}

// Whole days from today (Lagos) until the given YYYY-MM-DD; null if unparseable.
function daysUntil(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(dateStr || '')) return null
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' })
  const ms = Date.parse(dateStr.slice(0, 10) + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')
  return Number.isNaN(ms) ? null : Math.round(ms / 86400000)
}

function expiryStatus(dateStr) {
  const d = daysUntil(dateStr)
  if (d === null) return null
  if (d < 0)   return { label: 'Expired',  cls: 'text-red-300 bg-red-500/15 border-red-500/30' }
  if (d <= 30) return { label: 'Critical', cls: 'text-red-300 bg-red-500/10 border-red-500/25' }
  if (d <= 90) return { label: 'Warning',  cls: 'text-amber-300 bg-amber-500/10 border-amber-500/25' }
  return null   // healthy shelf life — no pill needed
}

// Normalize a transfer's carried lots into [{ batch, expiry }]. Prefers the
// structured `lots` array; falls back to a single notes-encoded pair. Accepts a
// record, or (legacy) a bare `{ notes }` shape.
export function transferLots(record) {
  if (!record) return []
  const arr = Array.isArray(record.lots) ? record.lots : null
  if (arr && arr.length) {
    return arr
      .map(l => ({ batch: (l.batch || '').toString(), expiry: (l.expiry || '').toString().slice(0, 10) }))
      .filter(l => l.batch || l.expiry)
  }
  const batch = rxNote(record.notes, 'Batch')
  const expiry = rxNote(record.notes, 'Expiry')
  return (batch || expiry) ? [{ batch, expiry }] : []
}

// True if any lot the transfer carries is already expired.
export function hasExpiredLot(record) {
  return transferLots(record).some(l => (daysUntil(l.expiry) ?? 1) < 0)
}

// The soonest already-expired expiry the transfer carries (for the warning text),
// or null when nothing is expired.
export function earliestExpiredExpiry(record) {
  return transferLots(record)
    .map(l => l.expiry)
    .filter(e => (daysUntil(e) ?? 1) < 0)
    .sort()[0] || null
}

// Inline batch + expiry readout with an urgency pill per lot. Renders nothing when
// the transfer carries no lot metadata. Pass `record` (preferred) or `notes`.
export function TransferLotInfo({ record, notes }) {
  const lots = transferLots(record || { notes })
  if (!lots.length) return null
  return (
    <div className="mt-1.5 space-y-1 text-xs">
      {lots.map((l, i) => {
        const st = expiryStatus(l.expiry)
        return (
          <div key={i} className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {l.batch && (
              <span className="text-gray-500">Batch: <span className="text-gray-300 font-medium">{l.batch}</span></span>
            )}
            {l.expiry && (
              <span className="text-gray-500 inline-flex items-center gap-1.5">
                Expiry: <span className="text-gray-300 font-medium">{fmtDate(l.expiry)}</span>
                {st && <span className={`rounded-full border px-1.5 py-0.5 leading-none font-medium ${st.cls}`}>{st.label}</span>}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
