import { useState } from 'react'
import { useAppStore } from '../../store/appStore'

export function FacilityPicker() {
  const store = useAppStore()
  const [selectedLga, setSelectedLga] = useState('')

  if (!store.isAdmin()) return null

  const allFacs = store.allFacilities
  const lgas = [...new Set(allFacs.map(f => f.lga).filter(Boolean))].sort()
  const facs = (selectedLga ? allFacs.filter(f => f.lga === selectedLga) : allFacs)
    .sort((a, b) => a.name.localeCompare(b.name))

  const selected = store.adminFilterFacility

  function handleLgaChange(lga) {
    setSelectedLga(lga)
    store.setAdminFilterFacility(null)
  }

  function handleFacChange(id) {
    const fac = id ? facs.find(f => f.id === id) : null
    store.setAdminFilterFacility(fac || null)
  }

  function clear() {
    setSelectedLga('')
    store.setAdminFilterFacility(null)
  }

  return (
    <div className="mb-4 bg-white/3 border border-white/8 rounded-xl px-4 py-3 flex flex-wrap gap-3 items-center">
      <span className="text-xs text-gray-500 uppercase tracking-widest">Filter</span>

      <select
        value={selectedLga}
        onChange={e => handleLgaChange(e.target.value)}
        className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500"
      >
        <option value="">All LGAs</option>
        {lgas.map(l => <option key={l} value={l}>{l}</option>)}
      </select>

      {selectedLga && (
        <select
          value={selected?.id || ''}
          onChange={e => handleFacChange(e.target.value)}
          className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500 flex-1 min-w-[180px]"
        >
          <option value="">All facilities in {selectedLga}</option>
          {facs.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      )}

      {(selectedLga || selected) && (
        <button onClick={clear} className="text-xs text-gray-500 hover:text-red-400 transition-colors">
          ✕ Clear
        </button>
      )}
    </div>
  )
}
