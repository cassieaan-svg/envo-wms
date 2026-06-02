import { useState, useEffect, useRef } from 'react'
import { sb } from '../../lib/supabase'
import { useAppStore } from '../../store/appStore'
import { useStock } from '../../hooks/useStock'
import { toast } from '../../components/ui/Toast'
import { Card, CardHeader, CardTitle, CardBody } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { LoadingState, EmptyState } from '../../components/ui/Loading'
import { fmtDate, SECTION_CATEGORIES } from '../../utils/helpers'

const inputCls = "w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"

function MultiCommodityLines({ lines, updateLine, addLine, removeLine, categories, label = 'commodity' }) {
  return (
    <div className="space-y-3">
      {lines.map((line, idx) => (
        <div key={line.id} className="grid grid-cols-2 sm:grid-cols-5 gap-3 items-end p-3 bg-white/3 rounded-lg border border-white/8">
          <div className="col-span-2 sm:col-span-2">
            <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Commodity *</label>
            <select value={line.commodity_id} onChange={e => updateLine(line.id, 'commodity_id', e.target.value)?.catch?.()} required className={inputCls}>
              <option value="">Select commodity…</option>
              {Object.entries(categories).sort().map(([cat, comms]) => (
                <optgroup key={cat} label={cat}>{comms.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Stock balance</label>
            <input type="number" value={line.stock_balance} readOnly className={`${inputCls} opacity-60 cursor-not-allowed`} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Stock required *</label>
            <input type="number" min="1" value={line.stock_required} onChange={e => updateLine(line.id, 'stock_required', e.target.value)} required className={inputCls} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Stock issued *</label>
            <input type="number" min="1" value={line.stock_issued} onChange={e => updateLine(line.id, 'stock_issued', e.target.value)} required className={inputCls} />
          </div>
          <div className="col-span-2 sm:col-span-5 flex gap-2 justify-end">
            {lines.length > 1 && <button type="button" onClick={() => removeLine(line.id)} className="text-xs text-red-400 hover:text-red-300">Remove line</button>}
            {idx === lines.length - 1 && <button type="button" onClick={addLine} className="text-xs text-blue-400 hover:text-blue-300">+ Add {label}</button>}
          </div>
        </div>
      ))}
    </div>
  )
}

export function Transfers() {
  const currentFacility  = useAppStore(s => s.currentFacility)
  const allCommodities   = useAppStore(s => s.allCommodities)
  const allFacilities    = useAppStore(s => s.allFacilities)
  const stockData        = useAppStore(s => s.stockData)
  const accessLevel      = useAppStore(s => s.accessLevel)
  const facilityRole     = useAppStore(s => s.facilityRole)
  const commoditySection = useAppStore(s => s.commoditySection)
  const setCurrentPage   = useAppStore(s => s.setCurrentPage)
  const { loadStock } = useStock()
  const canManage  = ['overall_admin','state_admin','lga_admin'].includes(accessLevel) || (accessLevel === 'facility' && facilityRole === 'store_manager')
  const isDispenser = accessLevel === 'facility' && facilityRole === 'dispenser'
  const isDSD       = accessLevel === 'facility' && facilityRole === 'dsd'
  const userDsdSiteName = useAppStore(s => s.dsdSiteName)
  const sec = q => commoditySection ? q.eq('section', commoditySection) : q
  // Non-reactive store access for callbacks (avoids full-store subscription)
  const getStore = useAppStore.getState
  // Suppress the next pending reload triggered by restoreDispatchedStock's own DB update
  const suppressNextPendingReload = useRef(false)

  // Two-level navigation: primary tab + sub-tab per group
  const [primary, setPrimary] = useState(null)
  const [reqSub, setReqSub]   = useState('pending')
  const [intSub, setIntSub]   = useState('dispensary')
  const [extSub, setExtSub]   = useState('form')

  // History date filters (default to current month)
  const _monthStart = () => new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10)
  const _today      = () => new Date().toISOString().slice(0, 10)
  const [reqHistFrom, setReqHistFrom] = useState(_monthStart)
  const [reqHistTo,   setReqHistTo]   = useState(_today)
  const [intHistFrom, setIntHistFrom] = useState(_monthStart)
  const [intHistTo,   setIntHistTo]   = useState(_today)
  const [extHistFrom, setExtHistFrom] = useState(_monthStart)
  const [extHistTo,   setExtHistTo]   = useState(_today)

  // Pending transfers
  const [pending, setPending] = useState([])
  const [loadingP, setLoadingP] = useState(true)
  const [acceptingId, setAcceptingId] = useState(null)
  const [acceptReceiverName, setAcceptReceiverName] = useState('')
  const [acceptLoading, setAcceptLoading] = useState(false)
  const [dispatchingId, setDispatchingId] = useState(null)
  const [dispatchApprovedBy, setDispatchApprovedBy] = useState('')
  const [dispatchCarrier, setDispatchCarrier] = useState('')
  const [dispatchExpiry, setDispatchExpiry] = useState('')
  const [dispatchBatch, setDispatchBatch] = useState('')
  const [dispatchQty, setDispatchQty] = useState(1)
  const [dispatchLoading, setDispatchLoading] = useState(false)

  // Admin assign & arrange state
  const [assigningId, setAssigningId]           = useState(null)
  const [assignFacState, setAssignFacState]     = useState('')
  const [assignFacLga, setAssignFacLga]         = useState('')
  const [assignFacId, setAssignFacId]           = useState('')
  const [assignApprovedBy, setAssignApprovedBy] = useState('')
  const [assignCarrier, setAssignCarrier]       = useState('')
  const [assignQty, setAssignQty]               = useState(1)
  const [assignLoading, setAssignLoading]       = useState(false)

  // External redistribution (send) form
  const [commId, setCommId] = useState('')
  const [qty, setQty] = useState(1)
  const [selectedState, setSelectedState] = useState('')
  const [selectedLga, setSelectedLga] = useState('')
  const [recFacId, setRecFacId] = useState('')
  const [notes, setNotes] = useState('')
  const [sentBy, setSentBy] = useState('')
  const [sendExpiry, setSendExpiry] = useState('')
  const [sendBatch, setSendBatch] = useState('')
  const [sendApprovedBy, setSendApprovedBy] = useState('')
  const [sendCarrier, setSendCarrier] = useState('')
  const [sending, setSending] = useState(false)
  const [msg, setMsg] = useState(null)
  const [sendHistory, setSendHistory] = useState([])
  const [loadingS, setLoadingS] = useState(false)

  // Request for redistribution (store manager only)
  const [requestLines, setRequestLines] = useState([{ id: Date.now(), commodity_id: '', requested_qty: 1, issued_qty: 0 }])
  const [reqBy, setReqBy] = useState('')
  const [reqNotes, setReqNotes] = useState('')
  const [reqSending, setReqSending] = useState(false)
  const [reqMsg, setReqMsg] = useState(null)
  const [myRequests, setMyRequests] = useState([])
  const [requestHistory, setRequestHistory] = useState([])
  const [reqSendFacId, setReqSendFacId] = useState('')
  const [reqSelectedState, setReqSelectedState] = useState('')
  const [reqSelectedLga, setReqSelectedLga] = useState('')
  const [loadingReqHist, setLoadingReqHist] = useState(false)

  // Internal redistribution (Store → Dispensary)
  const [intLines, setIntLines] = useState([{ id: Date.now(), commodity_id: '', stock_balance: 0, stock_required: 1, stock_issued: 1 }])
  const [intRequestedBy, setIntRequestedBy] = useState('')
  const [intNotes, setIntNotes] = useState('')
  const [intSending, setIntSending] = useState(false)
  const [intMsg, setIntMsg] = useState(null)
  const [intPendingApprovals, setIntPendingApprovals] = useState([])
  const [loadingIntPending, setLoadingIntPending] = useState(false)
  const [intApprovingId, setIntApprovingId] = useState(null)
  const [intApprovedBy, setIntApprovedBy] = useState('')
  const [intApproving, setIntApproving] = useState(false)
  const [intHistory, setIntHistory] = useState([])
  const [loadingI, setLoadingI] = useState(false)

  // DSD form
  const [dsdLines, setDsdLines] = useState([{ id: Date.now(), commodity_id: '', stock_balance: 0, stock_required: 1, stock_issued: 1 }])
  const [dsdType, setDsdType] = useState('')
  const [dsdSiteName, setDsdSiteName] = useState('')
  const [dsdSentBy, setDsdSentBy] = useState('')
  const [dsdNotes, setDsdNotes] = useState('')
  const [dsdSending, setDsdSending] = useState(false)
  const [dsdMsg, setDsdMsg] = useState(null)
  const [dsdPendingApprovals, setDsdPendingApprovals] = useState([])
  const [loadingDsdPending, setLoadingDsdPending] = useState(false)
  const [dsdApprovingId, setDsdApprovingId] = useState(null)
  const [dsdApprovedBy, setDsdApprovedBy] = useState('')
  const [dsdIssuedQty, setDsdIssuedQty] = useState('')
  const [dsdApproving, setDsdApproving] = useState(false)
  const [dsdHistory, setDsdHistory] = useState([])
  const [loadingD, setLoadingD] = useState(false)
  const [dsdDispatched, setDsdDispatched] = useState([])
  const [loadingDsdDispatched, setLoadingDsdDispatched] = useState(false)

  // All internal history (combined)
  const [allIntHistory, setAllIntHistory] = useState([])
  const [loadingAllInt, setLoadingAllInt] = useState(false)

  const fid = currentFacility?.id
  const myFac = currentFacility
  const stockRow = stockData.find(r => r.commodity_id === commId && r.facility_id === fid && r.location_type === 'store')
  const selectedComm = allCommodities.find(c => c.id === commId)

  const pharmacyCommodities = allCommodities.filter(c => SECTION_CATEGORIES.pharmacy.includes(c.category))
  const categories = {}
  pharmacyCommodities.forEach(c => {
    if (!categories[c.category]) categories[c.category] = []
    categories[c.category].push(c)
  })

  const facGroups = {}
  allFacilities.filter(f => f.id !== fid).forEach(f => {
    const s = f.state || 'Other', l = f.lga || 'Other'
    if (!facGroups[s]) facGroups[s] = {}
    if (!facGroups[s][l]) facGroups[s][l] = []
    facGroups[s][l].push(f)
  })
  const states = Object.keys(facGroups).sort()
  const lgas = selectedState ? Object.keys(facGroups[selectedState]).sort() : []
  const facilities = selectedState && selectedLga ? facGroups[selectedState][selectedLga].sort((a, b) => a.name.localeCompare(b.name)) : []

  const accessRestricted = !(canManage || isDispenser || isDSD)

  useEffect(() => {
    if (primary === 'internal' && isDSD) setIntSub('dsd')
  }, [primary])

  useEffect(() => {
    loadPending(true); loadMyRequests(); loadRequestHistory(); loadSendHistory()
    loadIntPendingApprovals(); loadIntHistory(); loadDsdPendingApprovals(); loadDsdDispatched(); loadDsdHistory()
    loadAllIntHistory()

    // Realtime: reload whenever any transfer row involving this facility changes.
    // Using a single unfiltered subscription and checking client-side avoids Supabase
    // replica identity issues where filtered UPDATE events may not fire cross-facility.
    const channel = sb.channel(fid ? `transfers-${fid}` : 'transfers-admin')
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'stock_transfer_log',
      }, async (payload) => {
        if (suppressNextPendingReload.current) {
          suppressNextPendingReload.current = false
        } else {
          await loadPendingSilent()
        }
        await loadMyRequests()
        loadSendHistory()
        loadRequestHistory()
        loadDsdPendingApprovals()
        loadDsdDispatched()
        loadIntPendingApprovals()

        if (fid) {
          const newRow = payload.new || {}
          if (newRow.status === 'in_transit') {
            const rowId = newRow.id || payload.old?.id
            if (rowId) {
              const { data: fullRow } = await sb.from('stock_transfer_log')
                .select('receiving_facility_id, commodity_name')
                .eq('id', rowId).maybeSingle()
              if (fullRow?.receiving_facility_id === fid && !isDSD) {
                setPrimary('request')
                setReqSub('alerts')
                toast(`${fullRow.commodity_name || 'Transfer'} dispatched to you — accept or dispute`, 'green')
              }
            }
          }
        }
      })
      .subscribe()

    return () => { sb.removeChannel(channel) }
  }, [fid])

  // ── Pending ───────────────────────────────────────────────────────────────
  async function loadPending(showSpinner = false) {
    if (showSpinner) setLoadingP(true)
    let q = sb.from('stock_transfer_log').select('*')
      .in('status', ['pending', 'in_transit', 'disputed'])
      .order('initiated_at', { ascending: false })
    if (fid) q = q.or(`sending_facility_id.eq.${fid},receiving_facility_id.eq.${fid}`)
    q = sec(q)
    const { data } = await q
    setPending(data || [])
    if (showSpinner) setLoadingP(false)
  }

  function loadPendingSilent() { return loadPending(false) }

  async function confirmDispatch(t) {
    if (!dispatchApprovedBy.trim()) { toast('Record approved by is required', 'red'); return }
    if (!dispatchCarrier.trim()) { toast('Carrier is required', 'red'); return }
    if (!dispatchExpiry.trim()) { toast('Expiry date is required', 'red'); return }
    if (!dispatchBatch.trim()) { toast('Batch / lot number is required', 'red'); return }
    const parsedQty = parseInt(dispatchQty)
    if (!parsedQty || parsedQty < 1) { toast('Qty issued must be at least 1', 'red'); return }
    setDispatchLoading(true)
    const appendNote = `[Approved by: ${dispatchApprovedBy.trim()}] [Carrier: ${dispatchCarrier.trim()}] [Expiry: ${dispatchExpiry.trim()}] [Batch: ${dispatchBatch.trim()}]`
    const newNotes = t.notes ? t.notes + ' ' + appendNote : appendNote
    const { error } = await sb.from('stock_transfer_log').update({
      status: 'in_transit',
      quantity: parsedQty,
      notes: newNotes,
    }).eq('id', t.id)
    if (error) { toast('Error confirming dispatch: ' + error.message, 'red'); setDispatchLoading(false); return }
    const { data: senderStk } = await sb.from('stock').select('id,quantity')
      .eq('facility_id', fid).eq('commodity_id', t.commodity_id).eq('location_type', 'store').maybeSingle()
    if (senderStk) {
      await sb.from('stock').update({ quantity: Math.max(0, senderStk.quantity - parsedQty), updated_at: new Date().toISOString() }).eq('id', senderStk.id)
      await loadStock()
    }
    toast('Transfer dispatched — awaiting receiver acceptance', 'green')
    setPending(prev => prev.map(p => p.id === t.id ? { ...p, status: 'in_transit', quantity: parsedQty, notes: newNotes } : p))
    setDispatchingId(null); setDispatchApprovedBy(''); setDispatchCarrier(''); setDispatchExpiry(''); setDispatchBatch(''); setDispatchQty(1); setDispatchLoading(false)
  }

  async function confirmAssignFacility(t) {
    if (!assignFacId) { toast('Select a source facility', 'red'); return }
    if (!assignApprovedBy.trim()) { toast('Reviewed by is required', 'red'); return }
    const parsedQty = parseInt(assignQty)
    if (!parsedQty || parsedQty < 1) { toast('Qty must be at least 1', 'red'); return }
    setAssignLoading(true)
    const srcFac = allFacilities.find(f => f.id === assignFacId)
    const reviewNote = `[Reviewed by: ${assignApprovedBy.trim()}]`
    const newNotes = t.notes ? t.notes + ' ' + reviewNote : reviewNote
    const { error } = await sb.from('stock_transfer_log').update({
      sending_facility_id: assignFacId,
      sending_facility_name: srcFac?.name || '',
      quantity: parsedQty,
      notes: newNotes,
    }).eq('id', t.id)
    if (error) { toast('Error assigning facility: ' + error.message, 'red'); setAssignLoading(false); return }
    toast(`Request sent to ${srcFac?.name || 'facility'}`, 'green')
    setAssigningId(null); setAssignFacState(''); setAssignFacLga(''); setAssignFacId('')
    setAssignApprovedBy(''); setAssignCarrier(''); setAssignQty(1); setAssignLoading(false)
    loadPendingSilent()
  }

  async function confirmAcceptTransfer(t) {
    if (!acceptReceiverName.trim()) { toast('Receiver name is required', 'red'); return }
    if (!t.sending_facility_id) { toast('Transfer has no sending facility — cannot accept', 'red'); return }
    setAcceptLoading(true)
    const { data: recStk } = await sb.from('stock').select('id,quantity')
      .eq('facility_id', t.receiving_facility_id).eq('commodity_id', t.commodity_id).eq('location_type', 'store').maybeSingle()
    if (recStk) {
      await sb.from('stock').update({ quantity: recStk.quantity + t.quantity, updated_at: new Date().toISOString() }).eq('id', recStk.id)
    } else {
      await sb.from('stock').insert({ facility_id: t.receiving_facility_id, commodity_id: t.commodity_id, quantity: t.quantity, location_type: 'store', updated_at: new Date().toISOString() })
    }
    await sb.from('intake_log').insert({
      facility_id: t.receiving_facility_id, commodity_id: t.commodity_id, quantity: t.quantity,
      supplier_source: t.sending_facility_name, condition_on_arrival: 'Good', received_by: acceptReceiverName.trim(),
      received_at: new Date().toISOString(), notes: 'Facility transfer in from ' + t.sending_facility_name,
    })
    const { error: updateErr } = await sb.from('stock_transfer_log').update({ status: 'accepted', resolved_at: new Date().toISOString(), resolved_by: acceptReceiverName.trim() }).eq('id', t.id)
    if (updateErr) { toast('Error updating transfer status: ' + updateErr.message, 'red'); setAcceptLoading(false); return }
    setAcceptingId(null); setAcceptReceiverName(''); setAcceptLoading(false)
    toast('Transfer accepted — stock updated', 'green')
    await loadStock(); loadPending(); loadMyRequests()
  }

  async function disputeTransfer(t) {
    const { error: dispErr } = await sb.from('stock_transfer_log')
      .update({ status: 'disputed', resolved_at: new Date().toISOString(), resolved_by: getStore().user?.email || '', dispute_note: 'Disputed by receiver' })
      .eq('id', t.id)
      .eq('receiving_facility_id', fid)
    if (dispErr) { toast('Error disputing transfer: ' + dispErr.message, 'red'); return }
    toast('Transfer marked as disputed', 'amber'); loadPending()
  }

  async function restoreDispatchedStock(t) {
    const { data: senderStk } = await sb.from('stock').select('id,quantity')
      .eq('facility_id', fid).eq('commodity_id', t.commodity_id).eq('location_type', 'store').maybeSingle()
    if (!senderStk) { toast('No stock record found to restore', 'red'); return }
    const { error: stockErr } = await sb.from('stock').update({ quantity: senderStk.quantity + t.quantity, updated_at: new Date().toISOString() }).eq('id', senderStk.id)
    if (stockErr) { toast('Error restoring stock: ' + stockErr.message, 'red'); return }
    suppressNextPendingReload.current = true
    const { data: updated, error: logErr } = await sb.from('stock_transfer_log')
      .update({ dispute_note: 'Disputed — stock restored', status: 'accepted', resolved_at: new Date().toISOString() })
      .eq('id', t.id)
      .eq('sending_facility_id', fid)
      .select('id')
    if (logErr) { suppressNextPendingReload.current = false; toast('Error updating transfer: ' + logErr.message, 'red'); return }
    if (!updated || updated.length === 0) {
      suppressNextPendingReload.current = false
      toast('Could not restore — permission denied or record not found', 'red')
      return
    }
    // Remove immediately from pending state so it stops showing
    setPending(prev => prev.filter(p => p.id !== t.id))
    toast('Stock restored', 'green')
    await loadStock(); loadSendHistory()
  }

  function arrangeTransferFromRequest(req) {
    const destFacility = allFacilities.find(f => f.id === req.sending_facility_id)
    if (!destFacility) { toast('Destination facility not found', 'red'); return }
    setPrimary('external')
    setSelectedState(destFacility.state || ''); setSelectedLga(destFacility.lga || '')
    setRecFacId(req.sending_facility_id); setCommId(req.commodity_id); setQty(req.quantity || 1)
    setNotes(req.notes ? '[Response] ' + req.notes : '')
  }

  // ── Request for redistribution ────────────────────────────────────────────
  // Request alerts: rows where I am the receiver and status=pending (awaiting sending facility to dispatch)
  async function loadMyRequests() {
    if (!fid) return
    let q = sb.from('stock_transfer_log').select('*')
      .in('status', ['pending', 'in_transit'])
      .eq('receiving_facility_id', fid)
      .order('initiated_at', { ascending: false })
    q = sec(q)
    const { data } = await q
    setMyRequests(data || [])
  }

  async function loadRequestHistory(from, to) {
    if (!fid) return
    const f = from || reqHistFrom; const t2 = to || reqHistTo
    setLoadingReqHist(true)
    let q = sb.from('stock_transfer_log').select('*')
      .in('status', ['accepted', 'cancelled', 'dismissed'])
      .eq('receiving_facility_id', fid)
      .gte('initiated_at', f + 'T00:00:00').lte('initiated_at', t2 + 'T23:59:59')
      .order('initiated_at', { ascending: false }).limit(200)
    q = sec(q)
    const { data } = await q
    setRequestHistory(data || []); setLoadingReqHist(false)
  }

  async function cancelRequest(id) {
    if (!window.confirm('Cancel this stock request?')) return
    await sb.from('stock_transfer_log').update({ status: 'cancelled', resolved_at: new Date().toISOString(), resolved_by: getStore().user?.email || '' }).eq('id', id)
    toast('Request cancelled', 'green'); loadMyRequests(); loadPending()
  }

  function addRequestLine() { setRequestLines(prev => [...prev, { id: Date.now() + Math.random(), commodity_id: '', requested_qty: 1, issued_qty: 0 }]) }
  function removeRequestLine(id) { setRequestLines(prev => prev.filter(l => l.id !== id)) }
  function updateRequestLine(id, field, value) { setRequestLines(prev => prev.map(l => l.id === id ? { ...l, [field]: value } : l)) }

  async function submitRequest(e) {
    e?.preventDefault(); setReqMsg(null)
    if (!fid) { setReqMsg({ type: 'error', text: 'No facility assigned to your account.' }); return }
    if (!reqBy) { setReqMsg({ type: 'error', text: 'Record compiled by is required.' }); return }
    const lines = requestLines.filter(l => l.commodity_id)
    if (!lines.length) { setReqMsg({ type: 'error', text: 'Add at least one commodity.' }); return }
    for (const l of lines) {
      const q = parseInt(l.requested_qty)
      if (!q || q < 1) { setReqMsg({ type: 'error', text: 'Qty requested must be at least 1 for all commodities.' }); return }
    }
    setReqSending(true)
    const payload = lines.map(l => {
      const comm = allCommodities.find(c => c.id === l.commodity_id)
      return {
        receiving_facility_id: fid, receiving_facility_name: myFac?.name || '',
        sending_facility_id: null, sending_facility_name: null,
        commodity_id: l.commodity_id, commodity_name: comm?.name || '',
        quantity: parseInt(l.requested_qty), qty_requested: parseInt(l.requested_qty), status: 'pending',
        initiated_by: reqBy, initiated_at: new Date().toISOString(),
        notes: reqNotes || null,
        section: commoditySection,
      }
    })
    const { error } = await sb.from('stock_transfer_log').insert(payload)
    if (error) { setReqMsg({ type: 'error', text: 'Error: ' + error.message }); setReqSending(false); return }
    toast('Request submitted — awaiting admin assignment', 'green')
    setReqMsg({ type: 'success', text: 'Request submitted. Admin will assign a source facility and arrange the transfer.' })
    setRequestLines([{ id: Date.now(), commodity_id: '', requested_qty: 1, issued_qty: 0 }])
    setReqNotes(''); setReqSendFacId(''); setReqSelectedState(''); setReqSelectedLga('')
    loadMyRequests(); loadPending(); setReqSub('pending'); setReqSending(false)
  }

  // ── External redistribution ───────────────────────────────────────────────
  async function loadSendHistory(from, to) {
    const f = from || extHistFrom; const t2 = to || extHistTo
    setLoadingS(true)
    let q = sb.from('stock_transfer_log').select('*').in('status', ['accepted', 'disputed'])
      .or(`sending_facility_id.eq.${fid},receiving_facility_id.eq.${fid}`)
      .gte('resolved_at', f + 'T00:00:00').lte('resolved_at', t2 + 'T23:59:59')
      .order('resolved_at', { ascending: false }).limit(200)
    q = sec(q)
    const { data } = await q
    setSendHistory((data || []).filter(t => t.sending_facility_id !== t.receiving_facility_id && !t.notes?.includes('[Internal:') && !t.notes?.includes('[DSD:')))
    setLoadingS(false)
  }

  async function sendTransfer(e) {
    e?.preventDefault(); setMsg(null)
    if (!commId) { setMsg({ type: 'error', text: 'Select a commodity.' }); return }
    if (qty < 1) { setMsg({ type: 'error', text: 'Quantity must be at least 1.' }); return }
    if (!recFacId) { setMsg({ type: 'error', text: 'Select receiving facility.' }); return }
    if (!sendExpiry) { setMsg({ type: 'error', text: 'Expiry date is required.' }); return }
    if (!sendBatch) { setMsg({ type: 'error', text: 'Batch / lot number is required.' }); return }
    if (!sentBy) { setMsg({ type: 'error', text: 'Sent by is required.' }); return }
    if (!sendApprovedBy) { setMsg({ type: 'error', text: 'Record approved by is required.' }); return }
    if (!sendCarrier) { setMsg({ type: 'error', text: 'Carrier is required.' }); return }
    if (!stockRow || stockRow.quantity === 0) { setMsg({ type: 'error', text: 'No stock available.' }); return }
    if (stockRow.quantity < qty) { setMsg({ type: 'error', text: `Insufficient stock. Available: ${stockRow.quantity} ${selectedComm?.unit || 'units'}.` }); return }
    setSending(true)
    const recFac = allFacilities.find(f => f.id === recFacId)
    const comm = allCommodities.find(c => c.id === commId)
    const fullNotes = `[Approved by: ${sendApprovedBy}] [Carrier: ${sendCarrier}] [Expiry: ${sendExpiry}] [Batch: ${sendBatch}]${notes ? ' ' + notes : ''}`
    const { error } = await sb.from('stock_transfer_log').insert({
      sending_facility_id: fid, sending_facility_name: myFac?.name || '',
      receiving_facility_id: recFacId, receiving_facility_name: recFac?.name || '',
      commodity_id: commId, commodity_name: comm?.name || '',
      quantity: parseInt(qty), qty_requested: parseInt(qty), status: 'in_transit', initiated_by: sentBy || '',
      initiated_at: new Date().toISOString(), notes: fullNotes,
      section: commoditySection,
    })
    if (error) { setMsg({ type: 'error', text: 'Error: ' + error.message }); setSending(false); return }
    toast('Transfer dispatched to ' + recFac?.name, 'green')
    setMsg({ type: 'success', text: 'Transfer dispatched. Awaiting receiver acceptance.' })
    setCommId(''); setQty(1); setRecFacId(''); setNotes(''); setSentBy(''); setSendExpiry(''); setSendBatch(''); setSendApprovedBy(''); setSendCarrier('')
    loadPending(); setSending(false)
  }

  // ── Internal redistribution ───────────────────────────────────────────────
  function addIntLine() { setIntLines(prev => [...prev, { id: Date.now() + Math.random(), commodity_id: '', stock_balance: 0, stock_required: 1, stock_issued: 1 }]) }
  function removeIntLine(id) { setIntLines(prev => prev.filter(l => l.id !== id)) }
  function updateIntLine(id, field, value) {
    setIntLines(prev => prev.map(l => {
      if (l.id !== id) return l
      const updated = { ...l, [field]: value }
      if (field === 'commodity_id') {
        const stk = stockData.find(r => r.commodity_id === value && r.facility_id === fid && r.location_type === 'dispensary')
        updated.stock_balance = stk?.quantity || 0
      }
      return updated
    }))
  }

  async function loadIntPendingApprovals() {
    if (!fid) return
    setLoadingIntPending(true)
    let q = sb.from('stock_transfer_log').select('*').eq('status', 'pending_approval').eq('sending_facility_id', fid).order('initiated_at', { ascending: false })
    q = sec(q)
    const { data } = await q
    setIntPendingApprovals((data || []).filter(r => r.notes?.includes('[Internal:')))
    setLoadingIntPending(false)
  }

  async function loadIntHistory() {
    setLoadingI(true)
    let q = sb.from('stock_transfer_log').select('*').eq('status', 'accepted').eq('sending_facility_id', fid).order('resolved_at', { ascending: false }).limit(50)
    q = sec(q)
    const { data } = await q
    setIntHistory((data || []).filter(t => t.notes?.includes('[Internal:')))
    setLoadingI(false)
  }

  async function loadAllIntHistory(from, to) {
    const f = from || intHistFrom; const t2 = to || intHistTo
    setLoadingAllInt(true)
    let q = sb.from('stock_transfer_log').select('*').eq('status', 'accepted').eq('sending_facility_id', fid)
      .gte('resolved_at', f + 'T00:00:00').lte('resolved_at', t2 + 'T23:59:59')
      .order('resolved_at', { ascending: false }).limit(200)
    q = sec(q)
    const { data } = await q
    setAllIntHistory((data || []).filter(t => t.notes?.includes('[Internal:') || t.notes?.includes('[DSD:')))
    setLoadingAllInt(false)
  }

  async function submitInternal(e) {
    e?.preventDefault(); setIntMsg(null)
    if (!intRequestedBy.trim()) { setIntMsg({ type: 'error', text: 'Requested by is required.' }); return }
    const lines = intLines.filter(l => l.commodity_id && l.stock_issued > 0)
    if (!lines.length) { setIntMsg({ type: 'error', text: 'Add at least one commodity with stock issued.' }); return }
    for (const l of lines) {
      if (parseInt(l.stock_issued) > l.stock_balance) {
        const comm = allCommodities.find(c => c.id === l.commodity_id)
        setIntMsg({ type: 'error', text: `Stock issued for ${comm?.name || 'commodity'} exceeds balance (${l.stock_balance}).` }); return
      }
    }
    setIntSending(true)
    const payload = lines.map(l => {
      const comm = allCommodities.find(c => c.id === l.commodity_id)
      return {
        sending_facility_id: fid, sending_facility_name: myFac?.name || '',
        receiving_facility_id: fid, receiving_facility_name: myFac?.name || '',
        commodity_id: l.commodity_id, commodity_name: comm?.name || '',
        quantity: parseInt(l.stock_issued), status: 'pending_approval',
        initiated_by: intRequestedBy, initiated_at: new Date().toISOString(),
        notes: `[Internal: Store→Dispensary] balance:${l.stock_balance} required:${l.stock_required}${intNotes ? ' ' + intNotes : ''}`,
        section: commoditySection,
      }
    })
    const { error } = await sb.from('stock_transfer_log').insert(payload)
    if (error) { setIntMsg({ type: 'error', text: 'Error: ' + error.message }); setIntSending(false); return }
    toast('Submitted for store manager approval', 'green')
    setIntMsg({ type: 'success', text: 'Submitted. Awaiting store manager approval.' })
    setIntLines([{ id: Date.now(), commodity_id: '', stock_balance: 0, stock_required: 1, stock_issued: 1 }])
    setIntRequestedBy(''); setIntNotes('')
    loadIntPendingApprovals(); setIntSending(false)
  }

  async function approveInternal(record) {
    if (!intApprovedBy.trim()) { toast('Approved by is required', 'red'); return }
    setIntApproving(true)
    const storeStk = stockData.find(r => r.commodity_id === record.commodity_id && r.facility_id === fid && r.location_type === 'store')
    if (!storeStk || storeStk.quantity < record.quantity) { toast(`Insufficient store stock. Available: ${storeStk?.quantity || 0}`, 'red'); setIntApproving(false); return }
    await sb.from('stock').update({ quantity: storeStk.quantity - record.quantity, updated_at: new Date().toISOString() }).eq('id', storeStk.id)
    const { data: dispStk } = await sb.from('stock').select('id,quantity').eq('facility_id', fid).eq('commodity_id', record.commodity_id).eq('location_type', 'dispensary').maybeSingle()
    if (dispStk) {
      await sb.from('stock').update({ quantity: dispStk.quantity + record.quantity, updated_at: new Date().toISOString() }).eq('id', dispStk.id)
    } else {
      await sb.from('stock').insert({ facility_id: fid, commodity_id: record.commodity_id, quantity: record.quantity, location_type: 'dispensary', updated_at: new Date().toISOString() })
    }
    await sb.from('stock_transfer_log').update({ status: 'accepted', resolved_at: new Date().toISOString(), resolved_by: intApprovedBy }).eq('id', record.id)
    const comm = allCommodities.find(c => c.id === record.commodity_id)
    toast(`${record.quantity} ${comm?.unit || 'units'} moved to dispensary`, 'green')
    setIntApprovingId(null); setIntApprovedBy('')
    await loadStock(); loadIntPendingApprovals(); loadIntHistory(); loadAllIntHistory(); setIntApproving(false)
  }

  async function rejectInternal(id) {
    if (!window.confirm('Reject this transfer request?')) return
    await sb.from('stock_transfer_log').update({ status: 'cancelled', resolved_at: new Date().toISOString(), resolved_by: getStore().user?.email || '' }).eq('id', id)
    toast('Transfer request rejected', 'green'); loadIntPendingApprovals()
  }

  // ── DSD ───────────────────────────────────────────────────────────────────
  function addDsdLine() { setDsdLines(prev => [...prev, { id: Date.now() + Math.random(), commodity_id: '', stock_balance: 0, stock_required: 1, stock_issued: 1 }]) }
  function removeDsdLine(id) { setDsdLines(prev => prev.filter(l => l.id !== id)) }
  async function updateDsdLine(id, field, value) {
    if (field === 'commodity_id') {
      const effectiveSiteName = isDSD ? userDsdSiteName : dsdSiteName
      if (!effectiveSiteName) return
      const { data: dsdStk } = await sb.from('dsd_stock').select('quantity')
        .eq('facility_id', fid).eq('dsd_site_name', effectiveSiteName).eq('commodity_id', value).maybeSingle()
      setDsdLines(prev => prev.map(l => {
        if (l.id !== id) return l
        return { ...l, [field]: value, stock_balance: dsdStk?.quantity || 0 }
      }))
    } else {
      setDsdLines(prev => prev.map(l => l.id === id ? { ...l, [field]: value } : l))
    }
  }

  async function loadDsdPendingApprovals() {
    if (!fid) return
    setLoadingDsdPending(true)
    let q = sb.from('stock_transfer_log').select('*')
      .eq('status', 'pending_approval')
      .eq('sending_facility_id', fid).order('initiated_at', { ascending: false })
    q = sec(q)
    const { data } = await q
    setDsdPendingApprovals((data || []).filter(r => r.notes?.includes('[DSD:')))
    setLoadingDsdPending(false)
  }

  async function loadDsdDispatched() {
    if (!fid) return
    setLoadingDsdDispatched(true)
    let q = sb.from('stock_transfer_log').select('*')
      .eq('status', 'dispatched')
      .eq('sending_facility_id', fid).order('initiated_at', { ascending: false })
    q = sec(q)
    const { data } = await q
    setDsdDispatched((data || []).filter(r => r.notes?.includes('[DSD:')))
    setLoadingDsdDispatched(false)
  }

  async function loadDsdHistory() {
    setLoadingD(true)
    let q = sb.from('stock_transfer_log').select('*')
      .in('status', ['accepted', 'disputed'])
      .eq('sending_facility_id', fid).order('resolved_at', { ascending: false }).limit(50)
    q = sec(q)
    const { data } = await q
    setDsdHistory((data || []).filter(t => t.notes?.includes('[DSD:')))
    setLoadingD(false)
  }

  async function submitDsd(e) {
    e?.preventDefault(); setDsdMsg(null)
    const effectiveSiteName = isDSD ? userDsdSiteName : dsdSiteName
    if (!isDSD && !dsdType) { setDsdMsg({ type: 'error', text: 'Select DSD type.' }); return }
    if (!effectiveSiteName) { setDsdMsg({ type: 'error', text: 'Enter DSD site name.' }); return }
    if (!dsdSentBy) { setDsdMsg({ type: 'error', text: 'Sent by is required.' }); return }
    const lines = dsdLines.filter(l => l.commodity_id && l.stock_issued > 0)
    if (!lines.length) { setDsdMsg({ type: 'error', text: 'Add at least one commodity with stock issued.' }); return }
    for (const l of lines) {
      if (parseInt(l.stock_issued) > l.stock_balance) {
        const comm = allCommodities.find(c => c.id === l.commodity_id)
        setDsdMsg({ type: 'error', text: `Stock issued for ${comm?.name || 'commodity'} exceeds balance (${l.stock_balance}).` }); return
      }
    }
    setDsdSending(true)
    const payload = lines.map(l => {
      const comm = allCommodities.find(c => c.id === l.commodity_id)
      return {
        sending_facility_id: fid, sending_facility_name: myFac?.name || '',
        receiving_facility_id: null, receiving_facility_name: effectiveSiteName,
        commodity_id: l.commodity_id, commodity_name: comm?.name || '',
        quantity: parseInt(l.stock_issued), status: 'pending_approval',
        initiated_by: dsdSentBy, initiated_at: new Date().toISOString(),
        notes: `[DSD: ${effectiveSiteName}] type:${isDSD ? 'Community Pharmacy' : dsdType} balance:${l.stock_balance} required:${l.stock_required}${dsdNotes ? ' ' + dsdNotes : ''}`,
        section: commoditySection,
      }
    })
    const { error } = await sb.from('stock_transfer_log').insert(payload)
    if (error) { setDsdMsg({ type: 'error', text: 'Error: ' + error.message }); setDsdSending(false); return }
    toast('Submitted for store manager approval', 'green')
    setDsdMsg({ type: 'success', text: 'Submitted. Awaiting store manager approval.' })
    setDsdLines([{ id: Date.now(), commodity_id: '', stock_balance: 0, stock_required: 1, stock_issued: 1 }])
    setDsdType(''); setDsdSiteName(''); setDsdSentBy(''); setDsdNotes('')
    loadDsdPendingApprovals(); setDsdSending(false)
  }

  async function approveDsd(record) {
    if (!dsdApprovedBy.trim()) { toast('Approved by store manager is required', 'red'); return }
    const issued = parseInt(dsdIssuedQty)
    if (!issued || issued < 1) { toast('Stock issued quantity is required', 'red'); return }
    setDsdApproving(true)
    const { data: storeStk } = await sb.from('stock').select('id,quantity')
      .eq('facility_id', fid).eq('commodity_id', record.commodity_id)
      .eq('location_type', 'store').maybeSingle()
    if (!storeStk || storeStk.quantity < issued) { toast(`Insufficient store stock. Available: ${storeStk?.quantity || 0}`, 'red'); setDsdApproving(false); return }
    await sb.from('stock').update({ quantity: storeStk.quantity - issued, updated_at: new Date().toISOString() }).eq('id', storeStk.id)

    // Update DSD site stock
    const dsdSiteNameFromNotes = record.notes?.match(/\[DSD:\s*([^\]]+)\]/)?.[1]?.trim() || record.receiving_facility_name || ''
    const { data: dsdStk } = await sb.from('dsd_stock').select('id,quantity')
      .eq('facility_id', fid).eq('dsd_site_name', dsdSiteNameFromNotes).eq('commodity_id', record.commodity_id).maybeSingle()
    if (dsdStk) {
      await sb.from('dsd_stock').update({ quantity: dsdStk.quantity + issued, updated_at: new Date().toISOString() }).eq('id', dsdStk.id)
    } else {
      await sb.from('dsd_stock').insert({ facility_id: fid, dsd_site_name: dsdSiteNameFromNotes, commodity_id: record.commodity_id, quantity: issued, updated_at: new Date().toISOString() })
    }

    const { error: updateErr } = await sb.from('stock_transfer_log').update({
      status: 'dispatched',
      quantity: issued,
      resolved_at: new Date().toISOString(),
      resolved_by: `[Approved: ${dsdApprovedBy}]`,
    }).eq('id', record.id)
    if (updateErr) { toast('Error updating transfer: ' + updateErr.message, 'red'); setDsdApproving(false); return }
    const comm = allCommodities.find(c => c.id === record.commodity_id)
    toast(`${issued} ${comm?.unit || 'units'} dispatched — awaiting DSD confirmation`, 'green')
    setDsdApprovingId(null); setDsdApprovedBy(''); setDsdIssuedQty('')
    await loadStock(); loadDsdPendingApprovals(); loadDsdDispatched(); loadDsdHistory(); loadAllIntHistory(); setDsdApproving(false)
  }

  async function rejectDsd(id) {
    if (!window.confirm('Reject this DSD request?')) return
    await sb.from('stock_transfer_log').update({ status: 'cancelled', resolved_at: new Date().toISOString(), resolved_by: getStore().user?.email || '' }).eq('id', id)
    toast('DSD request rejected', 'green'); loadDsdPendingApprovals()
  }

  // ── Print slip ────────────────────────────────────────────────────────────
  function printSlip(t) {
    const printDate = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
    const isInternal = t.notes?.includes('[Internal:')
    const isDSD = t.notes?.includes('[DSD:')
    const transferType = isDSD ? 'DSD Transfer' : isInternal ? 'Internal Transfer (Store → Dispensary)' : 'External Redistribution'
    const approvedByMatch = t.resolved_by?.match(/\[Approved: ([^\]]+)\]/)
    const receivedByMatch = t.resolved_by?.match(/\[Received by: ([^\]]+)\]/)
    const extApprovedMatch = t.notes?.match(/\[Approved by: ([^\]]+)\]/)
    const carrierMatch = t.notes?.match(/\[Carrier: ([^\]]+)\]/)
    const expiryMatch = t.notes?.match(/\[Expiry: ([^\]]+)\]/)
    const batchMatch = t.notes?.match(/\[Batch: ([^\]]+)\]/)
    const balanceMatch = t.notes?.match(/balance:(\d+)/)
    const extraFields = isDSD
      ? `<div class="field"><label>Approved by (Store Manager)</label><span>${approvedByMatch?.[1] || '—'}</span></div>
         <div class="field"><label>Received by</label><span>${receivedByMatch?.[1] || '—'}</span></div>`
      : isInternal
      ? `<div class="field"><label>Site stock balance</label><span>${balanceMatch?.[1] || '—'}</span></div>
         <div class="field"><label>Qty requested</label><span>${t.qty_requested || t.quantity || '—'}</span></div>
         <div class="field"><label>Qty issued</label><span>${t.quantity || '—'}</span></div>
         <div class="field"><label>Approved by (Store Manager)</label><span>${t.resolved_by || '—'}</span></div>`
      : `<div class="field"><label>Record approved by</label><span>${extApprovedMatch?.[1] || '—'}</span></div>
         <div class="field"><label>Carrier</label><span>${carrierMatch?.[1] || '—'}</span></div>
         <div class="field"><label>Expiry date</label><span>${expiryMatch?.[1] || '—'}</span></div>
         <div class="field"><label>Batch / lot number</label><span>${batchMatch?.[1] || '—'}</span></div>`
    const html = `<style>body{font-family:Arial,sans-serif;font-size:11pt;color:#000;margin:0}h2{margin:0 0 2px;font-size:14pt}.sub{font-size:9pt;color:#666;margin-bottom:16px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px;margin-bottom:16px}.field label{font-size:7.5pt;text-transform:uppercase;letter-spacing:.07em;color:#888;display:block;margin-bottom:2px}.field span{font-size:11pt;font-weight:600}.full{grid-column:1/-1}hr{border:none;border-top:1px solid #ccc;margin:16px 0}.sig{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:32px}.sig div{border-top:1px solid #000;padding-top:4px;font-size:8pt;color:#555}</style>
      <h2>Transfer Slip</h2><div class="sub">${transferType} &nbsp;·&nbsp; Printed ${printDate}</div><hr/>
      <div class="grid">
        <div class="field"><label>Commodity</label><span>${t.commodity_name || '—'}</span></div>
        <div class="field"><label>Quantity</label><span>${t.quantity}</span></div>
        <div class="field"><label>From</label><span>${t.sending_facility_name || '—'}</span></div>
        <div class="field"><label>To</label><span>${t.receiving_facility_name || '—'}</span></div>
        <div class="field"><label>Date initiated</label><span>${fmtDate(t.initiated_at) || '—'}</span></div>
        <div class="field"><label>Date resolved</label><span>${fmtDate(t.resolved_at) || '—'}</span></div>
        <div class="field"><label>Record compiled by</label><span>${t.initiated_by || '—'}</span></div>
        <div class="field"><label>Status</label><span>${t.status}</span></div>
        ${extraFields}
        ${!isInternal && !isDSD ? `<div class="field"><label>Received by</label><span>${t.resolved_by || '—'}</span></div>` : ''}
      </div><hr/>
      <div class="sig"><div>Sender signature &amp; stamp</div><div>Receiver signature &amp; stamp</div></div>`
    const blob = new Blob([`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Transfer Slip</title></head><body style="margin:20mm">${html}</body></html>`], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    const win = window.open(url, '_blank')
    if (win) { win.onload = () => { win.focus(); win.print(); URL.revokeObjectURL(url); win.onafterprint = () => win.close() } }
    else { URL.revokeObjectURL(url); toast('Allow pop-ups to print', 'red') }
  }

  // ── UI helpers ────────────────────────────────────────────────────────────

  const BackButton = () => (
    <button onClick={() => setPrimary(null)}
      className="mb-3 flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors">
      ← Back
    </button>
  )

  const SubTab = ({ id, current, onChange, label, badge }) => (
    <button onClick={() => onChange(id)}
      className={`px-3 py-1.5 text-xs rounded-lg border transition-colors flex items-center gap-1.5 ${current === id ? 'bg-white/8 border-white/15 text-gray-100 font-medium' : 'border-white/8 text-gray-500 hover:text-gray-300'}`}>
      {label}
      {badge > 0 && <span className="bg-red-500 text-white text-xs font-bold rounded-full px-1 py-0.5 min-w-[1.1rem] text-center leading-none">{badge}</span>}
    </button>
  )

  const HistoryTable = ({ rows, loading, emptyMsg }) => {
    if (loading) return <div className="px-5 py-4 text-sm text-gray-500">Loading history…</div>
    if (!rows.length) return <div className="px-5 py-4 text-sm text-gray-500">{emptyMsg}</div>
    return (
      <div className="table-wrap"><table className="w-full text-sm">
        <thead><tr className="border-b border-white/8 bg-white/2">
          {['Date', 'Commodity', 'Qty', 'Direction', 'From', 'To', 'Status', ''].map((h, i) => (
            <th key={i} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
          ))}
        </tr></thead>
        <tbody>{rows.map(t => {
          const isOut = t.sending_facility_id === fid
          return (
          <tr key={t.id} className="border-b border-white/5 hover:bg-white/2">
            <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDate(t.resolved_at)}</td>
            <td className="px-4 py-3 font-medium text-gray-100">{t.commodity_name}</td>
            <td className="px-4 py-3 font-mono text-sm text-gray-300">{t.quantity}{commUnit(t.commodity_id) ? ` ${commUnit(t.commodity_id)}` : ''}</td>
            <td className="px-4 py-3 text-xs font-semibold whitespace-nowrap"><span className={isOut ? 'text-red-400' : 'text-green-400'}>{isOut ? '▼ Stock out' : '▲ Stock in'}</span></td>
            <td className="px-4 py-3 text-xs text-gray-500">{t.sending_facility_name}</td>
            <td className="px-4 py-3 text-xs text-gray-500">{t.receiving_facility_name}</td>
            <td className="px-4 py-3"><Badge type={t.dispute_note === 'Disputed — stock restored' ? 'amber' : t.status === 'accepted' ? 'ok' : 'out'}>{t.dispute_note === 'Disputed — stock restored' ? 'Stock restored' : t.status}</Badge></td>
            <td className="px-4 py-3">
              <button onClick={() => printSlip(t)} className="text-xs text-gray-500 hover:text-gray-200 border border-white/10 rounded px-2 py-1 flex items-center gap-1">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3"><path d="M4 5V2h8v3M4 11H2V6h12v5h-2M4 9h8v5H4z"/></svg>
                Print
              </button>
            </td>
          </tr>
          )
        })}</tbody>
      </table></div>
    )
  }


  const commUnit = (commodityId) => allCommodities.find(c => c.id === commodityId)?.unit || ''

  const incomingCount = pending.filter(t => t.receiving_facility_id === fid && t.status === 'in_transit').length
  const outgoingCount = pending.filter(t =>
    (t.sending_facility_id === fid && t.status === 'pending') ||
    (t.receiving_facility_id === fid && t.status === 'pending' && t.sending_facility_id === null)
  ).length
  const totalPendingBadge = incomingCount + outgoingCount
  const inTransitForMe = incomingCount
  const allIntPendingBadge = intPendingApprovals.length + dsdPendingApprovals.length

  // ── Render ────────────────────────────────────────────────────────────────
  if (accessRestricted) return (
    <div>
      <div className="mb-6"><h1 className="text-xl font-medium text-gray-100">Access Restricted</h1></div>
      <Card><CardBody className="text-center py-12">
        <div className="text-5xl mb-4">🔒</div>
        <div className="font-medium text-gray-100 mb-2">Store Manager or Dispenser access required</div>
        <div className="text-sm text-gray-500">Contact your store manager to perform this action.</div>
        <div className="text-xs text-gray-600 mt-3 font-mono">role: {facilityRole || 'null'} · level: {accessLevel || 'null'}</div>
      </CardBody></Card>
    </div>
  )

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-medium text-gray-100">Redistribution &amp; Emergency Order</h1>
        <p className="text-sm text-gray-500 mt-1">Manage stock requests, internal and external redistributions.</p>
      </div>

      {/* Pending approval banners — visible to store manager on landing */}
      {primary === null && canManage && (intPendingApprovals.length > 0 || dsdPendingApprovals.length > 0) && (
        <div className="flex flex-col gap-2 mb-4">
          {intPendingApprovals.length > 0 && (
            <button
              onClick={() => { setPrimary('internal'); setIntSub('dispensary') }}
              className="w-full flex items-center gap-3 px-4 py-3 bg-amber-500/10 border border-amber-500/30 rounded-xl text-left hover:bg-amber-500/15 transition-colors"
            >
              <span className="text-amber-400 text-lg">⏳</span>
              <div>
                <div className="text-sm font-semibold text-amber-300">
                  {intPendingApprovals.length} Store→Dispensary request{intPendingApprovals.length > 1 ? 's' : ''} awaiting your approval
                </div>
                <div className="text-xs text-amber-500 mt-0.5">Click to review and approve →</div>
              </div>
            </button>
          )}
          {dsdPendingApprovals.length > 0 && (
            <button
              onClick={() => { setPrimary('internal'); setIntSub('dsd') }}
              className="w-full flex items-center gap-3 px-4 py-3 bg-amber-500/10 border border-amber-500/30 rounded-xl text-left hover:bg-amber-500/15 transition-colors"
            >
              <span className="text-amber-400 text-lg">⏳</span>
              <div>
                <div className="text-sm font-semibold text-amber-300">
                  {dsdPendingApprovals.length} DSD stock request{dsdPendingApprovals.length > 1 ? 's' : ''} awaiting your approval
                </div>
                <div className="text-xs text-amber-500 mt-0.5">Click to review and approve →</div>
              </div>
            </button>
          )}
        </div>
      )}

      {/* Landing — shown when no primary tab selected */}
      {primary === null && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            { id: 'request',  label: 'Request',                  desc: 'Submit and track redistribution requests',          badge: totalPendingBadge },
            { id: 'internal', label: 'Internal redistribution',  desc: 'Store to Dispensary and DSD transfers',             badge: allIntPendingBadge },
            { id: 'external', label: 'External redistribution',  desc: 'Send or receive stock from other facilities',       badge: 0 },
          ].filter(card => {
            if (isDispenser) return ['request','internal'].includes(card.id)
            if (isDSD)       return ['request', 'internal'].includes(card.id)
            return true
          })
          .map(({ id, label, desc, badge }) => (
            <button key={id} onClick={() => setPrimary(id)}
              className="text-left p-5 rounded-xl border border-white/10 bg-white/3 hover:bg-white/6 hover:border-white/20 transition-all">
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium text-gray-100">{label}</span>
                {badge > 0 && <span className="bg-red-500 text-white text-xs font-bold rounded-full px-1.5 py-0.5 min-w-[1.2rem] text-center">{badge}</span>}
              </div>
              <p className="text-xs text-gray-500">{desc}</p>
            </button>
          ))}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          REQUEST GROUP
      ══════════════════════════════════════════════════════════════════════ */}
      {primary === 'request' && (
        <>
          <BackButton />
          <div className="flex gap-1.5 mb-4 flex-wrap border-b border-white/8 pb-3">
            {canManage && accessLevel === 'facility' && <SubTab id="form"     current={reqSub} onChange={setReqSub} label="Request for redistribution" />}
            <SubTab id="pending"  current={reqSub} onChange={setReqSub} label="Pending" badge={incomingCount + outgoingCount} />
            <SubTab id="alerts"   current={reqSub} onChange={setReqSub} label="Request alerts" badge={myRequests.length} />
            <SubTab id="history"  current={reqSub} onChange={setReqSub} label="Request history" />
          </div>

          {/* Request for redistribution form (store manager only) */}
          {reqSub === 'form' && canManage && accessLevel === 'facility' && (
            <Card>
              <CardHeader><CardTitle>Request for redistribution</CardTitle></CardHeader>
              <CardBody>
                <form onSubmit={submitRequest} className="space-y-4">
                  <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-4 py-3 text-sm text-blue-300">
                    Submit your request below. Admin will review and assign a source facility to fulfil the transfer.
                  </div>
                  <div className="space-y-3">
                    {requestLines.map((line, idx) => (
                      <div key={line.id} className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
                        <div className="sm:col-span-2">
                          <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Commodity *</label>
                          <select value={line.commodity_id} onChange={e => updateRequestLine(line.id, 'commodity_id', e.target.value)} required className={inputCls}>
                            <option value="">Select commodity…</option>
                            {Object.entries(categories).sort().map(([cat, comms]) => (
                              <optgroup key={cat} label={cat}>{comms.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Qty requested *</label>
                          <input type="number" value={line.requested_qty} onChange={e => updateRequestLine(line.id, 'requested_qty', e.target.value)} className={inputCls} placeholder="0" />
                        </div>
                        <div className="sm:col-span-3 flex items-center gap-2 justify-end">
                          {requestLines.length > 1 && <button type="button" onClick={() => removeRequestLine(line.id)} className="text-sm text-red-400 hover:text-red-300">Remove</button>}
                          {idx === requestLines.length - 1 && <button type="button" onClick={addRequestLine} className="text-sm text-blue-400 hover:text-blue-300">+ Add commodity</button>}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Record compiled by *</label>
                    <input type="text" value={reqBy} onChange={e => setReqBy(e.target.value)} required className={inputCls} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Reason / urgency (optional)</label>
                    <textarea value={reqNotes} onChange={e => setReqNotes(e.target.value)} rows={2}
                      placeholder="e.g. Stock critically low, needed for outreach clinic on Friday" className={`${inputCls} resize-none`} />
                  </div>
                  {reqMsg && <div className={`rounded-lg px-4 py-3 text-sm ${reqMsg.type === 'error' ? 'bg-red-500/10 border border-red-500/20 text-red-400' : 'bg-green-500/10 border border-green-500/20 text-green-400'}`}>{reqMsg.text}</div>}
                  <button type="submit" disabled={reqSending}
                    className="w-full py-3 rounded-xl text-sm font-semibold transition-all bg-green-500 hover:bg-green-400 text-white disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-green-500/20">
                    {reqSending ? 'Sending request…' : '⬆ Send redistribution request'}
                  </button>
                </form>
              </CardBody>
            </Card>
          )}

          {/* Pending transfers */}
          {reqSub === 'pending' && (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>Pending transfers — action required</CardTitle>
                  <button onClick={loadPending} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">Refresh</button>
                </CardHeader>
                {loadingP ? <LoadingState /> : pending.length === 0 ? <EmptyState message="No pending transfers" /> : (
                  pending.map(t => {
                    const isSender        = fid === t.sending_facility_id
                    const isReceiver      = fid === t.receiving_facility_id
                    const isAdminUser     = ['overall_admin','state_admin','lga_admin'].includes(accessLevel)
                    const needsAssignment = t.sending_facility_id === null
                    if (t.status === 'disputed' && isReceiver) return null
                    const assignFacGroups = {}
                    allFacilities.filter(f => f.id !== t.receiving_facility_id).forEach(f => {
                      const s = f.state || 'Other', l = f.lga || 'Other'
                      if (!assignFacGroups[s]) assignFacGroups[s] = {}
                      if (!assignFacGroups[s][l]) assignFacGroups[s][l] = []
                      assignFacGroups[s][l].push(f)
                    })
                    return (
                      <div key={t.id} className="px-5 py-4 border-b border-white/8 last:border-0">
                        <div className="flex items-start justify-between gap-4 flex-wrap">
                          <div className="flex-1">
                            <div className="font-medium text-gray-100 mb-1">{t.commodity_name}</div>
                            <div className="text-sm text-gray-400">
                              <span className="font-medium text-gray-200">{t.quantity}</span>{commUnit(t.commodity_id) ? ` ${commUnit(t.commodity_id)}` : ''} ·{' '}
                              From: <span className="text-blue-400">{t.sending_facility_name || '(unassigned)'}</span> → To: <span className="text-green-400">{t.receiving_facility_name}</span>
                            </div>
                            <div className="text-xs text-gray-600 mt-1">Initiated {fmtDate(t.initiated_at)} by {t.initiated_by || '—'}</div>
                            {t.notes && <div className="text-xs text-gray-500 mt-1">Note: {t.notes}</div>}
                          </div>
                          <div className="flex gap-2 items-center flex-wrap">
                            {t.status === 'pending' && needsAssignment && isAdminUser && (
                              <Button variant="success" size="sm" onClick={() => { setAssigningId(t.id); setAssignFacState(''); setAssignFacLga(''); setAssignFacId(''); setAssignApprovedBy(''); setAssignQty(t.qty_requested ?? t.quantity) }}>Assign facility</Button>
                            )}
                            {t.status === 'pending' && isSender && !isDispenser && (
                              <>
                                <Button variant="success" size="sm" onClick={() => { setDispatchingId(t.id); setDispatchApprovedBy(''); setDispatchCarrier(''); setDispatchQty(t.quantity) }}>Arrange transfer</Button>
                                <Button variant="danger" size="sm" onClick={() => cancelRequest(t.id)}>Cancel</Button>
                              </>
                            )}
                            {t.status === 'pending' && isReceiver && (
                              <span className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-full px-2 py-0.5">
                                {needsAssignment ? '⏳ Awaiting review by admin' : `⏳ Awaiting transfer from ${t.sending_facility_name || 'facility'}`}
                              </span>
                            )}
                            {t.status === 'in_transit' && isReceiver && !isDispenser && (
                              <><Button variant="success" size="sm" onClick={() => { setAcceptingId(t.id); setAcceptReceiverName('') }}>✓ Accept</Button>
                                <Button variant="danger" size="sm" onClick={() => disputeTransfer(t)}>✕ Dispute</Button></>
                            )}
                            {t.status === 'in_transit' && isReceiver && isDispenser && (
                              <span className="text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded-full px-2 py-0.5">📦 In transit</span>
                            )}
                            {t.status === 'in_transit' && isSender && (
                              <span className="text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded-full px-2 py-0.5">📦 Dispatched — awaiting <strong>{t.receiving_facility_name}</strong></span>
                            )}
                            {t.status === 'in_transit' && isAdminUser && !isSender && !isReceiver && (
                              <span className="text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded-full px-2 py-0.5">📦 In transit</span>
                            )}
                            {t.status === 'disputed' && isSender && !isDispenser && t.dispute_note !== 'Disputed — stock restored' && (
                              <Button variant="warning" size="sm" onClick={() => restoreDispatchedStock(t)}>↩ Restore stock</Button>
                            )}
                            {t.status === 'disputed' && !isSender && (
                              <span className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-full px-2 py-0.5">✕ Disputed</span>
                            )}
                          </div>
                        </div>
                        {assigningId === t.id && (
                          <div className="mt-3 p-3 bg-purple-500/5 border border-purple-500/20 rounded-lg space-y-3">
                            <div className="text-xs text-gray-400 font-medium">Select facility to fulfil this request</div>
                            <div className="space-y-2">
                              <select value={assignFacState} onChange={e => { setAssignFacState(e.target.value); setAssignFacLga(''); setAssignFacId('') }} className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-purple-500">
                                <option value="">Select state…</option>
                                {Object.keys(assignFacGroups).sort().map(s => <option key={s} value={s}>{s}</option>)}
                              </select>
                              {assignFacState && (
                                <select value={assignFacLga} onChange={e => { setAssignFacLga(e.target.value); setAssignFacId('') }} className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-purple-500">
                                  <option value="">Select LGA…</option>
                                  {Object.keys(assignFacGroups[assignFacState] || {}).sort().map(l => <option key={l} value={l}>{l}</option>)}
                                </select>
                              )}
                              {assignFacLga && (
                                <select value={assignFacId} onChange={e => setAssignFacId(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-purple-500">
                                  <option value="">Select source facility…</option>
                                  {(assignFacGroups[assignFacState]?.[assignFacLga] || []).sort((a,b) => a.name.localeCompare(b.name)).map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                                </select>
                              )}
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              <div>
                                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Qty to issue *</label>
                                <input type="number" min="1" value={assignQty} onChange={e => setAssignQty(e.target.value)}
                                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-purple-500" />
                              </div>
                              <div>
                                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Reviewed by *</label>
                                <input type="text" value={assignApprovedBy} onChange={e => setAssignApprovedBy(e.target.value)}
                                  placeholder="Admin name" className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-purple-500" />
                              </div>
                            </div>
                            <div className="flex gap-2">
                              <Button variant="success" size="sm" disabled={assignLoading} onClick={() => confirmAssignFacility(t)}>
                                {assignLoading ? 'Sending…' : 'Send request to facility'}
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => { setAssigningId(null); setAssignFacState(''); setAssignFacLga(''); setAssignFacId(''); setAssignApprovedBy(''); setAssignQty(1) }}>Cancel</Button>
                            </div>
                          </div>
                        )}
                        {dispatchingId === t.id && (
                          <div className="mt-3 p-3 bg-blue-500/5 border border-blue-500/20 rounded-lg space-y-3">
                            <div className="text-xs text-gray-500">Qty requested: <span className="text-gray-300 font-medium">{t.qty_requested ?? t.quantity}{commUnit(t.commodity_id) ? ` ${commUnit(t.commodity_id)}` : ''}</span></div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              <div>
                                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Qty issued *</label>
                                <input autoFocus type="number" min="1" value={dispatchQty} onChange={e => setDispatchQty(e.target.value)}
                                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
                              </div>
                              <div>
                                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Record approved by *</label>
                                <input type="text" value={dispatchApprovedBy} onChange={e => setDispatchApprovedBy(e.target.value)}
                                  placeholder="Approving officer name" className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
                              </div>
                              <div>
                                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Carrier *</label>
                                <input type="text" value={dispatchCarrier} onChange={e => setDispatchCarrier(e.target.value)}
                                  placeholder="Carrier / transporter name" className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
                              </div>
                              <div>
                                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Expiry date *</label>
                                <input type="date" value={dispatchExpiry} onChange={e => setDispatchExpiry(e.target.value)}
                                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
                              </div>
                              <div>
                                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Batch / lot no. *</label>
                                <input type="text" value={dispatchBatch} onChange={e => setDispatchBatch(e.target.value)}
                                  placeholder="Batch or lot number" className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
                              </div>
                            </div>
                            <div className="flex gap-2">
                              <Button variant="success" size="sm" disabled={dispatchLoading} onClick={() => confirmDispatch(t)}>
                                {dispatchLoading ? 'Confirming…' : 'Confirm dispatch'}
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => { setDispatchingId(null); setDispatchApprovedBy(''); setDispatchCarrier(''); setDispatchExpiry(''); setDispatchBatch(''); setDispatchQty(1) }}>Cancel</Button>
                            </div>
                          </div>
                        )}
                        {acceptingId === t.id && (
                          <div className="mt-3 p-3 bg-green-500/5 border border-green-500/20 rounded-lg flex items-end gap-3 flex-wrap">
                            <div className="flex-1 min-w-[180px]">
                              <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Receiver name *</label>
                              <input autoFocus type="text" value={acceptReceiverName} onChange={e => setAcceptReceiverName(e.target.value)}
                                placeholder="Staff name" className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-green-500" />
                            </div>
                            <Button variant="success" size="sm" disabled={acceptLoading} onClick={() => confirmAcceptTransfer(t)}>
                              {acceptLoading ? 'Processing…' : 'Confirm accept'}
                            </Button>
                            <Button variant="default" size="sm" onClick={() => { setAcceptingId(null); setAcceptReceiverName('') }}>Cancel</Button>
                          </div>
                        )}
                      </div>
                    )
                  })
                )}
              </Card>
            </>
          )}

          {/* Request alerts — own pending requests */}
          {reqSub === 'alerts' && (
            <Card>
              <CardHeader>
                <CardTitle>My redistribution requests — action required</CardTitle>
                <div className="flex gap-2">
                  <button onClick={loadMyRequests} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">Refresh</button>
                </div>
              </CardHeader>
              {myRequests.length === 0 ? <EmptyState message="No pending redistribution requests ✓" /> : (
                myRequests.map(r => (
                  <div key={r.id} className="px-5 py-4 border-b border-white/8 last:border-0">
                    <div className="flex items-start justify-between gap-4 flex-wrap">
                      <div className="flex-1">
                        <div className="font-medium text-gray-100 mb-1">{r.commodity_name}</div>
                        <div className="text-sm text-gray-400">
                          {r.status === 'in_transit'
                            ? <><span className="font-medium text-gray-200">{r.quantity}</span>{commUnit(r.commodity_id) ? ` ${commUnit(r.commodity_id)}` : ''} dispatched</>
                            : <>Requested: <span className="font-medium text-gray-200">{r.qty_requested ?? r.quantity}</span>{commUnit(r.commodity_id) ? ` ${commUnit(r.commodity_id)}` : ''}</>
                          }
                        </div>
                        {r.sending_facility_name && <div className="text-xs text-gray-500 mt-0.5">Transferring facility: <span className="text-blue-400">{r.sending_facility_name}</span></div>}
                        <div className="text-xs text-gray-600 mt-1">Requested {fmtDate(r.initiated_at)} by {r.initiated_by || '—'}</div>
                        {r.notes && <div className="text-xs text-gray-500 mt-1">{r.notes}</div>}
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        {r.status === 'in_transit' ? (
                          <>
                            <span className="text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded-full px-2 py-0.5">📦 In transit</span>
                            {!isDispenser && <Button variant="success" size="sm" onClick={() => { setAcceptingId(r.id); setAcceptReceiverName('') }}>✓ Accept</Button>}
                            {!isDispenser && <Button variant="danger" size="sm" onClick={() => disputeTransfer(r)}>✕ Dispute</Button>}
                          </>
                        ) : r.sending_facility_id ? (
                          <>
                            <span className="text-xs text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded-full px-2 py-0.5">⏳ Awaiting transfer from {r.sending_facility_name}</span>
                            <Button variant="danger" size="sm" onClick={() => cancelRequest(r.id)}>Cancel</Button>
                          </>
                        ) : (
                          <>
                            <span className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-full px-2 py-0.5">⏳ Awaiting review by admin</span>
                            <Button variant="danger" size="sm" onClick={() => cancelRequest(r.id)}>Cancel</Button>
                          </>
                        )}
                      </div>
                    </div>
                    {acceptingId === r.id && (
                      <div className="mt-3 p-3 bg-green-500/5 border border-green-500/20 rounded-lg flex items-end gap-3 flex-wrap">
                        <div className="flex-1 min-w-[180px]">
                          <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Receiver name *</label>
                          <input autoFocus type="text" value={acceptReceiverName} onChange={e => setAcceptReceiverName(e.target.value)}
                            placeholder="Staff name" className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-green-500" />
                        </div>
                        <Button variant="success" size="sm" disabled={acceptLoading} onClick={() => confirmAcceptTransfer(r)}>
                          {acceptLoading ? 'Processing…' : 'Confirm accept'}
                        </Button>
                        <Button variant="default" size="sm" onClick={() => { setAcceptingId(null); setAcceptReceiverName('') }}>Cancel</Button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </Card>
          )}

          {/* Request history */}
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
                  <button onClick={() => loadRequestHistory(reqHistFrom, reqHistTo)} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">Refresh</button>
                </div>
              </CardHeader>
              {loadingReqHist ? <LoadingState /> : requestHistory.length === 0 ? <EmptyState message="No request history" /> : (
                <div className="table-wrap"><table className="w-full text-sm">
                  <thead><tr className="border-b border-white/8 bg-white/2">
                    {['Date', 'Commodity', 'Qty requested', 'Qty issued', 'From', 'To', 'Status', 'Compiled by'].map(h => (
                      <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>{requestHistory.map(r => {
                    const sc = r.status === 'requested' ? 'text-amber-400' : r.status === 'pending' ? 'text-purple-400' : r.status === 'in_transit' ? 'text-blue-400' : r.status === 'accepted' ? 'text-green-400' : 'text-gray-400'
                    return (
                      <tr key={r.id} className="border-b border-white/5 hover:bg-white/2">
                        <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDate(r.initiated_at)}</td>
                        <td className="px-4 py-3 font-medium text-gray-100">{r.commodity_name}</td>
                        <td className="px-4 py-3 font-mono text-sm text-gray-300">{r.qty_requested ?? r.quantity}{commUnit(r.commodity_id) ? ` ${commUnit(r.commodity_id)}` : ''}</td>
                        <td className="px-4 py-3 font-mono text-sm">
                          {r.qty_requested != null && r.quantity !== r.qty_requested
                            ? <span className="text-green-400">{r.quantity}{commUnit(r.commodity_id) ? ` ${commUnit(r.commodity_id)}` : ''}</span>
                            : <span className="text-gray-500">—</span>}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500">{r.sending_facility_name || '—'}</td>
                        <td className="px-4 py-3 text-xs text-gray-500">{r.receiving_facility_name || '—'}</td>
                        <td className={`px-4 py-3 text-xs font-semibold ${sc}`}>{r.status}</td>
                        <td className="px-4 py-3 text-xs text-gray-500">{r.initiated_by || '—'}</td>
                      </tr>
                    )
                  })}</tbody>
                </table></div>
              )}
            </Card>
          )}
        </>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          INTERNAL REDISTRIBUTION GROUP
      ══════════════════════════════════════════════════════════════════════ */}
      {primary === 'internal' && (
        <>
          <BackButton />
          <div className="flex gap-1.5 mb-4 flex-wrap border-b border-white/8 pb-3">
            {!isDSD && <SubTab id="dispensary" current={intSub} onChange={setIntSub} label="Store to Dispensary" badge={intPendingApprovals.length} />}
            {!isDispenser && <SubTab id="dsd" current={intSub} onChange={setIntSub} label="Send to DSD" badge={dsdPendingApprovals.length} />}
            {!isDispenser && !isDSD && <SubTab id="history" current={intSub} onChange={setIntSub} label="History" />}
          </div>

          {/* Internal history */}
          {intSub === 'history' && (
            <Card>
              <CardHeader>
                <CardTitle>Internal redistribution history</CardTitle>
                <div className="flex items-center gap-2 flex-wrap">
                  <input type="date" value={intHistFrom} onChange={e => setIntHistFrom(e.target.value)}
                    className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500" />
                  <span className="text-xs text-gray-600">to</span>
                  <input type="date" value={intHistTo} onChange={e => setIntHistTo(e.target.value)}
                    className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500" />
                  <button onClick={() => loadAllIntHistory(intHistFrom, intHistTo)} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">Refresh</button>
                </div>
              </CardHeader>
              <HistoryTable rows={allIntHistory} loading={loadingAllInt} emptyMsg="No internal redistributions recorded." />
            </Card>
          )}

          {/* Store → Dispensary */}
          {intSub === 'dispensary' && (
            <>
              <Card>
                <CardHeader><CardTitle>Internal redistribution: Store to Dispensary</CardTitle></CardHeader>
                <CardBody>
                  <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-4 py-3 text-sm text-blue-300 mb-4">
                    Moving stock from <strong className="text-blue-100">Store</strong> to <strong className="text-blue-100">Dispensary</strong> — submit for store manager approval
                  </div>
                  <form onSubmit={submitInternal} className="space-y-4">
                    <MultiCommodityLines lines={intLines} updateLine={updateIntLine} addLine={addIntLine} removeLine={removeIntLine} categories={categories} label="commodity" />
                    <div>
                      <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Requested by *</label>
                      <input type="text" value={intRequestedBy} onChange={e => setIntRequestedBy(e.target.value)} placeholder="Staff name or ID" required className={inputCls} />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Notes (optional)</label>
                      <input type="text" value={intNotes} onChange={e => setIntNotes(e.target.value)} placeholder="e.g. daily restocking" className={inputCls} />
                    </div>
                    {intMsg && <div className={`rounded-lg px-4 py-3 text-sm ${intMsg.type === 'error' ? 'bg-red-500/10 border border-red-500/20 text-red-400' : 'bg-green-500/10 border border-green-500/20 text-green-400'}`}>{intMsg.text}</div>}
                    <Button type="submit" variant="success" size="lg" disabled={intSending} className="w-full">{intSending ? 'Submitting…' : 'Submit for approval'}</Button>
                  </form>
                </CardBody>
              </Card>

              {canManage && (
                <Card>
                  <CardHeader>
                    <CardTitle>Pending approvals{intPendingApprovals.length > 0 ? ` (${intPendingApprovals.length})` : ''}</CardTitle>
                    <button onClick={loadIntPendingApprovals} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">Refresh</button>
                  </CardHeader>
                  {loadingIntPending ? <LoadingState /> : intPendingApprovals.length === 0 ? <EmptyState message="No pending approvals" /> : (
                    intPendingApprovals.map(r => (
                      <div key={r.id} className="px-5 py-4 border-b border-white/8 last:border-0">
                        <div className="flex items-start justify-between gap-4 flex-wrap">
                          <div className="flex-1">
                            <div className="font-medium text-gray-100 mb-1">{r.commodity_name}</div>
                            <div className="text-sm text-gray-400"><span className="font-medium text-gray-200">{r.quantity}</span>{commUnit(r.commodity_id) ? ` ${commUnit(r.commodity_id)}` : ''} to dispensary</div>
                            <div className="text-xs text-gray-600 mt-1">Submitted {fmtDate(r.initiated_at)} by {r.initiated_by || '—'}</div>
                            {r.notes && <div className="text-xs text-gray-500 mt-1">{r.notes}</div>}
                          </div>
                          <div className="flex gap-2 flex-wrap">
                            {intApprovingId === r.id ? (
                              <div className="flex items-end gap-2 flex-wrap">
                                <div>
                                  <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Approved by store manager *</label>
                                  <input type="text" value={intApprovedBy} onChange={e => setIntApprovedBy(e.target.value)} placeholder="Store manager name"
                                    className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500 w-52" />
                                </div>
                                <Button variant="success" size="sm" onClick={() => approveInternal(r)} disabled={intApproving}>{intApproving ? 'Approving…' : 'Confirm'}</Button>
                                <Button variant="ghost" size="sm" onClick={() => { setIntApprovingId(null); setIntApprovedBy('') }}>Cancel</Button>
                              </div>
                            ) : (
                              <><Button variant="success" size="sm" onClick={() => { setIntApprovingId(r.id); setIntApprovedBy('') }}>Approve</Button>
                                <Button variant="danger" size="sm" onClick={() => rejectInternal(r.id)}>Reject</Button></>
                            )}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </Card>
              )}

              <Card>
                <CardHeader><CardTitle>Store to Dispensary history</CardTitle></CardHeader>
                <HistoryTable rows={intHistory} loading={loadingI} emptyMsg="No store-to-dispensary redistributions recorded." />
              </Card>
            </>
          )}

          {/* DSD */}
          {intSub === 'dsd' && (
            <>
              <Card>
                <CardHeader><CardTitle>Internal redistribution: Send to DSD</CardTitle></CardHeader>
                <CardBody>
                  <div className="bg-purple-500/10 border border-purple-500/20 rounded-lg px-4 py-3 text-sm text-purple-300 mb-4">
                    Moving stock from <strong className="text-purple-100">Store</strong> to <strong className="text-purple-100">DSD site</strong> — submit for store manager approval
                  </div>
                  <form onSubmit={submitDsd} className="space-y-4">
                    {isDSD ? (
                      <div>
                        <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">DSD Site</label>
                        <div className="bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-sm text-gray-100">{userDsdSiteName}</div>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">DSD type *</label>
                          <select value={dsdType} onChange={e => setDsdType(e.target.value)} required className={inputCls}>
                            <option value="">Select DSD type…</option>
                            <option value="Community Pharmacy">Community Pharmacy</option>
                            <option value="Decentralized Hub & Spoke">Decentralized Hub &amp; Spoke</option>
                            <option value="Other">Other</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">DSD site name *</label>
                          <input type="text" value={dsdSiteName} onChange={e => setDsdSiteName(e.target.value)} required className={inputCls} />
                        </div>
                      </div>
                    )}
                    <MultiCommodityLines lines={dsdLines} updateLine={updateDsdLine} addLine={addDsdLine} removeLine={removeDsdLine} categories={categories} label="commodity" />
                    <div>
                      <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Sent by *</label>
                      <input type="text" value={dsdSentBy} onChange={e => setDsdSentBy(e.target.value)} placeholder="Staff name or ID" required className={inputCls} />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Notes (optional)</label>
                      <input type="text" value={dsdNotes} onChange={e => setDsdNotes(e.target.value)} placeholder="Additional details" className={inputCls} />
                    </div>
                    {dsdMsg && <div className={`rounded-lg px-4 py-3 text-sm ${dsdMsg.type === 'error' ? 'bg-red-500/10 border border-red-500/20 text-red-400' : 'bg-green-500/10 border border-green-500/20 text-green-400'}`}>{dsdMsg.text}</div>}
                    <Button type="submit" variant="success" size="lg" disabled={dsdSending} className="w-full">{dsdSending ? 'Submitting…' : 'Submit for approval'}</Button>
                  </form>
                </CardBody>
              </Card>

              {canManage && (
                <Card>
                  <CardHeader>
                    <CardTitle>Pending DSD approvals{dsdPendingApprovals.length > 0 ? ` (${dsdPendingApprovals.length})` : ''}</CardTitle>
                    <button onClick={loadDsdPendingApprovals} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">Refresh</button>
                  </CardHeader>
                  {loadingDsdPending ? <LoadingState /> : dsdPendingApprovals.length === 0 ? <EmptyState message="No pending DSD approvals" /> : (
                    dsdPendingApprovals.map(r => (
                      <div key={r.id} className="px-5 py-4 border-b border-white/8 last:border-0">
                        <div className="flex items-start justify-between gap-4 flex-wrap">
                          <div className="flex-1">
                            <div className="font-medium text-gray-100 mb-1">{r.commodity_name}</div>
                            <div className="text-sm text-gray-400">
                              <span className="text-gray-500">Required:</span> <span className="font-medium text-gray-200">{r.notes?.match(/required:(\d+)/)?.[1] ?? r.qty_requested ?? r.quantity}</span>{commUnit(r.commodity_id) ? ` ${commUnit(r.commodity_id)}` : ''}
                              {r.notes?.match(/balance:(\d+)/)?.[1] && <span className="ml-3 text-gray-600">Balance: {r.notes.match(/balance:(\d+)/)[1]}</span>}
                              <span className="ml-3">→ <span className="text-purple-400">{r.receiving_facility_name}</span></span>
                            </div>
                            <div className="text-xs text-gray-600 mt-1">Submitted {fmtDate(r.initiated_at)} by {r.initiated_by || '—'}</div>
                          </div>
                          <div className="flex gap-2 flex-wrap items-center">
                            {dsdApprovingId === r.id ? (
                              <div className="flex flex-col gap-2">
                                <div className="flex items-end gap-2 flex-wrap">
                                  <div>
                                    <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Stock issued *</label>
                                    <input type="number" min="1" value={dsdIssuedQty} onChange={e => setDsdIssuedQty(e.target.value)} placeholder={r.qty_requested || r.quantity}
                                      className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500 w-28" />
                                  </div>
                                  <div>
                                    <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Approved by store manager *</label>
                                    <input type="text" value={dsdApprovedBy} onChange={e => setDsdApprovedBy(e.target.value)} placeholder="Store manager name"
                                      className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500 w-52" />
                                  </div>
                                </div>
                                <div className="flex gap-2">
                                  <Button variant="success" size="sm" onClick={() => approveDsd(r)} disabled={dsdApproving}>{dsdApproving ? 'Approving…' : 'Approve & Dispatch'}</Button>
                                  <Button variant="ghost" size="sm" onClick={() => { setDsdApprovingId(null); setDsdApprovedBy(''); setDsdIssuedQty('') }}>Cancel</Button>
                                </div>
                              </div>
                            ) : (
                              <><Button variant="success" size="sm" onClick={() => { setDsdApprovingId(r.id); setDsdApprovedBy(''); setDsdIssuedQty('') }}>Approve</Button>
                                <Button variant="danger" size="sm" onClick={() => rejectDsd(r.id)}>Reject</Button></>
                            )}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </Card>
              )}

              {canManage && (
                <Card>
                  <CardHeader>
                    <CardTitle>Dispatched — awaiting DSD confirmation{dsdDispatched.length > 0 ? ` (${dsdDispatched.length})` : ''}</CardTitle>
                    <button onClick={loadDsdDispatched} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">Refresh</button>
                  </CardHeader>
                  {loadingDsdDispatched ? <LoadingState /> : dsdDispatched.length === 0 ? <EmptyState message="No dispatched DSD transfers awaiting confirmation" /> : (
                    dsdDispatched.map(r => (
                      <div key={r.id} className="px-5 py-4 border-b border-white/8 last:border-0">
                        <div className="flex items-start justify-between gap-4 flex-wrap">
                          <div className="flex-1">
                            <div className="font-medium text-gray-100 mb-1">{r.commodity_name}</div>
                            <div className="text-sm text-gray-400">
                              <span className="text-gray-500">Qty dispatched:</span> <span className="font-medium text-gray-200">{r.quantity}</span>{commUnit(r.commodity_id) ? ` ${commUnit(r.commodity_id)}` : ''}
                              <span className="ml-3">→ <span className="text-purple-400">{r.receiving_facility_name}</span></span>
                            </div>
                            <div className="text-xs text-gray-600 mt-1">Approved {fmtDate(r.resolved_at)} by {r.resolved_by?.match(/\[Approved: ([^\]]+)\]/)?.[1] || '—'}</div>
                          </div>
                          <div className="text-xs text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded-full px-2 py-0.5 h-fit">
                            In transit
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </Card>
              )}

              <Card>
                <CardHeader><CardTitle>DSD redistribution history</CardTitle></CardHeader>
                <HistoryTable rows={dsdHistory} loading={loadingD} emptyMsg="No DSD redistributions recorded." />
              </Card>
            </>
          )}
        </>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          EXTERNAL REDISTRIBUTION
      ══════════════════════════════════════════════════════════════════════ */}
      {!isDispenser && !isDSD && primary === 'external' && (
        <>
          <BackButton />
          <div className="flex gap-1.5 mb-4 flex-wrap border-b border-white/8 pb-3">
            <SubTab id="form"    current={extSub} onChange={setExtSub} label="Send transfer" />
            <SubTab id="history" current={extSub} onChange={setExtSub} label="History" />
          </div>

          {extSub === 'form' && (
            <Card>
              <CardHeader><CardTitle>External redistribution</CardTitle></CardHeader>
              <CardBody>
                <form onSubmit={sendTransfer} className="space-y-4">
                  <div className="bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-sm text-gray-300">
                    Sending from: <strong className="text-gray-100">{myFac?.name || '—'}</strong>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Commodity</label>
                      <select value={commId} onChange={e => setCommId(e.target.value)} className={inputCls}>
                        <option value="">Select commodity…</option>
                        {Object.entries(categories).sort().map(([cat, comms]) => (
                          <optgroup key={cat} label={cat}>{comms.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>
                        ))}
                      </select>
                      {commId && stockRow && <p className="text-xs text-gray-500 mt-1">Available: {stockRow.quantity} {selectedComm?.unit || 'units'}</p>}
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Quantity to send</label>
                      <input type="number" min="1" value={qty} onChange={e => setQty(e.target.value)} className={inputCls} />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Receiving facility</label>
                    <div className="space-y-2">
                      <select value={selectedState} onChange={e => { setSelectedState(e.target.value); setSelectedLga(''); setRecFacId('') }} className={inputCls}>
                        <option value="">Select state…</option>
                        {states.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                      {selectedState && (
                        <select value={selectedLga} onChange={e => { setSelectedLga(e.target.value); setRecFacId('') }} className={inputCls}>
                          <option value="">Select LGA…</option>
                          {lgas.map(l => <option key={l} value={l}>{l}</option>)}
                        </select>
                      )}
                      {selectedLga && (
                        <select value={recFacId} onChange={e => setRecFacId(e.target.value)} className={inputCls}>
                          <option value="">Select facility…</option>
                          {facilities.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                        </select>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Expiry date *</label>
                      <input type="date" value={sendExpiry} onChange={e => setSendExpiry(e.target.value)} className={inputCls} />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Batch / lot number *</label>
                      <input type="text" value={sendBatch} onChange={e => setSendBatch(e.target.value)} placeholder="e.g. LOT2024A001" className={inputCls} />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Sent by *</label>
                      <input type="text" value={sentBy} onChange={e => setSentBy(e.target.value)} placeholder="Staff name or ID" required className={inputCls} />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Record approved by *</label>
                      <input type="text" value={sendApprovedBy} onChange={e => setSendApprovedBy(e.target.value)} placeholder="Approving officer name" required className={inputCls} />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Carrier *</label>
                    <input type="text" value={sendCarrier} onChange={e => setSendCarrier(e.target.value)} placeholder="Carrier / transporter name" required className={inputCls} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Notes / reason (optional)</label>
                    <input type="text" value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. surplus stock, emergency supply" className={inputCls} />
                  </div>
                  {msg && <div className={`rounded-lg px-4 py-3 text-sm ${msg.type === 'error' ? 'bg-red-500/10 border border-red-500/20 text-red-400' : 'bg-green-500/10 border border-green-500/20 text-green-400'}`}>{msg.text}</div>}
                  <Button type="submit" variant="success" size="lg" disabled={sending}>{sending ? 'Sending…' : 'Send transfer request'}</Button>
                </form>
              </CardBody>
            </Card>
          )}

          {extSub === 'history' && (
            <Card>
              <CardHeader>
                <CardTitle>External redistribution history</CardTitle>
                <div className="flex items-center gap-2 flex-wrap">
                  <input type="date" value={extHistFrom} onChange={e => setExtHistFrom(e.target.value)}
                    className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500" />
                  <span className="text-xs text-gray-600">to</span>
                  <input type="date" value={extHistTo} onChange={e => setExtHistTo(e.target.value)}
                    className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500" />
                  <button onClick={() => loadSendHistory(extHistFrom, extHistTo)} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">Refresh</button>
                </div>
              </CardHeader>
              <HistoryTable rows={sendHistory} loading={loadingS} emptyMsg="No external redistributions recorded." />
            </Card>
          )}
        </>
      )}
    </div>
  )
}
