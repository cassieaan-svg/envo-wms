import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { Button } from '../ui/Button'
import { toast } from '../ui/Toast'

const field = 'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-green-500'
const label = 'text-xs text-gray-500 uppercase tracking-wide'

// Standalone facility creation — the master roster left one out. Independent of
// Create User (that form only offers it mid-way through picking a facility-role
// account's facility), because "add a facility" is its own action and an admin
// may want to add one before there is any login to attach it to.
//
// Same ceilings as createUser/createFacility server-side: a state/level-confined
// essential_admin gets its own state and level stamped on regardless of what
// this form asks for — the fields below just mirror that so the UI doesn't
// offer a choice the server will refuse.
export function AddFacilityModal({ meta, onClose, onCreated }) {
  const ownState = meta.identity?.state || null
  const ownLevel = meta.identity?.level || null
  const ownModule = meta.identity?.module || null
  const grantable = meta.identity?.grantableModules || null

  const [facilities, setFacilities] = useState([])
  const [name, setName] = useState('')
  const [state, setState] = useState(ownState || '')
  const [lga, setLga] = useState('')
  const [level, setLevel] = useState(ownLevel || '')
  // ONE module, not a multi-select. This session deliberately eliminated every
  // dual-enrolled (essential + hiv) FACILITY — a dual-module ACCOUNT points at
  // one single-module facility instead (see the store-manager pattern in
  // scope.js). Letting this form mint a dual-module facility would reopen
  // exactly the thing that was cleaned up.
  const [module, setModule] = useState(ownModule || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState(null)

  useEffect(() => { api.facilities.listAll().then(f => setFacilities(f || [])).catch(() => {}) }, [])

  const states = useMemo(() => [...new Set(facilities.map(f => f.state).filter(Boolean))].sort(), [facilities])
  const lgas = useMemo(() => [...new Set(facilities.filter(f => f.state === state).map(f => f.lga).filter(Boolean))].sort(), [facilities, state])

  const ready = name.trim() && (ownState || state) && lga.trim() && module

  async function save() {
    setBusy(true); setError('')
    try {
      const facility = await api.admin.createFacility({
        name: name.trim(), lga: lga.trim(),
        state: ownState ? undefined : state,
        level: level || undefined,
        module,
      })
      setCreated(facility)
      toast('Facility added', 'green')
      onCreated?.(facility)
    } catch (err) {
      setError(err.message || 'Could not add the facility.')
    } finally { setBusy(false) }
  }

  if (created) return (
    <Shell onClose={onClose}>
      <div className="text-base font-medium text-gray-100">Facility added</div>
      <div className="mt-4 rounded-lg border border-green-500/25 bg-green-500/10 p-4 space-y-2 text-sm">
        <Row k="Name" v={created.name} />
        <Row k="State" v={created.state} />
        <Row k="LGA" v={lga} />
        {created.level && <Row k="Level" v={created.level} />}
        <Row k="Module" v={module} />
      </div>
      <div className="flex justify-end mt-5">
        <Button variant="success" onClick={onClose}>Done</Button>
      </div>
    </Shell>
  )

  return (
    <Shell onClose={onClose}>
      <div className="flex items-start justify-between gap-4">
        <div className="text-base font-medium text-gray-100">Add facility</div>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-sm">Close</button>
      </div>
      <div className="text-xs text-gray-500 mt-1">For a facility the master roster left out.</div>

      <section className="mt-4">
        <div className={label}>Name</div>
        <input className={`${field} mt-2`} value={name} autoFocus
               onChange={e => setName(e.target.value)} placeholder="e.g. Uyo Cottage Hospital" />
      </section>

      {!ownState && (
        <section className="mt-4">
          <div className={label}>State</div>
          <select className={`${field} mt-2`} value={state} onChange={e => { setState(e.target.value); setLga('') }}>
            <option value="">— select a state —</option>
            {states.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </section>
      )}

      <section className="mt-4">
        <div className={label}>LGA</div>
        {(ownState || state) ? (
          <>
            <select className={`${field} mt-2`} value={lga} onChange={e => setLga(e.target.value)}>
              <option value="">— select an LGA —</option>
              {lgas.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
            <div className="text-xs text-gray-500 mt-1">Not listed? Type it directly below.</div>
            <input className={`${field} mt-2`} value={lga} onChange={e => setLga(e.target.value)} placeholder="LGA name" />
          </>
        ) : <div className="text-xs text-gray-500 mt-2">Pick a state first.</div>}
      </section>

      <section className="mt-4">
        <div className={label}>Level</div>
        {ownLevel ? (
          <div className="text-xs text-gray-400 mt-2">
            Locked to <span className="text-gray-200">{ownLevel}</span>.
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            <Chip on={level === ''} onClick={() => setLevel('')}>None / not applicable</Chip>
            <Chip on={level === 'primary'} onClick={() => setLevel('primary')}>Primary</Chip>
            <Chip on={level === 'secondary'} onClick={() => setLevel('secondary')}>Secondary</Chip>
          </div>
        )}
      </section>

      <section className="mt-4">
        <div className={label}>Module</div>
        {ownModule ? (
          <div className="text-xs text-gray-400 mt-2">
            Enrolled in <span className="text-gray-200">{ownModule}</span>.
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            {(grantable || ['essential', 'hiv']).map(m => (
              <Chip key={m} on={module === m} onClick={() => setModule(m)}>{m}</Chip>
            ))}
          </div>
        )}
      </section>

      {error && <div className="text-sm text-red-400 mt-3">{error}</div>}

      <div className="flex justify-end gap-2 mt-5">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="success" disabled={!ready || busy} onClick={save}>
          {busy ? 'Adding…' : 'Add facility'}
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
      <span className="text-sm text-gray-100">{v}</span>
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
