import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Loading'
import { toast } from '../ui/Toast'

const field = 'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-green-500'
const label = 'text-xs text-gray-500 uppercase tracking-wide'

// Which geography scope each role takes. Mirrors REQUIRED_GEOGRAPHY in
// aclAdminService.js — the server rejects a mismatch, so this only shapes the
// form. null = national, no geography row at all.
const GEOGRAPHY_FOR = {
  facility: 'facility', state_admin: 'state', state_viewer: 'state',
  cluster_admin: 'cluster', lga_admin: 'lga', essential_admin: 'state',
  overall_admin: null, system_admin: null,
}

const ROLE_HELP = {
  facility: 'Own facility. Reads and writes its own stock.',
  state_admin: 'Own state. The only cross-facility writer, and administers users in that state.',
  state_viewer: 'Own state, read-only.',
  cluster_admin: 'Own cluster, read-only.',
  lga_admin: 'Own LGA, read-only.',
  overall_admin: 'All states, read-only. Administers nobody.',
  system_admin: 'Administers users, roles and scopes. No operational access at all.',
  essential_admin: 'Essential Commodities module, within its state.',
}

export function UserConfigPanel({ userId, meta, onClose, onSaved }) {
  const [cfg, setCfg] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [role, setRole] = useState('')
  const [geoValue, setGeoValue] = useState('')
  // Narrowing selections, NOT the scope itself. Only geoValue is ever written;
  // these two exist so the picker can cascade instead of showing 288 facilities
  // in one flat list.
  const [geoState, setGeoState] = useState('')
  const [geoLga, setGeoLga] = useState('')
  // Sections are a SET, not one value: the commodity dimension ORs within
  // itself, so an account can hold several (an Essential login holds pharmacy
  // and essential).
  const [sections, setSections] = useState([])
  const [modules, setModules] = useState([])
  const [facilities, setFacilities] = useState([])
  const [confirm, setConfirm] = useState(null)

  useEffect(() => {
    (async () => {
      try {
        const [c, facs] = await Promise.all([api.admin.user(userId), api.facilities.list()])
        const list = facs || []
        setCfg(c); setFacilities(list)
        setRole(c.role || '')
        setSections(c.scopes
          .filter(s => s.dimension === 'commodity' && s.scope_type === 'section')
          .map(s => s.scope_id).sort())
        setModules(c.scopes.filter(s => s.dimension === 'module').map(s => s.scope_id))

        // Prefill the cascade by working BACKWARDS from the stored scope, so
        // opening an existing user shows where they already sit rather than an
        // empty form the administrator has to re-navigate.
        const geo = c.scopes.find(s => s.dimension === 'geography')
        setGeoValue(geo?.scope_id || '')
        if (geo) {
          const owner = geo.scope_type === 'facility'
            ? list.find(f => f.id === geo.scope_id)
            : list.find(f => f[geo.scope_type] === geo.scope_id)
          if (geo.scope_type === 'state') setGeoState(geo.scope_id)
          else if (owner) { setGeoState(owner.state || ''); setGeoLga(owner.lga || '') }
        }
      } catch (err) { setError(err.message || 'Could not load this user.') }
    })()
  }, [userId])

  const geoType = role ? GEOGRAPHY_FOR[role] : undefined

  // Every list is derived from the real facility table, so a scope can never name
  // something that matches no facility.
  const states = useMemo(
    () => [...new Set(facilities.map(f => f.state).filter(Boolean))].sort(),
    [facilities])

  const lgas = useMemo(
    () => [...new Set(facilities.filter(f => f.state === geoState).map(f => f.lga).filter(Boolean))].sort(),
    [facilities, geoState])

  const clusters = useMemo(
    () => [...new Set(facilities.filter(f => f.state === geoState).map(f => f.cluster).filter(Boolean))].sort(),
    [facilities, geoState])

  const facilityOptions = useMemo(
    () => facilities
      .filter(f => f.state === geoState && f.lga === geoLga)
      .sort((a, b) => a.name.localeCompare(b.name)),
    [facilities, geoState, geoLga])

  // Changing a wider level invalidates the narrower ones — otherwise a state
  // change would leave an LGA from the previous state still selected, and the
  // scope written would name a place the facility list does not agree with.
  const pickState = v => { setGeoState(v); setGeoLga(''); setGeoValue(geoType === 'state' ? v : '') }
  const pickLga = v => { setGeoLga(v); setGeoValue(geoType === 'lga' ? v : '') }

  if (error) return <Overlay onClose={onClose}><div className="text-sm text-red-400">{error}</div></Overlay>
  if (!cfg) return <Overlay onClose={onClose}><Spinner /></Overlay>

  const dirty = role !== (cfg.role || '')
    || geoValue !== (cfg.scopes.find(s => s.dimension === 'geography')?.scope_id || '')
    || sections.join(',') !== cfg.scopes
         .filter(s => s.dimension === 'commodity' && s.scope_type === 'section')
         .map(s => s.scope_id).sort().join(',')
    || modules.join(',') !== cfg.scopes.filter(s => s.dimension === 'module').map(s => s.scope_id).sort().join(',')

  function buildScopes() {
    const scopes = []
    if (geoType && geoValue) scopes.push({ dimension: 'geography', scope_type: geoType, scope_id: geoValue })
    for (const key of sections) scopes.push({ dimension: 'commodity', scope_type: 'section', scope_id: key })
    for (const key of modules) scopes.push({ dimension: 'module', scope_type: 'module', scope_id: key })
    return scopes
  }

  const toggleIn = setter => key => setter(v =>
    v.includes(key) ? v.filter(x => x !== key) : [...v, key].sort())
  const toggleModule = toggleIn(setModules)
  const toggleSection = toggleIn(setSections)

  async function save() {
    setBusy(true); setError('')
    try {
      const next = await api.admin.setRole(userId, { role, scopes: buildScopes() })
      setCfg(next)
      toast('Configuration saved', 'green')
      onSaved?.()
      setConfirm(null)
    } catch (err) {
      setError(err.message || 'Could not save.')
      setConfirm(null)
    } finally { setBusy(false) }
  }

  async function toggleOverride(key, effect) {
    setBusy(true); setError('')
    try {
      setCfg(await api.admin.setOverride(userId, { permission_key: key, effect }))
      toast(effect ? `Override set: ${effect}` : 'Override cleared', 'green')
    } catch (err) {
      setError(err.message || 'Could not change the override.')
    } finally { setBusy(false) }
  }

  const byModule = cfg.permissions.reduce((acc, p) => {
    (acc[p.module] ||= []).push(p); return acc
  }, {})

  return (
    <Overlay onClose={onClose} wide>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <div className="text-base font-medium text-gray-100">{cfg.email}</div>
          <div className="text-xs text-gray-500 mt-0.5">
            ACL role: {cfg.role || 'none'} · {cfg.scopes.length} scope {cfg.scopes.length === 1 ? 'row' : 'rows'}
          </div>
        </div>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-sm">Close</button>
      </div>

      {!cfg.editable && (
        <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 mb-4 text-xs text-gray-400">
          Read-only: you cannot modify your own account, or one whose role is above your own.
        </div>
      )}

      {/* Live metadata, deliberately read-only and shown first — this is what
          actually governs the account today. */}
      <section className="mb-5">
        <div className={label}>Current sign-in metadata (live)</div>
        <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <Meta k="access_level" v={cfg.legacy.access_level} />
          <Meta k="section" v={cfg.legacy.commodity_section} />
          <Meta k="facility" v={cfg.legacy.facility_name} />
          <Meta k="facility_role" v={cfg.legacy.facility_role} note="display only" />
        </div>
      </section>

      <section className="mb-5">
        <div className={label}>ACL role</div>
        <select className={`${field} mt-2`} value={role} disabled={!cfg.editable}
                onChange={e => { setRole(e.target.value); setGeoValue('') }}>
          <option value="">— select a role —</option>
          {meta.roles.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        {role && <div className="text-xs text-gray-500 mt-1.5">{ROLE_HELP[role]}</div>}
      </section>

      <section className="mb-5">
        <div className={label}>Geographic scope</div>
        {geoType === null ? (
          <div className="text-sm text-gray-400 mt-2">
            National — this role carries no geographic scope.
          </div>
        ) : !role ? (
          <div className="text-sm text-gray-500 mt-2">Select a role first.</div>
        ) : (
          // Cascading: state narrows the LGA list, which narrows the facility
          // list. Only the level the ROLE is scoped by is written as the scope —
          // the wider selections are navigation, not access.
          <div className="mt-2 space-y-2">
            <select className={field} value={geoState} disabled={!cfg.editable}
                    onChange={e => pickState(e.target.value)}>
              <option value="">— select a state —</option>
              {states.map(s => <option key={s} value={s}>{s}</option>)}
            </select>

            {(geoType === 'lga' || geoType === 'facility') && geoState && (
              <select className={field} value={geoLga} disabled={!cfg.editable}
                      onChange={e => pickLga(e.target.value)}>
                <option value="">— select an LGA in {geoState} —</option>
                {lgas.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            )}

            {geoType === 'facility' && geoLga && (
              <select className={field} value={geoValue} disabled={!cfg.editable}
                      onChange={e => setGeoValue(e.target.value)}>
                <option value="">— select a facility in {geoLga} —</option>
                {facilityOptions.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            )}

            {geoType === 'cluster' && geoState && (
              <select className={field} value={geoValue} disabled={!cfg.editable}
                      onChange={e => setGeoValue(e.target.value)}>
                <option value="">— select a cluster in {geoState} —</option>
                {clusters.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            )}

            <div className="text-xs text-gray-500">
              {geoValue
                ? <>Scope written: <span className="text-gray-400">{geoType}</span></>
                : `This role is scoped by ${geoType}.`}
            </div>
          </div>
        )}
      </section>

      <section className="mb-5">
        <div className={label}>Module access</div>
        <div className="mt-2 flex flex-wrap gap-2">
          {(meta.modules || []).map(m => {
            const on = modules.includes(m.key)
            return (
              <button key={m.key} type="button" disabled={!cfg.editable}
                onClick={() => toggleModule(m.key)}
                className={`text-xs px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-40 ${
                  on ? 'bg-green-500/20 border-green-500/40 text-green-300'
                     : 'bg-white/5 border-white/10 text-gray-400 hover:bg-white/10'}`}>
                {m.label}
              </button>
            )
          })}
        </div>
        <div className="text-xs text-gray-500 mt-1.5">
          {modules.length === 0
            ? <span className="text-amber-400">No module selected means every module — pick at least one.</span>
            : 'An account may hold more than one; the modules are OR-ed together.'}
        </div>
      </section>

      <section className="mb-5">
        <div className={label}>Section scope</div>
        <div className="mt-2 space-y-1.5">
          {meta.sections.map(s => {
            const on = sections.includes(s.key)
            return (
              <button key={s.key} type="button" disabled={!cfg.editable}
                onClick={() => toggleSection(s.key)}
                className={`w-full text-left px-3 py-2 rounded-lg border transition-colors disabled:opacity-40 ${
                  on ? 'bg-green-500/15 border-green-500/40'
                     : 'bg-white/5 border-white/10 hover:bg-white/10'}`}>
                <div className={`text-sm ${on ? 'text-green-300' : 'text-gray-300'}`}>{s.key}</div>
                <div className="text-xs text-gray-500">{s.categories.join(', ')}</div>
              </button>
            )
          })}
        </div>
        <div className="text-xs text-gray-500 mt-1.5">
          {sections.length === 0
            ? <span className="text-amber-400">None selected means EVERY section — an absent scope is unconstrained, not empty.</span>
            : 'Sections are OR-ed together: an account may hold several.'}
        </div>
      </section>

      <section className="mb-5">
        <div className="flex items-center justify-between">
          <div className={label}>Permissions</div>
          <div className="text-xs text-gray-500">
            {meta.identity.canOverride ? 'Click a row to override' : 'Overrides are system-administrator only'}
          </div>
        </div>
        <div className="mt-2 space-y-3">
          {Object.entries(byModule).map(([mod, perms]) => (
            <div key={mod}>
              <div className="text-xs text-gray-500 mb-1">{mod}</div>
              <div className="space-y-1">
                {perms.map(p => (
                  <PermissionRow key={p.key} p={p} busy={busy}
                    canOverride={meta.identity.canOverride && cfg.editable}
                    onSet={effect => toggleOverride(p.key, effect)} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {error && <div className="text-sm text-red-400 mb-3">{error}</div>}

      <div className="flex items-center justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="success" disabled={!dirty || busy || !cfg.editable || !role}
                onClick={() => setConfirm(true)}>
          {busy ? 'Saving…' : 'Save role & scope'}
        </Button>
      </div>

      {confirm && (
        <ConfirmDialog
          email={cfg.email}
          from={{ role: cfg.role, scopes: cfg.scopes }}
          to={{ role, scopes: buildScopes() }}
          onCancel={() => setConfirm(null)}
          onConfirm={save}
          busy={busy}
        />
      )}
    </Overlay>
  )
}

function Meta({ k, v, note }) {
  return (
    <div>
      <div className="text-xs text-gray-500">{k}</div>
      <div className="text-gray-300">{v || '—'}</div>
      {note && <div className="text-[10px] text-gray-600">{note}</div>}
    </div>
  )
}

// Inherited vs direct is the distinction the whole screen exists to make, so it
// is stated in words on every row rather than encoded in a colour.
function PermissionRow({ p, canOverride, busy, onSet }) {
  const state = p.override === 'deny' ? 'Denied (direct)'
              : p.override === 'grant' ? 'Granted (direct)'
              : p.inherited ? 'Inherited from role'
              : 'Not held'
  const tone = p.override === 'deny' ? 'text-red-400'
             : p.override === 'grant' ? 'text-blue-400'
             : p.inherited ? 'text-green-400' : 'text-gray-600'

  return (
    <div className="flex items-center justify-between gap-3 px-2 py-1.5 rounded bg-white/[0.03]">
      <div className="min-w-0">
        <div className="text-sm text-gray-200 truncate">{p.key}</div>
        <div className={`text-xs ${tone}`}>{state}</div>
      </div>
      {canOverride && (
        <div className="flex gap-1 flex-shrink-0">
          <MiniBtn active={p.override === 'grant'} disabled={busy}
                   onClick={() => onSet(p.override === 'grant' ? null : 'grant')}>Grant</MiniBtn>
          <MiniBtn active={p.override === 'deny'} disabled={busy} danger
                   onClick={() => onSet(p.override === 'deny' ? null : 'deny')}>Deny</MiniBtn>
        </div>
      )}
    </div>
  )
}

function MiniBtn({ children, active, danger, disabled, onClick }) {
  const base = 'text-[11px] px-2 py-1 rounded border transition-colors disabled:opacity-40'
  const on = danger ? 'bg-red-500/20 border-red-500/40 text-red-300'
                    : 'bg-blue-500/20 border-blue-500/40 text-blue-300'
  const off = 'bg-white/5 border-white/10 text-gray-400 hover:bg-white/10'
  return <button className={`${base} ${active ? on : off}`} disabled={disabled} onClick={onClick}>{children}</button>
}

// Impactful changes are confirmed against a printed before/after, not a generic
// "are you sure" — the point is that the administrator sees what actually moves.
function ConfirmDialog({ email, from, to, onCancel, onConfirm, busy }) {
  const fmt = s => s.scopes.length
    ? s.scopes.map(x => `${x.dimension}:${x.scope_type}=${x.scope_id}`).join(', ')
    : 'none (unconstrained)'
  return (
    <div className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center p-4"
         onClick={onCancel}>
      <div className="bg-gray-950 border border-white/10 rounded-xl p-5 max-w-lg w-full"
           onClick={e => e.stopPropagation()}>
        <div className="text-base font-medium text-gray-100">Change access for {email}?</div>
        <div className="mt-4 space-y-3 text-sm">
          <div>
            <div className="text-xs text-gray-500">Role</div>
            <div className="text-gray-300">{from.role || 'none'} → <span className="text-gray-100">{to.role}</span></div>
          </div>
          <div>
            <div className="text-xs text-gray-500">Scope</div>
            <div className="text-gray-400 text-xs">{fmt(from)}</div>
            <div className="text-gray-100 text-xs mt-0.5">{fmt(to)}</div>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="success" disabled={busy} onClick={onConfirm}>
            {busy ? 'Saving…' : 'Confirm'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Overlay({ children, onClose, wide }) {
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center p-4 overflow-y-auto"
         onClick={onClose}>
      <div className={`bg-gray-950 border border-white/10 rounded-xl p-5 my-8 w-full ${wide ? 'max-w-2xl' : 'max-w-md'}`}
           onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}
