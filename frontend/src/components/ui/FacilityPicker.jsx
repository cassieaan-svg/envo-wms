import { useAppStore } from '../../store/appStore'
import { facilityGroupLabel } from '../../utils/helpers'

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
//   overall admin              → State → LGA → Facility
//   state admin / state viewer → LGA → Facility  (state fixed)
//   cluster admin              → LGA → Facility  (cluster fixed; LGAs = the cluster's)
//   LGA admin                  → Facility
// The mid-tiers all have allFacilities pre-scoped to their remit at login, so the
// LGA list is derived from that scoped set (cluster admin → only its cluster's LGAs).
export function FacilityPicker() {
  const store = useAppStore()
  if (!store.isAdmin()) return null

  const allFacs   = store.allFacilities
  const isOverall = store.isOverallAdmin()
  // Tiers that pick LGA → Facility (allFacs already scoped to their state/cluster).
  const isMidTier = store.isStateAdmin() || store.isStateViewer() || store.isClusterAdmin()
  const isLGA     = store.isLGAAdmin()
  const stState   = store.adminFilterState
  const stLGA     = store.adminFilterLGA
  const stFac     = store.adminFilterFacility

  const states = [...new Set(allFacs.map(f => f.state).filter(Boolean))].sort()
  // LGAs available given the current state choice (mid-tiers already have allFacs
  // scoped to their area at login, so their full set is their LGA pool).
  const lgaPool = isOverall ? (stState ? allFacs.filter(f => f.state === stState) : []) : allFacs
  // Bucket by facilityGroupLabel (not raw f.lga) so state-office and cluster hubs —
  // which have no LGA — appear under their own "State Office" / "<Cluster> Cluster"
  // option and stay reachable, instead of being dropped from the filter entirely.
  const lgas    = [...new Set(lgaPool.map(facilityGroupLabel).filter(Boolean))].sort()
  // Facilities available given the current LGA (or state) choice.
  const facPool = stLGA
    ? allFacs.filter(f => facilityGroupLabel(f) === stLGA)
    : (isOverall ? (stState ? allFacs.filter(f => f.state === stState) : []) : allFacs)
  const facs = facPool.sort((a, b) => a.name.localeCompare(b.name))

  const setState = v => { store.setAdminFilterState(v || null); store.setAdminFilterLGA(null); store.setAdminFilterFacility(null) }
  const setLGA   = v => { store.setAdminFilterLGA(v || null); store.setAdminFilterFacility(null) }
  const setFac   = v => { store.setAdminFilterFacility(v ? allFacs.find(f => f.id === v) || null : null) }
  const clear    = () => { store.setAdminFilterState(null); store.setAdminFilterLGA(null); store.setAdminFilterFacility(null) }

  const showLGA = (isOverall && stState) || isMidTier
  const showFac = stLGA || isLGA   // LGA admin has no LGA level; mid-tiers reveal facilities after picking an LGA

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
