import { useState, useRef, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { SECTION_CATEGORIES, GENERAL_CONSUMABLES } from '../../utils/helpers'

// Canonical category order (pharmacy first, then lab: RTKs → reagents →
// consumables, then General Consumables). Unknown categories fall to the end,
// then alphabetical.
const CATEGORY_ORDER = [...SECTION_CATEGORIES.pharmacy, ...SECTION_CATEGORIES.lab, GENERAL_CONSUMABLES]

const DEFAULT_CLS = 'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500'

// Searchable drop-in replacement for the native <select> commodity dropdowns.
// Type to filter; results stay grouped by category in the canonical order.
// The menu renders in a portal so it isn't clipped by Card overflow.
export function CommoditySelect({
  categories,
  commodities,
  value,
  onChange,
  placeholder = 'Search commodity…',
  disabled = false,
  className = '',
}) {
  const list = useMemo(
    () => commodities || (categories ? Object.values(categories).flat() : []),
    [commodities, categories]
  )

  const [open, setOpen]   = useState(false)
  const [query, setQuery] = useState('')
  const [rect, setRect]   = useState(null)
  const btnRef = useRef(null)
  const popRef = useRef(null)

  const selected = list.find(c => c.id === value)

  // Place the menu below the trigger, or above it when there isn't enough room
  // below (common on mobile / lower form fields). Cap height to the space.
  const computeRect = () => {
    const r = btnRef.current.getBoundingClientRect()
    const vh = window.visualViewport?.height || window.innerHeight
    const below = vh - r.bottom
    const above = r.top
    if (below >= 220 || below >= above) {
      return { top: r.bottom + 4, left: r.left, width: r.width, maxHeight: Math.max(160, Math.min(288, below - 8)) }
    }
    const h = Math.max(160, Math.min(288, above - 8))
    return { top: r.top - 4 - h, left: r.left, width: r.width, maxHeight: h }
  }

  const close = () => { setOpen(false); setQuery('') }
  const toggle = () => {
    if (disabled) return
    if (open) return close()
    setRect(computeRect())
    setQuery('')
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const onDoc = e => {
      if (btnRef.current?.contains(e.target) || popRef.current?.contains(e.target)) return
      close()
    }
    // Keep the menu aligned to the trigger instead of closing it. Ignore scroll
    // that originates inside the menu (its own list) so the list can scroll, and
    // don't close on resize — opening the search keyboard on mobile fires resize.
    const reposition = e => {
      if (e?.target && popRef.current?.contains(e.target)) return
      if (!btnRef.current) return
      setRect(computeRect())
    }
    document.addEventListener('pointerdown', onDoc)
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      document.removeEventListener('pointerdown', onDoc)
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const byCat = {}
    list.forEach(c => {
      if (q && !(c.name || '').toLowerCase().includes(q)) return
      const cat = c.category || 'Other'
      ;(byCat[cat] = byCat[cat] || []).push(c)
    })
    return Object.keys(byCat)
      .sort((a, b) => {
        const ia = CATEGORY_ORDER.indexOf(a), ib = CATEGORY_ORDER.indexOf(b)
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b)
      })
      .map(cat => [cat, byCat[cat].sort((x, y) => (x.name || '').localeCompare(y.name || ''))])
  }, [list, query])

  const pick = id => { onChange(id); close() }

  return (
    <>
      <button ref={btnRef} type="button" disabled={disabled} onClick={toggle}
        className={`${className || DEFAULT_CLS} text-left flex items-center justify-between gap-2 ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
        <span className={selected ? 'text-gray-100 truncate' : 'text-gray-500'}>{selected ? selected.name : placeholder}</span>
        <span className="text-xs text-gray-500">▾</span>
      </button>

      {open && rect && createPortal(
        <div ref={popRef}
          style={{ position: 'fixed', top: rect.top, left: rect.left, width: rect.width, maxHeight: rect.maxHeight, zIndex: 1000 }}
          className="bg-gray-900 border border-white/15 rounded-lg shadow-2xl overflow-hidden flex flex-col">
          <input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder={placeholder}
            className="w-full bg-white/5 border-b border-white/10 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-500 focus:outline-none" />
          <div className="overflow-y-auto">
            {selected && (
              <button type="button" onClick={() => pick('')}
                className="w-full text-left px-3 py-1.5 text-xs text-gray-500 hover:bg-white/5">Clear selection</button>
            )}
            {groups.length === 0 ? (
              <div className="px-3 py-4 text-sm text-gray-500 text-center">No commodities found.</div>
            ) : groups.map(([cat, comms]) => (
              <div key={cat}>
                <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider bg-white/5">{cat}</div>
                {comms.map(c => (
                  <button key={c.id} type="button" onClick={() => pick(c.id)}
                    className={`w-full text-left px-4 py-1.5 text-sm hover:bg-white/5 ${c.id === value ? 'text-blue-400' : 'text-gray-200'}`}>
                    {c.name}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
