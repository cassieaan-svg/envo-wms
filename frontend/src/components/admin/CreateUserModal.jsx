import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { Button } from '../ui/Button'
import { toast } from '../ui/Toast'
import { exportCsv } from '../../utils/download'

const field = 'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-green-500'
const label = 'text-xs text-gray-500 uppercase tracking-wide'

// Which geography scope each role takes. Mirrors REQUIRED_GEOGRAPHY in
// aclAdminService.js — the server rejects a mismatch, so this only shapes the form.
const GEOGRAPHY_FOR = {
  facility: 'facility', state_admin: 'state', state_viewer: 'state',
  cluster_admin: 'cluster', lga_admin: 'lga', essential_admin: 'state',
  overall_admin: null, system_admin: null,
}

// Creating an account is the ONE action on this surface that takes effect
// immediately: the new login can sign in and reach data at once, because
// scope.js reads the metadata this creates. Everything else here is staged for
// cutover. The dialog says so, because "configuration only" is true of the rest
// of the screen and would be misleading here.
export function CreateUserModal({ meta, onClose, onCreated }) {
  const [username, setUsername] = useState('')
  const [role, setRole] = useState('')
  const [state, setState] = useState('')
  const [lga, setLga] = useState('')
  const [geoValue, setGeoValue] = useState('')
  const [sections, setSections] = useState([])
  const [modules, setModules] = useState(['hiv'])
  const [facilities, setFacilities] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState(null)

  useEffect(() => { api.facilities.list().then(f => setFacilities(f || [])).catch(() => {}) }, [])

  const geoType = role ? GEOGRAPHY_FOR[role] : undefined
  const states = useMemo(() => [...new Set(facilities.map(f => f.state).filter(Boolean))].sort(), [facilities])
  const lgas = useMemo(() => [...new Set(facilities.filter(f => f.state === state).map(f => f.lga).filter(Boolean))].sort(), [facilities, state])
  const clusters = useMemo(() => [...new Set(facilities.filter(f => f.state === state).map(f => f.cluster).filter(Boolean))].sort(), [facilities, state])
  const facilityOptions = useMemo(
    () => facilities.filter(f => f.state === state && f.lga === lga).sort((a, b) => a.name.localeCompare(b.name)),
    [facilities, state, lga])

  const pickState = v => { setState(v); setLga(''); setGeoValue(geoType === 'state' ? v : '') }
  const pickLga = v => { setLga(v); setGeoValue(geoType === 'lga' ? v : '') }
  const toggle = (v, set) => set(a => a.includes(v) ? a.filter(x => x !== v) : [...a, v].sort())

  function buildScopes() {
    const s = []
    if (geoType && geoValue) s.push({ dimension: 'geography', scope_type: geoType, scope_id: geoValue })
    for (const k of sections) s.push({ dimension: 'commodity', scope_type: 'section', scope_id: k })
    for (const k of modules) s.push({ dimension: 'module', scope_type: 'module', scope_id: k })
    return s
  }

  const ready = username.trim() && role && modules.length && (geoType === null || geoValue)

  async function save() {
    setBusy(true); setError('')
    try {
      setCreated(await api.admin.createUser({
        username: username.trim(), role, scopes: buildScopes(),
      }))
      toast('Account created', 'green')
      onCreated?.()
    } catch (err) {
      setError(err.message || 'Could not create the account.')
    } finally { setBusy(false) }
  }

  // The password is shown ONCE — only a bcrypt hash is stored, so it cannot be
  // retrieved later. Say that plainly rather than letting someone close the
  // dialog and discover it.
  if (created) return (
    <Shell onClose={onClose}>
      <div className="text-base font-medium text-gray-100">Account created</div>
      <div className="mt-4 rounded-lg border border-green-500/25 bg-green-500/10 p-4 space-y-2">
        <Row k="Username" v={created.username} />
        <Row k="Password" v={created.password} />
      </div>
      <div className="text-xs text-amber-300 mt-3">
        Copy or download the password now — it is not stored and cannot be shown again.
      </div>
      <div className="text-xs text-gray-500 mt-2">
        The login form appends @envo.ng, so this user signs in as “{created.username}”.
      </div>
      <div className="flex justify-between items-center mt-5">
        {/* Same CSV helper the rest of the app uses (BOM prefixed, so Excel does
            not mangle it). The file is the only durable copy — nothing here can
            reissue this password. */}
        <Button onClick={() => exportCsv(
          `envo-login-${created.username}.csv`,
          ['username', 'password', 'role', 'scope'],
          [[created.username, created.password, created.user.role,
            created.user.scopes.map(s => `${s.dimension}:${s.scope_id}`).join(' | ')]],
        )}>Download CSV</Button>
        <Button variant="success" onClick={onClose}>Done</Button>
      </div>
    </Shell>
  )

  return (
    <Shell onClose={onClose}>
      <div className="flex items-start justify-between gap-4">
        <div className="text-base font-medium text-gray-100">Create user</div>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-sm">Close</button>
      </div>

      <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 mt-3 text-xs text-amber-200/80">
        Unlike the other settings here, a new account is live immediately — it can
        sign in as soon as it is created.
      </div>

      <section className="mt-4">
        <div className={label}>Username</div>
        <input className={`${field} mt-2`} value={username} autoFocus
               onChange={e => setUsername(e.target.value)} placeholder="e.g. uyo.pharmacy" />
        <div className="text-xs text-gray-500 mt-1">
          Signs in as this; @envo.ng is added automatically.
        </div>
      </section>

      <section className="mt-4">
        <div className={label}>Role</div>
        <select className={`${field} mt-2`} value={role}
                onChange={e => { setRole(e.target.value); setGeoValue('') }}>
          <option value="">— select a role —</option>
          {meta.roles.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
      </section>

      {role && (
        <section className="mt-4">
          <div className={label}>Geographic scope</div>
          {geoType === null ? (
            <div className="text-sm text-gray-400 mt-2">National — no geographic scope.</div>
          ) : (
            <div className="mt-2 space-y-2">
              <select className={field} value={state} onChange={e => pickState(e.target.value)}>
                <option value="">— select a state —</option>
                {states.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              {(geoType === 'lga' || geoType === 'facility') && state && (
                <select className={field} value={lga} onChange={e => pickLga(e.target.value)}>
                  <option value="">— select an LGA —</option>
                  {lgas.map(l => <option key={l} value={l}>{l}</option>)}
                </select>
              )}
              {geoType === 'facility' && lga && (
                <select className={field} value={geoValue} onChange={e => setGeoValue(e.target.value)}>
                  <option value="">— select a facility —</option>
                  {facilityOptions.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              )}
              {geoType === 'cluster' && state && (
                <select className={field} value={geoValue} onChange={e => setGeoValue(e.target.value)}>
                  <option value="">— select a cluster —</option>
                  {clusters.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              )}
            </div>
          )}
        </section>
      )}

      <section className="mt-4">
        <div className={label}>Module access</div>
        <div className="mt-2 flex flex-wrap gap-2">
          {(meta.modules || []).map(m => (
            <Chip key={m.key} on={modules.includes(m.key)} onClick={() => toggle(m.key, setModules)}>
              {m.label}
            </Chip>
          ))}
        </div>
        {!modules.length && (
          <div className="text-xs text-amber-400 mt-1.5">
            Pick at least one — none selected means every module.
          </div>
        )}
      </section>

      <section className="mt-4">
        <div className={label}>Section scope</div>
        <div className="mt-2 flex flex-wrap gap-2">
          {meta.sections.map(s => (
            <Chip key={s.key} on={sections.includes(s.key)} onClick={() => toggle(s.key, setSections)}>
              {s.key}
            </Chip>
          ))}
        </div>
        <div className="text-xs text-gray-500 mt-1.5">
          {sections.length === 0
            ? <span className="text-amber-400">None selected means EVERY section.</span>
            : 'Sections are OR-ed together.'}
        </div>
      </section>

      {error && <div className="text-sm text-red-400 mt-3">{error}</div>}

      <div className="flex justify-end gap-2 mt-5">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="success" disabled={!ready || busy} onClick={save}>
          {busy ? 'Creating…' : 'Create user'}
        </Button>
      </div>
    </Shell>
  )
}

function Chip({ on, onClick, children }) {
  return (
    <button type="button" onClick={onClick}
      className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
        on ? 'bg-green-500/20 border-green-500/40 text-green-300'
           : 'bg-white/5 border-white/10 text-gray-400 hover:bg-white/10'}`}>
      {children}
    </button>
  )
}

function Row({ k, v }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-xs text-gray-500">{k}</span>
      <span className="font-mono text-sm text-gray-100 select-all">{v}</span>
    </div>
  )
}

function Shell({ children, onClose }) {
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center p-4 overflow-y-auto"
         onClick={onClose}>
      <div className="bg-gray-950 border border-white/10 rounded-xl p-5 my-8 w-full max-w-lg"
           onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}
