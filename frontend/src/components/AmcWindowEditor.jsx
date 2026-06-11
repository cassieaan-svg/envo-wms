import { useState } from 'react'
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
// facility. Saving upserts the selection; `onSaved` lets the host page recompute
// AMC in place.
export function AmcWindowEditor({ facilityId, facilityName, onSaved }) {
  const store = useAppStore()
  const win = store.amcWindows[facilityId] || null
  const [selected, setSelected] = useState(() => new Set(win?.months || []))
  const [saving, setSaving] = useState(false)

  // Offer the last 24 completed months, plus any already-saved month older than
  // that so a prior selection stays visible.
  const base = recentMonths(24)
  const options = [...new Set([...selected, ...base])].sort((a, b) => (a < b ? 1 : -1)) // desc

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
    toast('Reverted to the default AMC window', 'green')
    onSaved?.()
  }

  return (
    <Card className="mb-4">
      <div className="px-4 py-3">
        <div className="flex items-baseline justify-between gap-2 flex-wrap mb-2">
          <div className="text-sm font-medium text-gray-200">
            AMC months{facilityName ? ` — ${facilityName}` : ''}
          </div>
          <div className="text-xs text-gray-500">
            {win?.months?.length
              ? `Averaging ${win.months.length} selected month${win.months.length > 1 ? 's' : ''}`
              : 'Using the default quarterly window'}
          </div>
        </div>
        <p className="text-[11px] text-gray-600 mb-2">
          Pick the months to average — any combination, not just a range. AMC = total dispensed across them ÷ {count || 'N'} month{count === 1 ? '' : 's'}.
        </p>

        <div className="flex flex-wrap gap-1.5 mb-3">
          {options.map(ym => {
            const on = selected.has(ym)
            return (
              <button key={ym} type="button" onClick={() => toggle(ym)}
                className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${on
                  ? 'bg-green-500/15 border-green-500/40 text-green-300'
                  : 'bg-white/5 border-white/10 text-gray-400 hover:bg-white/8'}`}>
                {labelFor(ym)}
              </button>
            )
          })}
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs text-gray-400">{count} selected{count > 0 ? ` · ÷ ${count}` : ''}</span>
          <button onClick={save} disabled={saving || count < 1}
            className="bg-green-500 hover:bg-green-400 disabled:opacity-50 text-white rounded-lg px-4 py-1.5 text-xs font-medium transition-colors">
            Save
          </button>
          {selected.size > 0 && (
            <button onClick={() => setSelected(new Set())} disabled={saving}
              className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5 disabled:opacity-50">
              Clear
            </button>
          )}
          {win && (
            <button onClick={resetToDefault} disabled={saving}
              className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5 disabled:opacity-50">
              Reset to default
            </button>
          )}
        </div>
      </div>
    </Card>
  )
}
