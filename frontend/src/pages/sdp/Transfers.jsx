import { useState, useEffect, useRef } from 'react'
import { api } from '../../lib/api'
import { subscribeRealtime } from '../../lib/realtime'
import { useAppStore } from '../../store/appStore'
import { toast } from '../../components/ui/Toast'
import { Card, CardHeader, CardTitle, CardBody } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { CommoditySelect } from '../../components/ui/CommoditySelect'
import { LoadingState, EmptyState } from '../../components/ui/Loading'
import { fmtDate, rowForSite } from '../../utils/helpers'
import { TransferLotInfo, hasExpiredLot, earliestExpiredExpiry } from '../../components/TransferLotInfo'

function SubTab({ id, current, onChange, label, badge = 0 }) {
  return (
    <button onClick={() => onChange(id)}
      className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
        current === id
          ? 'border-blue-500 text-blue-400'
          : 'border-transparent text-gray-400 hover:text-gray-300'
      }`}>
      {label} {badge > 0 && <span className="ml-1.5 text-xs bg-red-500 text-white rounded-full px-1.5">{badge}</span>}
    </button>
  )
}

function BackButton({ onClick }) {
  return (
    <button onClick={onClick}
      className="text-sm text-gray-400 hover:text-gray-200 mb-4 flex items-center gap-1">
      ← Back
    </button>
  )
}

export function Transfers() {
  const currentFacility  = useAppStore(s => s.currentFacility)
  const allCommodities   = useAppStore(s => s.allCommodities)
  const allFacilities    = useAppStore(s => s.allFacilities)
  const accessLevel      = useAppStore(s => s.accessLevel)
  const facilityRole     = useAppStore(s => s.facilityRole)
  const sdpName          = useAppStore(s => s.sdpName)

  const canManage = ['overall_admin','state_admin','lga_admin'].includes(accessLevel) || (accessLevel === 'facility' && facilityRole === 'store_manager')

  const fid = currentFacility?.id

  // Keep ref so realtime callback always sees the latest fid
  const fidRef = useRef(null)
  useEffect(() => { fidRef.current = fid }, [fid])

  const [primary, setPrimary] = useState(null)
  const [reqSub, setReqSub] = useState('form')
  const [pending, setPending] = useState([])
  const [loadingP, setLoadingP] = useState(true)
  const [requestHistory, setRequestHistory] = useState([])
  const [loadingReqHist, setLoadingReqHist] = useState(false)

  const [requestLines, setRequestLines] = useState([{ id: Date.now(), commodity_id: '', stock_balance: 0, stock_required: 1 }])
  const [sentBy, setSentBy] = useState('')
  const [reqNotes, setReqNotes] = useState('')
  const [reqSending, setReqSending] = useState(false)
  const [reqMsg, setReqMsg] = useState(null)

  const [dispatched, setDispatched] = useState([])
  const [loadingDispatched, setLoadingDispatched] = useState(false)
  const [confirmingId, setConfirmingId] = useState(null)
  const [receivedBy, setReceivedBy] = useState('')
  const [confirming, setConfirming] = useState(false)

  const [reqHistFrom, setReqHistFrom] = useState(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10)
  })
  const [reqHistTo, setReqHistTo] = useState(() => new Date().toISOString().slice(0, 10))

  useEffect(() => {
    if (!fid) return
    loadPending(fid)
    loadDispatched(fid)
    loadRequestHistory(fid, reqHistFrom, reqHistTo)

    const unsub = subscribeRealtime(['stock_transfer_log'], (payload) => {
      loadPendingSilent(fidRef.current)
      loadDispatchedSilent(fidRef.current)
      if (payload.new?.status === 'dispatched') {
        setPrimary('request')
        setReqSub('pending')
        toast('Stock dispatched by store manager — confirm receipt below', 'green')
      }
    })

    // Poll every 10s as a fallback in case the SSE stream drops.
    const poll = setInterval(() => {
      loadPendingSilent(fidRef.current)
      loadDispatchedSilent(fidRef.current)
    }, 10000)

    return () => { unsub(); clearInterval(poll) }
  }, [fid])

  async function loadPending(facilityId) {
    if (!facilityId) return
    setLoadingP(true)
    const data = await api.transfers.list({ facility_id: facilityId, direction: 'outgoing', status: 'pending_approval' }).catch(() => [])
    setPending((data || []).filter(r => rowForSite(r, 'SDP', sdpName)))
    setLoadingP(false)
  }

  async function loadPendingSilent(facilityId) {
    if (!facilityId) return
    const data = await api.transfers.list({ facility_id: facilityId, direction: 'outgoing', status: 'pending_approval' }).catch(() => [])
    setPending((data || []).filter(r => rowForSite(r, 'SDP', sdpName)))
  }

  async function loadDispatched(facilityId) {
    if (!facilityId) return
    setLoadingDispatched(true)
    const data = await api.transfers.list({ facility_id: facilityId, direction: 'outgoing', status: 'dispatched' }).catch(() => [])
    setDispatched((data || []).filter(r => rowForSite(r, 'SDP', sdpName)))
    setLoadingDispatched(false)
  }

  async function loadDispatchedSilent(facilityId) {
    if (!facilityId) return
    const data = await api.transfers.list({ facility_id: facilityId, direction: 'outgoing', status: 'dispatched' }).catch(() => [])
    setDispatched((data || []).filter(r => rowForSite(r, 'SDP', sdpName)))
  }

  async function confirmReceipt(record) {
    if (!receivedBy.trim()) { toast('Received by is required', 'red'); return }
    setConfirming(true)
    // Server credits the SDP site stock (site parsed from notes) and marks accepted.
    try {
      await api.transfers.receive(record.id, { received_by: receivedBy.trim() })
    } catch (e) { toast('Error confirming receipt: ' + e.message, 'red'); setConfirming(false); return }
    toast('Receipt confirmed — stock updated', 'green')
    setConfirmingId(null); setReceivedBy('')
    await loadDispatched(fid); loadRequestHistory(fid, reqHistFrom, reqHistTo); setConfirming(false)
  }

  async function disputeReceipt(record) {
    // A dispute can be partial: keep what actually arrived, send the rest back.
    // dispatchedQty, not `dispatched` - that would shadow the component state array.
    const dispatchedQty = record.quantity || 0
    const input = window.prompt(
      `Dispute this transfer.\n\nDispatched: ${dispatchedQty}\nHow many did you actually accept? The rest goes back to the store.`, '0')
    if (input === null) return                        // cancelled
    const accepted = parseInt(input)
    if (isNaN(accepted) || accepted < 0 || accepted > dispatchedQty) {
      toast(`Qty accepted must be between 0 and ${dispatchedQty}`, 'red'); return
    }
    const reason = window.prompt('Reason for the dispute\n(e.g. quantity short, wrong item, damaged/expired):', '')
    if (reason === null) return
    const note = reason.trim()
    if (!note) { toast('Please enter a reason for the dispute', 'red'); return }
    // One transactional call: the server credits the accepted quantity to this
    // site, returns the rest to the parent facility's store and marks the
    // transfer disputed. Don't touch stock here too, or it would be added twice.
    // Record a person, never a login e-mail: this name is what shows against
    // the dispute and, for any accepted portion, on the printed transfer form.
    const u = useAppStore.getState().user
    let byName = (u?.user_metadata?.full_name || u?.user_metadata?.name || '').trim()
    if (!byName) {
      const typed = window.prompt('Your full name (recorded against this dispute):', '')
      if (typed === null) return
      byName = typed.trim()
      if (!byName) { toast('Please enter your name', 'red'); return }
    }
    try {
      await api.transfers.dispute(record.id, {
        disputed_by: byName,
        received_by: byName,
        facilityId: fid,
        dispute_note: note,
        qty_accepted: accepted,
      })
    } catch (err) { toast('Error disputing transfer: ' + err.message, 'red'); return }
    toast(accepted > 0
      ? `Disputed — ${accepted} accepted, ${dispatchedQty - accepted} returned to the store`
      : 'Transfer disputed — stock returned to the store', 'amber')
    await loadDispatched(fid)
  }

  async function cancelRequest(record) {
    if (!window.confirm('Cancel this request? This action cannot be undone.')) return
    await api.transfers.cancel(record.id, {}).catch(() => {})
    toast('Request cancelled', 'amber')
    await loadPending(fid)
  }

  async function loadRequestHistory(facilityId, from, to) {
    if (!facilityId) return
    setLoadingReqHist(true)
    const data = await api.transfers.list({
      facility_id: facilityId, direction: 'outgoing', status: 'accepted',
      date_field: 'initiated_at', from, to,
    }).catch(() => [])
    setRequestHistory((data || []).filter(r => rowForSite(r, 'SDP', sdpName)))
    setLoadingReqHist(false)
  }

  function addRequestLine() {
    setRequestLines(prev => [...prev, { id: Date.now() + Math.random(), commodity_id: '', stock_balance: 0, stock_required: 1 }])
  }

  function removeRequestLine(id) {
    setRequestLines(prev => prev.filter(l => l.id !== id))
  }

  async function updateRequestLine(id, field, value) {
    if (field === 'commodity_id') {
      if (!sdpName) return
      const sdpRows = await api.stock.sdp.list({ facility_id: fid, sdp_name: sdpName, commodity_id: value }).catch(() => [])
      const sdpStk = sdpRows && sdpRows[0]
      setRequestLines(prev => prev.map(l => {
        if (l.id !== id) return l
        return { ...l, [field]: value, stock_balance: sdpStk?.quantity || 0 }
      }))
    } else {
      setRequestLines(prev => prev.map(l => l.id === id ? { ...l, [field]: value } : l))
    }
  }

  async function submitRequest(e) {
    e?.preventDefault()
    setReqMsg(null)
    if (!sentBy.trim()) { setReqMsg({ type: 'error', text: 'Sent by is required.' }); return }
    const lines = requestLines.filter(l => l.commodity_id && l.stock_required > 0)
    if (!lines.length) { setReqMsg({ type: 'error', text: 'Add at least one commodity with stock required.' }); return }

    setReqSending(true)
    const payload = lines.map(l => {
      const comm = allCommodities.find(c => c.id === l.commodity_id)
      return {
        sending_facility_id: fid,
        sending_facility_name: currentFacility?.name || '',
        receiving_facility_id: null,
        receiving_facility_name: sdpName,
        commodity_id: l.commodity_id,
        commodity_name: comm?.name || '',
        quantity: parseInt(l.stock_required),
        qty_requested: parseInt(l.stock_required),
        status: 'pending_approval',
        section: 'lab',
        initiated_by: sentBy,
        initiated_at: new Date().toISOString(),
        notes: `[SDP: ${sdpName}] balance:${l.stock_balance} required:${l.stock_required}${reqNotes ? ' ' + reqNotes : ''}`,
      }
    })
    try {
      await api.transfers.create(payload)
    } catch (error) { setReqMsg({ type: 'error', text: 'Error: ' + error.message }); setReqSending(false); return }
    toast('Request submitted', 'green')
    setRequestLines([{ id: Date.now(), commodity_id: '', stock_balance: 0, stock_required: 1 }])
    setSentBy(''); setReqNotes('')
    await loadPending(fid)
    setReqSending(false)
    setReqSub('pending')
    setPrimary('request')
  }

  function printSlip(t) {
    const printDate = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
    const receivedByMatch = t.resolved_by?.match(/\[Received by: ([^\]]+)\]/)
    const html = `<style>body{font-family:Arial,sans-serif;font-size:11pt;color:#000;margin:0}h2{margin:0 0 2px;font-size:14pt}.sub{font-size:9pt;color:#666;margin-bottom:16px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px;margin-bottom:16px}.field label{font-size:7.5pt;text-transform:uppercase;letter-spacing:.07em;color:#888;display:block;margin-bottom:2px}.field span{font-size:11pt;font-weight:600}.full{grid-column:1/-1}hr{border:none;border-top:1px solid #ccc;margin:16px 0}.sig{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:32px}.sig div{border-top:1px solid #000;padding-top:4px;font-size:8pt;color:#555}</style>
      <h2>Redistribution Request Slip</h2><div class="sub">SDP Request &nbsp;·&nbsp; Printed ${printDate}</div><hr/>
      <div class="grid">
        <div class="field"><label>Commodity</label><span>${t.commodity_name || '—'}</span></div>
        <div class="field"><label>Quantity</label><span>${t.quantity}</span></div>
        <div class="field"><label>From</label><span>${t.sending_facility_name || '—'}</span></div>
        <div class="field"><label>To</label><span>${sdpName || '—'}</span></div>
        <div class="field"><label>Date initiated</label><span>${fmtDate(t.initiated_at) || '—'}</span></div>
        <div class="field"><label>Date received</label><span>${fmtDate(t.resolved_at) || '—'}</span></div>
        <div class="field"><label>Recorded by</label><span>${t.initiated_by || '—'}</span></div>
        <div class="field"><label>Received by</label><span>${receivedByMatch?.[1] || '—'}</span></div>
      </div><hr/>
      <div class="sig"><div>Sender signature &amp; stamp</div><div>Receiver signature &amp; stamp</div></div>`
    const blob = new Blob([`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Redistribution Request Slip</title></head><body style="margin:20mm">${html}</body></html>`], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    const win = window.open(url, '_blank')
    if (win) { win.onload = () => { win.focus(); win.print(); URL.revokeObjectURL(url); win.onafterprint = () => win.close() } }
    else { URL.revokeObjectURL(url); toast('Allow pop-ups to print', 'red') }
  }


  const categories = {}
  allCommodities.forEach(c => {
    if (!categories[c.category]) categories[c.category] = []
    categories[c.category].push(c)
  })

  const incomingCount = pending.length + dispatched.length
  const incomingPendingCount = pending.length + dispatched.length


  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-medium text-gray-100">Redistribution & Emergency Order</h1>
        <p className="text-sm text-gray-500 mt-1">Request and receive commodities from the store.</p>
      </div>

      {primary === null && dispatched.length > 0 && (
        <button
          onClick={() => { setPrimary('request'); setReqSub('pending') }}
          className="w-full mb-4 flex items-center gap-3 px-4 py-3 bg-green-500/10 border border-green-500/30 rounded-xl text-left hover:bg-green-500/15 transition-colors"
        >
          <span className="text-green-400 text-lg">📦</span>
          <div>
            <div className="text-sm font-semibold text-green-300">
              {dispatched.length} item{dispatched.length > 1 ? 's' : ''} dispatched by store manager — confirm receipt
            </div>
            <div className="text-xs text-green-600 mt-0.5">Click to confirm →</div>
          </div>
        </button>
      )}

      {primary === null && (
        <div className="grid grid-cols-1 gap-4">
          <button onClick={() => setPrimary('request')}
            className="text-left p-5 rounded-xl border border-white/10 bg-white/3 hover:bg-white/6 hover:border-white/20 transition-all">
            <div className="flex items-center justify-between mb-2">
              <span className="font-medium text-gray-100">Request</span>
              {incomingCount > 0 && <span className="bg-red-500 text-white text-xs font-bold rounded-full px-1.5 py-0.5 min-w-[1.2rem] text-center">{incomingCount}</span>}
            </div>
            <p className="text-xs text-gray-500">Submit and track redistribution requests</p>
          </button>
        </div>
      )}

      {primary === 'request' && (
        <>
          <BackButton onClick={() => setPrimary(null)} />
          {dispatched.length > 0 && reqSub !== 'pending' && (
            <button
              onClick={() => setReqSub('pending')}
              className="w-full mb-4 flex items-center gap-3 px-4 py-3 bg-green-500/10 border border-green-500/30 rounded-xl text-left hover:bg-green-500/15 transition-colors"
            >
              <span className="text-green-400 text-lg">📦</span>
              <div>
                <div className="text-sm font-semibold text-green-300">
                  {dispatched.length} item{dispatched.length > 1 ? 's' : ''} dispatched by store manager — confirm receipt
                </div>
                <div className="text-xs text-green-600 mt-0.5">Click to confirm →</div>
              </div>
            </button>
          )}
          <div className="flex gap-1.5 mb-4 flex-wrap border-b border-white/8 pb-3">
            <SubTab id="form"     current={reqSub} onChange={setReqSub} label="Request for redistribution" />
            <SubTab id="pending"  current={reqSub} onChange={setReqSub} label="Pending" badge={incomingPendingCount} />
            <SubTab id="history"  current={reqSub} onChange={setReqSub} label="Request history" />
          </div>

          {reqSub === 'pending' && (
            <>
              {dispatched.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>Dispatched — confirm receipt</CardTitle>
                    <button onClick={() => loadDispatched(fid)} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">Refresh</button>
                  </CardHeader>
                  {loadingDispatched ? <LoadingState /> : dispatched.map(t => (
                    <div key={t.id} className="px-5 py-4 border-b border-white/8 last:border-0">
                      <div className="flex items-start justify-between gap-4 flex-wrap">
                        <div className="flex-1">
                          <div className="font-medium text-gray-100 mb-1">{t.commodity_name}</div>
                          <div className="text-sm text-gray-400">
                            <span className="font-medium text-gray-200">{t.quantity}</span> dispatched by store manager
                          </div>
                          <div className="text-xs text-gray-600 mt-1">Submitted {fmtDate(t.initiated_at)} by {t.initiated_by || '—'}</div>
                          <TransferLotInfo record={t} />
                        </div>
                        <div className="flex gap-2 flex-wrap">
                          {confirmingId === t.id ? (
                            <div className="flex flex-col gap-2">
                              <div>
                                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Received by *</label>
                                <input type="text" value={receivedBy} onChange={e => setReceivedBy(e.target.value)} placeholder="Your name"
                                  className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500 w-52" />
                              </div>
                              <div className="flex gap-2">
                                <Button variant="success" size="sm" onClick={() => confirmReceipt(t)} disabled={confirming}>{confirming ? 'Confirming…' : 'Confirm receipt'}</Button>
                                <Button variant="ghost" size="sm" onClick={() => { setConfirmingId(null); setReceivedBy('') }}>Cancel</Button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <Button variant="success" size="sm" onClick={() => { setConfirmingId(t.id); setReceivedBy('') }}>Confirm receipt</Button>
                              <Button variant="danger" size="sm" onClick={() => disputeReceipt(t)}>Dispute</Button>
                            </>
                          )}
                        </div>
                      </div>
                      {confirmingId === t.id && hasExpiredLot(t) && (
                        <div className="mt-3 text-xs text-red-300 bg-red-500/10 border border-red-500/25 rounded-lg px-3 py-2">
                          ⚠ This delivery includes <strong>expired</strong> stock (expiry {fmtDate(earliestExpiredExpiry(t))}). Confirming receipt will bring expired stock into your site — dispute it instead unless you have a reason to keep it.
                        </div>
                      )}
                    </div>
                  ))}
                </Card>
              )}
              <Card>
                <CardHeader>
                  <CardTitle>Pending transfers — awaiting approval</CardTitle>
                  <button onClick={() => loadPending(fid)} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">Refresh</button>
                </CardHeader>
                {loadingP ? <LoadingState /> : pending.length === 0 ? <EmptyState message="No pending transfers" /> : (
                  pending.map(t => (
                    <div key={t.id} className="px-5 py-4 border-b border-white/8 last:border-0">
                      <div className="flex items-start justify-between gap-4 flex-wrap">
                        <div className="flex-1">
                          <div className="font-medium text-gray-100 mb-1">{t.commodity_name}</div>
                          <div className="text-sm text-gray-400">
                            <span className="font-medium text-gray-200">{t.quantity}</span> requested
                          </div>
                          <div className="text-xs text-gray-600 mt-1">Submitted {fmtDate(t.initiated_at)} by {t.initiated_by || '—'}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-full px-2 py-0.5">
                            ⏳ Awaiting store manager approval
                          </span>
                          <button onClick={() => cancelRequest(t)} className="text-xs text-red-400 hover:text-red-300 border border-red-500/30 rounded px-2 py-1 hover:bg-red-500/10 transition-colors">
                            Cancel
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </Card>
            </>
          )}

          {reqSub === 'history' && (
            <Card>
              <CardHeader>
                <CardTitle>Request history</CardTitle>
                <div className="flex items-center gap-2 flex-wrap">
                  <input type="date" value={reqHistFrom} onChange={e => setReqHistFrom(e.target.value)}
                    className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500" />
                  <span className="text-xs text-gray-600">to</span>
                  <input type="date" value={reqHistTo} onChange={e => setReqHistTo(e.target.value)}
                    className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500" />
                  <button onClick={() => loadRequestHistory(fid, reqHistFrom, reqHistTo)} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">Refresh</button>
                </div>
              </CardHeader>
              {loadingReqHist ? <LoadingState /> : requestHistory.length === 0 ? <EmptyState message="No history" /> : (
                <div className="table-wrap"><table className="w-full text-sm">
                  <thead><tr className="border-b border-white/8 bg-white/2">
                    {['Date', 'Commodity', 'Qty', 'Status', ''].map(h => (
                      <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>{requestHistory.map(r => (
                    <tr key={r.id} className="border-b border-white/5 hover:bg-white/2">
                      <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDate(r.initiated_at)}</td>
                      <td className="px-4 py-3 font-medium text-gray-100">{r.commodity_name}</td>
                      <td className="px-4 py-3 font-mono text-sm text-gray-300">{r.quantity}</td>
                      <td className="px-4 py-3 text-xs font-semibold text-green-400">Received</td>
                      <td className="px-4 py-3">
                        <button onClick={() => printSlip(r)} className="text-xs text-gray-500 hover:text-gray-200 border border-white/10 rounded px-2 py-1 flex items-center gap-1">
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3"><path d="M4 5V2h8v3M4 11H2V6h12v5h-2M4 9h8v5H4z"/></svg>
                          Print
                        </button>
                      </td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
            </Card>
          )}

          {reqSub === 'form' && (
            <Card>
              <CardHeader><CardTitle>Request for redistribution</CardTitle></CardHeader>
              <CardBody>
                <form onSubmit={submitRequest} className="space-y-4">
                  <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-4 py-3 text-sm text-blue-300 mb-4">
                    Requesting stock from <strong className="text-blue-100">{currentFacility?.name || 'Store'}</strong> — submit for store manager approval.
                  </div>
                  <div className="space-y-3">
                    {requestLines.map((line, idx) => (
                      <div key={line.id} className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end p-3 bg-white/3 rounded-lg border border-white/8">
                        <div className="col-span-2 sm:col-span-2">
                          <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Commodity *</label>
                          <CommoditySelect categories={categories} value={line.commodity_id} onChange={id => updateRequestLine(line.id, 'commodity_id', id)} />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Stock balance</label>
                          <input type="number" value={line.stock_balance} readOnly className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 opacity-60 cursor-not-allowed" />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Stock required *</label>
                          <input type="number" min="1" value={line.stock_required} onChange={e => updateRequestLine(line.id, 'stock_required', e.target.value)} required
                            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
                        </div>
                        <div className="col-span-2 sm:col-span-4 flex gap-2 justify-end">
                          {requestLines.length > 1 && <button type="button" onClick={() => removeRequestLine(line.id)} className="text-xs text-red-400 hover:text-red-300">Remove line</button>}
                          {idx === requestLines.length - 1 && <button type="button" onClick={addRequestLine} className="text-xs text-blue-400 hover:text-blue-300">+ Add commodity</button>}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Sent by *</label>
                    <input type="text" value={sentBy} onChange={e => setSentBy(e.target.value)} placeholder="Staff name or ID" required
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Notes (optional)</label>
                    <input type="text" value={reqNotes} onChange={e => setReqNotes(e.target.value)} placeholder="Additional details"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
                  </div>
                  {reqMsg && (
                    <div className={`rounded-lg px-4 py-3 text-sm ${reqMsg.type === 'error' ? 'bg-red-500/10 border border-red-500/20 text-red-400' : 'bg-green-500/10 border border-green-500/20 text-green-400'}`}>
                      {reqMsg.text}
                    </div>
                  )}
                  <Button type="submit" variant="success" size="lg" disabled={reqSending} className="w-full">
                    {reqSending ? 'Submitting…' : 'Submit request'}
                  </Button>
                </form>
              </CardBody>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
