import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { offlineWarehouseRequest } from '../../lib/offlineWrite'
import { useAppStore } from '../../store/appStore'
import { CommoditySelect } from '../../components/ui/CommoditySelect'
import { isValidNgPhone as validNgPhone } from '../../lib/phone'

const naira = (n) => '₦' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const STATUS_STYLE = {
  pending:    'bg-amber-500/15 text-amber-400',
  submitted:  'bg-blue-500/15 text-blue-400',
  picking:    'bg-indigo-500/15 text-indigo-400',
  dispatched: 'bg-cyan-500/15 text-cyan-400',
  received:   'bg-green-500/15 text-green-400',
  cancelled:  'bg-gray-500/15 text-gray-400',
}

export function RequestWarehouse() {
  const commodities = useAppStore(s => s.allCommodities)
  const canManage   = useAppStore(s => s.canManageStock())

  // Only priced commodities can be requested (a line needs a unit price for the total).
  const priced = useMemo(
    () => (commodities || []).filter(c => c.unit_price != null).sort((a, b) => a.name.localeCompare(b.name)),
    [commodities])

  const categories = useMemo(
    () => [...new Set(priced.map(c => c.category).filter(Boolean))].sort(),
    [priced])

  const [lines, setLines]   = useState([])          // [{ commodity_id, name, unit_price, quantity }]
  const [catFilter, setCatFilter] = useState('')
  const [pickId, setPickId] = useState('')
  const [unitCost, setUnitCost] = useState('')       // cost per unit, prefilled from the catalogue
  const [qty, setQty]       = useState('')

  const pickable = useMemo(
    () => catFilter ? priced.filter(c => c.category === catFilter) : priced,
    [priced, catFilter])

  // Prefill the cost-per-unit from the catalogue whenever the commodity changes.
  useEffect(() => {
    const c = priced.find(x => x.id === pickId)
    setUnitCost(c ? String(c.unit_price) : '')
  }, [pickId, priced])
  const [notes, setNotes]   = useState('')
  // The warehouse rings this number if a line needs confirming before the order goes out.
  // Remembered locally so the same store manager isn't retyping it on every request.
  // Who raised the request, so the warehouse has a person to call — not just the
  // login account. Remembered locally like the phone, so it isn't retyped each time.
  const [name, setName]     = useState(() => localStorage.getItem('envo_requester_name') || '')
  const [phone, setPhone]   = useState(() => localStorage.getItem('envo_requester_phone') || '')
  // Funding schemes come from the server (GET /api/schemes), not a constant here, so
  // adding a fund is a database insert. No default is pre-selected on purpose: which
  // fund an order is raised against decides who pays, and quietly defaulting to the DRF
  // would hand a facility a debt nobody chose.
  const [schemes, setSchemes] = useState([])
  const [scheme, setScheme]   = useState('')
  const [requests, setRequests] = useState([])
  const [histView, setHistView] = useState('active')  // 'active' (pending) | 'history'
  const [busy, setBusy]     = useState(false)
  const [msg, setMsg]       = useState(null)        // { type:'ok'|'err', text }

  useEffect(() => { loadRequests() }, [])
  async function loadRequests() {
    try { setRequests(await api.warehouseRequests.list() || []) } catch { /* ignore */ }
  }

  useEffect(() => { api.schemes.list().then(r => setSchemes(r || [])).catch(() => {}) }, [])
  // key -> label/flags, so a row can render "BHCPF" rather than "bhcpf" and can say
  // whether the fund bills the facility without hardcoding which one does.
  const schemeById = useMemo(() => Object.fromEntries((schemes || []).map(x => [x.key, x])), [schemes])
  const schemeLabel = (k) => schemeById[k]?.label || k || '—'

  const grandTotal = lines.reduce((s, l) => s + l.unit_price * l.quantity, 0)

  // Pending = still in flight; History = closed (received / cancelled).
  const ACTIVE_STATES = ['pending', 'submitted', 'picking', 'dispatched']
  const shownRequests = requests.filter(r =>
    histView === 'active' ? ACTIVE_STATES.includes(r.status) : ['received', 'cancelled'].includes(r.status))

  function downloadRequestsCsv() {
    const head = ['Date', 'Status', 'Scheme', 'Line items', 'Units', 'Total (NGN)', 'WMS ref']
    const rows = shownRequests.map(r => [
      new Date(r.requested_at).toISOString().slice(0, 10), r.status, schemeLabel(r.scheme),
      r.line_count, r.total_quantity, r.total_amount, r.wms_request_id ?? '',
    ])
    const csv = [head, ...rows].map(row => row.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    a.download = `warehouse-requests-${histView}-${new Date().toISOString().slice(0, 10)}.csv`
    a.click(); URL.revokeObjectURL(a.href)
  }

  function addLine() {
    const c = priced.find(x => x.id === pickId)
    const q = parseInt(qty)
    const cost = Number(unitCost)
    if (!c || !(q > 0) || !(cost >= 0)) return
    setLines(prev => {
      const existing = prev.find(l => l.commodity_id === c.id)
      if (existing) return prev.map(l => l.commodity_id === c.id ? { ...l, quantity: l.quantity + q, unit_price: cost } : l)
      return [...prev, { commodity_id: c.id, name: c.name, unit_price: cost, quantity: q }]
    })
    setPickId(''); setQty(''); setUnitCost('')
  }
  const removeLine = (id) => setLines(prev => prev.filter(l => l.commodity_id !== id))

  async function submit() {
    if (!lines.length) return
    setBusy(true); setMsg(null)
    try {
      // offlineWarehouseRequest is a no-op passthrough outside the Essential module
      // (see lib/offlineWrite.js). Queuing only covers the device-to-EnVo leg —
      // reaching the actual warehouse still depends on EnVo's own already-durable
      // outbox to WMS, unchanged.
      const created = await offlineWarehouseRequest({
        items: lines.map(l => ({ commodity_id: l.commodity_id, quantity: l.quantity, unit_price: l.unit_price })),
        requestedBy: name.trim(),
        requesterPhone: phone.trim(),
        scheme,
        notes: notes || undefined,
      })
      localStorage.setItem('envo_requester_name', name.trim())
      localStorage.setItem('envo_requester_phone', phone.trim())
      setLines([]); setNotes('')
      if (created?.queued) {
        setMsg({ type: 'ok', text: 'Saved on this device. No connection right now — it will be sent to the warehouse as soon as you\'re back online.' })
      } else {
        setMsg({ type: 'ok', text: created?.status === 'submitted'
          ? `Request sent to the warehouse (${naira(created.total_amount)}).`
          : `Request saved (${naira(created?.total_amount)}). Awaiting the warehouse — you can resubmit if it stays pending.` })
      }
      loadRequests()
    } catch (e) {
      setMsg({ type: 'err', text: e.message || 'Could not submit the request.' })
    } finally { setBusy(false) }
  }

  async function act(id, fn) {
    setBusy(true); setMsg(null)
    try { await fn(id); loadRequests() }
    catch (e) { setMsg({ type: 'err', text: e.message }) }
    finally { setBusy(false) }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-100">Request from Warehouse</h1>
        <p className="text-sm text-gray-500 mt-1">Build a priced order and send it to the central medical store.</p>
      </div>

      {msg && (
        <div className={`rounded-lg px-3 py-2.5 text-sm border ${msg.type === 'ok'
          ? 'bg-green-500/10 border-green-500/30 text-green-400'
          : 'bg-red-500/10 border-red-500/30 text-red-400'}`}>{msg.text}</div>
      )}

      {/* Builder */}
      {canManage ? (
        <div className="bg-gray-900 border border-white/10 rounded-xl p-4 space-y-4">
          <div className="flex flex-wrap gap-2 items-end">
            <div className="w-full sm:w-56">
              <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Category</label>
              <select value={catFilter} onChange={e => { setCatFilter(e.target.value); setPickId('') }}
                className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500">
                <option value="">All categories</option>
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="flex-1 min-w-[220px]">
              <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Commodity</label>
              <CommoditySelect commodities={pickable} value={pickId} onChange={setPickId}
                placeholder={`Search commodities… (${pickable.length})`}
                className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
            </div>
            <div className="w-32">
              <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Cost / unit (₦)</label>
              <input type="number" min="0" step="0.01" value={unitCost} onChange={e => setUnitCost(e.target.value)}
                disabled={!pickId} placeholder="0.00"
                onKeyDown={e => e.key === 'Enter' && addLine()}
                className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2.5 text-sm text-gray-100 disabled:opacity-40 focus:outline-none focus:border-blue-500" />
            </div>
            <div className="w-24">
              <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Qty</label>
              <input type="number" min="1" value={qty} onChange={e => setQty(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addLine()}
                className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
            </div>
            <button onClick={addLine} disabled={!pickId || !(parseInt(qty) > 0) || !(Number(unitCost) >= 0)}
              className="bg-white/10 hover:bg-white/15 disabled:opacity-40 text-gray-100 text-sm font-medium rounded-lg px-4 py-2.5">Add</button>
          </div>

          {lines.length > 0 && (
            <div className="border border-white/10 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-white/5 text-gray-400 text-xs uppercase tracking-wider">
                  <tr><th className="text-left px-3 py-2">Commodity</th><th className="text-right px-3 py-2">Unit price</th>
                    <th className="text-right px-3 py-2">Qty</th><th className="text-right px-3 py-2">Line total</th><th className="w-10"></th></tr>
                </thead>
                <tbody>
                  {lines.map(l => (
                    <tr key={l.commodity_id} className="border-t border-white/8 text-gray-200">
                      <td className="px-3 py-2">{l.name}</td>
                      <td className="px-3 py-2 text-right">{naira(l.unit_price)}</td>
                      <td className="px-3 py-2 text-right">{l.quantity}</td>
                      <td className="px-3 py-2 text-right">{naira(l.unit_price * l.quantity)}</td>
                      <td className="px-3 py-2 text-right">
                        <button onClick={() => removeLine(l.commodity_id)} className="text-gray-500 hover:text-red-400">✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-white/12 bg-white/5 font-semibold text-gray-100">
                    <td className="px-3 py-2" colSpan={3}>Total</td>
                    <td className="px-3 py-2 text-right">{naira(grandTotal)}</td><td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          <div className="flex flex-wrap gap-2 items-end justify-between">
            <div className="w-full sm:w-56">
              <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Scheme *</label>
              <select value={scheme} onChange={e => setScheme(e.target.value)}
                className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500">
                <option value="">Select scheme…</option>
                {schemes.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
              {/* creates_debt comes from the scheme row, so the client never hardcodes
                  which fund bills the facility. */}
              {schemes.find(x => x.key === scheme)?.creates_debt && (
                <p className="text-[11px] text-amber-400 mt-1">This order will be billed to the facility.</p>
              )}
            </div>
            <div className="w-full sm:w-52">
              <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Requested by *</label>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="Full name"
                className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2.5 text-sm text-gray-100 placeholder:text-gray-600 focus:outline-none focus:border-blue-500" />
            </div>
            <div className="w-full sm:w-52">
              <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Contact phone *</label>
              <input value={phone} onChange={e => setPhone(e.target.value)} inputMode="tel" placeholder="08031234567" maxLength={14}
                className={`w-full bg-white/5 border rounded-lg px-3 py-2.5 text-sm text-gray-100 placeholder:text-gray-600 focus:outline-none ${phone && !validNgPhone(phone) ? 'border-red-500/60 focus:border-red-500' : 'border-white/15 focus:border-blue-500'}`} />
            </div>
            <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes (optional)"
              className="flex-1 min-w-[220px] bg-white/5 border border-white/15 rounded-lg px-3 py-2.5 text-sm text-gray-100 placeholder:text-gray-600 focus:outline-none focus:border-blue-500" />
            <button onClick={submit} disabled={busy || !lines.length || !scheme || !name.trim() || !validNgPhone(phone)}
              className="bg-blue-500 hover:bg-blue-400 disabled:opacity-40 text-white text-sm font-semibold rounded-lg px-5 py-2.5">
              {busy ? 'Sending…' : `Send request${lines.length ? ' · ' + naira(grandTotal) : ''}`}
            </button>
          </div>
          {phone && !validNgPhone(phone) && (
            <p className="text-xs text-red-400">Enter a valid Nigerian phone number — 11 digits starting with 0 (e.g. 08031234567).</p>
          )}
          {lines.length > 0 && (!scheme || !name.trim() || !phone.trim()) && (
            <p className="text-xs text-gray-500">
              A requester name and contact phone are required — the warehouse uses them to confirm anything unclear on the order.
            </p>
          )}
        </div>
      ) : (
        <div className="text-sm text-gray-500 bg-gray-900 border border-white/10 rounded-xl p-4">
          Only the facility store manager can raise a warehouse request.
        </div>
      )}

      {/* Pending / History */}
      <div>
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <div className="inline-flex rounded-lg border border-white/10 overflow-hidden">
            {[['active', 'Pending'], ['history', 'History']].map(([id, label]) => (
              <button key={id} onClick={() => setHistView(id)}
                className={`px-3 py-1.5 text-xs font-medium ${histView === id ? 'bg-white/10 text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}>
                {label}
              </button>
            ))}
          </div>
          <button onClick={downloadRequestsCsv} disabled={!shownRequests.length}
            className="ml-auto text-xs px-3 py-1.5 rounded-lg border border-white/10 text-gray-300 hover:bg-white/8 disabled:opacity-40">
            Download CSV
          </button>
        </div>
        {shownRequests.length === 0 ? (
          <div className="text-sm text-gray-500">{histView === 'active' ? 'No pending requests.' : 'No completed requests.'}</div>
        ) : (
          <div className="space-y-2">
            {shownRequests.map(r => (
              <div key={r.id} className="bg-gray-900 border border-white/10 rounded-lg px-4 py-3 flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-3">
                <span className={`text-xs font-medium px-2 py-0.5 rounded ${STATUS_STYLE[r.status] || 'bg-white/10 text-gray-300'}`}>{r.status}</span>
                {/* The fund actually issued against once dispatched, else the one asked for. */}
                {/* A border, not just a tint: every bg-white/* is remapped to solid white
                    in light mode, so a tint-only chip would dissolve into the card. */}
                <span className="text-xs px-2 py-0.5 rounded border border-white/10 bg-white/8 text-gray-300">
                  {schemeLabel(r.scheme)}
                </span>
                <span className="text-sm text-gray-200">{r.line_count} item{r.line_count === 1 ? '' : 's'} · {r.total_quantity} unit{r.total_quantity === 1 ? '' : 's'}</span>
                <span className="text-sm text-gray-400">{naira(r.total_amount)}</span>
                <span className="text-xs text-gray-600">{new Date(r.requested_at).toLocaleDateString()}</span>
                <div className="ml-auto flex gap-2">
                  {r.status === 'pending' && canManage && (
                    <button onClick={() => act(r.id, api.warehouseRequests.resubmit)} className="text-xs px-2.5 py-1 rounded bg-white/10 hover:bg-white/15 text-gray-200">Resubmit</button>)}
                  {(r.status === 'pending' || r.status === 'submitted') && canManage && (
                    <button onClick={() => act(r.id, api.warehouseRequests.cancel)} className="text-xs px-2.5 py-1 rounded bg-white/10 hover:bg-red-500/20 text-gray-300">Cancel</button>)}
                  {r.status === 'dispatched' && canManage && (
                    <button onClick={() => act(r.id, api.warehouseRequests.receive)} className="text-xs px-2.5 py-1 rounded bg-green-500/15 hover:bg-green-500/25 text-green-400">Confirm receipt</button>)}
                </div>
                </div>

              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
