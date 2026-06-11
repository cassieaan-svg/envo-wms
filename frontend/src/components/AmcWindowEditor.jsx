import { useState, useRef, useEffect } from 'react'
import { sb } from '../lib/supabase'
import { useAppStore } from '../store/appStore'
import { Card } from './ui/Card'
import { toast } from './ui/Toast'

const labelFor = ym => {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, (m || 1) - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
}

// The last `count` completed months (excludes the current, in-progress month so
// a partial month can't skew the average), most-recent first.
function recentMonths(count = 24) {
  const out = []
  const now = new Date()
  for (let i = 1; i <= count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  return out
}

// Per-facility AMC month picker. A manager/admin selects the specific months
// (any combination, not a contiguous range) to average AMC over for one
// facility, via a multi-select dropdown. Saving upserts the selection; `onSaved`
// lets the host page recompute AMC in place.
export function AmcWindowEditor({ facilityId, facilityName, onSaved }) {
  const store = useAppStore()
  const win = store.amcWindows[facilityId] || null
  const [selected, setSelected] = useState(() => new Set(win?.months || []))
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const ref = useRef(null)

  // Close the dropdown on an outside click.
  useEffect(() => {
    if (!open) return
    const onDoc = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // Offer the last 24 completed months, plus any already-saved month older than
  // that so a prior selection stays visible.
  const base = recentMonths(24)
  const options = [...new Set([...selected, ...base])].sort((a, b) => (a < b ? 1 : -1)) // desc
  const chosen = [...selected].sort() // asc, for the summary
  const count = selected.size

  const toggle = ym => setSelected(prev => {
    const n = new Set(prev)
    n.has(ym) ? n.delete(ym) : n.add(ym)
    return n
  })

  async function save() {
    if (count < 1) { toast('Pick at least one month', 'red'); return }
    setSaving(true)
    const months = [...selected].sort()
    const { error } = await sb.from('facility_amc_settings').upsert(
      { facility_id: facilityId, months, updated_at: new Date().toISOString(), updated_by: store.user?.email || null },
      { onConflict: 'facility_id' },
    )
    setSaving(false)
    if (error) { toast(`Could not save AMC months: ${error.message}`, 'red'); return }
    store.setAmcWindow(facilityId, { months })
    setOpen(false)
    toast('AMC months saved', 'green')
    onSaved?.()
  }

  async function resetToDefault() {
    setSaving(true)
    const { error } = await sb.from('facility_amc_settings').delete().eq('facility_id', facilityId)
    setSaving(false)
    if (error) { toast(`Could not reset: ${error.message}`, 'red'); return }
    store.setAmcWindow(facilityId, null)
    setSelected(new Set())
    setOpen(false)
    toast('Reverted to the default AMC window', 'green')
    onSaved?.()
  }

  return (
    <Card className="mb-4 overflow-visible">
      <div className="px-4 py-3">
        <div className="flex items-baseline justify-between gap-2 flex-wrap mb-1">
          <div className="text-sm font-medium text-gray-200">
            AMC months{facilityName ? ` — ${facilityName}` : ''}
          </div>
          <div className="text-xs text-gray-500">
            {win?.months?.length
              ? `Averaging ${win.months.length} selected month${win.months.length > 1 ? 's' : ''}`
              : 'Using the default quarterly window'}
          </div>
        </div>
        <p className="text-[11px] text-gray-600 mb-2.5">
          Pick the months to average — any combination, not just a range. AMC = total dispensed across them ÷ {count || 'N'} month{count === 1 ? '' : 's'}.
        </p>

        <div className="flex items-center gap-2.5 flex-wrap">
          {/* Multi-select dropdown */}
          <div className="relative" ref={ref}>
            <button type="button" onClick={() => setOpen(o => !o)}
              className="flex items-center justify-between gap-3 min-w-52 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 hover:bg-white/10 focus:outline-none focus:border-blue-500">
              <span className={count ? 'text-gray-200' : 'text-gray-500'}>
                {count ? `${count} month${count > 1 ? 's' : ''} selected` : 'Select months…'}
              </span>
              <span className="text-xs text-gray-500">▼</span>
            </button>
            {open && (
              <div className="absolute top-full left-0 mt-1 bg-gray-900 border border-white/20 rounded-lg p-2 z-50 w-72 max-h-72 overflow-y-auto shadow-xl">
                <div className="flex items-center justify-between px-1 pb-2 mb-1 border-b border-white/8">
                  <span className="text-[11px] text-gray-500 uppercase tracking-widest">Months</span>
                  {count > 0 && (
                    <button type="button" onClick={() => setSelected(new Set())}
                      className="text-[11px] text-gray-500 hover:text-gray-300">Clear all</button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-0.5">
                  {options.map(ym => (
                    <label key={ym} className="flex items-center gap-2 px-2 py-1.5 hover:bg-white/5 rounded cursor-pointer">
                      <input type="checkbox" checked={selected.has(ym)} onChange={() => toggle(ym)} className="w-3.5 h-3.5 cursor-pointer" />
                      <span className="text-xs text-gray-200">{labelFor(ym)}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>

          {count > 0 && <span className="text-xs text-gray-400">÷ {count}</span>}

          <button onClick={save} disabled={saving || count < 1}
            className="bg-green-500 hover:bg-green-400 disabled:opacity-50 text-white rounded-lg px-4 py-2 text-xs font-medium transition-colors">
            Save
          </button>
          {win && (
            <button onClick={resetToDefault} disabled={saving}
              className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-2 disabled:opacity-50">
              Reset to default
            </button>
          )}
        </div>

        {/* At-a-glance summary of the picked months */}
        {chosen.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2.5">
            {chosen.map(ym => (
              <span key={ym} className="inline-flex items-center gap-1 text-[11px] bg-green-500/12 border border-green-500/30 text-green-300 rounded-full px-2 py-0.5">
                {labelFor(ym)}
                <button type="button" onClick={() => toggle(ym)} className="text-green-400/70 hover:text-green-200">✕</button>
              </span>
            ))}
          </div>
        )}
      </div>
    </Card>
  )
}
