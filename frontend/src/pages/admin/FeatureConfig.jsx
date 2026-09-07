import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { Card, CardBody, CardHeader, CardTitle } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { LoadingState, EmptyState } from '../../components/ui/Loading'
import { toast } from '../../components/ui/Toast'
import { ShadowBanner } from './UserAccess'

const field = 'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-green-500'

// Feature Configuration — facility → department → feature → on/off.
//
// THE ONE IDEA THIS SCREEN MUST COMMUNICATE: configuration is DENY-ONLY.
// Turning a feature ON does not grant anybody anything; it removes a
// suppression. Turning it OFF suppresses a capability the user's role already
// carries. A permission answers "is this person capable of this"; a feature
// answers "does this workflow exist here at all".
//
// So "on" is rendered as the neutral default state, not as a grant, and the
// copy says what off actually does. The server enforces the same thing
// structurally: enabling DELETES the row rather than storing enabled = true.

export function FeatureConfig() {
  const [meta, setMeta] = useState(null)
  const [config, setConfig] = useState([])
  const [facilities, setFacilities] = useState([])
  const [facilityId, setFacilityId] = useState('')
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    (async () => {
      try {
        const [m, cfg, facs] = await Promise.all([
          api.admin.meta(), api.admin.featureConfig(), api.facilities.list(),
        ])
        setMeta(m); setConfig(cfg || []); setFacilities(facs || [])
      } catch (err) {
        setError(err.status === 403
          ? 'This screen is for system and state administrators.'
          : (err.message || 'Could not load configuration.'))
      } finally { setLoading(false) }
    })()
  }, [])

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase()
    return t ? facilities.filter(f => f.name.toLowerCase().includes(t)) : facilities
  }, [facilities, q])

  const selected = facilities.find(f => f.id === facilityId) || null

  // Explicit disables only — an absent row means enabled.
  const disabled = useMemo(() => {
    const s = new Set()
    for (const r of config) if (!r.enabled) s.add(`${r.facility_id}|${r.department}|${r.feature}`)
    return s
  }, [config])

  async function toggle(department, feature, nextEnabled) {
    const k = `${department}|${feature}`
    setBusy(k); setError('')
    try {
      setConfig(await api.admin.setFeatureConfig({
        facility_id: facilityId, department, feature, enabled: nextEnabled,
      }))
      toast(nextEnabled
        ? `${feature} restored for ${department}`
        : `${feature} switched off for ${department}`, nextEnabled ? 'green' : '')
    } catch (err) {
      setError(err.message || 'Could not save.')
    } finally { setBusy('') }
  }

  if (loading) return <LoadingState />
  if (error && !meta) return (
    <Card><CardBody><div className="py-8 text-center text-sm text-gray-400">{error}</div></CardBody></Card>
  )

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-medium text-gray-100">Feature Configuration</h1>
        <p className="text-sm text-gray-500 mt-1">
          Switch a workflow off for one department at one facility
          {meta.identity.state ? ` · ${meta.identity.state} state only` : ''}
        </p>
      </div>

      <ShadowBanner />

      <div className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3 text-xs text-gray-400 leading-relaxed">
        <span className="text-gray-300 font-medium">Off suppresses. On does not grant.</span>{' '}
        Switching a feature off hides a workflow that the department's role would
        otherwise allow. Switching it back on only removes that suppression — it
        never gives anyone a capability their role does not already carry, and it
        never affects reading history.
      </div>

      <Card><CardBody>
        <div className="flex flex-col sm:flex-row gap-3">
          <input className={field} value={q} onChange={e => setQ(e.target.value)}
                 placeholder="Search facilities…" />
          <select className={`${field} sm:w-96`} value={facilityId}
                  onChange={e => setFacilityId(e.target.value)}>
            <option value="">— select a facility —</option>
            {shown.map(f => (
              <option key={f.id} value={f.id}>{f.name}{f.state ? ` · ${f.state}` : ''}</option>
            ))}
          </select>
        </div>
      </CardBody></Card>

      {!facilityId ? (
        <Card><CardBody><EmptyState message="Choose a facility to configure its features." /></CardBody></Card>
      ) : (
        <Card>
          <CardHeader><CardTitle>{selected?.name}</CardTitle></CardHeader>
          <CardBody>
            {error && <div className="text-sm text-red-400 mb-3">{error}</div>}
            <div className="space-y-4">
              {meta.sections.map(section => (
                <div key={section.key}>
                  <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">{section.key}</div>
                  <div className="space-y-1.5">
                    {meta.features.map(f => {
                      const off = disabled.has(`${facilityId}|${section.key}|${f.key}`)
                      const k = `${section.key}|${f.key}`
                      return (
                        <div key={f.key}
                             className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/5">
                          <div className="min-w-0">
                            <div className="text-sm text-gray-200">{f.key}</div>
                            <div className="text-xs text-gray-500">
                              {off
                                ? `Suppresses ${f.suppresses.join(', ')} for this department`
                                : `Available — role decides who may use it`}
                            </div>
                          </div>
                          <Toggle on={!off} busy={busy === k}
                                  onChange={next => toggle(section.key, f.key, next)} />
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  )
}

function Toggle({ on, busy, onChange }) {
  return (
    <button
      onClick={() => onChange(!on)}
      disabled={busy}
      aria-pressed={on}
      className={`flex-shrink-0 w-14 h-7 rounded-full border transition-colors relative disabled:opacity-50 ${
        on ? 'bg-green-500/25 border-green-500/40' : 'bg-white/5 border-white/15'
      }`}
    >
      <span className={`absolute top-0.5 w-5 h-5 rounded-full transition-all ${
        on ? 'left-8 bg-green-400' : 'left-0.5 bg-gray-500'
      }`} />
      <span className="sr-only">{on ? 'On' : 'Off'}</span>
    </button>
  )
}
