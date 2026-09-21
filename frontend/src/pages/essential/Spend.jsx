import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/appStore'
import { FacilityPicker } from '../../components/ui/FacilityPicker'
import { Pagination, pageSlice } from '../../components/ui/Pagination'
import { naira } from '../../utils/helpers'
import { SalesPanel } from './SalesPanel'

// What facilities have bought through the central warehouse, in naira.
//
// A page of its own, under Reports (Essential module only). Monitoring is
// quantity-shaped — consumption, intake, adjustments, expiry — and has no concept of
// price anywhere in it; spend is a reporting question, so it sits with the reports.
//
// Built on DISPATCH ORDERS read from the WMS, so it covers both orders a facility
// raised through EnVo and direct dispatches raised at the warehouse. Reading only
// EnVo's own requests is what made this page report ₦0 issued beside a six-figure
// debt — every order behind that debt was a direct dispatch.
//
//   Issued      — value of what left the store
//   Paid        — settled against it
//   Outstanding — still owed (debt-bearing schemes only; BHCPF/insurance are never owed)

const num = (n) => Number(n || 0).toLocaleString()

// 'facility' and 'lga' group ACROSS facilities, so they are meaningless on a facility
// login — it would be one row, itself. Those two are admin-only; the rest apply to
// everyone. (The server scopes the data either way, so this is about the view making
// sense, not about access.)
const GROUPS = [
  { key: 'facility',  label: 'By facility',  adminOnly: true },
  { key: 'lga',       label: 'By LGA',       adminOnly: true },
  { key: 'commodity', label: 'By commodity' },
  { key: 'month',     label: 'By month' },
  { key: 'scheme',    label: 'By scheme' },
]

// Clicking a card sorts the table by that measure. The measure is what people are
// actually asking when they click "Outstanding" — "show me who owes most".
const MEASURES = [
  { key: 'issued',      label: 'Issued',      hint: 'left the store' },
  { key: 'paid',        label: 'Paid',        hint: 'settled' },
  { key: 'outstanding', label: 'Outstanding', hint: 'unpaid, this period' },
  { key: 'orders',      label: 'Orders',      hint: 'dispatches', count: true },
]

const COLUMN_HEAD = {
  facility: 'Facility', lga: 'LGA', commodity: 'Commodity', month: 'Month', scheme: 'Scheme',
}

function Tab({ id, label, active, onSelect }) {
  return (
    <button type="button" onClick={() => onSelect(id)}
      className={`px-4 py-2 text-sm border-b-2 transition-colors ${
        active ? 'border-green-500 text-gray-100 font-medium' : 'border-transparent text-gray-500 hover:text-gray-300'}`}>
      {label}
    </button>
  )
}

// Clickable when onClick is given; `active` marks the measure the table is sorted by.
function Stat({ label, value, hint, onClick, active }) {
  const cls = `flex-1 min-w-[170px] rounded-lg border px-4 py-3 text-left transition-colors ${
    active ? 'border-green-500 bg-white/5' : 'border-white/10 bg-white/3'
  } ${onClick ? 'hover:border-white/25 cursor-pointer' : ''}`
  const body = (
    <>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-xl font-medium mt-0.5 ${active ? 'text-gray-100' : 'text-gray-100'}`}>{value}</div>
      {hint && <div className="text-[11px] text-gray-500 mt-0.5">{hint}</div>}
    </>
  )
  return onClick
    ? <button type="button" onClick={onClick} className={cls} aria-pressed={active}>{body}</button>
    : <div className={cls}>{body}</div>
}

// Default period: the calendar year to date. Spend is a budget question, so a
// year-to-date default matches how it actually gets asked.
const today = () => new Date().toISOString().slice(0, 10)
const yearStart = () => `${new Date().getFullYear()}-01-01`


export function Spend() {
  // Bought (this page's original content — WMS dispatch orders) vs Sold (revenue
  // from consumption — dispense_log, local to EnVo). Same page because they're the
  // two sides of the same question: this is what came in, this is what went out.
  const [view, setView] = useState('bought')

  const isAdmin        = useAppStore(s => s.isAdmin())
  const filterState    = useAppStore(s => s.adminFilterState)
  const filterLGA      = useAppStore(s => s.adminFilterLGA)
  const filterFacility = useAppStore(s => s.adminFilterFacility)
  const ownFacility     = useAppStore(s => s.currentFacility)
  // The one facility this view is pinned to, if any — a facility login is always
  // pinned to itself; an admin is pinned only once it has picked one.
  const singleFacility = isAdmin ? filterFacility : ownFacility

  const groups = useMemo(() => GROUPS.filter(g => isAdmin || !g.adminOnly), [isAdmin])
  // A facility login has no 'facility'/'lga' grouping, so it must not start on one.
  const [group, setGroup] = useState(() => (isAdmin ? 'facility' : 'commodity'))
  // Which card is selected; drives the table's sort order.
  const [measure, setMeasure] = useState('issued')
  const [from, setFrom]   = useState(yearStart)
  const [to, setTo]       = useState(today)
  const [pageState, setPageState] = useState({ key: '', page: 0 })
  // The result is stored WITH the query that produced it, so `loading` is derived by
  // comparing keys rather than being flipped by a setState in the effect body (which
  // costs an extra render pass, and trips react-hooks). It also makes a stale response
  // impossible to display: data for an old key simply reads as "still loading".
  const [data, setData] = useState({ key: null, rows: [], err: null })
  // Bought-vs-sold comparison strip, visible regardless of which tab is open — a
  // lightweight totals-only fetch of the same sales data SalesPanel shows in
  // detail, scoped to the same period/facility filter as the Bought view.
  const [soldTotal, setSoldTotal] = useState(undefined)   // undefined = loading, null = failed
  // Bought splits into "from your request" vs "direct dispatch" only when the view
  // is pinned to ONE facility — the WMS spend aggregate has no source dimension, so
  // the split comes from that facility's own order list (already fetched for the
  // balance drill-down) rather than a per-facility loop across a whole jurisdiction.
  const [showBoughtSplit, setShowBoughtSplit] = useState(false)
  const [boughtSplit, setBoughtSplit] = useState(undefined)  // undefined = loading, null = failed

  // The admin picker narrows the query server-side. state/lga travel as params rather
  // than an id list — resolveListFacilityIds intersects them with the caller's own
  // scope, so this can narrow the view but never widen it past the token.
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
  // Memoised so its identity is stable while the data is: `loading ? [] : data.rows`
  // built a fresh [] on every render, which would re-run the totals reduce each time.
  const rows = useMemo(() => (loading ? [] : data.rows), [loading, data.rows])
  const err = loading ? null : data.err

  useEffect(() => {
    let cancelled = false
    api.warehouseRequests.spend({ group_by: group, from, to, ...scopeParams })
      .then(d => { if (!cancelled) setData({ key: queryKey, rows: d || [], err: null }) })
      .catch(e => { if (!cancelled) setData({ key: queryKey, rows: [], err: e?.message || 'Could not load spend' }) })
    return () => { cancelled = true }
  }, [queryKey, group, from, to, scopeParams])

  // The Bought card's requested-vs-direct split, fetched only while the panel is
  // open and only for a single pinned facility (see singleFacility above).
  useEffect(() => {
    if (!showBoughtSplit) return
    if (!singleFacility?.id) { setBoughtSplit(null); return }
    let cancelled = false
    setBoughtSplit(undefined)
    api.warehouseRequests.balanceOrders(singleFacility.id)
      .then(orders => {
        if (cancelled) return
        const inRange = (orders || []).filter(o => {
          const d = String(o.dispatched_at || '').slice(0, 10)
          return d >= from && d <= to
        })
        const split = { request: { amount: 0, orders: 0 }, direct: { amount: 0, orders: 0 } }
        inRange.forEach(o => {
          const bucket = split[o.source] || split.direct
          bucket.amount += Number(o.total_amount || 0)
          bucket.orders += 1
        })
        setBoughtSplit(split)
      })
      .catch(() => { if (!cancelled) setBoughtSplit(null) })
    return () => { cancelled = true }
  }, [showBoughtSplit, singleFacility?.id, from, to])

  // Same from/to/scope as Bought, but grouping doesn't matter here — only the sum.
  useEffect(() => {
    let cancelled = false
    setSoldTotal(undefined)
    api.dispense.salesSummary({ group_by: 'month', from, to, ...scopeParams })
      .then(rows => { if (!cancelled) setSoldTotal((rows || []).reduce((s, r) => s + Number(r.revenue || 0), 0)) })
      .catch(() => { if (!cancelled) setSoldTotal(null) })
    return () => { cancelled = true }
  }, [from, to, scopeParams])

  const totals = useMemo(() => rows.reduce((a, r) => ({
    orders:      a.orders      + Number(r.orders || 0),
    issued:      a.issued      + Number(r.issued || 0),
    paid:        a.paid        + Number(r.paid || 0),
    outstanding: a.outstanding + Number(r.outstanding || 0),
  }), { orders: 0, issued: 0, paid: 0, outstanding: 0 }), [rows])

  // Sorted by the selected card. Commodity grain has no paid/outstanding (money is
  // settled per order, not per line), so it falls back to issued rather than showing
  // an arbitrary order.
  const sorted = useMemo(() => {
    const k = (group === 'commodity' && measure !== 'orders' && measure !== 'issued') ? 'issued' : measure
    return [...rows].sort((a, b) => Number(b[k] || 0) - Number(a[k] || 0))
  }, [rows, measure, group])

  const page = pageState.key === queryKey + measure ? pageState.page : 0
  const setPage = (p) => setPageState({ key: queryKey + measure, page: p })

  const pager = pageSlice(sorted, page)

  function downloadCsv() {
    const head = [COLUMN_HEAD[group], 'Orders', 'Quantity', 'Issued (NGN)', 'Paid (NGN)', 'Outstanding (NGN)']
    const body = sorted.map(r => [r.label, r.orders, r.quantity, r.issued, r.paid, r.outstanding])
    const csv = [head, ...body].map(row => row.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
    a.download = `essential-spend-${group}-${from}-to-${to}.csv`
    a.click(); URL.revokeObjectURL(a.href)
  }

  // Bought = value issued from the warehouse (what came in); Sold = revenue from
  // priced consumption (what went out). Same period/facility filter as whichever
  // is currently selected, so the two numbers are always comparable at a glance.
  const boughtTotal = loading ? undefined : totals.issued
  const bsGap = (boughtTotal != null && soldTotal != null) ? boughtTotal - soldTotal : null

  return (
    <div className="p-6">
      <div className="mb-1 text-xl text-gray-100 font-medium">Spend</div>

      <div className="flex gap-3 flex-wrap mb-2">
        <button type="button" onClick={() => setShowBoughtSplit(s => !s)}
          className={`flex-1 min-w-[170px] text-left rounded-lg border px-4 py-3 transition-colors ${
            showBoughtSplit ? 'border-green-500 bg-white/5' : 'border-white/10 bg-white/3 hover:border-white/25'}`}>
          <div className="text-xs text-gray-500">Bought {showBoughtSplit ? '▾' : '▸'}</div>
          <div className="text-xl font-medium mt-0.5 text-gray-100">
            {boughtTotal === undefined ? '…' : naira(boughtTotal)}
          </div>
          <div className="text-[11px] text-gray-500 mt-0.5">from the central warehouse — click for requested vs dispatched</div>
        </button>
        <div className="flex-1 min-w-[170px] rounded-lg border border-white/10 bg-white/3 px-4 py-3">
          <div className="text-xs text-gray-500">Sold</div>
          <div className="text-xl font-medium mt-0.5 text-gray-100">
            {soldTotal === undefined ? '…' : soldTotal === null ? 'unavailable' : naira(soldTotal)}
          </div>
          <div className="text-[11px] text-gray-500 mt-0.5">priced consumption</div>
        </div>
        <div className="flex-1 min-w-[170px] rounded-lg border border-white/10 bg-white/3 px-4 py-3">
          <div className="text-xs text-gray-500">Gap</div>
          <div className={`text-xl font-medium mt-0.5 ${bsGap == null ? 'text-gray-100' : bsGap >= 0 ? 'text-blue-300' : 'text-amber-400'}`}>
            {bsGap == null ? '…' : naira(Math.abs(bsGap))}
          </div>
        </div>
      </div>

      {showBoughtSplit && (
        <div className="rounded-lg border border-white/10 bg-white/3 px-4 py-3 mb-5">
          {!singleFacility?.id ? (
            <div className="text-sm text-gray-500">
              Select a single facility (the picker above the table) to see the requested-vs-dispatched split —
              the warehouse doesn't report that split summed across many facilities at once.
            </div>
          ) : boughtSplit === undefined ? (
            <div className="text-sm text-gray-500">Loading…</div>
          ) : boughtSplit === null ? (
            <div className="text-sm text-red-400">Could not load {singleFacility.name}'s orders from the warehouse.</div>
          ) : (
            <div className="flex gap-6 flex-wrap">
              <div>
                <div className="text-xs text-gray-500">From your requests</div>
                <div className="text-lg font-medium text-gray-100">{naira(boughtSplit.request.amount)}</div>
                <div className="text-[11px] text-gray-500">{boughtSplit.request.orders} order(s)</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">Direct dispatch</div>
                <div className="text-lg font-medium text-gray-100">{naira(boughtSplit.direct.amount)}</div>
                <div className="text-[11px] text-gray-500">{boughtSplit.direct.orders} order(s)</div>
              </div>
              <div className="text-[11px] text-gray-600 self-end">for {singleFacility.name}, {from} to {to}</div>
            </div>
          )}
        </div>
      )}

      <div className="flex gap-2 mb-5">
        <button type="button" onClick={() => setView('bought')}
          className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            view === 'bought' ? 'bg-white/10 text-gray-100' : 'text-gray-500 hover:text-gray-300'}`}>
          Bought
        </button>
        <button type="button" onClick={() => setView('sold')}
          className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            view === 'sold' ? 'bg-white/10 text-gray-100' : 'text-gray-500 hover:text-gray-300'}`}>
          Sold
        </button>
      </div>

      {view === 'sold' ? <SalesPanel /> : <>

      <p className="text-sm text-gray-500 mb-5">
        What has been bought from the central warehouse. Cancelled requests are excluded.
      </p>

      {err && <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-400">{err}</div>}

      {/* Filters live above the cards they drive, so it's clear every number below
          (including the Bought/Sold/Gap strip) is scoped to this window. */}
      <div className="flex gap-2 flex-wrap items-center mb-5">
        {/* Narrows the query server-side via scopeParams; self-hides for facility users. */}
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

      <div className="flex gap-3 flex-wrap mb-5">
        {MEASURES.map(m => (
          <Stat
            key={m.key}
            label={m.label}
            value={m.count ? num(totals[m.key]) : naira(totals[m.key])}
            hint={m.hint}
            active={measure === m.key}
            onClick={() => setMeasure(m.key)}
          />
        ))}
      </div>

      <div className="flex border-b border-white/10 mb-4 flex-wrap">
        {groups.map(g => <Tab key={g.key} id={g.key} label={g.label} active={group === g.key} onSelect={setGroup} />)}
      </div>

      <div className="rounded-lg border border-white/10">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-white/10">
                <th className="px-4 py-2 font-medium">{COLUMN_HEAD[group]}</th>
                <th className="px-4 py-2 font-medium text-right">Orders</th>
                {group === 'commodity' && <th className="px-4 py-2 font-medium text-right">Quantity</th>}
                <th className="px-4 py-2 font-medium text-right">Issued</th>
                {group !== 'commodity' && <th className="px-4 py-2 font-medium text-right">Paid</th>}
                {group !== 'commodity' && <th className="px-4 py-2 font-medium text-right">Outstanding</th>}
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={group === 'commodity' ? 4 : 5} className="px-4 py-6 text-center text-gray-500">Loading…</td></tr>}
              {!loading && !pager.slice.length && (
                <tr><td colSpan={group === 'commodity' ? 4 : 5} className="px-4 py-6 text-center text-gray-500">No purchases in this period.</td></tr>
              )}
              {!loading && pager.slice.map(r => (
                <tr key={r.key} className="border-b border-white/5 hover:bg-white/2">
                  <td className="px-4 py-2 text-gray-100">{r.label}</td>
                  <td className="px-4 py-2 text-right text-gray-300">{num(r.orders)}</td>
                  {group === 'commodity' && (
                    <td className="px-4 py-2 text-right text-gray-300">{num(r.quantity)}</td>
                  )}
                  <td className="px-4 py-2 text-right text-gray-100">{naira(r.issued)}</td>
                  {group !== 'commodity' && (
                    <td className="px-4 py-2 text-right text-gray-300">{naira(r.paid)}</td>
                  )}
                  {group !== 'commodity' && (
                    <td className="px-4 py-2 text-right">
                      {r.outstanding > 0
                        ? <span className="text-amber-400">{naira(r.outstanding)}</span>
                        : <span className="text-gray-500">—</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pagination pager={pager} onPage={setPage} unit="rows" />
      </div>

      </>}
    </div>
  )
}
