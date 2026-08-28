import { useState, useEffect, useMemo } from 'react'
import { api } from '../../lib/api'
import { subscribeRealtime } from '../../lib/realtime'
import { useAppStore } from '../../store/appStore'
import { Card, CardHeader, CardTitle } from '../../components/ui/Card'
import { MetricGrid, Metric } from '../../components/ui/Metric'
import { CommoditySelect } from '../../components/ui/CommoditySelect'
import { Badge, CatBadge } from '../../components/ui/Badge'
import { LoadingState, EmptyState, Spinner } from '../../components/ui/Loading'
import { FacilityPicker } from '../../components/ui/FacilityPicker'
import { toast } from '../../components/ui/Toast'
import { Button } from '../../components/ui/Button'
import { fmtDate, fmtDateTime, loadConsumptionAmcMap, getMOS, getStockStatus, isLabCategory, transferReason, reviewerNameOf } from '../../utils/helpers'
import { exportCsv, exportPdf } from '../../utils/download'

// Defined at module scope, not inside Alerts(). A component created during render is a
// new type on every render, so React unmounts and remounts it each time — throwing away
// any DOM state it held and re-doing the work. What these closed over (tab/setTab,
// stockPending) is passed as props instead.
function TabBtn({ id, label, active, onSelect }) {
  return (
    <button onClick={() => onSelect(id)}
      className={`px-4 py-2 text-sm rounded-lg border transition-colors ${active?'bg-white/8 border-white/15 text-gray-100 font-medium':'border-white/10 text-gray-400 hover:text-gray-200'}`}>
      {label}
    </button>
  )
}

function StockTable({ rows, emptyMsg, qtyClass, onRowClick, stockPending }) {
  return stockPending ? <LoadingState/> : rows.length===0 ? <EmptyState message={emptyMsg}/> : (
    <div className="table-wrap"><table className="w-full text-sm">
      <thead><tr className="border-b border-white/8 bg-white/2">
        {['Commodity','Category','Unit','Stock on hand','AMC','MOS'].map(h=>(
          <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
        ))}
      </tr></thead>
      <tbody>{rows.map(r=>{
        const mosColor = r._mos!==null ? (r._mos<2?'text-red-400':r._mos>4?'text-blue-400':'text-green-400') : 'text-gray-500'
        return (
          <tr key={r.id} onClick={onRowClick ? ()=>onRowClick(r) : undefined}
            className={`border-b border-white/5 ${onRowClick?'cursor-pointer hover:bg-white/5':'hover:bg-white/2'}`}>
            <td className={`px-4 py-3 font-medium ${onRowClick?'text-blue-400 hover:text-blue-300':'text-gray-100'}`}>{r.commodities?.name||'—'}{onRowClick && <span className="text-gray-600 ml-1">›</span>}</td>
            <td className="px-4 py-3"><CatBadge>{r.commodities?.category||'—'}</CatBadge></td>
            <td className="px-4 py-3 text-xs text-gray-500">{r.commodities?.unit||'—'}</td>
            <td className={`px-4 py-3 font-mono text-sm font-semibold ${qtyClass}`}>{r.quantity}</td>
            <td className="px-4 py-3 font-mono text-xs text-gray-500">{r._amc>0?r._amc.toFixed(1):'—'}</td>
            <td className={`px-4 py-3 font-mono text-sm font-medium ${mosColor}`}>{r._mos!==null?r._mos+'mo':'—'}</td>
          </tr>
        )
      })}</tbody>
    </table></div>
  )
}

export function Alerts() {
  const store = useAppStore()
  const commoditySection = useAppStore(s => s.commoditySection)
  const [tab, setTab]           = useState('expiry')
  // Sub-filter of the Out-of-stock tab only: '' | 'inuse' | 'unused'.
  const [useFilter, setUseFilter] = useState('')
  const [expiryDays, setDays]   = useState(180)
  const [expiryRows, setExpiry] = useState([])
  const [stockRows, setStock]   = useState({ out:[], low:[], over:[] })
  const [loading, setLoading]   = useState(true)
  // Facility request alerts — own pending redistribution requests
  const [facReqAlerts, setFacReqAlerts] = useState([])
  const [loadingFacReq, setLoadingFacReq] = useState(true)
  const [acceptingId, setAcceptingId]       = useState(null)
  const [acceptReceiverName, setAcceptReceiverName] = useState('')
  const [acceptLoading, setAcceptLoading]   = useState(false)

  // Admin: review & arrange (assign a source facility) inline, plus history + filters
  const [reqView, setReqView]       = useState('active')   // 'active' | 'history'
  const [filterComm, setFilterComm] = useState('')
  const [filterLga, setFilterLga]   = useState('')
  const [filterCat, setFilterCat]   = useState('')   // request alerts: commodity category
  const [stockCat, setStockCat]     = useState('')   // expiry / out / low / overstock: category
  const [drillComm, setDrillComm]   = useState(null) // stock tab: commodity drilled into {id,name,cat,comm}
  const [drillRows, setDrillRows] = useState([])  // per-facility rollup for the drilled commodity
  // Value intentionally unread: only the reset (setExpDrillComm(null) on a scope
  // change) is used. Kept as state so that reset still forces a re-render.
  const [, setExpDrillComm] = useState(null)
  const [expUrgency, setExpUrgency] = useState('all')    // expiry tab urgency filter: 'all'|Expired|Critical|Warning|Monitor
  const [assigningId, setAssigningId]           = useState(null)
  const [assignFacState, setAssignFacState]     = useState('')
  const [assignFacLga, setAssignFacLga]         = useState('')
  const [assignFacId, setAssignFacId]           = useState('')
  // Prefilled with the signed-in admin's own name, the same source Intake uses for
  // "Received by". Still editable — someone reviewing on a colleague's behalf can
  // overwrite it — but the common case stops being a retyped name every time.
  //
  // Read at call time, not captured once: the session hydrates after this component
  // mounts, so a value snapshotted here would be empty for the first render. Every
  // place that RESETS this field must reset it to this, not to '' — opening the
  // panel, cancelling and submitting all clear the form, and clearing it to empty
  // is what silently defeated the prefill the first time round.
  const reviewerDefault = () => reviewerNameOf(store.user)
  const [assignReviewedBy, setAssignReviewedBy] = useState(reviewerDefault)
  const [assignQty, setAssignQty]               = useState(1)
  const [assignLoading, setAssignLoading]       = useState(false)
  // Unscoped facility list for the assign picker only — lets a state admin
  // assign a source facility from another state for emergency orders, without
  // widening their scoped dashboard/stock views.
  const [assignFacPool, setAssignFacPool]       = useState([])

  // ── Batch assign ───────────────────────────────────────────────────────────
  // The admin's real workflow is "these twenty lab requests all come from the State
  // Office Store". Quantities stay per-request (batchQty), because reviewing them is
  // the part of the job that must not be lost in a bulk action.
  const [batchSel, setBatchSel]         = useState({})   // requestId -> true
  const [batchQty, setBatchQty]         = useState({})   // requestId -> quantity
  const [batchFacState, setBatchFacState] = useState('')
  const [batchFacLga, setBatchFacLga]     = useState('')
  const [batchFacId, setBatchFacId]       = useState('')
  const [batchReviewedBy, setBatchReviewedBy] = useState('')
  const [batchStock, setBatchStock]     = useState(null) // commodity_id -> on-hand at source
  const [batchSending, setBatchSending] = useState(false)
  const [reqHistory, setReqHistory]   = useState([])
  const [loadingHist, setLoadingHist] = useState(false)
  // Admin: requests already assigned to a source but not yet completed —
  // either awaiting dispatch by the source, or in transit awaiting receipt.
  const [inflightReqs, setInflightReqs]     = useState([])
  const [loadingInflight, setLoadingInflight] = useState(true)
  const [histFrom, setHistFrom] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10))
  const [histTo, setHistTo]     = useState(() => new Date().toISOString().slice(0, 10))

  const fid     = store.currentFacility?.id
  // Admin location scope (State → LGA → Facility via the shared FacilityPicker,
  // which sets the global admin filter that getAdminStockScope resolves).
  const { fid: scopeFid, scopeIds: scopeIdList } = store.getAdminStockScope()
  const scopeSet = scopeFid ? new Set([scopeFid]) : (scopeIdList ? new Set(scopeIdList) : null)
  const inScope  = fId => !scopeSet || scopeSet.has(fId)
  const scopeKey = scopeFid || (scopeIdList && scopeIdList.length ? scopeIdList.join(',') : 'all')
  const commIds = store.allCommodities.map(c => c.id)

  useEffect(() => {
    loadAll()
    // Overall admin doesn't handle redistribution requests — skip loading them.
    if (!store.isOverallAdmin()) loadFacReqAlerts()
    if (store.isAdmin() && !store.isOverallAdmin()) loadInflight()
    if (store.isStateAdmin()) api.facilities.list({}).then(setAssignFacPool).catch(() => setAssignFacPool([]))
    return subscribeRealtime(['stock_transfer_log'], (payload) => {
      if (store.isOverallAdmin()) return
      if (store.isAdmin()) { loadFacReqAlerts(); loadInflight(); return }
      const row = payload.new?.receiving_facility_id ? payload.new : (payload.old || {})
      if ((row.receiving_facility_id === fid || row.sending_facility_id === fid) && fid) loadFacReqAlerts()
    })
  }, [fid])

  async function loadAll() {
    setLoading(true)
    await Promise.all([loadExpiry(), loadStockAlerts()])
    setLoading(false)
  }

  async function loadFacReqAlerts() {
    let data
    if (store.isAdmin()) {
      // Facility → admin requests awaiting fulfillment (sending null), scoped to the
      // admin's jurisdiction server-side. Filter the sending-null set client-side.
      data = await api.transfers.list({ status: 'pending', section: commoditySection || undefined }).catch(() => [])
      data = (data || []).filter(t => !t.sending_facility_id)
    } else {
      // Incoming = own requests; to-dispatch = requests this facility was assigned
      // to fulfil as the source (possibly from another state), still pending.
      const [incoming, toDispatch] = await Promise.all([
        api.transfers.list({
          facility_id: fid, direction: 'incoming', status: 'pending,in_transit',
          section: commoditySection || undefined,
        }).catch(() => []),
        api.transfers.list({
          facility_id: fid, direction: 'outgoing', status: 'pending',
          section: commoditySection || undefined,
        }).catch(() => []),
      ])
      const tagged = (toDispatch || []).map(t => ({ ...t, _toDispatch: true }))
      data = [...tagged, ...(incoming || [])]
    }
    setFacReqAlerts(data || [])
    setLoadingFacReq(false)
  }

  async function cancelFacRequest(id) {
    // Reason is recorded on the request (notes "[Cancelled: …]") so the requesting
    // facility can see why the admin cancelled it.
    const reason = window.prompt('Reason for cancelling this redistribution request:', '')
    if (reason === null) return
    const note = reason.trim()
    if (!note) { toast('Please enter a reason', 'red'); return }
    try {
      await api.transfers.cancel(id, { cancelled_by: store.user?.email || '', reason: note })
    } catch { toast('Error cancelling request','red'); return }
    toast('Request cancelled','green')
    loadFacReqAlerts()
  }

  // State admin dismisses a facility request that shouldn't be fulfilled. Same
  // transition the requester's cancel uses — no stock moves. The reason is
  // recorded so the requesting facility sees why it was rejected.
  async function rejectFacRequest(req) {
    const reason = window.prompt(`Reason for rejecting the request for ${req.commodity_name || 'this commodity'} from ${req.receiving_facility_name || 'the facility'}:`, '')
    if (reason === null) return
    const note = reason.trim()
    if (!note) { toast('Please enter a reason', 'red'); return }
    try {
      await api.transfers.cancel(req.id, { cancelled_by: store.user?.email || '', reason: note })
    } catch { toast('Error rejecting request','red'); return }
    toast('Request rejected','green')
    loadFacReqAlerts()
  }

  // Admin reviews a facility request and assigns a source facility to fulfil it.
  // Setting sending_facility_id hands the request off to that facility to dispatch.
  async function confirmAssignFacility(req) {
    if (!assignFacId) { toast('Select a source facility','red'); return }
    if (!assignReviewedBy.trim()) { toast('Reviewed by is required','red'); return }
    const parsedQty = parseInt(assignQty)
    if (!parsedQty || parsedQty < 1) { toast('Qty must be at least 1','red'); return }
    setAssignLoading(true)
    const srcFac = (assignFacPool.length ? assignFacPool : store.allFacilities).find(f => f.id === assignFacId)
    try {
      await api.transfers.assignSource(req.id, {
        sending_facility_id: assignFacId,
        sending_facility_name: srcFac?.name || '',
        quantity: parsedQty,
        reviewed_by: assignReviewedBy.trim(),
      })
    } catch (error) { toast('Error assigning facility: ' + error.message,'red'); setAssignLoading(false); return }
    toast(`Request sent to ${srcFac?.name || 'facility'}`,'green')
    setAssigningId(null); setAssignFacState(''); setAssignFacLga(''); setAssignFacId('')
    setAssignReviewedBy(reviewerDefault()); setAssignQty(1); setAssignLoading(false)
    loadFacReqAlerts()
  }

  // Resolved redistribution requests within the admin's jurisdiction (excludes
  // internal Store→Dispensary and DSD transfers, which aren't request-driven).
  async function loadHistory() {
    setLoadingHist(true)
    const data = await api.transfers.list({
      status: 'accepted,cancelled,disputed',
      date_field: 'initiated_at', from: histFrom, to: histTo, limit: 300,
      section: commoditySection || undefined,
    }).catch(() => [])
    // Exclude internal moves — Store→Dispensary and the DSD/SDP site dispatches
    // (e.g. "[SDP: Main Lab]") — so only real facility→facility redistributions show.
    setReqHistory((data || []).filter(t => !t.notes?.includes('[Internal:') && !t.notes?.includes('[DSD:') && !t.notes?.includes('[SDP:')))
    setLoadingHist(false)
  }

  // Assigned-but-not-completed facility→facility redistributions within the
  // admin's jurisdiction: pending with a source assigned (awaiting dispatch), or
  // in_transit (dispatched, awaiting receipt). Excludes internal Store→Dispensary
  // and DSD/SDP site moves, matching the history view.
  async function loadInflight() {
    setLoadingInflight(true)
    const data = await api.transfers.list({
      status: 'pending,in_transit', section: commoditySection || undefined,
    }).catch(() => [])
    const rows = (data || []).filter(t =>
      !t.notes?.includes('[Internal:') && !t.notes?.includes('[DSD:') && !t.notes?.includes('[SDP:') &&
      (t.status === 'in_transit' || (t.status === 'pending' && t.sending_facility_id)))
    setInflightReqs(rows)
    setLoadingInflight(false)
  }

  async function confirmAccept(req) {
    if (!acceptReceiverName.trim()) { toast('Receiver name is required','red'); return }
    setAcceptLoading(true)
    // Server credits the receiver store, writes the intake_log entry, and marks accepted.
    try {
      await api.transfers.accept(req.id, { received_by: acceptReceiverName.trim() })
    } catch (updateErr) { toast('Error updating transfer: ' + updateErr.message,'red'); setAcceptLoading(false); return }
    setAcceptingId(null); setAcceptReceiverName(''); setAcceptLoading(false)
    toast('Transfer accepted — stock updated','green')
    loadFacReqAlerts()
  }

  async function disputeTransfer(req) {
    // A dispute can be partial: keep what actually arrived and the rest goes
    // back to the sending facility's store. The server splits the stock and
    // closes the transfer as disputed — a dispute is terminal, so the facility
    // raises a fresh request for anything it still needs.
    const dispatched = req.quantity || 0
    const input = window.prompt(
      `Dispute this transfer.

Dispatched: ${dispatched}
How many did you actually accept? The rest goes back to the sender.`, '0')
    if (input === null) return                        // cancelled
    const accepted = parseInt(input)
    if (isNaN(accepted) || accepted < 0 || accepted > dispatched) {
      toast(`Qty accepted must be between 0 and ${dispatched}`, 'red'); return
    }
    const reason = window.prompt('Reason for the dispute\n(e.g. quantity short, wrong item, damaged/expired):', '')
    if (reason === null) return
    const note = reason.trim()
    if (!note) { toast('Please enter a reason for the dispute', 'red'); return }
    // Report a real failure instead of swallowing it: this moves stock now.
    // Record a person, never a login e-mail: this name is what shows against
    // the dispute and, for any accepted portion, on the printed transfer form.
    let byName = reviewerNameOf(store.user)
    if (!byName) {
      const typed = window.prompt('Your full name (recorded against this dispute):', '')
      if (typed === null) return
      byName = typed.trim()
      if (!byName) { toast('Please enter your name', 'red'); return }
    }
    try {
      await api.transfers.dispute(req.id, {
        disputed_by: byName,
        received_by: byName,
        facilityId: fid,
        dispute_note: note,
        qty_accepted: accepted,
      })
    } catch (err) { toast('Error disputing transfer: ' + err.message, 'red'); return }
    toast(accepted > 0
      ? `Disputed — ${accepted} accepted, ${dispatched - accepted} returned to the sender`
      : 'Transfer disputed — stock returned to the sender', 'amber')
    loadFacReqAlerts()
  }

  async function loadExpiry() {
    const today  = new Date()
    const cutoff = new Date(today.getTime()+expiryDays*86400000).toISOString().split('T')[0]
    // Per-batch balances from the AUTHORITATIVE lot ledger — already the on-hand
    // truth, so a batch that is ALREADY expired but still on the shelf surfaces
    // here (the old intake-history estimate inferred those away). Expired lots are
    // always returned; `expiry_to` caps the future look-ahead.
    const lots = await api.stock.lotsExpiry({
      facility_id: fid, commodity_ids: commIds,
      expiry_to: cutoff, section: commoditySection || undefined,
    }).catch(() => [])
    setExpiry(lots || [])
  }

  async function loadStockAlerts() {
    // AMC from the consumption recorded so far (elapsed weeks scaled to a
    // month), the same figure the Dashboard and Stock Levels use — these
    // counts must not disagree with the pages they mirror.
    const amcMap = await loadConsumptionAmcMap({
      commIds, scopeParams: { facility_id: fid }, section: commoditySection,
    })

    // Per-commodity rollup for the current scope (store / dispensary / DSD / SDP
    // totals and baseline AMC) plus the ever-transacted ids, in parallel. The
    // overall admin can narrow to one state from the stock-tab State filter;
    // everyone else sees their whole scope — the same narrowing that used to be
    // applied by filtering the full stock array client-side.
    const [summary, everUsed] = await Promise.all([
      // Compact scope params, not an enumerated facility id list — see the
      // Dashboard: a large state's ids pushed that URL past the reverse proxy's
      // query-string limit and it was rejected before reaching the API. Both come
      // from the same store state, so the facility set is identical.
      api.stock.summary(store.getAdminScopeParams()).catch(() => []),
      // Commodity ids this scope has ever transacted (any intake/dispense, however
      // old) — one of the "in use here" signals, mirroring the Dashboard.
      api.commodities.transacted(store.getAdminScopeParams()).catch(() => []),
    ])
    const transacted = new Set(everUsed || [])
    const gMap = {}
    ;(summary || []).forEach(r => { gMap[r.commodity_id] = r })
    // DSD/SDP site stock is only folded in when a single facility is in view, as before.
    const dsdMap = {}, sdpMap = {}
    if (fid) (summary || []).forEach(r => {
      dsdMap[r.commodity_id] = r.dsd_qty || 0
      sdpMap[r.commodity_id] = r.sdp_qty || 0
    })

    // Seed from every tracked commodity (not just those with a stock row) so
    // zero-stock / out-of-stock items are counted — keeps these alerts
    // consistent with the Dashboard.
    const enriched = store.allCommodities.map(c=>{
      const g             = gMap[c.id] || {}
      const comm          = c
      const storeQty      = g.store_qty || 0
      const dispensaryQty = g.dispensary_qty || 0
      const lab           = isLabCategory(comm?.category)
      const quantity      = lab ? (storeQty + (sdpMap[c.id]||0)) : (storeQty + dispensaryQty + (dsdMap[c.id]||0))
      const amc           = amcMap[c.id]&&amcMap[c.id]>0?amcMap[c.id]:(g.baseline_amc||0)
      // "In use here" = a stock row exists (holds/once held stock), or there is
      // AMC-window consumption, or it was ever transacted. Same rule as the Dashboard.
      const inUse         = !!gMap[c.id]?.has_stock || (amcMap[c.id]||0) > 0 || transacted.has(c.id)
      return { id:c.id, commodity_id:c.id, commodities:comm, storeQty, dispensaryQty, quantity, inUse,
               _amc:amc, _mos:getMOS(quantity,amc), _status:getStockStatus(quantity,amc) }
    })
    setStock({
      out:  enriched.filter(r=>r._status==='out'),
      low:  enriched.filter(r=>r._status==='low'),
      over: enriched.filter(r=>r._status==='over'),
    })
  }

  // The session can hydrate after this mounts; fill the reviewer name then, but
  // never overwrite something already typed.
  useEffect(() => {
    if (assignReviewedBy) return
    const n = reviewerNameOf(store.user)
    if (n) setAssignReviewedBy(n)
  }, [store.user])

  useEffect(()=>{ if(fid) loadExpiry() },[expiryDays])
  // The in-use split belongs to the Out-of-stock tab; drop it when the tab moves.
  useEffect(()=>{ if(tab!=='out') setUseFilter('') },[tab])
  // Recompute the out/low/over aggregates when the overall admin picks a state.
  useEffect(()=>{ if(store.isAdmin()) loadStockAlerts() },[scopeKey])
  // (The recompute that used to wait for the large app-wide stock payload is
  // gone: the alert figures now come from the scoped rollup fetched in loadAll
  // itself, so there is nothing to wait for and no second pass to run.)
  useEffect(()=>{ if(store.isAdmin() && reqView==='history') loadHistory() },[reqView, histFrom, histTo])
  useEffect(()=>{ if(store.isAdmin() && reqView==='inflight') loadInflight() },[reqView])

  // Drill-in: one per-facility rollup for the selected commodity — store,
  // dispensary and both site tables in a single response. This replaces two
  // paginated site-stock calls AND the page's last read of the global stock
  // array, which for an admin was a 449 KB download (~5.7 s on the measured
  // link) fetched on every visit to this page just for this one breakdown.
  useEffect(() => {
    if (!drillComm) { setDrillRows([]); return }
    let active = true
    // No facility_ids: the list sent here was the caller's own facilities, which
    // is precisely the scope the server already applies from the token. Sending it
    // narrowed nothing and, for a large state, put ~6 KB of ids in the URL — the
    // same thing that had the dashboards' request rejected by the reverse proxy.
    api.stock.summary({ group_by: 'facility', commodity_id: drillComm.id })
      .then(rows => { if (active) setDrillRows(rows || []) })
      .catch(() => { if (active) setDrillRows([]) })
    return () => { active = false }
  }, [drillComm])

  // Reset any open drill-in when switching tabs or category.
  useEffect(() => { setDrillComm(null); setExpDrillComm(null); setExpUrgency('all') }, [tab, stockCat, scopeKey])

  // ── Admin request filters (commodity + LGA) ───────────────────────────────
  const facLgaById = {}
  const facMeta = {}
  store.allFacilities.forEach(f => { facLgaById[f.id] = f.lga || '—'; facMeta[f.id] = { name: f.name, lga: f.lga || '—', state: f.state || '—' } })
  const lgaOptions = [...new Set(store.allFacilities.map(f => f.lga).filter(Boolean))].sort()
  const categories = [...new Set(store.allCommodities.map(c => c.category).filter(Boolean))].sort()
  const applyReqFilters = list => list.filter(r =>
    (!filterComm || r.commodity_id === filterComm) &&
    (!filterLga  || facLgaById[r.receiving_facility_id] === filterLga) &&
    (!filterCat  || (r.commodities?.category) === filterCat))
  const activeReqs   = applyReqFilters(facReqAlerts)
  const histReqs     = applyReqFilters(reqHistory)
  const inflightList = applyReqFilters(inflightReqs)
  const reqRowCount  = reqView==='inflight' ? inflightList.length : reqView==='history' ? histReqs.length : activeReqs.length

  // NOTE: this block must stay BELOW `activeReqs` above — it reads it, and a const
  // cannot be read before its declaration has run.
  // ── Batch assign helpers ───────────────────────────────────────────────────
  const batchIds = Object.keys(batchSel).filter(id => batchSel[id])
  const batchRows = activeReqs.filter(r => batchSel[r.id])

  // Source pool, grouped State -> LGA -> Facility, exactly as the single-assign picker
  // does. A flat list of every facility in the country is unusable to pick from.
  const batchFacPool = assignFacPool.length ? assignFacPool : store.allFacilities
  const batchFacGroups = useMemo(() => {
    const g = {}
    for (const f of batchFacPool) {
      // No state at all = not a dispatchable source (leaked test fixtures look like
      // this). But a State Office Store legitimately has NO LGA — it serves the whole
      // state — so it gets its own bucket rather than being dropped. It is the source
      // most of these requests are headed for, so hiding it would defeat the feature.
      if (!f.state) continue
      const st = f.state, lg = f.lga || 'State Office'
      if (!g[st]) g[st] = {}
      if (!g[st][lg]) g[st][lg] = []
      g[st][lg].push(f)
    }
    return g
  }, [batchFacPool])

  // Within an LGA, the State Office Store sorts first — most lab consumables come from
  // there — but it is never pre-selected: a silent default on a bulk action is how
  // twenty requests get assigned to the wrong store in one click.
  const batchFacOptions = useMemo(() => {
    const list = batchFacGroups[batchFacState]?.[batchFacLga] || []
    const isStateOffice = f => /state office/i.test(f.name || '')
    return [...list].sort((a, b) =>
      ((isStateOffice(b) ? 1 : 0) - (isStateOffice(a) ? 1 : 0)) ||
      (a.name || '').localeCompare(b.name || ''))
  }, [batchFacGroups, batchFacState, batchFacLga])

  // Demand per COMMODITY across the selection. Two facilities asking for the same item
  // must be judged against the combined figure — checked row by row, each would look
  // satisfiable while together they exceed what the source holds.
  const batchDemand = useMemo(() => {
    const m = {}
    for (const r of batchRows) {
      const q = parseInt(batchQty[r.id] ?? r.qty_requested ?? r.quantity ?? 0) || 0
      m[r.commodity_id] = (m[r.commodity_id] || 0) + q
    }
    return m
  }, [batchRows, batchQty])

  // The distinct commodities in the selection, as a stable key. Extracted rather than
  // computed inside the dependency array: an inline expression there cannot be checked
  // statically, and it made the linter give up on this whole component — silencing
  // thirteen pre-existing diagnostics elsewhere in the file.
  const batchCommodityIds = useMemo(
    () => [...new Set(batchRows.map(r => r.commodity_id))].sort(),
    [batchRows])
  const batchCommodityKey = batchCommodityIds.join(',')

  // On-hand at the chosen source, for the commodities in the selection.
  useEffect(() => {
    if (!batchFacId || batchCommodityKey === '') { setBatchStock(null); return }
    let off = false
    api.stock.summary({ facility_id: batchFacId, commodity_ids: batchCommodityKey.split(',') })
      .then(rows => {
        if (off) return
        const m = {}
        for (const row of rows || []) m[row.commodity_id] = Number(row.store_qty || 0)
        setBatchStock(m)
      })
      .catch(() => { if (!off) setBatchStock(null) })
    return () => { off = true }
  }, [batchFacId, batchCommodityKey])

  const batchShortfalls = useMemo(() => {
    if (!batchStock) return []
    return Object.entries(batchDemand)
      .filter(([cid, want]) => want > (batchStock[cid] ?? 0))
      .map(([cid, want]) => ({
        commodity_id: cid,
        name: batchRows.find(r => r.commodity_id === cid)?.commodity_name || cid,
        want, have: batchStock[cid] ?? 0,
      }))
  }, [batchDemand, batchStock, batchRows])

  // Select-all applies to activeReqs — the list as currently filtered, not every pending
  // request in the database. Ticking a box you cannot see would be a nasty surprise on
  // an action that assigns real stock.
  const allBatchSelected = activeReqs.length > 0 && activeReqs.every(r => batchSel[r.id])

  function toggleSelectAll() {
    if (allBatchSelected) { clearBatch(); return }
    const sel = {}, qty = { ...batchQty }
    for (const r of activeReqs) {
      sel[r.id] = true
      if (qty[r.id] == null) qty[r.id] = r.qty_requested ?? r.quantity ?? 1
    }
    setBatchSel(sel)
    setBatchQty(qty)
  }

  function toggleBatch(req) {
    setBatchSel(m => ({ ...m, [req.id]: !m[req.id] }))
    setBatchQty(m => (m[req.id] != null ? m : { ...m, [req.id]: req.qty_requested ?? req.quantity ?? 1 }))
  }

  function clearBatch() {
    setBatchSel({}); setBatchQty({})
    setBatchFacState(''); setBatchFacLga(''); setBatchFacId('')
    setBatchStock(null)
  }

  async function sendBatch() {
    if (!batchFacId) { toast('Select a source facility','red'); return }
    if (!batchReviewedBy.trim()) { toast('Reviewed by is required','red'); return }
    const items = batchRows.map(r => ({
      id: r.id,
      quantity: parseInt(batchQty[r.id] ?? r.qty_requested ?? r.quantity ?? 0),
    }))
    if (items.some(i => !(i.quantity > 0))) { toast('Every selected request needs a quantity of at least 1','red'); return }

    setBatchSending(true)
    const src = batchFacPool.find(f => f.id === batchFacId)
    try {
      await api.transfers.assignBatch({
        sending_facility_id: batchFacId,
        sending_facility_name: src?.name || '',
        reviewed_by: batchReviewedBy.trim(),
        items,
      })
      toast(`${items.length} request${items.length===1?'':'s'} sent to ${src?.name || 'facility'}`,'green')
      clearBatch()
      loadFacReqAlerts()
    } catch (error) {
      // All-or-nothing: nothing was assigned, so the list is reloaded to show whatever
      // changed underneath (another admin assigned one, a requester cancelled one).
      toast(error.message || 'Could not assign the selected requests','red')
      loadFacReqAlerts()
    } finally { setBatchSending(false) }
  }

  // Commodity filter options = only the commodities that were actually requested in
  // the current view (not the whole catalogue), deduped. Fed to a searchable select.
  const reqSourceForView = reqView==='inflight' ? inflightReqs : reqView==='history' ? reqHistory : facReqAlerts
  const requestedCommodities = [...new Map(
    reqSourceForView.map(r => store.allCommodities.find(c => c.id === r.commodity_id)).filter(Boolean).map(c => [c.id, c])
  ).values()]

  // Export payload for whichever request view is on screen, honouring the active
  // commodity / category / LGA filters (so you download exactly what you see).
  function buildReqExport() {
    const lgaOf = r => facLgaById[r.receiving_facility_id] || '—'
    const stamp = new Date().toISOString().slice(0,10)
    if (reqView === 'inflight') return {
      title: 'Redistribution requests in progress',
      subtitle: `${inflightList.length} request(s) awaiting dispatch or receipt`,
      filename: `redistribution-requests_in-progress_${stamp}.csv`,
      headers: ['Date requested','Commodity','Qty','Requesting facility','LGA','Source facility','Stage','Days waiting'],
      rightCols: new Set([2,7]),
      rows: inflightList.map(r => [
        fmtDateTime(r.initiated_at), r.commodity_name, r.quantity,
        r.receiving_facility_name || '—', lgaOf(r), r.sending_facility_name || '—',
        r.status === 'in_transit' ? 'In transit — awaiting receipt' : 'Awaiting dispatch by source',
        Math.max(0, Math.round((today - new Date(r.initiated_at))/86400000)),
      ]),
    }
    if (reqView === 'history') return {
      title: 'Redistribution request history',
      subtitle: `${histReqs.length} resolved request(s) · ${histFrom} to ${histTo}`,
      filename: `redistribution-requests_history_${histFrom}_to_${histTo}.csv`,
      headers: ['Date requested','Commodity','Qty','Requesting facility','LGA','Source facility','Status','Reason'],
      rightCols: new Set([2]),
      rows: histReqs.map(r => [
        fmtDateTime(r.initiated_at), r.commodity_name, r.quantity,
        r.receiving_facility_name || '—', lgaOf(r), r.sending_facility_name || '—', r.status, transferReason(r) || '—',
      ]),
    }
    return {
      title: 'Redistribution requests awaiting review',
      subtitle: `${activeReqs.length} request(s) awaiting a source facility`,
      filename: `redistribution-requests_awaiting-review_${stamp}.csv`,
      headers: ['Date submitted','Commodity','Category','Qty requested','Requesting facility','LGA','Submitted by','Notes'],
      rightCols: new Set([3]),
      rows: activeReqs.map(r => [
        fmtDateTime(r.initiated_at), r.commodity_name, r.commodities?.category || '—',
        r.qty_requested ?? r.quantity, r.receiving_facility_name || '—', lgaOf(r),
        r.initiated_by || '—', r.notes || '',
      ]),
    }
  }
  function downloadReqCsv() { const e = buildReqExport(); exportCsv(e.filename, e.headers, e.rows) }
  function downloadReqPdf() { const e = buildReqExport(); exportPdf(e.title, e.subtitle, e.headers, e.rows, e.rightCols) }

  // Category + State narrowing for the expiry / out / low / overstock tables.
  // Out/low/over are per-commodity aggregates already scoped to the picked state
  // in loadStockAlerts, so they only need the category filter here; expiry rows
  // carry a facility_id, so State is applied client-side.
  const inStockCat = r => !stockCat || (r.commodities?.category) === stockCat
  const shownExpiry = expiryRows.filter(r => inStockCat(r) && inScope(r.facility_id))
  const shownOut    = stockRows.out.filter(inStockCat)
  const shownLow    = stockRows.low.filter(inStockCat)
  const shownOver   = stockRows.over.filter(inStockCat)
  // Out-of-stock rows divided into in-use (a real stockout) and not-in-use.
  const outInUse    = shownOut.filter(r => r.inUse)
  const outNotInUse = shownOut.filter(r => !r.inUse)

  // Stock-derived counts are only meaningful once the stock payload has landed.
  // The alert figures come from loadAll's own scoped rollup now, so `loading`
  // alone is the correct gate — there is no separate app-wide payload to await.
  const stockPending = loading

  const today = new Date()
  const urgency = r => {
    const d=(new Date(r.expiry_date)-today)/86400000
    if(d<0)    return {label:'Expired', color:'text-red-500',bg:'bg-red-500/15',border:'border-red-500/30'}
    if(d<=30)  return {label:'Critical',color:'text-red-400',bg:'bg-red-500/10',border:'border-red-500/20'}
    if(d<=90)  return {label:'Warning', color:'text-amber-400',bg:'bg-amber-500/10',border:'border-amber-500/20'}
    return            {label:'Monitor', color:'text-blue-400',bg:'bg-blue-500/10',border:'border-blue-500/20'}
  }
  // Urgency-bucketed expiry rows for the tiles + the flat table, matching the
  // Monitoring expiry view: the tiles count every in-scope batch; the table shows
  // the selected bucket ('all' = every batch), soonest expiry first.
  const expBucketRows = lbl => shownExpiry.filter(r => urgency(r).label === lbl)
  const expShown = (expUrgency==='all' ? shownExpiry : expBucketRows(expUrgency))
    .slice().sort((a,b)=>new Date(a.expiry_date)-new Date(b.expiry_date))
  const expUrgencyLabel = { all:'All expiring', Expired:'Expired', Critical:'Critical (≤30d)', Warning:'Warning (≤90d)', Monitor:'Monitor (>90d)' }[expUrgency]
  function downloadExpiryCsv() {
    const headers = ['Facility','LGA','Commodity','Category','Batch','Expiry date','Days left','Qty','Unit','Urgency']
    const rows = expShown.map(r => {
      const dL = Math.round((new Date(r.expiry_date)-today)/86400000)
      return [facMeta[r.facility_id]?.name||'—', facMeta[r.facility_id]?.lga||'—', r.commodities?.name||'—',
        r.commodities?.category||'—', r.batch_number||'', fmtDate(r.expiry_date), dL, r.quantity, r.commodities?.unit||'', urgency(r).label]
    })
    exportCsv(`expiry_${expUrgency.toLowerCase()}_${expiryDays}d.csv`, headers, rows)
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-medium text-gray-100">Alerts</h1>
        <p className="text-sm text-gray-500 mt-1">Expiry, low stock, overstock and out of stock</p>
      </div>

      {/* Admin location filter — State → LGA → Facility (self-hides for facility users) */}
      <FacilityPicker />

      <MetricGrid>
        {store.module !== 'essential' && store.isAdmin() && !store.isOverallAdmin() && <Metric label="Requests" value={facReqAlerts.length} color="amber" loading={loadingFacReq} onClick={()=>{setTab('fac-requests');setReqView('active')}} active={tab==='fac-requests'&&reqView==='active'}/>}
        {store.module !== 'essential' && store.isAdmin() && !store.isOverallAdmin() && <Metric label="In progress" value={inflightReqs.length} color="blue" loading={loadingInflight} onClick={()=>{setTab('fac-requests');setReqView('inflight')}} active={tab==='fac-requests'&&reqView==='inflight'}/>}
        <Metric label="Out of stock"   value={stockRows.out.length}   color="red"   loading={stockPending} onClick={()=>setTab('out')}       active={tab==='out'}/>
        <Metric label="Low stock"      value={stockRows.low.length}   color="amber" loading={stockPending} onClick={()=>setTab('low')}       active={tab==='low'}/>
        <Metric label="Overstock"      value={stockRows.over.length}  color="blue"  loading={stockPending} onClick={()=>setTab('overstock')} active={tab==='overstock'}/>
        <Metric label="Expiry alerts"  value={expiryRows.filter(r=>(new Date(r.expiry_date)-today)/86400000<=30).length} color="red" loading={stockPending} onClick={()=>setTab('expiry')} active={tab==='expiry'}/>
      </MetricGrid>

      <div className="flex gap-2 mb-4 flex-wrap">
        <TabBtn id="expiry"    label="Expiry alerts" active={tab==="expiry"} onSelect={setTab}/>
        <TabBtn active={tab==="out"} onSelect={setTab} id="out"       label={`Out of stock${stockPending ? '' : ` (${stockRows.out.length})`}`}/>
        <TabBtn active={tab==="low"} onSelect={setTab} id="low"       label={`Low stock${stockPending ? '' : ` (${stockRows.low.length})`}`}/>
        <TabBtn active={tab==="overstock"} onSelect={setTab} id="overstock" label={`Overstock${stockPending ? '' : ` (${stockRows.over.length})`}`}/>
        {!store.isOverallAdmin() && store.module !== 'essential' && (
          <button onClick={()=>setTab('fac-requests')}
            className={`px-4 py-2 text-sm rounded-lg border transition-colors flex items-center gap-2 ${tab==='fac-requests'?'bg-white/8 border-white/15 text-gray-100 font-medium':'border-white/10 text-gray-400 hover:text-gray-200'}`}>
            Request alerts
            {facReqAlerts.length > 0 && <span className="bg-red-500 text-white text-xs font-bold rounded-full px-1.5 py-0.5 min-w-[1.2rem] text-center">{facReqAlerts.length}</span>}
          </button>
        )}
      </div>

      {['expiry','out','low','overstock'].includes(tab) && (
        <div className="mb-4 flex gap-2 items-center flex-wrap">
          <span className="text-xs text-gray-500 uppercase tracking-widest">Category</span>
          <select value={stockCat} onChange={e=>setStockCat(e.target.value)}
            className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500">
            <option value="">All categories</option>
            {categories.map(c=><option key={c} value={c}>{c}</option>)}
          </select>
          <button onClick={loadAll} disabled={loading} className="ml-auto text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5 disabled:opacity-60 inline-flex items-center gap-1.5">
            {loading && <Spinner size="sm"/>}{loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      )}

      {tab==='expiry' && (
        <>
          <MetricGrid>
            <Metric label="Expired" value={expBucketRows('Expired').length} color="red"
              onClick={()=>setExpUrgency(expUrgency==='Expired'?'all':'Expired')} active={expUrgency==='Expired'}/>
            <Metric label="Critical (≤30d)" value={expBucketRows('Critical').length} color="red"
              onClick={()=>setExpUrgency(expUrgency==='Critical'?'all':'Critical')} active={expUrgency==='Critical'}/>
            <Metric label="Warning (≤90d)" value={expBucketRows('Warning').length} color="amber"
              onClick={()=>setExpUrgency(expUrgency==='Warning'?'all':'Warning')} active={expUrgency==='Warning'}/>
            <Metric label="Monitor (>90d)" value={expBucketRows('Monitor').length} color="blue"
              onClick={()=>setExpUrgency(expUrgency==='Monitor'?'all':'Monitor')} active={expUrgency==='Monitor'}/>
            <Metric label="Total batches" value={shownExpiry.length}
              onClick={()=>setExpUrgency('all')} active={expUrgency==='all'}/>
          </MetricGrid>

          <Card>
            <CardHeader>
              <CardTitle>{expUrgencyLabel} batches{store.isAdmin()?' — by facility':''} <span className="text-gray-500 font-normal">· {expShown.length} {expShown.length===1?'batch':'batches'}</span></CardTitle>
              <div className="flex gap-2 items-center flex-wrap">
                <select value={expiryDays} onChange={e=>{setDays(parseInt(e.target.value));loadExpiry()}}
                  className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500">
                  <option value={30}>Within 30 days</option>
                  <option value={90}>Within 90 days</option>
                  <option value={180}>Within 6 months</option>
                  <option value={365}>Within 12 months</option>
                </select>
                {store.isAdmin() && (
                  <button onClick={downloadExpiryCsv} disabled={expShown.length===0}
                    className="text-xs text-gray-300 hover:text-white border border-white/10 rounded px-3 py-1.5 disabled:opacity-50 inline-flex items-center gap-1.5">↓ Download CSV</button>
                )}
              </div>
            </CardHeader>
            {loading ? <LoadingState/> : expShown.length===0 ? <EmptyState message={expUrgency==='all'?`No commodities expiring within ${expiryDays} days ✓`:`No ${expUrgencyLabel.toLowerCase()} batches ✓`}/> :
              !store.isAdmin() ? (
                /* Facility view: flat batch list (their own batches). */
                <div className="table-wrap"><table className="w-full text-sm">
                  <thead><tr className="border-b border-white/8 bg-white/2">
                    {['Commodity','Category','Batch','Expiry date','Days left','Qty','Urgency'].map(h=>(
                      <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>{expShown.map(r=>{
                    const u=urgency(r), dL=Math.round((new Date(r.expiry_date)-today)/86400000)
                    return (
                      <tr key={r.id} className="border-b border-white/5 hover:bg-white/2">
                        <td className="px-4 py-3 font-medium text-gray-100">{r.commodities?.name||'—'}</td>
                        <td className="px-4 py-3"><CatBadge>{r.commodities?.category||'—'}</CatBadge></td>
                        <td className="px-4 py-3 font-mono text-xs text-gray-500">{r.batch_number||'—'}</td>
                        <td className="px-4 py-3 font-mono text-xs text-gray-300">{fmtDate(r.expiry_date)}</td>
                        <td className={`px-4 py-3 font-mono text-sm font-semibold ${u.color}`}>{dL<0?`${-dL}d ago`:`${dL}d`}</td>
                        <td className="px-4 py-3 font-mono text-sm text-gray-300">{r.quantity} {r.commodities?.unit||''}</td>
                        <td className="px-4 py-3"><span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${u.bg} ${u.color} ${u.border}`}>{u.label}</span></td>
                      </tr>
                    )
                  })}</tbody>
                </table></div>
              ) : (
                /* Admin view: one flat row per expiring batch — facility & commodity side by side. */
                <div className="table-wrap"><table className="w-full text-sm">
                  <thead><tr className="border-b border-white/8 bg-white/2">
                    {['Facility','LGA','Commodity','Category','Batch','Expiry date','Days left','Qty','Urgency'].map(h=>(
                      <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>{expShown.map(r=>{
                    const u=urgency(r), dL=Math.round((new Date(r.expiry_date)-today)/86400000)
                    return (
                      <tr key={`${r.facility_id}|${r.commodity_id}|${r.batch_number}|${r.expiry_date}`} className="border-b border-white/5 hover:bg-white/2">
                        <td className="px-4 py-3 font-medium text-gray-100">{facMeta[r.facility_id]?.name||'—'}</td>
                        <td className="px-4 py-3 text-xs text-gray-500">{facMeta[r.facility_id]?.lga||'—'}</td>
                        <td className="px-4 py-3 text-gray-200">{r.commodities?.name||'—'}</td>
                        <td className="px-4 py-3"><CatBadge>{r.commodities?.category||'—'}</CatBadge></td>
                        <td className="px-4 py-3 font-mono text-xs text-gray-500">{r.batch_number||'—'}</td>
                        <td className="px-4 py-3 font-mono text-xs text-gray-300">{fmtDate(r.expiry_date)}</td>
                        <td className={`px-4 py-3 font-mono text-sm font-semibold ${u.color}`}>{dL<0?`${-dL}d ago`:`${dL}d`}</td>
                        <td className="px-4 py-3 font-mono text-sm text-gray-300">{r.quantity} {r.commodities?.unit||''}</td>
                        <td className="px-4 py-3"><span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${u.bg} ${u.color} ${u.border}`}>{u.label}</span></td>
                      </tr>
                    )
                  })}</tbody>
                </table></div>
              )
            }
          </Card>
        </>
      )}

      {/* Stock-status tabs. Admin can tap a commodity to drill into its facilities. */}
      {['out','low','overstock'].includes(tab) && drillComm ? (() => {
        const isLabSel  = isLabCategory(drillComm.cat)
        const statusFor = tab==='out' ? 'out' : tab==='low' ? 'low' : 'over'
        // Built from the per-facility rollup. Facility names come from the
        // catalogue already in the store rather than being repeated on every row.
        // `other_qty` is deliberately ignored: this breakdown only ever counted
        // store and dispensary rows from the stock table, and that is preserved.
        const byFac = {}
        drillRows.filter(r => inScope(r.facility_id)).forEach(r => {
          const x = store.allFacilities.find(y => y.id === r.facility_id)
          byFac[r.facility_id] = {
            id: r.facility_id, name: x?.name||'—', state: x?.state||'—', lga: x?.lga||'—',
            store: r.store_qty, dispensary: r.dispensary_qty,
            dsd: r.dsd_qty, sdp: r.sdp_qty,
            amc: r.baseline_amc || 0, comm: drillComm.comm,
          }
        })
        Object.values(byFac).forEach(f => { f.total = isLabSel ? (f.store + f.sdp) : (f.store + f.dispensary + f.dsd) })
        const list = Object.values(byFac).filter(f => getStockStatus(f.total, f.amc) === statusFor).sort((a,b)=>a.total-b.total)
        const cols = isLabSel ? ['Facility','State','LGA','Store SOH','SDP SOH','Total SOH','MOS'] : ['Facility','State','LGA','Store SOH','Dispensary SOH','DSD SOH','Total SOH','MOS']
        return (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">{drillComm.name} <CatBadge>{drillComm.cat}</CatBadge> — {statusFor==='out'?'out-of-stock':statusFor==='low'?'low-stock':'overstocked'} facilities</CardTitle>
              <button onClick={()=>setDrillComm(null)} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">← Back to commodities</button>
            </CardHeader>
            {list.length===0 ? <EmptyState message="No facilities in this status for this commodity."/> : (
              <div className="table-wrap"><table className="w-full text-sm">
                <thead><tr className="border-b border-white/8 bg-white/2">
                  {cols.map(h=><th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>)}
                </tr></thead>
                <tbody>{list.map(f=>{
                  const mos=getMOS(f.total,f.amc)
                  return (
                    <tr key={f.id} className="border-b border-white/5 hover:bg-white/2">
                      <td className="px-4 py-3 font-medium text-gray-100">{f.name}</td>
                      <td className="px-4 py-3 text-xs text-gray-500">{f.state}</td>
                      <td className="px-4 py-3 text-xs text-gray-500">{f.lga}</td>
                      <td className="px-4 py-3 font-mono text-sm text-gray-200">{f.store}</td>
                      {isLabSel
                        ? <td className="px-4 py-3 font-mono text-sm text-blue-300">{f.sdp}</td>
                        : <><td className="px-4 py-3 font-mono text-sm text-blue-300">{f.dispensary}</td><td className="px-4 py-3 font-mono text-sm text-purple-300">{f.dsd}</td></>}
                      <td className="px-4 py-3 font-mono text-sm font-semibold text-gray-100">{f.total}</td>
                      <td className="px-4 py-3 font-mono text-sm text-gray-400">{mos!==null?`${mos}mo`:'—'}</td>
                    </tr>
                  )
                })}</tbody>
              </table></div>
            )}
          </Card>
        )
      })() : (
        <>
          {tab==='out' && (
            <>
              {/* Split the zero balances into ones this facility actually uses (a
                  real stockout) and ones it has never used/reported. Click a card
                  to filter the table below. */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                <Metric label="Out of stock · in use" value={shownOut.filter(r=>r.inUse).length}
                  color="red" loading={stockPending}
                  onClick={()=>setUseFilter(v=>v==='inuse'?'':'inuse')} active={useFilter==='inuse'} />
                <Metric label="Out of stock · not in use" value={shownOut.filter(r=>!r.inUse).length}
                  loading={stockPending}
                  onClick={()=>setUseFilter(v=>v==='unused'?'':'unused')} active={useFilter==='unused'} />
              </div>
              <p className="text-xs text-gray-600 mb-4">
                “In use” = this facility has ever received or consumed it, or holds stock of it.
              </p>
              {/* Two divisions: in-use (real stockouts) on top, not-in-use below.
                  The cards above focus one division; with none selected, both show. */}
              {useFilter !== 'unused' && (
                <Card className="mb-4"><CardHeader><CardTitle>In use — out of stock ({outInUse.length})</CardTitle></CardHeader>
                  <StockTable stockPending={stockPending} rows={outInUse} emptyMsg="Nothing in use is out of stock ✓" qtyClass="text-red-400"
                    onRowClick={store.isAdmin()?(r)=>setDrillComm({id:r.commodity_id,name:r.commodities?.name,cat:r.commodities?.category,comm:r.commodities}):undefined}/></Card>
              )}
              {useFilter !== 'inuse' && (
                <Card><CardHeader><CardTitle>Not in use — out of stock ({outNotInUse.length})</CardTitle></CardHeader>
                  <StockTable stockPending={stockPending} rows={outNotInUse} emptyMsg="Nothing not-in-use is out of stock" qtyClass="text-red-400"
                    onRowClick={store.isAdmin()?(r)=>setDrillComm({id:r.commodity_id,name:r.commodities?.name,cat:r.commodities?.category,comm:r.commodities}):undefined}/></Card>
              )}
            </>
          )}
          {tab==='low'       && <Card><CardHeader><CardTitle>Low stock — below 2 months AMC</CardTitle></CardHeader><StockTable stockPending={stockPending} rows={shownLow}  emptyMsg="No commodities below threshold ✓" qtyClass="text-amber-400" onRowClick={store.isAdmin()?(r)=>setDrillComm({id:r.commodity_id,name:r.commodities?.name,cat:r.commodities?.category,comm:r.commodities}):undefined}/></Card>}
          {tab==='overstock' && <Card><CardHeader><CardTitle>Overstock — above 4 months AMC</CardTitle></CardHeader><StockTable stockPending={stockPending} rows={shownOver} emptyMsg="No commodities overstocked ✓" qtyClass="text-blue-400"  onRowClick={store.isAdmin()?(r)=>setDrillComm({id:r.commodity_id,name:r.commodities?.name,cat:r.commodities?.category,comm:r.commodities}):undefined}/></Card>}
        </>
      )}

      {tab==='fac-requests' && (
        <Card>
          <CardHeader>
            <CardTitle>{store.isAdmin() ? (reqView==='history' ? 'Redistribution request history' : reqView==='inflight' ? 'Requests in progress' : 'Facility redistribution requests') : 'Requests & dispatch tasks'}</CardTitle>
            <div className="flex gap-2 flex-wrap">
              {store.isAdmin() ? (
                <>
                  {[
                    { id:'active',   label:`Awaiting review (${activeReqs.length})` },
                    { id:'inflight', label:`In progress (${inflightList.length})` },
                    { id:'history',  label:'History' },
                  ].map(v => (
                    <button key={v.id} onClick={()=>{ setReqView(v.id); setAssigningId(null) }}
                      className={`text-xs rounded-lg border px-3 py-1.5 transition-colors ${reqView===v.id ? 'bg-white/8 border-white/15 text-gray-100 font-medium' : 'border-white/10 text-gray-400 hover:text-gray-200'}`}>
                      {v.label}
                    </button>
                  ))}
                  <button onClick={downloadReqCsv} disabled={reqRowCount===0}
                    className="text-xs text-gray-400 hover:text-gray-200 border border-white/10 rounded px-3 py-1.5 disabled:opacity-40 disabled:hover:text-gray-400">
                    ↓ CSV
                  </button>
                  <button onClick={downloadReqPdf} disabled={reqRowCount===0}
                    className="text-xs text-gray-400 hover:text-gray-200 border border-white/10 rounded px-3 py-1.5 disabled:opacity-40 disabled:hover:text-gray-400">
                    ↓ PDF
                  </button>
                  <button onClick={reqView==='history' ? loadHistory : reqView==='inflight' ? loadInflight : loadFacReqAlerts} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">Refresh</button>
                </>
              ) : (
                <>
                  <button onClick={loadFacReqAlerts} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">Refresh</button>
                  <Button variant="primary" size="sm" onClick={()=>store.setCurrentPage('transfers')}>Submit new request</Button>
                </>
              )}
            </div>
          </CardHeader>

          {store.isAdmin() && (
            <div className="px-5 py-3 border-b border-white/8 flex flex-wrap gap-3 items-end">
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Commodity</label>
                <CommoditySelect commodities={requestedCommodities} value={filterComm} onChange={setFilterComm}
                  placeholder="All commodities"
                  className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500 min-w-[200px]" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Category</label>
                <select value={filterCat} onChange={e=>setFilterCat(e.target.value)} className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500 min-w-[140px]">
                  <option value="">All categories</option>
                  {categories.map(c=><option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">LGA</label>
                <select value={filterLga} onChange={e=>setFilterLga(e.target.value)} className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500 min-w-[140px]">
                  <option value="">All LGAs</option>
                  {lgaOptions.map(l=><option key={l} value={l}>{l}</option>)}
                </select>
              </div>
              {reqView==='history' && (
                <>
                  <div>
                    <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">From</label>
                    <input type="date" value={histFrom} onChange={e=>setHistFrom(e.target.value)} className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">To</label>
                    <input type="date" value={histTo} onChange={e=>setHistTo(e.target.value)} className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500" />
                  </div>
                </>
              )}
              {(filterComm || filterLga || filterCat) && (
                <button onClick={()=>{ setFilterComm(''); setFilterLga(''); setFilterCat('') }} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">Clear filters</button>
              )}
            </div>
          )}

          {store.isAdmin() ? (
            reqView==='history' ? (
              loadingHist ? <LoadingState/> : histReqs.length===0 ? <EmptyState message="No matching resolved requests"/> : (
                <div className="table-wrap"><table className="w-full text-sm">
                  <thead><tr className="border-b border-white/8 bg-white/2">
                    {['Date requested','Commodity','Qty','Requesting facility','LGA','Source facility','Status'].map(h=>(
                      <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>{histReqs.map(r=>(
                    <tr key={r.id} className="border-b border-white/5 hover:bg-white/2">
                      <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDateTime(r.initiated_at)}</td>
                      <td className="px-4 py-3 font-medium text-gray-100">{r.commodity_name}</td>
                      <td className="px-4 py-3 font-mono text-sm text-gray-300">{r.quantity}</td>
                      <td className="px-4 py-3 text-xs text-gray-400">{r.receiving_facility_name||'—'}</td>
                      <td className="px-4 py-3 text-xs text-gray-500">{facLgaById[r.receiving_facility_id]||'—'}</td>
                      <td className="px-4 py-3 text-xs text-gray-400">{r.sending_facility_name||'—'}</td>
                      <td className="px-4 py-3">
                        <Badge type={r.status==='accepted'?'ok':r.status==='disputed'?'out':'amber'}>{r.status}</Badge>
                        {transferReason(r) && <div className="text-xs text-red-300 mt-1 max-w-[240px] whitespace-normal">Reason: {transferReason(r)}</div>}
                      </td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )
            ) : reqView==='inflight' ? (
              loadingInflight ? <LoadingState/> : inflightList.length===0 ? <EmptyState message="No requests in progress — nothing awaiting dispatch or receipt ✓"/> : (
                <div className="table-wrap"><table className="w-full text-sm">
                  <thead><tr className="border-b border-white/8 bg-white/2">
                    {['Date requested','Commodity','Qty','Requesting facility','LGA','Source facility','Stage','Waiting'].map(h=>(
                      <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>{inflightList.map(r=>{
                    const daysWaiting = Math.max(0, Math.round((today - new Date(r.initiated_at))/86400000))
                    const inTransit = r.status === 'in_transit'
                    return (
                      <tr key={r.id} className="border-b border-white/5 hover:bg-white/2">
                        <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDateTime(r.initiated_at)}</td>
                        <td className="px-4 py-3 font-medium text-gray-100">{r.commodity_name}</td>
                        <td className="px-4 py-3 font-mono text-sm text-gray-300">{r.quantity}</td>
                        <td className="px-4 py-3 text-xs text-gray-400">{r.receiving_facility_name||'—'}</td>
                        <td className="px-4 py-3 text-xs text-gray-500">{facLgaById[r.receiving_facility_id]||'—'}</td>
                        <td className="px-4 py-3 text-xs text-gray-400">{r.sending_facility_name||'—'}</td>
                        <td className="px-4 py-3">
                          <span className={`text-xs font-medium rounded-full px-2 py-0.5 border ${inTransit ? 'text-blue-400 bg-blue-500/10 border-blue-500/20' : 'text-amber-400 bg-amber-500/10 border-amber-500/20'}`}>
                            {inTransit ? '📦 In transit — awaiting receipt' : '⏳ Awaiting dispatch by source'}
                          </span>
                        </td>
                        <td className={`px-4 py-3 font-mono text-xs ${daysWaiting>=7?'text-red-400':daysWaiting>=3?'text-amber-400':'text-gray-500'}`}>{daysWaiting}d</td>
                      </tr>
                    )
                  })}</tbody>
                </table></div>
              )
            ) : activeReqs.length===0 ? <EmptyState message="No pending redistribution requests ✓"/> : (
              <>
              {/* Batch assign. Sits above the list so the admin can tick several
                  requests — typically every lab consumable heading to the State Office
                  Store — set one source, and send them together. Quantities stay
                  editable per request. */}
              {store.isStateAdmin() && (
                <div className="px-5 py-3 border-b border-white/8 bg-white/3">
                  <div className="flex items-center gap-3 flex-wrap mb-2">
                    <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                      <input type="checkbox" checked={allBatchSelected} onChange={toggleSelectAll}
                        className="w-4 h-4 accent-blue-500 cursor-pointer" />
                      Select all {activeReqs.length}
                    </label>
                    {batchIds.length > 0 && (
                      <span className="text-xs text-gray-500">
                        {batchIds.length} of {activeReqs.length} selected
                      </span>
                    )}
                  </div>
                  {batchIds.length === 0 ? (
                    <div className="text-xs text-gray-500">
                      Tick requests below to assign several to one source facility at once.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-end gap-2">
                        <div className="w-full sm:w-64 space-y-2">
                          <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Source facility *</label>
                          <select value={batchFacState} onChange={e=>{setBatchFacState(e.target.value);setBatchFacLga('');setBatchFacId('')}}
                            className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500">
                            <option value="">Select state…</option>
                            {Object.keys(batchFacGroups).sort().map(st => <option key={st} value={st}>{st}</option>)}
                          </select>
                          {batchFacState && (
                            <select value={batchFacLga} onChange={e=>{setBatchFacLga(e.target.value);setBatchFacId('')}}
                              className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500">
                              <option value="">Select LGA…</option>
                              {Object.keys(batchFacGroups[batchFacState]||{}).sort().map(l => <option key={l} value={l}>{l}</option>)}
                            </select>
                          )}
                          {batchFacLga && (
                            <select value={batchFacId} onChange={e=>setBatchFacId(e.target.value)}
                              className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500">
                              <option value="">Select source facility…</option>
                              {batchFacOptions.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                            </select>
                          )}
                        </div>
                        <div className="w-full sm:w-52">
                          <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Reviewed by *</label>
                          <input value={batchReviewedBy} onChange={e=>setBatchReviewedBy(e.target.value)}
                            placeholder="Your name"
                            className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600 focus:outline-none focus:border-blue-500" />
                        </div>
                        <Button variant="primary" size="sm" disabled={batchSending || !batchFacId || !batchReviewedBy.trim()} onClick={sendBatch}>
                          {batchSending
                            ? 'Sending…'
                            : `Send ${batchIds.length} request${batchIds.length===1?'':'s'} to source`}
                        </Button>
                        <Button variant="default" size="sm" disabled={batchSending} onClick={clearBatch}>Clear selection</Button>
                      </div>

                      {/* Shortfalls are a warning, never a block: stock moves between
                          assignment and dispatch, and the source can still refuse. */}
                      {batchFacId && batchShortfalls.length > 0 && (
                        <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2">
                          <div className="font-medium mb-0.5">Source may not have enough — checked against the combined selection:</div>
                          {batchShortfalls.map(sf => (
                            <div key={sf.commodity_id}>
                              {sf.name}: needs {sf.want}, store holds {sf.have}
                            </div>
                          ))}
                          <div className="text-gray-500 mt-0.5">You can still send — the source facility can dispatch what it has, or decline.</div>
                        </div>
                      )}
                      {batchFacId && batchStock && batchShortfalls.length === 0 && (
                        <div className="text-xs text-green-400">Source holds enough for every selected request.</div>
                      )}
                    </div>
                  )}
                </div>
              )}
              {activeReqs.map(req => {
                const assignFacGroups = {}
                ;(assignFacPool.length ? assignFacPool : store.allFacilities)
                  .filter(f => f.id !== req.receiving_facility_id && f.state)
                  .forEach(f => {
                  const s=f.state, l=f.lga || 'State Office'
                  if(!assignFacGroups[s]) assignFacGroups[s]={}
                  if(!assignFacGroups[s][l]) assignFacGroups[s][l]=[]
                  assignFacGroups[s][l].push(f)
                })
                return (
                <div key={req.id} className="px-5 py-4 border-b border-white/8 last:border-0">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    {store.isStateAdmin() && (
                      <input type="checkbox" checked={!!batchSel[req.id]} onChange={()=>toggleBatch(req)}
                        aria-label={`Select ${req.commodity_name} for batch assign`}
                        className="mt-1.5 w-4 h-4 accent-blue-500 cursor-pointer" />
                    )}
                    <div className="flex-1">
                      <div className="font-medium text-gray-100 mb-1">{req.commodity_name}</div>
                      <div className="text-sm text-gray-400">
                        Requested: <span className="font-medium text-gray-200">{req.qty_requested ?? req.quantity}</span>
                        {' '}· From: <span className="text-blue-400">{req.receiving_facility_name || '—'}</span>
                        {facLgaById[req.receiving_facility_id] && facLgaById[req.receiving_facility_id]!=='—' && <> · LGA: <span className="text-gray-300">{facLgaById[req.receiving_facility_id]}</span></>}
                      </div>
                      <div className="text-xs text-gray-600 mt-1">Submitted {fmtDateTime(req.initiated_at)} by {req.initiated_by||'—'}</div>
                      {store.isStateAdmin() && batchSel[req.id] && (
                        <div className="flex items-center gap-2 mt-2">
                          <label className="text-xs text-gray-500 uppercase tracking-widest">Qty to send</label>
                          <input type="number" min="1" value={batchQty[req.id] ?? ''}
                            onChange={e=>setBatchQty(m=>({ ...m, [req.id]: e.target.value }))}
                            className="w-24 bg-white/5 border border-white/15 rounded-lg px-2 py-1 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
                          {/* Availability for THIS commodity at the chosen source; the
                              combined-demand warning sits in the bar above. */}
                          {batchFacId && batchStock && (
                            <span className="text-xs text-gray-500">
                              source holds {batchStock[req.commodity_id] ?? 0}
                            </span>
                          )}
                        </div>
                      )}
                      {req.notes && <div className="text-xs text-amber-400 mt-1 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1 inline-block">{req.notes}</div>}
                    </div>
                    {store.isStateAdmin() && (
                      <div className="flex gap-2">
                        <Button variant="primary" size="sm" onClick={()=>{ const open = assigningId===req.id; setAssigningId(open?null:req.id); setAssignFacState(''); setAssignFacLga(''); setAssignFacId(''); setAssignReviewedBy(reviewerDefault()); setAssignQty(req.qty_requested ?? req.quantity ?? 1) }}>{assigningId===req.id ? 'Close' : 'Review & arrange'}</Button>
                        <Button variant="danger" size="sm" onClick={()=>rejectFacRequest(req)}>Reject</Button>
                      </div>
                    )}
                  </div>
                  {store.isStateAdmin() && assigningId === req.id && (
                    <div className="mt-3 p-3 bg-purple-500/5 border border-purple-500/20 rounded-lg space-y-3">
                      <div className="text-xs text-gray-400 font-medium">Select facility to fulfil this request</div>
                      <div className="space-y-2">
                        <select value={assignFacState} onChange={e=>{setAssignFacState(e.target.value);setAssignFacLga('');setAssignFacId('')}} className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-purple-500">
                          <option value="">Select state…</option>
                          {Object.keys(assignFacGroups).sort().map(s=><option key={s} value={s}>{s}</option>)}
                        </select>
                        {assignFacState && (
                          <select value={assignFacLga} onChange={e=>{setAssignFacLga(e.target.value);setAssignFacId('')}} className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-purple-500">
                            <option value="">Select LGA…</option>
                            {Object.keys(assignFacGroups[assignFacState]||{}).sort().map(l=><option key={l} value={l}>{l}</option>)}
                          </select>
                        )}
                        {assignFacLga && (
                          <select value={assignFacId} onChange={e=>setAssignFacId(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-purple-500">
                            <option value="">Select source facility…</option>
                            {(assignFacGroups[assignFacState]?.[assignFacLga]||[]).sort((a,b)=>a.name.localeCompare(b.name)).map(f=><option key={f.id} value={f.id}>{f.name}</option>)}
                          </select>
                        )}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Qty to issue *</label>
                          <input type="number" min="1" value={assignQty} onChange={e=>setAssignQty(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-purple-500" />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Reviewed by *</label>
                          <input type="text" value={assignReviewedBy} onChange={e=>setAssignReviewedBy(e.target.value)} placeholder="Admin name" className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-purple-500" />
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button variant="success" size="sm" disabled={assignLoading} onClick={()=>confirmAssignFacility(req)}>{assignLoading?'Sending…':'Send request to facility'}</Button>
                        <Button variant="ghost" size="sm" onClick={()=>{setAssigningId(null);setAssignFacState('');setAssignFacLga('');setAssignFacId('');setAssignReviewedBy(reviewerDefault());setAssignQty(1)}}>Cancel</Button>
                      </div>
                    </div>
                  )}
                </div>
                )
              })}
              </>
            )
          ) : facReqAlerts.length===0 ? <EmptyState message="No pending redistribution requests ✓"/> : (
            facReqAlerts.map(req => (
              <div key={req.id} className="px-5 py-4 border-b border-white/8 last:border-0">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="flex-1">
                    <div className="font-medium text-gray-100 mb-1">{req.commodity_name}</div>
                    <div className="text-sm text-gray-400">
                      Requested: <span className="font-medium text-gray-200">{req.qty_requested ?? req.quantity}</span>{store.allCommodities.find(c=>c.id===req.commodity_id)?.unit ? ` ${store.allCommodities.find(c=>c.id===req.commodity_id).unit}` : ''}
                      {req.qty_requested != null && req.quantity !== req.qty_requested && (
                        <> · Issued: <span className="font-medium text-green-300">{req.quantity}{store.allCommodities.find(c=>c.id===req.commodity_id)?.unit ? ` ${store.allCommodities.find(c=>c.id===req.commodity_id).unit}` : ''}</span></>
                      )}
                      {req._toDispatch
                        ? <> · To: <span className="text-green-400">{req.receiving_facility_name}</span></>
                        : req.sending_facility_name && <> · From: <span className="text-blue-400">{req.sending_facility_name}</span></>}
                    </div>
                    <div className="text-xs text-gray-600 mt-1">Submitted {fmtDateTime(req.initiated_at)} by {req.initiated_by||'—'}</div>
                    {req.notes && <div className="text-xs text-amber-400 mt-1 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1 inline-block">{req.notes}</div>}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {req._toDispatch ? (
                      <>
                        <span className="text-xs text-purple-300 bg-purple-500/10 border border-purple-500/20 rounded-full px-2 py-0.5">📤 Dispatch requested by admin</span>
                        <Button variant="primary" size="sm" onClick={()=>store.setCurrentPage('transfers')}>Go to dispatch</Button>
                      </>
                    ) : req.status === 'in_transit' ? (
                      <>
                        <span className="text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded-full px-2 py-0.5">📦 In transit</span>
                        <Button variant="success" size="sm" onClick={()=>{ setAcceptingId(req.id); setAcceptReceiverName('') }}>✓ Accept</Button>
                        <Button variant="danger" size="sm" onClick={()=>disputeTransfer(req)}>✕ Dispute</Button>
                      </>
                    ) : req.sending_facility_id ? (
                      <>
                        <span className="text-xs text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded-full px-2 py-0.5">⏳ Awaiting transfer from {req.sending_facility_name}</span>
                        <Button variant="danger" size="sm" onClick={()=>cancelFacRequest(req.id)}>Cancel</Button>
                      </>
                    ) : (
                      <>
                        <span className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-full px-2 py-0.5">⏳ Awaiting review by admin</span>
                        <Button variant="danger" size="sm" onClick={()=>cancelFacRequest(req.id)}>Cancel</Button>
                      </>
                    )}
                  </div>
                </div>
                {acceptingId === req.id && (
                  <div className="mt-3 p-3 bg-green-500/5 border border-green-500/20 rounded-lg flex items-end gap-3 flex-wrap">
                    <div className="flex-1 min-w-[180px]">
                      <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Receiver name *</label>
                      <input autoFocus type="text" value={acceptReceiverName} onChange={e=>setAcceptReceiverName(e.target.value)}
                        placeholder="Staff name" className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-green-500" />
                    </div>
                    <Button variant="success" size="sm" disabled={acceptLoading} onClick={()=>confirmAccept(req)}>
                      {acceptLoading ? 'Processing…' : 'Confirm accept'}
                    </Button>
                    <Button variant="default" size="sm" onClick={()=>{ setAcceptingId(null); setAcceptReceiverName('') }}>Cancel</Button>
                  </div>
                )}
              </div>
            ))
          )}
        </Card>
      )}

    </div>
  )
}
