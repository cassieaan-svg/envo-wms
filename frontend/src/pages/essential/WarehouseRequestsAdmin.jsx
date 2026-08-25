import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/appStore'
import { FacilityPicker } from '../../components/ui/FacilityPicker'
import { Pagination, pageSlice } from '../../components/ui/Pagination'

// Admin oversight of the facility-raised warehouse requests, for the Essential
// Commodities module. READ-ONLY by design: admins watch this module, facilities run
// it — there is no approve step, and the backend refuses every write from an admin
// tier (see isEssentialOversight in middleware/scope.js). So this page deliberately
// offers no cancel/resubmit/receive control; adding one would only produce a 403.
//
// The server already narrows the list to the caller's jurisdiction, so an LGA admin
// gets its own LGA without asking. The FacilityPicker below narrows FURTHER within
// that remit — it is a view filter, never a way to widen scope.

const naira = (n) => '₦' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const STATUS_STYLE = {
  pending:    'bg-amber-500/15 text-amber-400',
  submitted:  'bg-blue-500/15 text-blue-400',
  picking:    'bg-indigo-500/15 text-indigo-400',
  dispatched: 'bg-cyan-500/15 text-cyan-400',
  received:   'bg-green-500/15 text-green-400',
  cancelled:  'bg-gray-500/15 text-gray-400',
}

// Still in flight vs closed. Mirrors RequestWarehouse so the two pages agree on what
// "outstanding" means — a request the facility sees as active must not read as closed
// on the admin's screen.
const ACTIVE_STATES = ['pending', 'submitted', 'picking', 'dispatched']
const ALL_STATES = [...ACTIVE_STATES, 'received', 'cancelled']

// Defined at module scope, not inside the component: a component created during
// render is a NEW type on every render, so React unmounts and remounts it each time —
// which would drop focus from the search box on every keystroke.
function Tab({ id, label, active, onSelect }) {
  return (
    <button type="button" onClick={() => onSelect(id)}
      className={`px-4 py-2 text-sm border-b-2 transition-colors ${
        active ? 'border-green-500 text-gray-100 font-medium' : 'border-transparent text-gray-500 hover:text-gray-300'}`}>
      {label}
    </button>
  )
}

function Stat({ label, value }) {
  return (
    <div className="flex-1 min-w-[140px] rounded-lg border border-white/10 bg-white/3 px-4 py-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-xl text-gray-100 font-medium mt-0.5">{value}</div>
    </div>
  )
}

export function WarehouseRequestsAdmin() {
  const filterState    = useAppStore(s => s.adminFilterState)
  const filterLGA      = useAppStore(s => s.adminFilterLGA)
  const filterFacility = useAppStore(s => s.adminFilterFacility)
  const allFacilities  = useAppStore(s => s.allFacilities)

  const [schemes, setSchemes] = useState([])
  const [rows, setRows]   = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr]     = useState(null)
  const [view, setView]   = useState('active')   // 'active' | 'history' | 'all'
  const [status, setStatus] = useState('')       // exact-status filter, '' = any
  const [search, setSearch] = useState('')
  // Paging is stored together with the filter combination it belongs to, so any
  // filter change reads back as page 0 without an effect writing state after render.
  const [pageState, setPageState] = useState({ key: '', page: 0 })

  useEffect(() => { load() }, [])
  useEffect(() => { api.schemes.list().then(r => setSchemes(r || [])).catch(() => {}) }, [])
  async function load() {
    setLoading(true); setErr(null)
    try { setRows(await api.warehouseRequests.list() || []) }
    catch (e) { setErr(e?.message || 'Could not load requests') }
    finally { setLoading(false) }
  }

  // The facility ids the picker currently allows. null = no narrowing. Resolved from
  // allFacilities (already scoped to the admin's remit at login) rather than from the
  // rows, so choosing an LGA with no requests correctly yields an empty table instead
  // of silently falling back to everything.
  const pickedIds = useMemo(() => {
    if (filterFacility) return new Set([filterFacility])
    if (filterLGA)   return new Set(allFacilities.filter(f => f.lga === filterLGA).map(f => f.id))
    if (filterState) return new Set(allFacilities.filter(f => f.state === filterState).map(f => f.id))
    return null
  }, [filterFacility, filterLGA, filterState, allFacilities])

  const schemeById = useMemo(() => Object.fromEntries((schemes || []).map(x => [x.key, x])), [schemes])
  const schemeLabel = (k) => schemeById[k]?.label || k || '—'

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter(r => {
      if (view === 'active'  && !ACTIVE_STATES.includes(r.status)) return false
      if (view === 'history' && ACTIVE_STATES.includes(r.status))  return false
      if (status && r.status !== status) return false
      if (pickedIds && !pickedIds.has(r.facility_id)) return false
      if (q && !(`${r.facility_name || ''} ${r.requested_by || ''} ${r.wms_request_id || ''}`.toLowerCase().includes(q))) return false
      return true
    })
  }, [rows, view, status, pickedIds, search])


  const totals = useMemo(() => ({
    count:      filtered.length,
    facilities: new Set(filtered.map(r => r.facility_id)).size,
    outstanding: filtered.filter(r => ACTIVE_STATES.includes(r.status)).length,
    value:      filtered.reduce((s, r) => s + Number(r.total_amount || 0), 0),
  }), [filtered])

  // JSON, not a joined string: it quotes and escapes each part, so no combination of
  // filter values can produce the same key as a different combination.
  const filterKey = JSON.stringify([view, status, search, filterState, filterLGA, filterFacility])
  const page = pageState.key === filterKey ? pageState.page : 0
  const setPage = (p) => setPageState({ key: filterKey, page: p })
  const pager = pageSlice(filtered, page)

  function downloadCsv() {
    const head = ['Facility', 'Requested', 'Status', 'Scheme',
                  'Line items', 'Units', 'Total (NGN)', 'Requested by', 'WMS ref']
    const body = filtered.map(r => [
      r.facility_name ?? '', String(r.requested_at || '').slice(0, 10), r.status, schemeLabel(r.scheme),
      r.line_count, r.total_quantity, r.total_amount, r.requested_by ?? '', r.wms_request_id ?? '',
    ])
    // Exports the whole filtered set, not just the visible page.
    const csv = [head, ...body].map(row => row.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
    a.download = `warehouse-requests-${view}-${new Date().toISOString().slice(0, 10)}.csv`
    a.click(); URL.revokeObjectURL(a.href)
  }

  return (
    <div className="p-6">
      <div className="mb-1 text-xl text-gray-100 font-medium">Warehouse Requests</div>
      <p className="text-sm text-gray-500 mb-5">
        Requests raised by facilities in your area, for oversight. Facilities raise, cancel and confirm
        their own requests — this view is read-only.
      </p>

      {err && <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-400">{err}</div>}

      <div className="flex gap-3 flex-wrap mb-5">
        <Stat label="Requests" value={totals.count.toLocaleString()} />
        <Stat label="Facilities" value={totals.facilities.toLocaleString()} />
        <Stat label="Outstanding" value={totals.outstanding.toLocaleString()} />
        <Stat label="Value" value={naira(totals.value)} />
      </div>

      <div className="flex border-b border-white/10 mb-4">
        <Tab onSelect={setView} active={view === 'active'} id="active"  label="Outstanding" />
        <Tab onSelect={setView} active={view === 'history'} id="history" label="Closed" />
        <Tab onSelect={setView} active={view === 'all'} id="all"     label="All" />
      </div>

      <div className="flex gap-2 flex-wrap items-center mb-4">
        <FacilityPicker />
        <select value={status} onChange={e => setStatus(e.target.value)}
          className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500">
          <option value="">Any status</option>
          {ALL_STATES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search facility, requester, WMS ref"
          className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 min-w-[240px] focus:outline-none focus:border-blue-500" />
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={load}
            className="px-3 py-1.5 text-xs rounded-lg border border-white/10 text-gray-300 hover:bg-white/5">Refresh</button>
          <button type="button" onClick={downloadCsv} disabled={!filtered.length}
            className="px-3 py-1.5 text-xs rounded-lg border border-white/10 text-gray-300 hover:bg-white/5 disabled:opacity-40">Download CSV</button>
        </div>
      </div>

      <div className="rounded-lg border border-white/10">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-white/10">
              <th className="px-4 py-2 font-medium">Facility</th>
              <th className="px-4 py-2 font-medium">Requested</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Scheme</th>
              <th className="px-4 py-2 font-medium text-right">Lines</th>
              <th className="px-4 py-2 font-medium text-right">Units</th>
              <th className="px-4 py-2 font-medium text-right">Total</th>
              <th className="px-4 py-2 font-medium">Requested by</th>
              <th className="px-4 py-2 font-medium">WMS ref</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={9} className="px-4 py-6 text-center text-gray-500">Loading…</td></tr>}
            {!loading && !pager.slice.length && (
              <tr><td colSpan={9} className="px-4 py-6 text-center text-gray-500">No requests match this view.</td></tr>
            )}
            {!loading && pager.slice.map(r => (
              <tr key={r.id} className="border-b border-white/5 hover:bg-white/2">
                <td className="px-4 py-2 text-gray-100">{r.facility_name || '—'}</td>
                <td className="px-4 py-2 text-gray-300">{String(r.requested_at || '').slice(0, 10)}</td>
                <td className="px-4 py-2">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded ${STATUS_STYLE[r.status] || 'bg-white/10 text-gray-300'}`}>{r.status}</span>
                </td>
                <td className="px-4 py-2 text-gray-300">{schemeLabel(r.scheme)}</td>
                <td className="px-4 py-2 text-right text-gray-300">{r.line_count}</td>
                <td className="px-4 py-2 text-right text-gray-300">{Number(r.total_quantity || 0).toLocaleString()}</td>
                <td className="px-4 py-2 text-right text-gray-300">{naira(r.total_amount)}</td>
                <td className="px-4 py-2 text-gray-300">{r.requested_by || '—'}</td>
                <td className="px-4 py-2 text-gray-500">{r.wms_request_id ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        <Pagination pager={pager} onPage={setPage} unit="requests" />
      </div>
    </div>
  )
}
