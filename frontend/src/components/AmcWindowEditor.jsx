import { useState } from 'react'
import { sb } from '../lib/supabase'
import { useAppStore } from '../store/appStore'
import { Card } from './ui/Card'
import { toast } from './ui/Toast'
import { resolveAmcWindow, monthsInRange } from '../utils/helpers'

const toMonthInput = d => (d ? String(d).slice(0, 7) : '')   // 'YYYY-MM-DD' → 'YYYY-MM'
const currentMonth = () => {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`
}

// Per-facility AMC window editor. Lets a manager/admin pick the From→To month
// range used to average AMC for one facility. Saving upserts the setting and
// updates the store; `onSaved` lets the host page recompute AMC in place.
export function AmcWindowEditor({ facilityId, facilityName, onSaved }) {
  const store = useAppStore()
  const win = store.amcWindows[facilityId] || null
  const [from, setFrom] = useState(toMonthInput(win?.amc_from))
  const [to, setTo]     = useState(toMonthInput(win?.amc_to))
  const [saving, setSaving] = useState(false)

  const maxMonth = currentMonth()
  const valid = from && to && from <= to && to <= maxMonth
  const months = valid ? monthsInRange(`${from}-01`, `${to}-01`) : 0
  const resolved = resolveAmcWindow(win)

  async function save() {
    if (!valid) {
      toast('Pick a valid range: From ≤ To, and not in the future', 'red')
      return
    }
    setSaving(true)
    const payload = {
      facility_id: facilityId,
      amc_from: `${from}-01`,
      amc_to: `${to}-01`,
      updated_at: new Date().toISOString(),
      updated_by: store.user?.email || null,
    }
    const { error } = await sb.from('facility_amc_settings').upsert(payload, { onConflict: 'facility_id' })
    setSaving(false)
    if (error) { toast(`Could not save AMC window: ${error.message}`, 'red'); return }
    store.setAmcWindow(facilityId, { amc_from: payload.amc_from, amc_to: payload.amc_to })
    toast('AMC window saved', 'green')
    onSaved?.()
  }

  async function resetToDefault() {
    setSaving(true)
    const { error } = await sb.from('facility_amc_settings').delete().eq('facility_id', facilityId)
    setSaving(false)
    if (error) { toast(`Could not reset: ${error.message}`, 'red'); return }
    store.setAmcWindow(facilityId, null)
    setFrom(''); setTo('')
    toast('Reverted to the default AMC window', 'green')
    onSaved?.()
  }

  const inputCls = 'block mt-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-blue-500'

  return (
    <Card className="mb-4">
      <div className="px-4 py-3">
        <div className="mb-2">
          <div className="text-sm font-medium text-gray-200">
            AMC window{facilityName ? ` — ${facilityName}` : ''}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            {resolved.custom
              ? `Averaging ${resolved.months} month${resolved.months > 1 ? 's' : ''} of consumption (custom range)`
              : 'Using the default quarterly window'}
          </div>
        </div>
        <div className="flex items-end gap-3 flex-wrap">
          <label className="text-xs text-gray-500">From
            <input type="month" max={maxMonth} value={from} onChange={e => setFrom(e.target.value)} className={inputCls} />
          </label>
          <label className="text-xs text-gray-500">To
            <input type="month" max={maxMonth} value={to} onChange={e => setTo(e.target.value)} className={inputCls} />
          </label>
          {valid && (
            <span className="text-xs text-gray-400 pb-1.5">÷ {months} month{months > 1 ? 's' : ''}</span>
          )}
          <button onClick={save} disabled={saving || !valid}
            className="bg-green-500 hover:bg-green-400 disabled:opacity-50 text-white rounded-lg px-4 py-1.5 text-xs font-medium transition-colors">
            Save
          </button>
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
