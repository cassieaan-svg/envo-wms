import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/appStore'
import { FacilityPicker } from '../../components/ui/FacilityPicker'
import { Pagination, pageSlice } from '../../components/ui/Pagination'
import { exportCsv, exportPdf } from '../../utils/download'

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

const naira = (n) => '₦' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const num = (n) => Number(n || 0).toLocaleString()

// The WMS catalogue stores "1" as the unit for items that have no meaningful one, which
// renders as "300 1 × ₦71". Treat that (and a blank) as no unit rather than printing it.
const unitLabel = (u) => {
  const t = String(u ?? '').trim()
  return !t || t === '1' ? '' : t
}

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
  { key: 'outstanding', label: 'Outstanding', hint: 'still owed' },
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

// One facility's balance, expandable into the orders behind it. Most of those orders are
// DIRECT dispatches — issued at the warehouse with no EnVo request — so this is the only
// place in EnVo they can be seen. Read-only: payments are recorded at the warehouse.
// One row per order LINE, with the order's totals repeated on each — a flat shape both
// CSV and the PDF can render.
//
// Individual instalments are deliberately not exploded here: a payment belongs to the
// order, not to a commodity line, so repeating it per line would make it look like the
// facility paid that amount several times. The order's paid/outstanding totals carry
// the money; the on-screen panel shows the instalments behind them.
function orderRows(b, orders) {
  const out = []
  for (const o of orders) {
    if (o.items?.length) {
      for (const i of o.items) {
        out.push([
          `#${o.id}`, String(o.dispatched_at || '').slice(0, 10),
          o.source === 'request' ? 'From request' : 'Direct dispatch', o.scheme,
          i.commodity,
          i.quantity, unitLabel(i.unit), i.unit_price, i.line_total,
          o.total_amount, o.amount_paid, o.outstanding,
        ])
      }
    } else {
      out.push([`#${o.id}`, String(o.dispatched_at || '').slice(0, 10),
        o.source === 'request' ? 'From request' : 'Direct dispatch', o.scheme,
        '(no line detail)', '', '', '', '',
        o.total_amount, o.amount_paid, o.outstanding])
    }
  }
  return out
}

const ORDER_HEAD = ['Order', 'Dispatched', 'Source', 'Scheme', 'Commodity',
                    'Qty', 'Unit', 'Unit price', 'Line total',
                    'Order total', 'Paid', 'Outstanding']
// Numeric columns, right-aligned in the PDF.
const ORDER_RIGHT = new Set([5, 7, 8, 9, 10, 11])


function BalanceRow({ b, open, onToggle, orders, error }) {
  const stamp = new Date().toISOString().slice(0, 10)
  const base = `${b.facility_name.replace(/[^\w]+/g, '-').toLowerCase()}-orders-${stamp}`
  const subtitle = `${naira(b.outstanding)} outstanding across ${b.unpaid_orders} order(s) · as at ${stamp}`

  return (
    <>
      <div className="flex items-center gap-3 py-2 border-b border-white/5">
        <button type="button" onClick={() => onToggle(b.facility_id)}
          className="text-sm text-gray-300 hover:text-gray-100 text-left flex-1">
          <span className="text-gray-500 mr-2">{open ? '▾' : '▸'}</span>{b.facility_name}
        </button>
        <span className="text-xs text-gray-500">{b.unpaid_orders} unpaid</span>
        <span className="text-sm text-amber-400 tabular-nums w-32 text-right">{naira(b.outstanding)}</span>
        {/* Enabled only once the orders are loaded — there is nothing to export before
            the facility has been opened. */}
        <button type="button" disabled={!orders?.length}
          onClick={() => exportCsv(`${base}.csv`, ORDER_HEAD, orderRows(b, orders))}
          className="text-[11px] px-2 py-0.5 rounded border border-white/10 text-gray-400 hover:bg-white/5 disabled:opacity-30">
          CSV
        </button>
        <button type="button" disabled={!orders?.length}
          onClick={() => exportPdf(`${b.facility_name} — warehouse orders`, subtitle, ORDER_HEAD, orderRows(b, orders), ORDER_RIGHT)}
          className="text-[11px] px-2 py-0.5 rounded border border-white/10 text-gray-400 hover:bg-white/5 disabled:opacity-30">
          PDF
        </button>
      </div>
      {open && (
        <div className="pl-6 pb-3 border-b border-white/5">
          {error ? (
            <div className="text-xs text-red-400 py-2">{error}</div>
          ) : !orders ? (
            <div className="text-xs text-gray-500 py-2">Loading orders…</div>
          ) : orders.length === 0 ? (
            <div className="text-xs text-gray-500 py-2">No orders found at the central store.</div>
          ) : (
            <table className="w-full text-xs mt-2">
              <thead>
                <tr className="text-left text-gray-500">
                  <th className="py-1 font-medium">Order</th>
                  <th className="py-1 font-medium">Dispatched</th>
                  <th className="py-1 font-medium">Source</th>
                  <th className="py-1 font-medium">Scheme</th>
                  <th className="py-1 font-medium text-right">Total</th>
                  <th className="py-1 font-medium text-right">Paid</th>
                  <th className="py-1 font-medium text-right">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {orders.map(o => (
                  <>
                    <tr key={o.id} className="border-t border-white/5">
                      <td className="py-1 text-gray-300">#{o.id}</td>
                      <td className="py-1 text-gray-500">{String(o.dispatched_at || '').slice(0, 10)}</td>
                      <td className="py-1 text-gray-500">
                        {/* A facility can't otherwise tell an order it raised from one the
                            warehouse issued to it directly. */}
                        {o.source === 'request' ? 'From your request' : 'Direct dispatch'}
                      </td>
                      <td className="py-1 text-gray-500">{o.scheme}</td>
                      <td className="py-1 text-right text-gray-300">{naira(o.total_amount)}</td>
                      <td className="py-1 text-right text-gray-300">{naira(o.amount_paid)}</td>
                      <td className="py-1 text-right">
                        {o.outstanding > 0
                          ? <span className="text-amber-400">{naira(o.outstanding)}</span>
                          : <span className="text-green-400">paid</span>}
                      </td>
                    </tr>
                    {/* What was issued. The order total means little without the
                        commodities behind it — this is the line a facility checks when
                        it queries a bill. */}
                    {o.items?.length > 0 && (
                      <tr key={`it-${o.id}`}>
                        <td colSpan={7} className="pl-4 pb-1">
                          {/* Section titles carry the weight: they are what tells you
                              which block you are reading once an order is expanded. */}
                          <div className="text-sm text-gray-100 font-semibold mb-1">
                            Commodities issued
                          </div>
                          {o.items.map((i, n) => (
                            <div key={n} className="flex gap-3 items-baseline py-0.5">
                              <span className="flex-1 text-sm text-gray-100 font-medium">{i.commodity}</span>
                              <span className="tabular-nums text-gray-500">
                                {i.quantity.toLocaleString()}
                                {unitLabel(i.unit) ? ` ${unitLabel(i.unit)}` : ''} × {naira(i.unit_price)}
                              </span>
                              <span className="tabular-nums w-28 text-right text-sm text-gray-100 font-medium">
                                {naira(i.line_total)}
                              </span>
                            </div>
                          ))}
                        </td>
                      </tr>
                    )}
                    {o.payments.length > 0 && (
                      <tr key={`p-${o.id}`}>
                        <td colSpan={7} className="pl-4 pb-2 text-gray-500">
                          <div className="text-sm text-gray-100 font-semibold mb-1">Payments</div>
                          {/* The receipt number leads, because that is what the facility
                              is holding in its hand when it queries a payment — the row
                              exists so a receipt can be matched against the balance. */}
                          <div className="flex gap-3 text-[10px] uppercase tracking-wide text-gray-600 pb-0.5">
                            <span className="w-24">Receipt no.</span>
                            <span className="w-20">Paid on</span>
                            <span className="w-24 text-right">Amount</span>
                            <span className="flex-1">Recorded by</span>
                          </div>
                          {o.payments.map(p => (
                            <div key={p.id} className="flex gap-3 py-0.5">
                              <span className="w-24 text-gray-100 font-medium">
                                {/* Blank on payments taken before receipts were captured. */}
                                {p.receipt_no || <span className="text-gray-600 font-normal">—</span>}
                              </span>
                              <span className="w-20">{String(p.paid_at).slice(0, 10)}</span>
                              <span className="w-24 text-right tabular-nums text-gray-300">{naira(p.amount)}</span>
                              <span className="flex-1">
                                {p.recorded_by || '—'}
                                {p.note && <span className="text-gray-600"> · {p.note}</span>}
                              </span>
                            </div>
                          ))}
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  )
}

export function Spend() {
  const isAdmin        = useAppStore(s => s.isAdmin())
  const filterState    = useAppStore(s => s.adminFilterState)
  const filterLGA      = useAppStore(s => s.adminFilterLGA)
  const filterFacility = useAppStore(s => s.adminFilterFacility)

  const groups = useMemo(() => GROUPS.filter(g => isAdmin || !g.adminOnly), [isAdmin])
  // A facility login has no 'facility'/'lga' grouping, so it must not start on one.
  const [group, setGroup] = useState(() => (isAdmin ? 'facility' : 'commodity'))
  // Which card is selected; drives the table's sort order.
  const [measure, setMeasure] = useState('issued')
  const [from, setFrom]   = useState(yearStart)
  const [to, setTo]       = useState(today)
  const [pageState, setPageState] = useState({ key: '', page: 0 })
  // Balances read from the WMS, which owns the money. undefined = loading,
  // null = the warehouse was unreachable (shown as unknown, never as zero).
  const [balances, setBalances] = useState(undefined)
  const [openFacility, setOpenFacility] = useState(null)
  const [orders, setOrders] = useState({})        // facilityId -> orders
  const [orderErr, setOrderErr] = useState({})
  // The result is stored WITH the query that produced it, so `loading` is derived by
  // comparing keys rather than being flipped by a setState in the effect body (which
  // costs an extra render pass, and trips react-hooks). It also makes a stale response
  // impossible to display: data for an old key simply reads as "still loading".
  const [data, setData] = useState({ key: null, rows: [], err: null })

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
    let off = false
    api.warehouseRequests.balances(scopeParams)
      .then(r => { if (!off) setBalances(r || []) })
      .catch(() => { if (!off) setBalances(null) })
    return () => { off = true }
  }, [scopeParams])

  async function toggleFacility(id) {
    if (openFacility === id) { setOpenFacility(null); return }
    setOpenFacility(id)
    if (orders[id] || orderErr[id]) return
    try {
      const rows = await api.warehouseRequests.balanceOrders(id)
      setOrders(m => ({ ...m, [id]: rows }))
    } catch (e) {
      setOrderErr(m => ({ ...m, [id]: e?.message || 'Could not load orders' }))
    }
  }

  useEffect(() => {
    let cancelled = false
    api.warehouseRequests.spend({ group_by: group, from, to, ...scopeParams })
      .then(d => { if (!cancelled) setData({ key: queryKey, rows: d || [], err: null }) })
      .catch(e => { if (!cancelled) setData({ key: queryKey, rows: [], err: e?.message || 'Could not load spend' }) })
    return () => { cancelled = true }
  }, [queryKey, group, from, to, scopeParams])

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
  // Derived once and shared by the card and the list below, so the two can never
  // disagree about what is owed.
  const owingFacilities = useMemo(
    () => (Array.isArray(balances) ? balances : [])
      .filter(b => Number(b.outstanding) > 0)
      .sort((a, b) => b.outstanding - a.outstanding),
    [balances])
  const owedTotal = useMemo(
    () => owingFacilities.reduce((s, b) => s + Number(b.outstanding), 0),
    [owingFacilities])

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

  return (
    <div className="p-6">
      <div className="mb-1 text-xl text-gray-100 font-medium">Spend</div>
      <p className="text-sm text-gray-500 mb-5">
        What has been bought from the central warehouse. Cancelled requests are excluded.
      </p>

      {err && <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-400">{err}</div>}

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
        {/* Owed sits with the other money cards rather than only as a heading below —
            it is the figure people come to this page for. */}
        <Stat
          label="Owed to the store"
          value={balances === undefined ? '…' : balances === null ? 'unavailable' : naira(owedTotal)}
          hint={balances && owingFacilities.length
            ? `${owingFacilities.length} facilit${owingFacilities.length === 1 ? 'y' : 'ies'}`
            : balances ? 'nothing outstanding' : 'warehouse unreachable'}
        />
      </div>

      {/* Owed to the central store. Lives on Spend because it is a money question —
          and because the orders behind it are mostly direct dispatches, which the
          request pages cannot show at all. */}
      {balances !== undefined && (
        <div className="rounded-lg border border-white/10 bg-white/3 px-4 py-3 mb-5">
          {balances === null ? (
            <div className="text-sm text-gray-500">
              Balances unavailable — the central store could not be reached.
            </div>
          ) : (
              <>
                <div className="text-xs text-gray-500 mb-2">
                  {owingFacilities.length
                    ? 'Owed to the central store — click a facility to see the orders'
                    : 'Nothing outstanding with the central store.'}
                </div>
                {owingFacilities.map(b => (
                  <BalanceRow
                    key={b.facility_id}
                    b={b}
                    open={openFacility === b.facility_id}
                    onToggle={toggleFacility}
                    orders={orders[b.facility_id]}
                    error={orderErr[b.facility_id]}
                  />
                ))}
              </>
          )}
        </div>
      )}

      <div className="flex border-b border-white/10 mb-4 flex-wrap">
        {groups.map(g => <Tab key={g.key} id={g.key} label={g.label} active={group === g.key} onSelect={setGroup} />)}
      </div>

      <div className="flex gap-2 flex-wrap items-center mb-4">
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
    </div>
  )
}
