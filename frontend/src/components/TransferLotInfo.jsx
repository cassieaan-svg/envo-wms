import { fmtDate } from '../utils/helpers'

// Batch + expiry a sender stamped into a transfer's notes as [Batch: …] [Expiry: …].
// Surfaced on the receiver's Accept view so they can see what they're taking in —
// and get warned before accepting stock that's already expired or close to it.
// Urgency buckets match the Monitoring expiry view: expired <0d, critical ≤30d,
// warning ≤90d.
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
  if (d < 0)   return { label: 'Expired',  tone: 'red',   cls: 'text-red-300 bg-red-500/15 border-red-500/30' }
  if (d <= 30) return { label: 'Critical', tone: 'red',   cls: 'text-red-300 bg-red-500/10 border-red-500/25' }
  if (d <= 90) return { label: 'Warning',  tone: 'amber', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/25' }
  return null   // healthy shelf life — no pill needed
}

// Parse a transfer's notes for batch/expiry. Returns null when neither is present
// (e.g. a plain internal move), so callers can render nothing.
export function parseLotFromNotes(notes) {
  const batch = rxNote(notes, 'Batch')
  const expiry = rxNote(notes, 'Expiry')
  if (!batch && !expiry) return null
  return { batch, expiry, status: expiryStatus(expiry), isExpired: (daysUntil(expiry) ?? 1) < 0 }
}

// Inline batch + expiry readout with an urgency pill. Renders nothing when the
// transfer carries no lot metadata.
export function TransferLotInfo({ notes }) {
  const lot = parseLotFromNotes(notes)
  if (!lot) return null
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      {lot.batch && (
        <span className="text-gray-500">Batch: <span className="text-gray-300 font-medium">{lot.batch}</span></span>
      )}
      {lot.expiry && (
        <span className="text-gray-500 inline-flex items-center gap-1.5">
          Expiry: <span className="text-gray-300 font-medium">{fmtDate(lot.expiry)}</span>
          {lot.status && (
            <span className={`rounded-full border px-1.5 py-0.5 leading-none font-medium ${lot.status.cls}`}>
              {lot.status.label}
            </span>
          )}
        </span>
      )}
    </div>
  )
}
