import { useAppStore } from '../../store/appStore'

function Select({ value, onChange, children }) {
  return (
    <select
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500 min-w-[150px]"
    >
      {children}
    </select>
  )
}

// Admin facility filter. Hierarchy follows the admin's level:
//   overall admin → State → LGA → Facility
//   state admin   → LGA → Facility
//   LGA admin     → Facility
export function FacilityPicker() {
  const store = useAppStore()
  if (!store.isAdmin()) return null

  const allFacs   = store.allFacilities
  const isOverall = store.isOverallAdmin()
  const isState   = store.isStateAdmin()
  const stState   = store.adminFilterState
  const stLGA     = store.adminFilterLGA
  const stFac     = store.adminFilterFacility

  const states = [...new Set(allFacs.map(f => f.state).filter(Boolean))].sort()
  // LGAs available given the current state choice (state/LGA admins already
  // have allFacs scoped to their area at login).
  const lgaPool = isOverall ? (stState ? allFacs.filter(f => f.state === stState) : []) : allFacs
  const lgas    = [...new Set(lgaPool.map(f => f.lga).filter(Boolean))].sort()
  // Facilities available given the current LGA (or state) choice.
  const facPool = stLGA
    ? allFacs.filter(f => f.lga === stLGA)
    : (isOverall ? (stState ? allFacs.filter(f => f.state === stState) : []) : allFacs)
  const facs = facPool.sort((a, b) => a.name.localeCompare(b.name))

  const setState = v => { store.setAdminFilterState(v || null); store.setAdminFilterLGA(null); store.setAdminFilterFacility(null) }
  const setLGA   = v => { store.setAdminFilterLGA(v || null); store.setAdminFilterFacility(null) }
  const setFac   = v => { store.setAdminFilterFacility(v ? allFacs.find(f => f.id === v) || null : null) }
  const clear    = () => { store.setAdminFilterState(null); store.setAdminFilterLGA(null); store.setAdminFilterFacility(null) }

  const showLGA = (isOverall && stState) || isState
  const showFac = stLGA || (!isOverall && !isState)   // LGA admin has no LGA level

  return (
    <div className="mb-4 bg-white/3 border border-white/8 rounded-xl px-4 py-3 flex flex-wrap gap-3 items-center">
      <span className="text-xs text-gray-500 uppercase tracking-widest">Filter</span>

      {isOverall && (
        <Select value={stState} onChange={setState}>
          <option value="">All states</option>
          {states.map(s => <option key={s} value={s}>{s} ({allFacs.filter(f => f.state === s).length})</option>)}
        </Select>
      )}

      {showLGA && (
        <Select value={stLGA} onChange={setLGA}>
          <option value="">All LGAs{isOverall && stState ? ` in ${stState}` : ''}</option>
          {lgas.map(l => <option key={l} value={l}>{l}</option>)}
        </Select>
      )}

      {showFac && (
        <Select value={stFac?.id} onChange={setFac}>
          <option value="">All facilities{stLGA ? ` in ${stLGA}` : ''}</option>
          {facs.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </Select>
      )}

      {(stState || stLGA || stFac) && (
        <button onClick={clear} className="text-xs text-gray-500 hover:text-red-400 transition-colors">✕ Clear</button>
      )}
    </div>
  )
}
