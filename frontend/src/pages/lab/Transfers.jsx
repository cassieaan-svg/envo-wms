import { useState, useEffect, useRef } from 'react'
import { api } from '../../lib/api'
import { subscribeRealtime } from '../../lib/realtime'
import { useAppStore } from '../../store/appStore'
import { useStock } from '../../hooks/useStock'
import { toast } from '../../components/ui/Toast'
import { Card, CardHeader, CardTitle, CardBody } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { CommoditySelect } from '../../components/ui/CommoditySelect'
import { BatchSelect } from '../../components/ui/BatchSelect'
import { Badge } from '../../components/ui/Badge'
import { LoadingState, EmptyState } from '../../components/ui/Loading'
import { fmtDate, SECTION_CATEGORIES, transferReason, expiredDispatchWarning, reviewerNameOf, explicitReviewerName } from '../../utils/helpers'
import { TransferLotInfo, hasExpiredLot, earliestExpiredExpiry } from '../../components/TransferLotInfo'

const inputCls = "w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"

function MultiCommodityLines({ lines, updateLine, addLine, removeLine, categories, label = 'commodity', hideStockIssued = false }) {
  return (
    <div className="space-y-3">
      {lines.map((line, idx) => (
        <div key={line.id} className={`grid gap-3 items-end p-3 bg-white/3 rounded-lg border border-white/8 ${hideStockIssued ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-2 sm:grid-cols-5'}`}>
          <div className="col-span-2 sm:col-span-2">
            <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Commodity *</label>
            <CommoditySelect categories={categories} value={line.commodity_id} onChange={id => updateLine(line.id, 'commodity_id', id)?.catch?.()} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Stock balance</label>
            <input type="number" value={line.stock_balance} readOnly className={`${inputCls} opacity-60 cursor-not-allowed`} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Stock required *</label>
            <input type="number" min="1" value={line.stock_required} onChange={e => updateLine(line.id, 'stock_required', e.target.value)} required className={inputCls} />
          </div>
          {!hideStockIssued && (
            <div>
              <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Stock issued *</label>
              <input type="number" min="1" value={line.stock_issued} onChange={e => updateLine(line.id, 'stock_issued', e.target.value)} required className={inputCls} />
            </div>
          )}
          <div className={`${hideStockIssued ? 'col-span-2 sm:col-span-4' : 'col-span-2 sm:col-span-5'} flex gap-2 justify-end`}>
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
  const isSDP       = accessLevel === 'facility' && facilityRole === 'sdp'
  const sdpName     = useAppStore(s => s.sdpName)
  const getStore = useAppStore.getState

  // Two-level navigation
  const [primary, setPrimary] = useState(null)
  const [reqSub, setReqSub]   = useState('pending')
  const [intSub, setIntSub]   = useState('dsd')  // lab has no dispensary — default to SDP
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
  // Partial dispute: how much of the delivery the receiver is keeping, + reason.
  const [disputingId, setDisputingId] = useState(null)
  const [disputeQtyAccepted, setDisputeQtyAccepted] = useState(0)
  const [disputeReason, setDisputeReason] = useState('')
  const [disputeByName, setDisputeByName] = useState('')
  const [disputeLoading, setDisputeLoading] = useState(false)
  const [dispatchingId, setDispatchingId] = useState(null)
  // Left empty here on purpose. The dispatch panel only renders after "Arrange
  // transfer" is clicked, and that handler seeds these from dispatchSigner() — by
  // which point the session has certainly hydrated. Seeding them at mount instead
  // would capture an empty store on first paint and silently never fill.
  const [dispatchApprovedBy, setDispatchApprovedBy] = useState('')
  const [dispatchCarrier, setDispatchCarrier] = useState('')
  const [dispatchExpiry, setDispatchExpiry] = useState('')
  const [dispatchBatch, setDispatchBatch] = useState('')
  const [dispatchQty, setDispatchQty] = useState(1)
  const [dispatchLoading, setDispatchLoading] = useState(false)
  const [dispatchLots, setDispatchLots] = useState([])

  // Admin assign & arrange state
  const [assigningId, setAssigningId]           = useState(null)
  const [assignFacState, setAssignFacState]     = useState('')
  const [assignFacLga, setAssignFacLga]         = useState('')
  const [assignFacId, setAssignFacId]           = useState('')
  // Prefilled with the signed-in admin's name, same as the Alerts review panel.
  // Editable, so a colleague signing off can type over it.
  const sessionUser = useAppStore(s => s.user)
  const [assignApprovedBy, setAssignApprovedBy] = useState(() => reviewerNameOf(sessionUser))

  // Who this account signs its own dispatches as, and who carries them. Only set for
  // accounts given an explicit reviewer_name (e.g. the Lagos State Office Store, where
  // one officer both approves and transports); '' for everyone else, leaving the
  // fields blank and required exactly as before. Read at call time, never captured.
  const dispatchSigner = () => explicitReviewerName(sessionUser)
  const [assignCarrier, setAssignCarrier]       = useState('')
  const [assignQty, setAssignQty]               = useState(1)
  const [assignLoading, setAssignLoading]       = useState(false)

  // External redistribution
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

  // Request for redistribution
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
  const [intIssuedQty, setIntIssuedQty] = useState('')
  const [intApproving, setIntApproving] = useState(false)
  // Batch being issued out of the store (null = FEFO). Chosen at approval,
  // because that is when the stock actually leaves the store.
  const [intApproveBatch, setIntApproveBatch] = useState(null)
  const [intHistory, setIntHistory] = useState([])
  const [loadingI, setLoadingI] = useState(false)

  // Service Delivery Point form
  const [dsdLines, setDsdLines] = useState([{ id: Date.now(), commodity_id: '', stock_balance: 0, stock_required: 1, stock_issued: 1 }])
  const [dsdType, setDsdType] = useState('')
  const [dsdCtNumber, setDsdCtNumber] = useState('')
  const [dsdSentBy, setDsdSentBy] = useState('')
  const [dsdNotes, setDsdNotes] = useState('')
  const [dsdSending, setDsdSending] = useState(false)
  const [dsdMsg, setDsdMsg] = useState(null)
  const [dsdPendingApprovals, setDsdPendingApprovals] = useState([])
  const [loadingDsdPending, setLoadingDsdPending] = useState(false)
  const [dsdApprovingId, setDsdApprovingId] = useState(null)
  const [dsdApprovedBy, setDsdApprovedBy] = useState('')
  const [dsdIssuedQty, setDsdIssuedQty] = useState('')
  const [dsdReceivedBy, setDsdReceivedBy] = useState('')
  const [dsdApproving, setDsdApproving] = useState(false)
  const [dsdApproveBatch, setDsdApproveBatch] = useState(null)
  const [dsdApproveLots, setDsdApproveLots] = useState([])   // raw on-hand lots for the expiry warning
  const [dsdHistory, setDsdHistory] = useState([])
  const [loadingD, setLoadingD] = useState(false)

  // All internal history (combined)
  const [allIntHistory, setAllIntHistory] = useState([])
  const [loadingAllInt, setLoadingAllInt] = useState(false)

  const fid = currentFacility?.id
  const myFac = currentFacility
  const stockRow = stockData.find(r => r.commodity_id === commId && r.facility_id === fid && r.location_type === 'store')
  const selectedComm = allCommodities.find(c => c.id === commId)

  const labCommodities = allCommodities.filter(c => SECTION_CATEGORIES.lab.includes(c.category))
  const categories = {}
  labCommodities.forEach(c => {
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

  const accessRestricted = !(canManage || isDispenser || isSDP)

  useEffect(() => {
    if (primary === 'internal' && isSDP) setIntSub('dsd')
  }, [primary])

  useEffect(() => {
    loadPending(true); loadMyRequests(); loadRequestHistory(); loadSendHistory()
    loadIntPendingApprovals(); loadIntHistory(); loadDsdPendingApprovals(); loadDsdHistory()
    loadAllIntHistory()

    return subscribeRealtime(['stock_transfer_log'], async (payload) => {
        await loadPendingSilent()
        await loadMyRequests()
        loadSendHistory()
        loadRequestHistory()
        // Refresh service-delivery-point approvals so a store manager sees
        // new SDP requests arrive live (not only on next login).
        loadDsdPendingApprovals()

        if (fid) {
          const newRow = payload.new || {}
          if (newRow.status === 'in_transit') {
            const rowId = newRow.id || payload.old?.id
            if (rowId) {
              const fullRow = await api.transfers.get(rowId).catch(() => null)
              if (fullRow?.receiving_facility_id === fid) {
                setPrimary('request')
                setReqSub('alerts')
                toast(`${fullRow.commodity_name || 'Transfer'} dispatched to you — accept or dispute`, 'green')
              }
            }
          }
        }
    })
  }, [fid])

  // ── Pending ───────────────────────────────────────────────────────────────
  async function loadPending(showSpinner = false) {
    if (showSpinner) setLoadingP(true)
    const data = await api.transfers.list({
      facility_id: fid || undefined,
      status: 'pending,in_transit,disputed',
      section: commoditySection || undefined,
    }).catch(() => [])
    setPending(data || [])
    if (showSpinner) setLoadingP(false)
  }

  function loadPendingSilent() { return loadPending(false) }

  async function confirmDispatch(t) {
    // Batch picks decided up front: they determine which fields are required.
    // `selected` non-null IS the pick — BatchSelect reports FEFO as onSelect(null).
    // Do NOT also test batch_number: lots received without one are listed as
    // "(no batch)" and carry batch_number '', so testing it silently reclassified a
    // deliberate pick as FEFO and then demanded a typed expiry for it.
    const pickedLots = (dispatchLots || []).filter(d => d.selected)

    if (!dispatchApprovedBy.trim()) { toast('Record approved by is required', 'red'); return }
    if (!dispatchCarrier.trim()) { toast('Carrier is required', 'red'); return }
    // Expiry is typed by hand ONLY on the FEFO path. When batches are picked from
    // the ledger each one already carries its expiry_date, so demanding a typed one
    // asks for data the screen already has. There is deliberately no dispatchBatch
    // check: the picker replaced that input, so nothing can set it any more.
    if (!pickedLots.length && !dispatchExpiry.trim()) {
      toast('Expiry date is required', 'red'); return
    }
    const parsedQty = parseInt(dispatchQty)
    if (!parsedQty || parsedQty < 1) { toast('Qty issued must be at least 1', 'red'); return }
    setDispatchLoading(true)
    // Server marks in_transit, sets qty, appends the dispatch note, and decrements sender store.
    let updatedRow
    try {
      if (pickedLots.length) {
        const totalPicked = pickedLots.reduce((s, l) => s + (parseInt(l.qty) || 0), 0)
        if (totalPicked !== parsedQty) { toast(`Sum of selected batch quantities (${totalPicked}) must equal issued qty (${parsedQty})`, 'red'); setDispatchLoading(false); return }
        const lotsPayload = pickedLots.map(l => ({ batch: l.selected.batch_number || null, quantity: parseInt(l.qty) }))
        // Derive the paper-form metadata from the batches actually drawn, so the
        // dispatch note still records a batch and an expiry. Earliest expiry across
        // the picked lots — that is the date the consignment as a whole is good to.
        // filter(Boolean): a lot received without a batch number contributes nothing
        // to the label rather than an empty segment (", ").
        const batchLabel = [...new Set(pickedLots.map(l => l.selected.batch_number).filter(Boolean))]
          .join(', ') || '(no batch)'
        const earliestExpiry = pickedLots
          .map(l => l.selected.expiry_date).filter(Boolean).sort()[0] || dispatchExpiry.trim()
        updatedRow = await api.transfers.dispatch(t.id, {
          approved_by: dispatchApprovedBy.trim(),
          carrier: dispatchCarrier.trim(),
          expiry: earliestExpiry,
          batch: batchLabel,
          quantity: parsedQty,
          lots: lotsPayload,
        })
      } else {
        updatedRow = await api.transfers.dispatch(t.id, {
          approved_by: dispatchApprovedBy.trim(),
          carrier: dispatchCarrier.trim(),
          expiry: dispatchExpiry.trim(),
          batch: dispatchBatch.trim(),
          quantity: parsedQty,
        })
      }
    } catch (error) { toast('Error confirming dispatch: ' + error.message, 'red'); setDispatchLoading(false); return }
    await loadStock()
    toast('Transfer dispatched — awaiting receiver acceptance', 'green')
    setPending(prev => prev.map(p => p.id === t.id ? { ...p, status: 'in_transit', quantity: parsedQty, notes: updatedRow?.notes ?? p.notes } : p))
    setDispatchingId(null); setDispatchApprovedBy(dispatchSigner()); setDispatchCarrier(dispatchSigner()); setDispatchExpiry(''); setDispatchBatch(''); setDispatchQty(1); setDispatchLots([]); setDispatchLoading(false)
  }

  async function confirmAssignFacility(t) {
    if (!assignFacId) { toast('Select a source facility', 'red'); return }
    if (!assignApprovedBy.trim()) { toast('Reviewed by is required', 'red'); return }
    const parsedQty = parseInt(assignQty)
    if (!parsedQty || parsedQty < 1) { toast('Qty must be at least 1', 'red'); return }
    setAssignLoading(true)
    const srcFac = allFacilities.find(f => f.id === assignFacId)
    try {
      await api.transfers.assignSource(t.id, {
        sending_facility_id: assignFacId,
        sending_facility_name: srcFac?.name || '',
        quantity: parsedQty,
        reviewed_by: assignApprovedBy.trim(),
      })
    } catch (error) { toast('Error assigning facility: ' + error.message, 'red'); setAssignLoading(false); return }
    toast(`Request sent to ${srcFac?.name || 'facility'}`, 'green')
    setAssigningId(null); setAssignFacState(''); setAssignFacLga(''); setAssignFacId('')
    setAssignApprovedBy(''); setAssignCarrier(''); setAssignQty(1); setAssignLoading(false)
    loadPendingSilent()
  }

  async function confirmAcceptTransfer(t) {
    if (!acceptReceiverName.trim()) { toast('Receiver name is required', 'red'); return }
    if (!t.sending_facility_id) { toast('Transfer has no sending facility — cannot accept', 'red'); return }
    setAcceptLoading(true)
    // Server credits the receiver store, writes the intake_log entry, and marks accepted.
    try {
      await api.transfers.accept(t.id, { received_by: acceptReceiverName.trim() })
    } catch (updateErr) { toast('Error updating transfer status: ' + updateErr.message, 'red'); setAcceptLoading(false); return }
    setAcceptingId(null); setAcceptReceiverName(''); setAcceptLoading(false)
    toast('Transfer accepted — stock updated', 'green')
    await loadStock(); loadPending(); loadMyRequests()
  }

  // A dispute can be partial: the receiver states how much of the delivery they
  // are keeping and gives a reason. The server credits the kept quantity here and
  // returns the rest to the sender's store, then closes the transfer as disputed.
  function openDispute(t) {
    const u = getStore().user
    setDisputingId(t.id); setDisputeQtyAccepted(0); setDisputeReason('')
    setDisputeByName(u?.user_metadata?.full_name || u?.user_metadata?.name || '')
  }

  async function confirmDispute(t) {
    const note = disputeReason.trim()
    if (!note) { toast('Please enter a reason for the dispute', 'red'); return }
    const dispatched = t.quantity || 0
    const accepted = parseInt(disputeQtyAccepted) || 0
    if (accepted < 0 || accepted > dispatched) {
      toast(`Qty accepted must be between 0 and ${dispatched}`, 'red'); return
    }
    // Both rows record a person, never a login: the dispute is attributed to
    // this name, and any accepted portion prints it on the national Transfer &
    // Return form as the receiver.
    const byName = disputeByName.trim()
    if (!byName) { toast('Please enter your name', 'red'); return }
    setDisputeLoading(true)
    try {
      await api.transfers.dispute(t.id, {
        disputed_by: byName,
        facilityId: fid,
        dispute_note: note,
        qty_accepted: accepted,
        received_by: byName,
      })
    } catch (dispErr) { toast('Error disputing transfer: ' + dispErr.message, 'red'); setDisputeLoading(false); return }
    const returned = dispatched - accepted
    toast(accepted > 0
      ? `Disputed — ${accepted} accepted, ${returned} returned to ${t.sending_facility_name || 'sender'}`
      : 'Transfer disputed — stock returned to sender', 'amber')
    setDisputingId(null); setDisputeReason(''); setDisputeQtyAccepted(0); setDisputeByName(''); setDisputeLoading(false)
    await loadStock(); loadPending(); loadMyRequests()
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
  async function loadMyRequests() {
    if (!fid) return
    const data = await api.transfers.list({
      facility_id: fid, direction: 'incoming', status: 'pending,in_transit',
      section: commoditySection || undefined,
    }).catch(() => [])
    setMyRequests(data || [])
  }

  async function loadRequestHistory(from, to) {
    if (!fid) return
    const f = from || reqHistFrom; const t2 = to || reqHistTo
    setLoadingReqHist(true)
    const data = await api.transfers.list({
      // The requesting facility's own record of requests they made — the full
      // lifecycle: still in transit (dispatched, awaiting their acceptance),
      // accepted, refused (disputed) and cancelled/dismissed.
      facility_id: fid, direction: 'incoming', status: 'accepted,cancelled,dismissed,in_transit,disputed',
      date_field: 'initiated_at', from: f, to: t2, limit: 200,
      section: commoditySection || undefined,
    }).catch(() => [])
    // External redistributions only: a real facility→facility move (both parties
    // set and different), never an internal store→dispensary/DSD/SDP redistribution.
    const ext = (data || []).filter(r => r.sending_facility_id && r.receiving_facility_id
      && r.sending_facility_id !== r.receiving_facility_id
      && !r.notes?.includes('[Internal:') && !r.notes?.includes('[DSD:') && !r.notes?.includes('[SDP:'))
    setRequestHistory(ext); setLoadingReqHist(false)
  }

  async function cancelRequest(id) {
    // Cancelling / refusing a transfer captures an optional reason (e.g. out of
    // stock, cannot fulfil) recorded on the transfer notes as [Cancelled: …].
    const reason = window.prompt('Reason for cancelling / refusing this transfer (optional):', '')
    if (reason === null) return
    await api.transfers.cancel(id, { cancelled_by: getStore().user?.email || '', reason: reason.trim() || undefined }).catch(() => {})
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
    try {
      await api.transfers.create(payload)
    } catch (error) { setReqMsg({ type: 'error', text: 'Error: ' + error.message }); setReqSending(false); return }
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
    const data = await api.transfers.list({
      facility_id: fid, status: 'accepted,disputed',
      date_field: 'resolved_at', from: f, to: t2, limit: 200,
      section: commoditySection || undefined,
    }).catch(() => [])
    // External redistributions only (a real facility→facility move, both sides set
    // and different), for BOTH directions — the transferring facility and the
    // receiving facility each see the resolved move and can print it.
    setSendHistory((data || []).filter(t => t.sending_facility_id && t.receiving_facility_id
      && t.sending_facility_id !== t.receiving_facility_id
      && !t.notes?.includes('[Internal:') && !t.notes?.includes('[SDP:') && !t.notes?.includes('[DSD:')))
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
    try {
      await api.transfers.create({
        sending_facility_id: fid, sending_facility_name: myFac?.name || '',
        receiving_facility_id: recFacId, receiving_facility_name: recFac?.name || '',
        commodity_id: commId, commodity_name: comm?.name || '',
        quantity: parseInt(qty), qty_requested: parseInt(qty), status: 'in_transit', initiated_by: sentBy || '',
        initiated_at: new Date().toISOString(), notes: fullNotes,
        section: commoditySection,
      })
    } catch (error) { setMsg({ type: 'error', text: 'Error: ' + error.message }); setSending(false); return }
    toast('Transfer dispatched to ' + recFac?.name, 'green')
    setMsg({ type: 'success', text: 'Transfer dispatched. Awaiting receiver acceptance.' })
    setCommId(''); setQty(1); setRecFacId(''); setNotes(''); setSentBy(''); setSendExpiry(''); setSendBatch(''); setSendApprovedBy(''); setSendCarrier('')
    loadPending(); setSending(false)
  }

  // ── Internal redistribution ───────────────────────────────────────────────
  function addIntLine() { setIntLines(prev => [...prev, { id: Date.now() + Math.random(), commodity_id: '', stock_balance: 0, stock_required: 1, stock_issued: 1 }]) }
  function removeIntLine(id) { setIntLines(prev => prev.filter(l => l.id !== id)) }
  async function updateIntLine(id, field, value) {
    if (field === 'commodity_id') {
      let balance = 0
      if (intSub === 'dispensary') {
        // Dispensary tab: query stock with location_type === 'dispensary'
        const stk = stockData.find(r => r.commodity_id === value && r.facility_id === fid && r.location_type === 'dispensary')
        balance = stk?.quantity || 0
      } else if (intSub === 'dsd') {
        // SDP tab: query sdp_stock with sdp_name
        const sdpRows = await api.stock.sdp.list({ facility_id: fid, sdp_name: sdpName, commodity_id: value }).catch(() => [])
        balance = (sdpRows && sdpRows[0]?.quantity) || 0
      }
      setIntLines(prev => prev.map(l => {
        if (l.id !== id) return l
        return { ...l, [field]: value, stock_balance: balance }
      }))
    } else {
      setIntLines(prev => prev.map(l => l.id === id ? { ...l, [field]: value } : l))
    }
  }

  async function loadIntPendingApprovals() {
    if (!fid) return
    setLoadingIntPending(true)
    const data = await api.transfers.list({
      facility_id: fid, direction: 'outgoing', status: 'pending_approval', notes_includes: '[Internal:',
      section: commoditySection || undefined,
    }).catch(() => [])
    setIntPendingApprovals((data || []).filter(r => r.notes?.includes('[Internal:')))
    setLoadingIntPending(false)
  }

  async function loadIntHistory() {
    setLoadingI(true)
    const data = await api.transfers.list({
      facility_id: fid, direction: 'outgoing', status: 'accepted', notes_includes: '[Internal:',
      date_field: 'resolved_at', limit: 50, section: commoditySection || undefined,
    }).catch(() => [])
    setIntHistory((data || []).filter(t => t.notes?.includes('[Internal:')))
    setLoadingI(false)
  }

  async function loadAllIntHistory(from, to) {
    const f = from || intHistFrom; const t2 = to || intHistTo
    setLoadingAllInt(true)
    const data = await api.transfers.list({
      facility_id: fid, direction: 'outgoing', status: 'accepted',
      date_field: 'resolved_at', from: f, to: t2, limit: 200,
      section: commoditySection || undefined,
    }).catch(() => [])
    setAllIntHistory((data || []).filter(t => t.notes?.includes('[Internal:') || t.notes?.includes('[SDP:') || t.notes?.includes('[DSD:')))
    setLoadingAllInt(false)
  }

  async function submitInternal(e) {
    e?.preventDefault(); setIntMsg(null)
    if (!intRequestedBy.trim()) { setIntMsg({ type: 'error', text: 'Requested by is required.' }); return }
    const lines = intLines.filter(l => l.commodity_id && l.stock_required > 0)
    if (!lines.length) { setIntMsg({ type: 'error', text: 'Add at least one commodity with stock required.' }); return }
    setIntSending(true)
    const payload = lines.map(l => {
      const comm = allCommodities.find(c => c.id === l.commodity_id)
      return {
        sending_facility_id: fid, sending_facility_name: myFac?.name || '',
        receiving_facility_id: fid, receiving_facility_name: myFac?.name || '',
        commodity_id: l.commodity_id, commodity_name: comm?.name || '',
        quantity: parseInt(l.stock_required), qty_requested: parseInt(l.stock_required), status: 'pending_approval',
        initiated_by: intRequestedBy, initiated_at: new Date().toISOString(),
        notes: `[Internal: Store→Dispensary] balance:${l.stock_balance} required:${l.stock_required}${intNotes ? ' ' + intNotes : ''}`,
        section: commoditySection,
      }
    })
    try {
      await api.transfers.create(payload)
    } catch (error) { setIntMsg({ type: 'error', text: 'Error: ' + error.message }); setIntSending(false); return }
    toast('Submitted for store manager approval', 'green')
    setIntMsg({ type: 'success', text: 'Submitted. Awaiting store manager approval.' })
    setIntLines([{ id: Date.now(), commodity_id: '', stock_balance: 0, stock_required: 1, stock_issued: 1 }])
    setIntRequestedBy(''); setIntNotes('')
    loadIntPendingApprovals(); setIntSending(false)
  }

  async function approveInternal(record, issuedQty) {
    if (!intApprovedBy.trim()) { toast('Approved by is required', 'red'); return }
    const parsedQty = parseInt(issuedQty)
    if (!parsedQty || parsedQty < 1) { toast('Stock issued quantity is required', 'red'); return }
    setIntApproving(true)
    const storeStk = stockData.find(r => r.commodity_id === record.commodity_id && r.facility_id === fid && r.location_type === 'store')
    if (!storeStk || storeStk.quantity < parsedQty) { toast(`Insufficient store stock. Available: ${storeStk?.quantity || 0}`, 'red'); setIntApproving(false); return }
    // Server moves the qty store→dispensary and marks accepted (transactional).
    try {
      await api.transfers.approveInternal(record.id, { approved_by: intApprovedBy, quantity: parsedQty,
        batch_number: intApproveBatch?.batch_number || undefined })
    } catch (err) {
      toast(err.status === 409 ? err.message : 'Error approving: ' + err.message, 'red'); setIntApproving(false); return
    }
    const comm = allCommodities.find(c => c.id === record.commodity_id)
    toast(`${parsedQty} ${comm?.unit || 'units'} moved to dispensary`, 'green')
    setIntApprovingId(null); setIntApprovedBy(''); setIntApproveBatch(null)
    await loadStock(); loadIntPendingApprovals(); loadIntHistory(); loadAllIntHistory(); setIntApproving(false)
  }

  async function rejectInternal(id) {
    const reason = window.prompt('Reason for rejecting this transfer request (optional):', '')
    if (reason === null) return
    await api.transfers.cancel(id, { cancelled_by: getStore().user?.email || '', reason: reason.trim() || undefined }).catch(() => {})
    toast('Transfer request rejected', 'green'); loadIntPendingApprovals()
  }

  // ── Service Delivery Point ────────────────────────────────────────────────
  function addDsdLine() { setDsdLines(prev => [...prev, { id: Date.now() + Math.random(), commodity_id: '', stock_balance: 0, stock_required: 1, stock_issued: 1 }]) }
  function removeDsdLine(id) { setDsdLines(prev => prev.filter(l => l.id !== id)) }
  async function updateDsdLine(id, field, value) {
    if (field === 'commodity_id') {
      let siteData = null
      const effectiveSdpName = isSDP ? sdpName : (dsdType === 'CT' ? dsdCtNumber : dsdType)
      if (!effectiveSdpName) return
      // Query sdp_stock for the SDP (either user's own or selected SDP)
      const sdpRows = await api.stock.sdp.list({ facility_id: fid, sdp_name: effectiveSdpName, commodity_id: value }).catch(() => [])
      siteData = (sdpRows && sdpRows[0]) || null
      setDsdLines(prev => prev.map(l => {
        if (l.id !== id) return l
        return { ...l, [field]: value, stock_balance: siteData?.quantity || 0 }
      }))
    } else {
      setDsdLines(prev => prev.map(l => l.id === id ? { ...l, [field]: value } : l))
    }
  }

  async function loadDsdPendingApprovals() {
    if (!fid) return
    setLoadingDsdPending(true)
    const data = await api.transfers.list({
      facility_id: fid, direction: 'outgoing', status: 'pending_approval',
      section: commoditySection || undefined,
    }).catch(() => [])
    setDsdPendingApprovals((data || []).filter(r => r.notes?.includes('[SDP:') || r.notes?.includes('[DSD:')))
    setLoadingDsdPending(false)
  }

  async function loadDsdHistory() {
    setLoadingD(true)
    const data = await api.transfers.list({
      facility_id: fid, direction: 'outgoing', status: 'accepted',
      date_field: 'resolved_at', limit: 50, section: commoditySection || undefined,
    }).catch(() => [])
    setDsdHistory((data || []).filter(t => t.notes?.includes('[SDP:') || t.notes?.includes('[DSD:')))
    setLoadingD(false)
  }

  async function submitDsd(e) {
    e?.preventDefault(); setDsdMsg(null)
    const effectiveDsdType = isSDP ? sdpName : (dsdType === 'CT' ? (dsdCtNumber ? `CT ${dsdCtNumber}` : '') : dsdType)
    if (!effectiveDsdType) {
      if (dsdType === 'CT') { setDsdMsg({ type: 'error', text: 'Enter CT name.' }); return }
      setDsdMsg({ type: 'error', text: 'Select service delivery point.' }); return
    }
    if (!dsdSentBy) { setDsdMsg({ type: 'error', text: 'Sent by is required.' }); return }
    const lines = dsdLines.filter(l => l.commodity_id && l.stock_required > 0)
    if (!lines.length) { setDsdMsg({ type: 'error', text: 'Add at least one commodity with stock required.' }); return }
    setDsdSending(true)
    const payload = lines.map(l => {
      const comm = allCommodities.find(c => c.id === l.commodity_id)
      return {
        sending_facility_id: fid, sending_facility_name: myFac?.name || '',
        receiving_facility_id: null, receiving_facility_name: effectiveDsdType,
        commodity_id: l.commodity_id, commodity_name: comm?.name || '',
        quantity: parseInt(l.stock_required), qty_requested: parseInt(l.stock_required), status: 'pending_approval',
        initiated_by: dsdSentBy, initiated_at: new Date().toISOString(),
        notes: `[SDP: ${effectiveDsdType}] balance:${l.stock_balance} required:${l.stock_required}${dsdNotes ? ' ' + dsdNotes : ''}`,
        section: commoditySection,
      }
    })
    try {
      await api.transfers.create(payload)
    } catch (error) { setDsdMsg({ type: 'error', text: 'Error: ' + error.message }); setDsdSending(false); return }
    toast('Submitted for store manager approval', 'green')
    setDsdMsg({ type: 'success', text: 'Submitted. Awaiting store manager approval.' })
    setDsdLines([{ id: Date.now(), commodity_id: '', stock_balance: 0, stock_required: 1, stock_issued: 1 }])
    setDsdType(''); setDsdCtNumber(''); setDsdSentBy(''); setDsdNotes('')
    loadDsdPendingApprovals(); setDsdSending(false)
  }

  async function approveDsd(record, issuedQty) {
    if (!dsdApprovedBy.trim()) { toast('Approved by store manager is required', 'red'); return }
    const parsedQty = parseInt(issuedQty)
    if (!parsedQty || parsedQty < 1) { toast('Stock issued quantity is required', 'red'); return }
    setDsdApproving(true)
    const storeStk = stockData.find(r => r.commodity_id === record.commodity_id && r.facility_id === fid && r.location_type === 'store')
    if (!storeStk || storeStk.quantity < parsedQty) { toast(`Insufficient store stock. Available: ${storeStk?.quantity || 0}`, 'red'); setDsdApproving(false); return }
    // Warn (don't block) if this dispatch would send expired stock to the site.
    const expWarn = expiredDispatchWarning(dsdApproveLots, dsdApproveBatch, parsedQty)
    if (expWarn && !window.confirm(`${expWarn}\n\nSending expired stock to a service delivery point is not recommended — clear it with an adjustment instead. Dispatch anyway?`)) {
      setDsdApproving(false); return
    }
    // Server decrements the store and marks the request dispatched. Single-facility
    // internal transfer with one login + one SDP: auto-receive right after approval
    // so the store manager doesn't need a separate receive step (credits sdp_stock).
    try {
      await api.transfers.approveDsd(record.id, { approved_by: dsdApprovedBy, quantity: parsedQty,
        batch_number: dsdApproveBatch?.batch_number || undefined })
    } catch (updateErr) {
      toast(updateErr.status === 409 ? updateErr.message : 'Error updating transfer: ' + updateErr.message, 'red'); setDsdApproving(false); return
    }
    try {
      await api.transfers.receive(record.id, { received_by: dsdApprovedBy })
    } catch (recvErr) {
      toast('Approved & dispatched, but auto-receipt failed: ' + recvErr.message + ' — confirm receipt manually.', 'amber')
      setDsdApprovingId(null); setDsdApprovedBy(''); setDsdIssuedQty(''); setDsdApproveBatch(null)
      await loadStock(); loadDsdPendingApprovals(); loadDsdHistory(); loadAllIntHistory(); setDsdApproving(false); return
    }
    const comm = allCommodities.find(c => c.id === record.commodity_id)
    const sdpPointName = record.notes?.match(/\[(?:SDP|DSD): ([^\]]+)\]/)?.[1] || record.receiving_facility_name || ''
    toast(`${parsedQty} ${comm?.unit || 'units'} approved & received at ${sdpPointName || 'service delivery point'}`, 'green')
    setDsdApprovingId(null); setDsdApprovedBy(''); setDsdIssuedQty(''); setDsdApproveBatch(null)
    await loadStock(); loadDsdPendingApprovals(); loadDsdHistory(); loadAllIntHistory(); setDsdApproving(false)
  }

  async function rejectDsd(id) {
    const reason = window.prompt('Reason for rejecting this request (optional):', '')
    if (reason === null) return
    await api.transfers.cancel(id, { cancelled_by: getStore().user?.email || '', reason: reason.trim() || undefined }).catch(() => {})
    toast('Request rejected', 'green'); loadDsdPendingApprovals()
  }

  // ── Print slip ────────────────────────────────────────────────────────────
  function printSlip(t) {
    const printDate = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
    const isInternal = t.notes?.includes('[Internal:')
    const isDSD = t.notes?.includes('[SDP:') || t.notes?.includes('[DSD:')
    const transferType = isDSD ? 'Store → Service Delivery Point Transfer' : isInternal ? 'Internal Transfer (Store → Dispensary)' : 'External Redistribution'
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

  // A move = same source + destination (from the notes tag) on the same DAY: a
  // multi-commodity request to one place is one move. There is no move-id in the
  // data, so this day-level key ties the move's lines together.
  const rxTag = (n, tag) => new RegExp(`\\[${tag}:\\s*([^\\]]+)\\]`, 'i').exec(n || '')?.[1]?.trim()
  const moveKey = r => [r.sending_facility_id, rxTag(r.notes, 'DSD') || rxTag(r.notes, 'SDP') || 'Dispensary', String(r.initiated_at || '').slice(0, 10)].join('|')
  async function printRIRVMove(t, rows) {
    const moveRows = rows.filter(r => moveKey(r) === moveKey(t))
    const facId = t.sending_facility_id || fid
    // FEFO-estimated batch/expiry per redistribution (Batch column only).
    const batches = {}
    await Promise.all([...new Set(moveRows.map(r => r.commodity_id))].map(async cid => {
      const m = await api.binCardRedistBatches({ facility_id: facId, commodity_id: cid }).catch(() => ({}))
      Object.assign(batches, m || {})
    }))
    const { printRIRV } = await import('../../utils/nationalForms')
    printRIRV(moveRows, { facilityName: myFac?.name || '', packSize: cid => allCommodities.find(c => c.id === cid)?.pack_size || '', batches })
  }

  // External move = same source + same RECEIVING FACILITY + same day. Different
  // facilities never merge (one Transfer & Return form is to one facility).
  const extMoveKey = r => [r.sending_facility_id, r.receiving_facility_id, String(r.initiated_at || '').slice(0, 10)].join('|')
  async function printTransferMove(t, rows) {
    const moveRows = rows.filter(r => extMoveKey(r) === extMoveKey(t))
    const { printTransfer } = await import('../../utils/nationalForms')
    printTransfer(moveRows, { facilityName: myFac?.name || '' })
  }

  const HistoryTable = ({ rows, loading, emptyMsg, kind }) => {
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
          // Only a genuinely completed move has a form to print. A cancelled or
          // disputed transfer never delivered the commodities, and a dispute that
          // was restored sent them back — printing any of these would document a
          // handover that did not happen.
          const canPrint = t.status === 'accepted' && t.dispute_note !== 'Disputed — stock restored'
          return (
          <tr key={t.id} className="border-b border-white/5 hover:bg-white/2">
            <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDate(t.resolved_at)}</td>
            <td className="px-4 py-3 font-medium text-gray-100">{t.commodity_name}</td>
            <td className="px-4 py-3 font-mono text-sm text-gray-300">
              {t.quantity}{commUnit(t.commodity_id) ? ` ${commUnit(t.commodity_id)}` : ''}
              {t.status === 'disputed' && t.qty_accepted != null && (
                <div className="text-xs text-gray-500 font-sans mt-0.5">{t.qty_accepted} kept · {t.qty_returned} returned</div>
              )}
            </td>
            <td className="px-4 py-3 text-xs font-semibold whitespace-nowrap"><span className={isOut ? 'text-red-400' : 'text-green-400'}>{isOut ? '▼ Stock out' : '▲ Stock in'}</span></td>
            <td className="px-4 py-3 text-xs text-gray-500">{t.sending_facility_name}</td>
            <td className="px-4 py-3 text-xs text-gray-500">{t.receiving_facility_name}</td>
            <td className="px-4 py-3"><Badge type={t.status === 'accepted' ? 'ok' : 'out'}>{t.status}</Badge></td>
            <td className="px-4 py-3">
              {canPrint && (
                <button onClick={() => kind === 'internal' ? printRIRVMove(t, rows) : kind === 'external' ? printTransferMove(t, rows) : printSlip(t)} className="text-xs text-gray-500 hover:text-gray-200 border border-white/10 rounded px-2 py-1 flex items-center gap-1">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3"><path d="M4 5V2h8v3M4 11H2V6h12v5h-2M4 9h8v5H4z"/></svg>
                  {kind === 'internal' ? 'Print RIRV' : kind === 'external' ? 'Print Transfer' : 'Print'}
                </button>
              )}
            </td>
          </tr>
          )
        })}</tbody>
      </table></div>
    )
  }


  const commUnit = (commodityId) => allCommodities.find(c => c.id === commodityId)?.unit || ''

  // Partial-dispute panel. Deliberately a plain function called as
  // {disputePanel(t)} rather than a nested <Component/>: a component defined in
  // the render body is a new type every render, so the inputs would remount and
  // the reason field would lose focus on every keystroke.
  const disputePanel = (t) => {
    const dispatched = t.quantity || 0
    const accepted = Math.min(Math.max(parseInt(disputeQtyAccepted) || 0, 0), dispatched)
    const unit = commUnit(t.commodity_id) ? ` ${commUnit(t.commodity_id)}` : ''
    return (
      <div className="mt-3 p-3 bg-red-500/5 border border-red-500/20 rounded-lg space-y-3">
        <div className="text-xs text-gray-500">
          Dispatched: <span className="text-gray-300 font-medium">{dispatched}{unit}</span> — keep what you received and the rest goes back.
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Qty accepted</label>
            <input type="number" min="0" max={dispatched} value={disputeQtyAccepted}
              onChange={e => setDisputeQtyAccepted(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-red-500" />
            <p className="text-xs text-gray-600 mt-1">Leave 0 to reject the whole delivery.</p>
          </div>
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Qty returned</label>
            <input type="number" value={dispatched - accepted} readOnly
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-400 opacity-60 cursor-not-allowed" />
            <p className="text-xs text-gray-600 mt-1">Back to {t.sending_facility_name || 'the sender'}.</p>
          </div>
        </div>
        <div>
          <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Disputed by *</label>
          <input type="text" value={disputeByName} onChange={e => setDisputeByName(e.target.value)}
            placeholder="Your full name"
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-red-500" />
          <p className="text-xs text-gray-600 mt-1">
            {accepted > 0
              ? `Recorded as the receiver of the ${accepted} accepted, which prints on the transfer form.`
              : 'Recorded against the dispute.'}
          </p>
        </div>
        <div>
          <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Reason *</label>
          <input type="text" value={disputeReason} onChange={e => setDisputeReason(e.target.value)}
            placeholder="e.g. quantity short, wrong item, damaged/expired"
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-red-500" />
        </div>
        <div className="flex gap-2">
          <Button variant="danger" size="sm" disabled={disputeLoading} onClick={() => confirmDispute(t)}>
            {disputeLoading ? 'Submitting…' : 'Confirm dispute'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => { setDisputingId(null); setDisputeReason(''); setDisputeQtyAccepted(0); setDisputeByName('') }}>Cancel</Button>
        </div>
      </div>
    )
  }

  const incomingCount = pending.filter(t => t.receiving_facility_id === fid && t.status === 'in_transit').length
  // My requests still open (awaiting admin review or the assigned source to dispatch).
  const myOpenRequests = pending.filter(t => t.receiving_facility_id === fid && t.status === 'pending').length
  // Requests the admin assigned this facility to dispatch as the source.
  const dispatchTasks  = pending.filter(t => t.sending_facility_id === fid && t.status === 'pending').length
  const outgoingCount = myOpenRequests + dispatchTasks
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
        <p className="text-sm text-gray-500 mt-1">Manage stock requests, internal and external redistributions, including service delivery points.</p>
      </div>

      {/* Landing — shown when no primary tab selected */}
      {primary === null && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            { id: 'request',  label: 'Request',                  desc: 'Submit and track redistribution requests',          badge: totalPendingBadge },
            { id: 'internal', label: 'Internal redistribution',  desc: 'Store to service delivery point transfers', badge: allIntPendingBadge },
            { id: 'external', label: 'External redistribution',  desc: 'Monitor and print sent & received transfers',       badge: 0 },
          ].filter(card => {
            if (isDispenser || isSDP) return ['request','internal'].includes(card.id)
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
      {!isSDP && primary === 'request' && (
        <>
          <BackButton />
          <div className="flex gap-1.5 mb-4 flex-wrap border-b border-white/8 pb-3">
            {canManage && accessLevel === 'facility' && <SubTab id="form"    current={reqSub} onChange={setReqSub} label="Request for redistribution" />}
            <SubTab id="pending"  current={reqSub} onChange={setReqSub} label="Pending" badge={incomingCount + outgoingCount} />
            <SubTab id="alerts"   current={reqSub} onChange={setReqSub} label="Request alerts" badge={myRequests.length} />
            <SubTab id="history"  current={reqSub} onChange={setReqSub} label="Request history" />
          </div>

          {/* Request for redistribution form */}
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
                          <CommoditySelect categories={categories} value={line.commodity_id} onChange={id => updateRequestLine(line.id, 'commodity_id', id)} className={inputCls} />
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
                  // A dispute is terminal: the server already returned the stock to
                  // the sender and the requesting facility raises a new request, so
                  // there is nothing to action here. It stays visible in history.
                  if (t.status === 'disputed') return null
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
                          {t.notes?.match(/\[Reviewed by: ([^\]]+)\]/)?.[1] && <div className="text-xs text-gray-500 mt-0.5">Reviewed by admin: <span className="text-purple-400">{t.notes.match(/\[Reviewed by: ([^\]]+)\]/)[1]}</span></div>}
                          {t.notes?.replace(/\[(Reviewed by|Approved by|Carrier|Expiry|Batch): [^\]]*\]/g, '').trim() && <div className="text-xs text-gray-500 mt-1">Note: {t.notes.replace(/\[(Reviewed by|Approved by|Carrier|Expiry|Batch): [^\]]*\]/g, '').trim()}</div>}
                          <TransferLotInfo record={t} />
                        </div>
                        <div className="flex gap-2 items-center flex-wrap">
                          {t.status === 'pending' && needsAssignment && isAdminUser && (
                            <Button variant="success" size="sm" onClick={() => { setAssigningId(t.id); setAssignFacState(''); setAssignFacLga(''); setAssignFacId(''); setAssignApprovedBy(''); setAssignQty(t.qty_requested ?? t.quantity) }}>Assign facility</Button>
                          )}
                          {t.status === 'pending' && isSender && !isDispenser && (
                            <>
                                <Button variant="success" size="sm" onClick={() => { setDispatchingId(t.id); setDispatchApprovedBy(dispatchSigner()); setDispatchCarrier(dispatchSigner()); setDispatchQty(t.quantity); setDispatchExpiry(''); setDispatchBatch(''); setDispatchLots([{ id: Date.now(), selected: null, qty: t.quantity }]) }}>Arrange transfer</Button>
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
                              <Button variant="danger" size="sm" onClick={() => openDispute(t)}>✕ Dispute</Button></>
                          )}
                          {t.status === 'in_transit' && isReceiver && isDispenser && (
                            <span className="text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded-full px-2 py-0.5">📦 In transit</span>
                          )}
                          {t.status === 'in_transit' && isSender && (
                            <span className="text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded-full px-2 py-0.5">📦 In transit — awaiting receiver</span>
                          )}
                          {t.status === 'in_transit' && isAdminUser && !isSender && !isReceiver && (
                            <span className="text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded-full px-2 py-0.5">📦 In transit</span>
                          )}
                          {t.status === 'disputed' && !isSender && (
                            <span className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-full px-2 py-0.5">✕ Disputed</span>
                          )}
                          {t.status === 'disputed' && t.dispute_note && t.dispute_note !== 'Disputed — stock restored' && (
                            <span className="text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-full px-2 py-0.5" title="Dispute reason">Reason: {t.dispute_note}</span>
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
                        <div className="mt-3 p-3 bg-white/5 border border-white/10 rounded-lg space-y-3">
                          <div className="text-xs text-gray-500">Qty requested: <span className="text-gray-300 font-medium">{t.qty_requested ?? t.quantity}{commUnit(t.commodity_id) ? ` ${commUnit(t.commodity_id)}` : ''}</span></div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                              <label className="block text-xs text-gray-200 uppercase tracking-widest mb-1">Qty issued *</label>
                              <input autoFocus type="number" min="1" value={dispatchQty} onChange={e => setDispatchQty(e.target.value)}
                                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
                            </div>
                            <div>
                              <label className="block text-xs text-gray-200 uppercase tracking-widest mb-1">Record approved by *</label>
                              <input type="text" value={dispatchApprovedBy} onChange={e => setDispatchApprovedBy(e.target.value)}
                                placeholder="Approving officer name" className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
                            </div>
                            <div>
                              <label className="block text-xs text-gray-200 uppercase tracking-widest mb-1">Carrier *</label>
                              <input type="text" value={dispatchCarrier} onChange={e => setDispatchCarrier(e.target.value)}
                                placeholder="Carrier / transporter name" className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
                            </div>
                            <div>
                              {/* Only required on the FEFO path — a picked batch brings its own expiry. */}
                              <label className="block text-xs text-gray-200 uppercase tracking-widest mb-1">
                                {dispatchLots.some(d => d.selected)
                                  ? 'Expiry date (from batch)'
                                  : 'Expiry date *'}
                              </label>
                              <input type="date" value={dispatchExpiry} onChange={e => setDispatchExpiry(e.target.value)}
                                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
                            </div>
                            <div>
                              <label className="block text-xs text-gray-200 uppercase tracking-widest mb-1">Batches (optional — pick batches and per-batch qty)</label>
                              <div className="space-y-2">
                                {dispatchLots.map((dl, i) => (
                                  <div key={dl.id} className="flex gap-2 items-center">
                                    <BatchSelect facilityId={fid} commodityId={t.commodity_id} locationType={"store"} value={dl.selected?.key || null} onSelect={opt => { const copy = [...dispatchLots]; copy[i] = { ...copy[i], selected: opt }; setDispatchLots(copy) }} className={inputCls} />
                                    <input type="number" min="0" value={dl.qty} onChange={e => { const copy = [...dispatchLots]; copy[i] = { ...copy[i], qty: e.target.value }; setDispatchLots(copy) }} className="w-28 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
                                    {dispatchLots.length > 1 && <button type="button" onClick={() => { setDispatchLots(dispatchLots.filter((_, idx) => idx !== i)) }} className="text-xs text-red-400">Remove</button>}
                                  </div>
                                ))}
                                <div className="flex gap-2">
                                  <button type="button" onClick={() => setDispatchLots([...dispatchLots, { id: Date.now(), selected: null, qty: 0 }])} className="text-xs text-blue-400 hover:text-blue-300">+ Add batch</button>
                                  <div className="text-xs text-gray-400">Leave batches empty to let server draw FEFO</div>
                                </div>
                              </div>
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <Button variant="success" size="sm" disabled={dispatchLoading} onClick={() => confirmDispatch(t)}>
                              {dispatchLoading ? 'Confirming…' : 'Confirm dispatch'}
                            </Button>
                            <Button variant="default" size="sm" onClick={() => { setDispatchingId(null); setDispatchApprovedBy(dispatchSigner()); setDispatchCarrier(dispatchSigner()); setDispatchExpiry(''); setDispatchBatch(''); setDispatchQty(1); setDispatchLots([]) }}>Cancel</Button>
                          </div>
                        </div>
                      )}
                      {acceptingId === t.id && (
                        <div className="mt-3 p-3 bg-green-500/5 border border-green-500/20 rounded-lg space-y-3">
                          {hasExpiredLot(t) && (
                            <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/25 rounded-lg px-3 py-2">
                              ⚠ This delivery is <strong>expired</strong> (expiry {fmtDate(earliestExpiredExpiry(t))}). Accepting it will bring expired stock into your store — dispute it instead unless you have a reason to keep it.
                            </div>
                          )}
                          <div className="flex items-end gap-3 flex-wrap">
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
                        </div>
                      )}
                      {disputingId === t.id && disputePanel(t)}
                    </div>
                  )
                })
              )}
            </Card>
          )}

          {/* Request alerts */}
          {reqSub === 'alerts' && (
            <Card>
              <CardHeader>
                <CardTitle>My redistribution requests — action required</CardTitle>
                <button onClick={loadMyRequests} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">Refresh</button>
              </CardHeader>
              {myRequests.length === 0 ? <EmptyState message="No pending redistribution requests ✓" /> : (
                myRequests.map(r => {
                  const reviewedBy = r.notes?.match(/\[Reviewed by: ([^\]]+)\]/)?.[1]
                  const cleanNotes = r.notes?.replace(/\[(Reviewed by|Approved by|Carrier|Expiry|Batch): [^\]]*\]/g, '').trim()
                  return (
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
                        {reviewedBy && <div className="text-xs text-gray-500 mt-0.5">Reviewed by admin: <span className="text-purple-400">{reviewedBy}</span></div>}
                        {cleanNotes && <div className="text-xs text-gray-500 mt-1">{cleanNotes}</div>}
                        <TransferLotInfo record={r} />
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        {r.status === 'in_transit' ? (
                          <>
                            <span className="text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded-full px-2 py-0.5">📦 In transit</span>
                            {!isDispenser && <Button variant="success" size="sm" onClick={() => { setAcceptingId(r.id); setAcceptReceiverName('') }}>✓ Accept</Button>}
                            {!isDispenser && <Button variant="danger" size="sm" onClick={() => openDispute(r)}>✕ Dispute</Button>}
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
                      <div className="mt-3 p-3 bg-green-500/5 border border-green-500/20 rounded-lg space-y-3">
                        {hasExpiredLot(r) && (
                          <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/25 rounded-lg px-3 py-2">
                            ⚠ This delivery is <strong>expired</strong> (expiry {fmtDate(earliestExpiredExpiry(r))}). Accepting it will bring expired stock into your store — dispute it instead unless you have a reason to keep it.
                          </div>
                        )}
                        <div className="flex items-end gap-3 flex-wrap">
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
                      </div>
                    )}
                    {disputingId === r.id && disputePanel(r)}
                  </div>
                )})
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
                    {['Date', 'Commodity', 'Qty requested', 'Qty issued', 'From', 'To', 'Status', 'Compiled by', ''].map((h, i) => (
                      <th key={i} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
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
                        <td className={`px-4 py-3 text-xs font-semibold ${sc}`}>
                          {r.status}
                          {transferReason(r) && <div className="text-red-300 font-normal normal-case mt-0.5 max-w-[240px] whitespace-normal">Reason: {transferReason(r)}</div>}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500">{r.initiated_by || '—'}</td>
                        <td className="px-4 py-3">
                          {r.status === 'accepted' && r.dispute_note !== 'Disputed — stock restored' && (
                            <button onClick={() => printTransferMove(r, requestHistory)} title="Transfer & Return form"
                              className="text-xs text-gray-500 hover:text-gray-200 border border-white/10 rounded px-2 py-1 flex items-center gap-1">
                              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3"><path d="M4 5V2h8v3M4 11H2V6h12v5h-2M4 9h8v5H4z"/></svg>
                              Print
                            </button>
                          )}
                        </td>
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
            <SubTab id="dsd" current={intSub} onChange={setIntSub} label="Store to Service Delivery Point" badge={dsdPendingApprovals.length} />
            {!isDispenser && !isSDP && <SubTab id="history" current={intSub} onChange={setIntSub} label="History" />}
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
              <HistoryTable rows={allIntHistory} loading={loadingAllInt} emptyMsg="No internal redistributions recorded." kind="internal" />
            </Card>
          )}

          {/* Store → Service Delivery Point */}
          {intSub === 'dsd' && (
            <>
              <Card>
                <CardHeader><CardTitle>Internal redistribution: Store → Service Delivery Point</CardTitle></CardHeader>
                <CardBody>
                  <div className="bg-purple-500/10 border border-purple-500/20 rounded-lg px-4 py-3 text-sm text-purple-300 mb-4">
                    Moving stock from <strong className="text-purple-100">Store</strong> to <strong className="text-purple-100">Service Delivery Point</strong> — submit for store manager approval
                  </div>
                  <form onSubmit={submitDsd} className="space-y-4">
                    {isSDP ? (
                      <div>
                        <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Service Delivery Point</label>
                        <div className="bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-sm text-gray-100">{sdpName}</div>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Service Delivery Point *</label>
                          <select value={dsdType} onChange={e => { setDsdType(e.target.value); setDsdCtNumber('') }} required className={inputCls}>
                            <option value="">Select service delivery point…</option>
                            {/* Hidden SDPs (not shown to avoid wrong entries): OPD, ANC, Labour Ward, Children's Ward, Immunization, TB Dot, Female Ward, A & E, Family Planning, CT */}
                            {['Main Lab'].map(s => (
                              <option key={s} value={s}>{s}</option>
                            ))}
                          </select>
                        </div>
                        {dsdType === 'CT' && (
                          <div>
                            <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">CT Name *</label>
                            <input type="text" value={dsdCtNumber} onChange={e => setDsdCtNumber(e.target.value)} placeholder="Enter CT name" required className={inputCls} />
                          </div>
                        )}
                      </div>
                    )}
                    <MultiCommodityLines lines={dsdLines} updateLine={updateDsdLine} addLine={addDsdLine} removeLine={removeDsdLine} categories={categories} label="commodity" hideStockIssued={true} />
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
                    <CardTitle>Pending service delivery point approvals{dsdPendingApprovals.length > 0 ? ` (${dsdPendingApprovals.length})` : ''}</CardTitle>
                    <button onClick={loadDsdPendingApprovals} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">Refresh</button>
                  </CardHeader>
                  {loadingDsdPending ? <LoadingState /> : dsdPendingApprovals.length === 0 ? <EmptyState message="No pending approvals" /> : (
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
                            {r.notes && <div className="text-xs text-gray-500 mt-1">{r.notes}</div>}
                          </div>
                          <div className="flex gap-2 flex-wrap">
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
                                  <div className="min-w-[15rem]">
                                    <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Batch issued</label>
                                    <BatchSelect key={r.id} facilityId={fid} commodityId={r.commodity_id} locationType="store"
                                      value={dsdApproveBatch?.key} onSelect={setDsdApproveBatch} onLotsLoaded={setDsdApproveLots} />
                                  </div>
                                </div>
                                <div className="flex gap-2">
                                  <Button variant="success" size="sm" onClick={() => approveDsd(r, dsdIssuedQty)} disabled={dsdApproving}>{dsdApproving ? 'Approving…' : 'Approve & dispatch'}</Button>
                                  <Button variant="ghost" size="sm" onClick={() => { setDsdApprovingId(null); setDsdApprovedBy(''); setDsdIssuedQty(''); setDsdApproveBatch(null) }}>Cancel</Button>
                                </div>
                              </div>
                            ) : (
                              <><Button variant="success" size="sm" onClick={() => { setDsdApprovingId(r.id); setDsdApprovedBy(''); setDsdIssuedQty(''); setDsdApproveBatch(null) }}>Approve</Button>
                                <Button variant="danger" size="sm" onClick={() => rejectDsd(r.id)}>Reject</Button></>
                            )}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </Card>
              )}

              <Card>
                <CardHeader><CardTitle>Service Delivery Point redistribution history</CardTitle></CardHeader>
                <HistoryTable rows={dsdHistory} loading={loadingD} emptyMsg="No service delivery point redistributions recorded." kind="internal" />
              </Card>
            </>
          )}

        </>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          EXTERNAL REDISTRIBUTION
      ══════════════════════════════════════════════════════════════════════ */}
      {primary === 'external' && (
        <>
          <BackButton />
          {/* Send form intentionally disabled: this module is view/print only and must
              NOT be used to perform transfers. */}
          {false && (
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
                      <CommoditySelect categories={categories} value={commId} onChange={setCommId} className={inputCls} />
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

          {(
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
              <HistoryTable rows={sendHistory} loading={loadingS} emptyMsg="No external redistributions recorded." kind="external" />
            </Card>
          )}
        </>
      )}
    </div>
  )
}
