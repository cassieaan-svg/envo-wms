import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { Button } from './ui/Button'
import { toast } from './ui/Toast'
import { isStateOfficeName } from '../utils/helpers'

// The source facility's side of a batch assignment, grouped BY COMMODITY.
//
// A storekeeper pulls one commodity off the shelf once and splits it across the
// facilities that asked for it — so the unit of work here is a commodity, not a
// request. Grouping this way is also the only view that shows whether TOTAL demand
// exceeds what is on the shelf; the per-request list cannot, so a store discovers it
// lot by lot, part-way through dispatching.
//
// Lots are pre-allocated FEFO across the whole group and shown with their expiry, then
// left editable. The system cannot know which facility turns stock over fastest, and
// handing a three-week lot to a low-volume PHC while a busy hospital gets the year-long
// one is how stock expires on a shelf. Pre-filled, not decided.

const fmtExp = (d) => (d ? String(d).slice(0, 10) : 'no expiry')

const lotKey = (l) => String(l.batch_number ?? '')
const byFefo = (a, b) =>
  String(a.expiry_date || '9999').localeCompare(String(b.expiry_date || '9999'))

/**
 * Work out what each facility is taking from which lot.
 *
 * A row the storekeeper has edited (`manual[rowId]`) is honoured exactly as entered.
 * Everything else is filled FEFO from what those manual picks leave behind — so
 * overriding one facility re-flows the rest rather than double-promising a lot.
 *
 * Returns { [rowId]: { picks, short, manual } } plus `lotUsage` so the editor can show
 * what is still free on each lot across the WHOLE group.
 */
function allocate(lots, rows, manual = {}) {
  const sorted = [...lots].sort(byFefo)
  const left = new Map(sorted.map(l => [lotKey(l), Number(l.quantity) || 0]))
  const usage = new Map(sorted.map(l => [lotKey(l), 0]))

  const take = (key, n) => {
    left.set(key, (left.get(key) ?? 0) - n)
    usage.set(key, (usage.get(key) ?? 0) + n)
  }

  // Manual picks first — they are decisions already made, so they get the stock.
  const out = {}
  for (const r of rows) {
    const picks = manual[r.id]
    if (!picks) continue
    for (const p of picks) take(String(p.batch ?? ''), Number(p.quantity) || 0)
    const got = picks.reduce((s, p) => s + (Number(p.quantity) || 0), 0)
    out[r.id] = {
      picks: picks.map(p => ({
        ...p,
        expiry: sorted.find(l => lotKey(l) === String(p.batch ?? ''))?.expiry_date ?? null,
      })),
      short: (Number(r.qty) || 0) - got,
      manual: true,
    }
  }

  // Then FEFO for the rest, over whatever is left.
  for (const r of rows) {
    if (out[r.id]) continue
    let need = Number(r.qty) || 0
    const picks = []
    for (const l of sorted) {
      if (need <= 0) break
      const k = lotKey(l)
      const avail = Math.max(0, left.get(k) ?? 0)
      const n = Math.min(need, avail)
      if (n > 0) {
        picks.push({ lot_id: l.id, batch: l.batch_number ?? '', expiry: l.expiry_date, quantity: n })
        take(k, n)
        need -= n
      }
    }
    out[r.id] = { picks, short: need, manual: false }
  }

  // Over-allocation is possible once a storekeeper edits by hand.
  const overDrawn = sorted
    .filter(l => (usage.get(lotKey(l)) ?? 0) > (Number(l.quantity) || 0))
    .map(l => ({ batch: l.batch_number ?? '', used: usage.get(lotKey(l)), have: Number(l.quantity) || 0 }))

  return { rows: out, usage, overDrawn }
}

export function BatchDispatchPanel({ facilityId, facilityName, tasks, onDone }) {
  // For a State Office Store the approving officer IS the carrier — the office drives
  // the stock out to the facilities — so one name covers the whole run.
  const stateOffice = isStateOfficeName(facilityName)

  const [openComm, setOpenComm] = useState(null)
  const [qty, setQty] = useState({})            // transferId -> quantity to send
  const [lots, setLots] = useState({})          // commodityId -> store lots
  const [approvedBy, setApprovedBy] = useState('')
  const [carrier, setCarrier] = useState('')
  // rowId -> [{ batch, quantity }] once the storekeeper edits that facility's split.
  // Absent = leave it to FEFO.
  const [manual, setManual] = useState({})
  const [editingRow, setEditingRow] = useState(null)
  const [sending, setSending] = useState(false)

  // One row per commodity: who asked, how much in total, what is on the shelf.
  const groups = useMemo(() => {
    const m = new Map()
    for (const t of tasks) {
      if (!m.has(t.commodity_id)) {
        m.set(t.commodity_id, { commodity_id: t.commodity_id, name: t.commodity_name, rows: [] })
      }
      m.get(t.commodity_id).rows.push(t)
    }
    return [...m.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  }, [tasks])

  // Load the store's lots for a commodity when it is opened.
  useEffect(() => {
    if (!openComm || lots[openComm] || !facilityId) return
    let off = false
    api.stock.lots({ facility_id: facilityId, commodity_id: openComm, location_type: 'store' })
      .then(rows => { if (!off) setLots(m => ({ ...m, [openComm]: rows || [] })) })
      .catch(() => { if (!off) setLots(m => ({ ...m, [openComm]: [] })) })
    return () => { off = true }
  }, [openComm, facilityId, lots])

  const group = groups.find(g => g.commodity_id === openComm)
  const groupRows = (group?.rows || []).map(t => ({
    ...t,
    qty: qty[t.id] ?? (t.qty_requested ?? t.quantity ?? 0),
  }))
  const onShelf = (lots[openComm] || []).reduce((s, l) => s + (Number(l.quantity) || 0), 0)
  const totalWanted = groupRows.reduce((s, r) => s + (Number(r.qty) || 0), 0)
  // Recomputed each render rather than memoised: it is a walk over a handful of rows,
  // and memoising it needed a dependency key describing derived state — the kind of
  // inline expression that cannot be checked statically and hides real warnings.
  const { rows: allocation, usage, overDrawn } = allocate(lots[openComm] || [], groupRows, manual)
  const anyMismatch = Object.values(allocation).some(a => a.short !== 0)
  const anyOver = overDrawn.length > 0

  // What is still free on a lot, from this row's point of view: the lot's balance less
  // everything the OTHER facilities in this group are taking from it.
  function freeOnLot(lot, rowId) {
    const key = String(lot.batch_number ?? '')
    const mine = (allocation[rowId]?.picks || [])
      .filter(p => String(p.batch ?? '') === key)
      .reduce((sum, p) => sum + (Number(p.quantity) || 0), 0)
    return (Number(lot.quantity) || 0) - (usage.get(key) ?? 0) + mine
  }

  function startEdit(row) {
    // Seed the editor with whatever is currently allocated, so editing starts from the
    // system's suggestion rather than a blank slate.
    setManual(m => ({ ...m, [row.id]: (allocation[row.id]?.picks || []).map(p => ({ batch: p.batch ?? '', quantity: p.quantity })) }))
    setEditingRow(row.id)
  }

  function setPick(rowId, i, patch) {
    setManual(m => ({ ...m, [rowId]: (m[rowId] || []).map((p, n) => (n === i ? { ...p, ...patch } : p)) }))
  }
  function addPick(rowId) {
    setManual(m => ({ ...m, [rowId]: [...(m[rowId] || []), { batch: '', quantity: 0 }] }))
  }
  function removePick(rowId, i) {
    setManual(m => ({ ...m, [rowId]: (m[rowId] || []).filter((_, n) => n !== i) }))
  }
  function resetPicks(rowId) {
    setManual(m => { const next = { ...m }; delete next[rowId]; return next })
    setEditingRow(null)
  }

  async function send() {
    if (!approvedBy.trim()) { toast('Approved by is required', 'red'); return }
    if (!stateOffice && !carrier.trim()) { toast('Carrier is required', 'red'); return }
    const items = groupRows
      .filter(r => Number(r.qty) > 0)
      .map(r => ({
        id: r.id,
        quantity: Number(r.qty),
        // Send the exact allocation, so the ledger debits the batches shown on screen
        // rather than re-deciding FEFO server-side and possibly picking differently.
        lots: (allocation[r.id]?.picks || []).map(p => ({ batch: p.batch, quantity: p.quantity })),
      }))
    if (!items.length) { toast('Nothing to send — every quantity is zero', 'red'); return }
    const bad = items.find(i => (allocation[i.id]?.short || 0) !== 0)
    if (bad) {
      const s2 = allocation[bad.id].short
      toast(s2 > 0
        ? `A facility still has ${s2} unallocated — the batches must add up to the send quantity`
        : `A facility is allocated ${-s2} more than its send quantity`, 'red')
      return
    }
    if (overDrawn.length) {
      toast(`Batch ${overDrawn[0].batch || '(no batch)'} is over-allocated`, 'red'); return
    }

    setSending(true)
    try {
      await api.transfers.dispatchBatch({
        approved_by: approvedBy.trim(),
        // State office: the approver carries it. Otherwise the named carrier.
        carrier: stateOffice ? approvedBy.trim() : carrier.trim(),
        items,
      })
      toast(`${items.length} dispatch${items.length === 1 ? '' : 'es'} sent`, 'green')
      setOpenComm(null); setQty({}); setLots({}); setCarrier(''); setManual({}); setEditingRow(null)
      onDone?.()
    } catch (e) {
      // All-or-nothing: nothing moved, so reload to show what changed underneath.
      toast(e.message || 'Could not dispatch', 'red')
      onDone?.()
    } finally { setSending(false) }
  }

  if (!tasks.length) return null

  return (
    <div className="border border-white/10 rounded-xl overflow-hidden mb-4">
      <div className="px-4 py-3 bg-white/3 border-b border-white/8">
        <div className="text-sm text-gray-100 font-medium">Dispatch by commodity</div>
        <div className="text-xs text-gray-500 mt-0.5">
          {groups.length} commodit{groups.length === 1 ? 'y' : 'ies'} requested by {new Set(tasks.map(t => t.receiving_facility_id)).size} facilit
          {new Set(tasks.map(t => t.receiving_facility_id)).size === 1 ? 'y' : 'ies'} · pick once, split across them
        </div>
      </div>

      {groups.map(g => {
        const open = openComm === g.commodity_id
        const wanted = g.rows.reduce((s, t) => s + (qty[t.id] ?? (t.qty_requested ?? t.quantity ?? 0)), 0)
        return (
          <div key={g.commodity_id} className="border-b border-white/5 last:border-0">
            <button type="button" onClick={() => setOpenComm(open ? null : g.commodity_id)}
              className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/2">
              <span className="text-gray-500">{open ? '▾' : '▸'}</span>
              <span className="flex-1 text-sm text-gray-100 font-medium">{g.name}</span>
              <span className="text-xs text-gray-500">{g.rows.length} facilit{g.rows.length === 1 ? 'y' : 'ies'}</span>
              <span className="text-sm text-gray-300 tabular-nums w-24 text-right">{wanted} requested</span>
            </button>

            {open && (
              <div className="px-4 pb-4">
                <div className="text-xs mb-2">
                  {overDrawn.length > 0 && (
                    <div className="text-amber-400 mb-1">
                      Over-allocated: {overDrawn.map(o => `${o.batch || '(no batch)'} — ${o.used} of ${o.have}`).join('; ')}
                    </div>
                  )}
                  {lots[openComm] === undefined ? (
                    <span className="text-gray-500">Loading lots…</span>
                  ) : (
                    <span className={onShelf < totalWanted ? 'text-amber-400' : 'text-gray-500'}>
                      Shelf holds {onShelf} · this batch would send {totalWanted}
                      {onShelf < totalWanted && ' — reduce quantities to fit'}
                    </span>
                  )}
                </div>

                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-gray-500 border-b border-white/8">
                      <th className="py-1 font-medium">Facility</th>
                      <th className="py-1 font-medium">Requested</th>
                      <th className="py-1 font-medium">Send</th>
                      <th className="py-1 font-medium">Batch allocated (earliest expiry first)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groupRows.map(r => {
                      const a = allocation[r.id] || { picks: [], short: 0 }
                      return (
                        <tr key={r.id} className="border-b border-white/5">
                          <td className="py-2 text-gray-100">{r.receiving_facility_name}</td>
                          <td className="py-2 text-gray-500">{r.qty_requested ?? r.quantity}</td>
                          <td className="py-2">
                            <input type="number" min="0" value={r.qty}
                              onChange={e => setQty(m => ({ ...m, [r.id]: e.target.value }))}
                              className="w-20 bg-white/5 border border-white/15 rounded px-2 py-1 text-gray-100 focus:outline-none focus:border-blue-500" />
                          </td>
                          <td className="py-2">
                            {editingRow === r.id ? (
                              <div className="space-y-1">
                                {(manual[r.id] || []).map((p, i) => {
                                  const lot = (lots[openComm] || []).find(l => String(l.batch_number ?? '') === String(p.batch ?? ''))
                                  const free = lot ? freeOnLot(lot, r.id) : 0
                                  return (
                                    <div key={i} className="flex items-center gap-1.5">
                                      <select value={p.batch ?? ''} onChange={e => setPick(r.id, i, { batch: e.target.value })}
                                        className="bg-white/5 border border-white/15 rounded px-1.5 py-1 text-gray-100 focus:outline-none focus:border-blue-500">
                                        <option value="">(no batch)</option>
                                        {(lots[openComm] || []).sort(byFefo).map(l => (
                                          <option key={l.id} value={String(l.batch_number ?? '')}>
                                            {l.batch_number || '(no batch)'} · exp {fmtExp(l.expiry_date)} · {freeOnLot(l, r.id)} free
                                          </option>
                                        ))}
                                      </select>
                                      <input type="number" min="0" value={p.quantity}
                                        onChange={e => setPick(r.id, i, { quantity: Number(e.target.value) })}
                                        className="w-16 bg-white/5 border border-white/15 rounded px-1.5 py-1 text-gray-100 focus:outline-none focus:border-blue-500" />
                                      {/* Availability is net of what the OTHER facilities in this
                                          group are taking from the same lot. */}
                                      <span className={p.quantity > free ? 'text-amber-400' : 'text-gray-600'}>
                                        /{free} free
                                      </span>
                                      <button type="button" onClick={() => removePick(r.id, i)}
                                        className="text-gray-600 hover:text-red-400 px-1">✕</button>
                                    </div>
                                  )
                                })}
                                <div className="flex gap-2 pt-0.5">
                                  <button type="button" onClick={() => addPick(r.id)}
                                    className="text-blue-400 hover:text-blue-300">+ Add batch</button>
                                  <button type="button" onClick={() => setEditingRow(null)}
                                    className="text-gray-400 hover:text-gray-200">Done</button>
                                  <button type="button" onClick={() => resetPicks(r.id)}
                                    className="text-gray-500 hover:text-gray-300">Reset to FEFO</button>
                                </div>
                                {a.short !== 0 && (
                                  <div className="text-amber-400">
                                    {a.short > 0 ? `${a.short} still unallocated` : `${-a.short} more than the send quantity`}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <div className="group/alloc">
                                {a.picks.length === 0 && a.short === 0 && <span className="text-gray-600">—</span>}
                                {a.picks.map((p, i) => (
                                  <div key={i} className="text-gray-300">
                                    {p.quantity} from <span className="text-gray-100">{p.batch || '(no batch)'}</span>
                                    <span className="text-gray-500"> · exp {fmtExp(p.expiry)}</span>
                                  </div>
                                ))}
                                {a.short > 0 && (
                                  <div className="text-amber-400">short {a.short} — not enough on the shelf</div>
                                )}
                                {a.short < 0 && (
                                  <div className="text-amber-400">{-a.short} more than the send quantity</div>
                                )}
                                <button type="button" onClick={() => startEdit(r)}
                                  className="text-blue-400 hover:text-blue-300 mt-0.5">
                                  {a.manual ? 'Edit batches' : 'Change batches'}
                                </button>
                                {a.manual && <span className="text-gray-600"> · edited</span>}
                              </div>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>

                <div className="flex flex-wrap gap-2 items-end mt-3">
                  <div className="w-full sm:w-56">
                    <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">
                      {stateOffice ? 'Approved & carried by *' : 'Approved by *'}
                    </label>
                    <input value={approvedBy} onChange={e => setApprovedBy(e.target.value)}
                      placeholder="Store officer's name"
                      className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600 focus:outline-none focus:border-blue-500" />
                    {stateOffice && (
                      <p className="text-[11px] text-gray-500 mt-1">
                        The state office carries the stock, so the approving officer is recorded as the carrier.
                      </p>
                    )}
                  </div>
                  {!stateOffice && (
                    <div className="w-full sm:w-56">
                      <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Carrier *</label>
                      <input value={carrier} onChange={e => setCarrier(e.target.value)}
                        placeholder="Driver or collector"
                        className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600 focus:outline-none focus:border-blue-500" />
                    </div>
                  )}
                  <Button variant="primary" size="sm" disabled={sending || anyMismatch || anyOver} onClick={send}>
                    {sending ? 'Dispatching…' : `Dispatch ${groupRows.filter(r => Number(r.qty) > 0).length} facilit${groupRows.filter(r => Number(r.qty) > 0).length === 1 ? 'y' : 'ies'}`}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
