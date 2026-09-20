import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/appStore'
import { FacilityPicker } from '../../components/ui/FacilityPicker'
import { Pagination, pageSlice } from '../../components/ui/Pagination'
import { naira } from '../../utils/helpers'

// The counterpart to the "Bought" view on the same page: how much has been SOLD —
// dispensed at its unit price, snapshotted server-side at the moment it was
// recorded (see LogService.recordDispense / getSalesSummary). Only priced
// dispenses count; most of HIV carries no catalogue price and is excluded rather
// than shown as ₦0.
//
// Admin sees this scoped the same way every other report on this page is scoped —
// 'By facility' groups it the same way Monitoring's own facility breakdown does
// (LGA/state read off each row's facility, not a server-side LGA grouping).

const num = (n) => Number(n || 0).toLocaleString()

const GROUPS = [
  { key: 'commodity', label: 'By commodity' },
  { key: 'facility',  label: 'By facility', adminOnly: true },
  { key: 'month',     label: 'By month' },
]

const COLUMN_HEAD = { commodity: 'Commodity', facility: 'Facility', month: 'Month' }

function Tab({ id, label, active, onSelect }) {
  return (
    <button type="button" onClick={() => onSelect(id)}
      className={`px-4 py-2 text-sm border-b-2 transition-colors ${
        active ? 'border-green-500 text-gray-100 font-medium' : 'border-transparent text-gray-500 hover:text-gray-300'}`}>
      {label}
    </button>
  )
}

function Stat({ label, value, hint }) {
  return (
    <div className="flex-1 min-w-[170px] rounded-lg border border-white/10 bg-white/3 px-4 py-3 text-left">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-xl font-medium mt-0.5 text-gray-100">{value}</div>
      {hint && <div className="text-[11px] text-gray-500 mt-0.5">{hint}</div>}
    </div>
  )
}

const today = () => new Date().toISOString().slice(0, 10)
const yearStart = () => `${new Date().getFullYear()}-01-01`

export function SalesPanel() {
  const isAdmin = useAppStore(s => s.isAdmin())
  const filterState    = useAppStore(s => s.adminFilterState)
  const filterLGA      = useAppStore(s => s.adminFilterLGA)
  const filterFacility = useAppStore(s => s.adminFilterFacility)

  const groups = useMemo(() => GROUPS.filter(g => isAdmin || !g.adminOnly), [isAdmin])
  const [group, setGroup] = useState('commodity')
  const [from, setFrom] = useState(yearStart)
  const [to, setTo]     = useState(today)
  const [page, setPage] = useState(0)
  const [data, setData] = useState({ key: null, rows: [], err: null })

  const scopeParams = useMemo(() => {
    if (!isAdmin) return {}
    if (filterFacility) return { facility_ids: filterFacility }
    const p = {}
    if (filterState) p.state = filterState
    if (filterLGA)   p.lga = filterLGA
    return p
  }, [isAdmin, filterFacility, filterState, filterLGA])

  const queryKey = JSON.stringify([group, from, to, scopeParams])
  const loading = data.key !== queryKey
  const rows = useMemo(() => (loading ? [] : data.rows), [loading, data.rows])
  const err = loading ? null : data.err

  useEffect(() => setPage(0), [queryKey])

  useEffect(() => {
    let cancelled = false
    api.dispense.salesSummary({ group_by: group, from, to, ...scopeParams })
      .then(d => { if (!cancelled) setData({ key: queryKey, rows: d || [], err: null }) })
      .catch(e => { if (!cancelled) setData({ key: queryKey, rows: [], err: e?.message || 'Could not load sales' }) })
    return () => { cancelled = true }
  }, [queryKey, group, from, to, scopeParams])

  const totals = useMemo(() => rows.reduce((a, r) => ({
    revenue:  a.revenue  + Number(r.revenue || 0),
    quantity: a.quantity + Number(r.quantity || 0),
    txn:      a.txn      + Number(r.txn || 0),
  }), { revenue: 0, quantity: 0, txn: 0 }), [rows])

  const sorted = useMemo(() => [...rows].sort((a, b) => Number(b.revenue || 0) - Number(a.revenue || 0)), [rows])
  const pager = pageSlice(sorted, page)

  function downloadCsv() {
    const head = [COLUMN_HEAD[group], 'Quantity', 'Revenue (NGN)', 'Transactions']
    const body = sorted.map(r => [r.label, r.quantity, r.revenue, r.txn])
    const csv = [head, ...body].map(row => row.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
    a.download = `essential-sales-${group}-${from}-to-${to}.csv`
    a.click(); URL.revokeObjectURL(a.href)
  }

  return (
    <div>
      <p className="text-sm text-gray-500 mb-5">
        What has been sold — consumption of a priced commodity, at the price it was recorded at.
        Commodities with no catalogue price aren't counted.
      </p>

      {err && <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-400">{err}</div>}

      <div className="flex gap-3 flex-wrap mb-5">
        <Stat label="Total sold" value={naira(totals.revenue)} />
        <Stat label="Quantity" value={num(totals.quantity)} />
        <Stat label="Transactions" value={num(totals.txn)} />
      </div>

      <div className="flex border-b border-white/10 mb-4 flex-wrap">
        {groups.map(g => <Tab key={g.key} id={g.key} label={g.label} active={group === g.key} onSelect={setGroup} />)}
      </div>

      <div className="flex gap-2 flex-wrap items-center mb-4">
        <FacilityPicker />
        <label className="text-xs text-gray-500">From</label>
        <input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)}
          className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500" />
        <label className="text-xs text-gray-500">To</label>
        <input type="date" value={to} min={from} onChange={e => setTo(e.target.value)}
          className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500" />
        <button type="button" onClick={downloadCsv} disabled={!rows.length}
          className="ml-auto px-3 py-1.5 text-xs rounded-lg border border-white/10 text-gray-300 hover:bg-white/5 disabled:opacity-40">
          Download CSV
        </button>
      </div>

      <div className="rounded-lg border border-white/10">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-white/10">
                <th className="px-4 py-2 font-medium">{COLUMN_HEAD[group]}</th>
                <th className="px-4 py-2 font-medium text-right">Quantity</th>
                <th className="px-4 py-2 font-medium text-right">Revenue</th>
                <th className="px-4 py-2 font-medium text-right">Transactions</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-500">Loading…</td></tr>}
              {!loading && !pager.slice.length && (
                <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-500">No sales in this period.</td></tr>
              )}
              {!loading && pager.slice.map(r => (
                <tr key={r.key} className="border-b border-white/5 hover:bg-white/2">
                  <td className="px-4 py-2 text-gray-100">{r.label || '—'}</td>
                  <td className="px-4 py-2 text-right text-gray-300">{num(r.quantity)}</td>
                  <td className="px-4 py-2 text-right text-gray-100">{naira(r.revenue)}</td>
                  <td className="px-4 py-2 text-right text-gray-300">{num(r.txn)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pagination pager={pager} onPage={setPage} unit="rows" />
      </div>
    </div>
  )
}
