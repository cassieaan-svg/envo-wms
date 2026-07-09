import { useState, useEffect } from 'react'
import { api } from '../../lib/api'
import { subscribeRealtime } from '../../lib/realtime'
import { useAppStore } from '../../store/appStore'
import { Card, CardHeader, CardTitle, CardBody } from '../../components/ui/Card'
import { MetricGrid, Metric } from '../../components/ui/Metric'
import { Badge, CatBadge } from '../../components/ui/Badge'
import { LoadingState, EmptyState, Spinner } from '../../components/ui/Loading'
import { FacilityPicker } from '../../components/ui/FacilityPicker'
import { toast } from '../../components/ui/Toast'
import { Button } from '../../components/ui/Button'
import { fmtDate, fmtDateTime, resolveAmcWindow, amcMapFromRows, getMOS, getStockStatus, groupStockByComm, isLabCategory, capExpiryBatchesToStock } from '../../utils/helpers'

export function Alerts() {
  const store = useAppStore()
  const commoditySection = useAppStore(s => s.commoditySection)
  const [tab, setTab]           = useState('expiry')
  const [expiryDays, setDays]   = useState(180)
  const [expiryRows, setExpiry] = useState([])
  const [stockRows, setStock]   = useState({ out:[], low:[], over:[] })
  const [loading, setLoading]   = useState(true)
  // Facility request alerts — own pending redistribution requests
  const [facReqAlerts, setFacReqAlerts] = useState([])
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
  const [drillSites, setDrillSites] = useState({ sdp:{}, dsd:{} }) // per-facility site stock for the drilled commodity
  const [expDrillComm, setExpDrillComm] = useState(null) // expiry tab: commodity drilled into {id,name,cat}
  const [assigningId, setAssigningId]           = useState(null)
  const [assignFacState, setAssignFacState]     = useState('')
  const [assignFacLga, setAssignFacLga]         = useState('')
  const [assignFacId, setAssignFacId]           = useState('')
  const [assignReviewedBy, setAssignReviewedBy] = useState('')
  const [assignQty, setAssignQty]               = useState(1)
  const [assignLoading, setAssignLoading]       = useState(false)
  // Unscoped facility list for the assign picker only — lets a state admin
  // assign a source facility from another state for emergency orders, without
  // widening their scoped dashboard/stock views.
  const [assignFacPool, setAssignFacPool]       = useState([])
  const [reqHistory, setReqHistory]   = useState([])
  const [loadingHist, setLoadingHist] = useState(false)
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
    if (store.isStateAdmin()) api.facilities.list({}).then(setAssignFacPool).catch(() => setAssignFacPool([]))
    return subscribeRealtime(['stock_transfer_log'], (payload) => {
      if (store.isOverallAdmin()) return
      if (store.isAdmin()) { loadFacReqAlerts(); return }
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
  }

  async function cancelFacRequest(id) {
    const confirmed = window.confirm('Cancel this redistribution request?')
    if (!confirmed) return
    try {
      await api.transfers.cancel(id, { cancelled_by: store.user?.email || '' })
    } catch { toast('Error cancelling request','red'); return }
    toast('Request cancelled','green')
    loadFacReqAlerts()
  }

  // State admin dismisses a facility request that shouldn't be fulfilled. Same
  // transition the requester's cancel uses — no stock moves.
  async function rejectFacRequest(req) {
    if (!window.confirm(`Reject the request for ${req.commodity_name || 'this commodity'} from ${req.receiving_facility_name || 'the facility'}? No transfer will be made.`)) return
    try {
      await api.transfers.cancel(req.id, { cancelled_by: store.user?.email || '' })
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
    setAssignReviewedBy(''); setAssignQty(1); setAssignLoading(false)
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
    await api.transfers.dispute(req.id, {
      disputed_by: store.user?.email || '',
      dispute_note: 'Disputed by receiver',
    }).catch(() => {})
    toast('Transfer marked as disputed','amber')
    loadFacReqAlerts()
  }

  async function loadExpiry() {
    const today  = new Date()
    const cutoff = new Date(today.getTime()+expiryDays*86400000).toISOString().split('T')[0]
    const todayS = today.toISOString().split('T')[0]
    const data = await api.intake.history({
      facility_id: fid, commodity_ids: commIds,
      expiry_from: todayS, expiry_to: cutoff, has_quantity: true,
      section: commoditySection || undefined,
    }).catch(() => [])

    // Cap each batch to current stock on hand (store + dispensary + DSD) so the
    // expiry list reflects what's physically left, not the original receipt.
    let dsdMap = {}
    if (fid) {
      const dsdData = await api.stock.dsd.list({ facility_id: fid }).catch(() => [])
      ;(dsdData || []).forEach(d => { dsdMap[d.commodity_id] = (dsdMap[d.commodity_id] || 0) + d.quantity })
    }
    const sohByComm = {}
    groupStockByComm(store.stockData).forEach(g => {
      sohByComm[g.commodity_id] = (g.storeQty || 0) + (g.dispensaryQty || 0) + (dsdMap[g.commodity_id] || 0)
    })
    const capped = capExpiryBatchesToStock(data || [], sohByComm)
    setExpiry(capped)
  }

  async function loadStockAlerts() {
    const amcWin = resolveAmcWindow(store.amcWindows[fid])
    let amcMap = {}
    if (commIds.length && fid) {
      const data = await api.dispense.history({
        facility_id: fid, commodity_ids: commIds,
        from: amcWin.start.toISOString(), to: amcWin.end.toISOString(),
        section: commoditySection || undefined,
      }).catch(() => [])
      amcMap = amcMapFromRows(data, amcWin)
    }

    // Aggregate DSD (pharmacy) and SDP (lab) stock so the total matches the Dashboard.
    let dsdMap = {}, sdpMap = {}
    if (fid) {
      const [dsdData, sdpData] = await Promise.all([
        api.stock.dsd.list({ facility_id: fid }).catch(() => []),
        api.stock.sdp.list({ facility_id: fid }).catch(() => []),
      ])
      ;(dsdData||[]).forEach(d=>{ dsdMap[d.commodity_id]=(dsdMap[d.commodity_id]||0)+d.quantity })
      ;(sdpData||[]).forEach(d=>{ sdpMap[d.commodity_id]=(sdpMap[d.commodity_id]||0)+d.quantity })
    }

    // Overall admin can narrow the aggregate to one state (from the stock-tab
    // State filter); everyone else sees their whole scope.
    const scopedStock = scopeSet ? store.stockData.filter(r => scopeSet.has(r.facility_id)) : store.stockData
    const grouped = groupStockByComm(scopedStock)
    const gMap = {}
    grouped.forEach(g=>{ gMap[g.commodity_id]=g })

    // Seed from every tracked commodity (not just those with a stock row) so
    // zero-stock / out-of-stock items are counted — keeps these alerts
    // consistent with the Dashboard.
    const enriched = store.allCommodities.map(c=>{
      const g             = gMap[c.id] || {}
      const comm          = g.commodities || c
      const storeQty      = g.storeQty || 0
      const dispensaryQty = g.dispensaryQty || 0
      const lab           = isLabCategory(comm?.category)
      const quantity      = lab ? (storeQty + (sdpMap[c.id]||0)) : (storeQty + dispensaryQty + (dsdMap[c.id]||0))
      const amc           = amcMap[c.id]&&amcMap[c.id]>0?amcMap[c.id]:(g.baseline_amc||0)
      return { id:c.id, commodity_id:c.id, commodities:comm, storeQty, dispensaryQty, quantity,
               _amc:amc, _mos:getMOS(quantity,amc), _status:getStockStatus(quantity,amc) }
    })
    setStock({
      out:  enriched.filter(r=>r._status==='out'),
      low:  enriched.filter(r=>r._status==='low'),
      over: enriched.filter(r=>r._status==='over'),
    })
  }

  useEffect(()=>{ if(fid) loadExpiry() },[expiryDays])
  // Recompute the out/low/over aggregates when the overall admin picks a state.
  useEffect(()=>{ if(store.isAdmin()) loadStockAlerts() },[scopeKey])
  useEffect(()=>{ if(store.isAdmin() && reqView==='history') loadHistory() },[reqView, histFrom, histTo])

  // Drill-in: load per-facility SDP/DSD site stock for the selected commodity so
  // the facility breakdown total matches the Dashboard (store + dispensary + site).
  useEffect(() => {
    if (!drillComm) { setDrillSites({ sdp:{}, dsd:{} }); return }
    let active = true
    const facIds = store.isOverallAdmin() ? undefined : store.allFacilities.map(f => f.id)
    Promise.all([
      api.stock.sdp.list({ commodity_id: drillComm.id, facility_ids: facIds, limit: 2000 }).catch(()=>[]),
      api.stock.dsd.list({ commodity_id: drillComm.id, facility_ids: facIds, limit: 2000 }).catch(()=>[]),
    ]).then(([sdp,dsd]) => {
      if (!active) return
      const sm={}, dm={}
      ;(sdp||[]).forEach(r=>{ sm[r.facility_id]=(sm[r.facility_id]||0)+r.quantity })
      ;(dsd||[]).forEach(r=>{ dm[r.facility_id]=(dm[r.facility_id]||0)+r.quantity })
      setDrillSites({ sdp:sm, dsd:dm })
    })
    return () => { active = false }
  }, [drillComm])

  // Reset any open drill-in when switching tabs or category.
  useEffect(() => { setDrillComm(null); setExpDrillComm(null) }, [tab, stockCat, scopeKey])

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
  const activeReqs = applyReqFilters(facReqAlerts)
  const histReqs   = applyReqFilters(reqHistory)

  // Category + State narrowing for the expiry / out / low / overstock tables.
  // Out/low/over are per-commodity aggregates already scoped to the picked state
  // in loadStockAlerts, so they only need the category filter here; expiry rows
  // carry a facility_id, so State is applied client-side.
  const inStockCat = r => !stockCat || (r.commodities?.category) === stockCat
  const shownExpiry = expiryRows.filter(r => inStockCat(r) && inScope(r.facility_id))
  const shownOut    = stockRows.out.filter(inStockCat)
  const shownLow    = stockRows.low.filter(inStockCat)
  const shownOver   = stockRows.over.filter(inStockCat)

  const today = new Date()
  const urgency = r => {
    const d=(new Date(r.expiry_date)-today)/86400000
    if(d<=30)  return {label:'Critical',color:'text-red-400',bg:'bg-red-500/10',border:'border-red-500/20'}
    if(d<=90)  return {label:'Warning', color:'text-amber-400',bg:'bg-amber-500/10',border:'border-amber-500/20'}
    return            {label:'Monitor', color:'text-blue-400',bg:'bg-blue-500/10',border:'border-blue-500/20'}
  }

  const TabBtn = ({id,label}) => (
    <button onClick={()=>setTab(id)}
      className={`px-4 py-2 text-sm rounded-lg border transition-colors ${tab===id?'bg-white/8 border-white/15 text-gray-100 font-medium':'border-white/10 text-gray-400 hover:text-gray-200'}`}>
      {label}
    </button>
  )

  const StockTable = ({rows,emptyMsg,qtyClass,onRowClick}) => rows.length===0 ? <EmptyState message={emptyMsg}/> : (
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

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-medium text-gray-100">Alerts</h1>
        <p className="text-sm text-gray-500 mt-1">Expiry, low stock, overstock and out of stock</p>
      </div>

      {/* Admin location filter — State → LGA → Facility (self-hides for facility users) */}
      <FacilityPicker />

      <MetricGrid>
        {store.isAdmin() && !store.isOverallAdmin() && <Metric label="Requests" value={facReqAlerts.length} color="amber" onClick={()=>setTab('fac-requests')} active={tab==='fac-requests'}/>}
        <Metric label="Out of stock"   value={stockRows.out.length}   color="red"   onClick={()=>setTab('out')}       active={tab==='out'}/>
        <Metric label="Low stock"      value={stockRows.low.length}   color="amber" onClick={()=>setTab('low')}       active={tab==='low'}/>
        <Metric label="Overstock"      value={stockRows.over.length}  color="blue"  onClick={()=>setTab('overstock')} active={tab==='overstock'}/>
        <Metric label="Expiry alerts"  value={expiryRows.filter(r=>(new Date(r.expiry_date)-today)/86400000<=30).length} color="red" onClick={()=>setTab('expiry')} active={tab==='expiry'}/>
      </MetricGrid>

      <div className="flex gap-2 mb-4 flex-wrap">
        <TabBtn id="expiry"    label="Expiry alerts"/>
        <TabBtn id="out"       label={`Out of stock (${stockRows.out.length})`}/>
        <TabBtn id="low"       label={`Low stock (${stockRows.low.length})`}/>
        <TabBtn id="overstock" label={`Overstock (${stockRows.over.length})`}/>
        {!store.isOverallAdmin() && (
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
        <Card>
          <CardHeader>
            <CardTitle>Batches expiring soon</CardTitle>
            <select value={expiryDays} onChange={e=>{setDays(parseInt(e.target.value));loadExpiry()}}
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500">
              <option value={30}>Within 30 days</option>
              <option value={90}>Within 90 days</option>
              <option value={180}>Within 6 months</option>
              <option value={365}>Within 12 months</option>
            </select>
          </CardHeader>
          {loading ? <LoadingState/> : shownExpiry.length===0 ? <EmptyState message={`No commodities expiring within ${expiryDays} days ✓`}/> :
            !store.isAdmin() ? (
              /* Facility view: flat batch list (their own batches). */
              <div className="table-wrap"><table className="w-full text-sm">
                <thead><tr className="border-b border-white/8 bg-white/2">
                  {['Commodity','Category','Batch','Expiry date','Days left','Qty','Urgency'].map(h=>(
                    <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                  ))}
                </tr></thead>
                <tbody>{shownExpiry.map(r=>{
                  const u=urgency(r), dL=Math.round((new Date(r.expiry_date)-today)/86400000)
                  return (
                    <tr key={r.id} className="border-b border-white/5 hover:bg-white/2">
                      <td className="px-4 py-3 font-medium text-gray-100">{r.commodities?.name||'—'}</td>
                      <td className="px-4 py-3"><CatBadge>{r.commodities?.category||'—'}</CatBadge></td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-500">{r.batch_number||'—'}</td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-300">{fmtDate(r.expiry_date)}</td>
                      <td className={`px-4 py-3 font-mono text-sm font-semibold ${u.color}`}>{dL}d</td>
                      <td className="px-4 py-3 font-mono text-sm text-gray-300">{r.quantity} {r.commodities?.unit||''}</td>
                      <td className="px-4 py-3"><span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${u.bg} ${u.color} ${u.border}`}>{u.label}</span></td>
                    </tr>
                  )
                })}</tbody>
              </table></div>
            ) : expDrillComm ? (() => {
              /* Admin drill-in: expiring batches for the selected commodity, by facility. */
              const batches = shownExpiry.filter(r => r.commodity_id === expDrillComm.id)
                .sort((a,b)=>new Date(a.expiry_date)-new Date(b.expiry_date))
              return (
                <>
                  <div className="px-5 py-3 border-b border-white/8 flex items-center justify-between flex-wrap gap-2">
                    <span className="text-sm text-gray-300 flex items-center gap-2">{expDrillComm.name} <CatBadge>{expDrillComm.cat}</CatBadge> — expiring batches by facility</span>
                    <button onClick={()=>setExpDrillComm(null)} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">← Back to commodities</button>
                  </div>
                  <div className="table-wrap"><table className="w-full text-sm">
                    <thead><tr className="border-b border-white/8 bg-white/2">
                      {['Facility','LGA','Batch','Expiry date','Days left','Qty','Urgency'].map(h=>(
                        <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>{batches.map(r=>{
                      const u=urgency(r), dL=Math.round((new Date(r.expiry_date)-today)/86400000)
                      return (
                        <tr key={r.id} className="border-b border-white/5 hover:bg-white/2">
                          <td className="px-4 py-3 font-medium text-gray-100">{facMeta[r.facility_id]?.name||'—'}</td>
                          <td className="px-4 py-3 text-xs text-gray-500">{facMeta[r.facility_id]?.lga||'—'}</td>
                          <td className="px-4 py-3 font-mono text-xs text-gray-500">{r.batch_number||'—'}</td>
                          <td className="px-4 py-3 font-mono text-xs text-gray-300">{fmtDate(r.expiry_date)}</td>
                          <td className={`px-4 py-3 font-mono text-sm font-semibold ${u.color}`}>{dL}d</td>
                          <td className="px-4 py-3 font-mono text-sm text-gray-300">{r.quantity} {r.commodities?.unit||''}</td>
                          <td className="px-4 py-3"><span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${u.bg} ${u.color} ${u.border}`}>{u.label}</span></td>
                        </tr>
                      )
                    })}</tbody>
                  </table></div>
                </>
              )
            })() : (() => {
              /* Admin top view: one row per commodity (tap to drill into facilities). */
              const byComm = {}
              shownExpiry.forEach(r => {
                const g = byComm[r.commodity_id] || (byComm[r.commodity_id] = { id:r.commodity_id, name:r.commodities?.name||'—', cat:r.commodities?.category||'—', unit:r.commodities?.unit||'', batches:0, qty:0, soonest:null, facs:new Set() })
                g.batches++; g.qty += r.quantity; g.facs.add(r.facility_id)
                const d = new Date(r.expiry_date)
                if (!g.soonest || d < g.soonest) g.soonest = d
              })
              const list = Object.values(byComm).sort((a,b)=>a.soonest-b.soonest)
              return (
                <div className="table-wrap"><table className="w-full text-sm">
                  <thead><tr className="border-b border-white/8 bg-white/2">
                    {['Commodity','Category','Facilities','Batches','Total qty','Soonest expiry','Days left','Urgency'].map(h=>(
                      <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>{list.map(g=>{
                    const dL=Math.round((g.soonest-today)/86400000)
                    const u=dL<=30?{label:'Critical',color:'text-red-400',bg:'bg-red-500/10',border:'border-red-500/20'}:dL<=90?{label:'Warning',color:'text-amber-400',bg:'bg-amber-500/10',border:'border-amber-500/20'}:{label:'Monitor',color:'text-blue-400',bg:'bg-blue-500/10',border:'border-blue-500/20'}
                    return (
                      <tr key={g.id} onClick={()=>setExpDrillComm({id:g.id,name:g.name,cat:g.cat})}
                        className="border-b border-white/5 cursor-pointer hover:bg-white/5">
                        <td className="px-4 py-3 font-medium text-blue-400 hover:text-blue-300">{g.name}<span className="text-gray-600 ml-1">›</span></td>
                        <td className="px-4 py-3"><CatBadge>{g.cat}</CatBadge></td>
                        <td className="px-4 py-3 text-gray-400">{g.facs.size}</td>
                        <td className="px-4 py-3 text-gray-400">{g.batches}</td>
                        <td className="px-4 py-3 font-mono text-sm text-gray-300">{g.qty} {g.unit}</td>
                        <td className="px-4 py-3 font-mono text-xs text-gray-300">{fmtDate(g.soonest.toISOString().slice(0,10))}</td>
                        <td className={`px-4 py-3 font-mono text-sm font-semibold ${u.color}`}>{dL}d</td>
                        <td className="px-4 py-3"><span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${u.bg} ${u.color} ${u.border}`}>{u.label}</span></td>
                      </tr>
                    )
                  })}</tbody>
                </table></div>
              )
            })()
          }
        </Card>
      )}

      {/* Stock-status tabs. Admin can tap a commodity to drill into its facilities. */}
      {['out','low','overstock'].includes(tab) && drillComm ? (() => {
        const isLabSel  = isLabCategory(drillComm.cat)
        const statusFor = tab==='out' ? 'out' : tab==='low' ? 'low' : 'over'
        // Per-facility store + dispensary from the loaded stock, plus on-demand SDP/DSD site stock.
        const byFac = {}
        store.stockData.filter(r => r.commodity_id === drillComm.id && inScope(r.facility_id)).forEach(r => {
          const f = byFac[r.facility_id] || (byFac[r.facility_id] = { id:r.facility_id, name:r.facilities?.name||'—', state:r.facilities?.state||'—', lga:r.facilities?.lga||'—', store:0, dispensary:0, dsd:0, sdp:0, amc:0, comm:r.commodities })
          if (r.location_type === 'store') f.store += r.quantity
          else if (r.location_type === 'dispensary') f.dispensary += r.quantity
          if ((r.baseline_amc||0) > f.amc) f.amc = r.baseline_amc||0
        })
        const ensure = fid => byFac[fid] || (byFac[fid] = (() => { const x=store.allFacilities.find(y=>y.id===fid); return { id:fid, name:x?.name||'—', state:x?.state||'—', lga:x?.lga||'—', store:0, dispensary:0, dsd:0, sdp:0, amc:0, comm:drillComm.comm } })())
        Object.entries(drillSites.sdp).forEach(([fid,q]) => { if (inScope(fid)) ensure(fid).sdp += q })
        Object.entries(drillSites.dsd).forEach(([fid,q]) => { if (inScope(fid)) ensure(fid).dsd += q })
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
          {tab==='out'       && <Card><CardHeader><CardTitle>Out of stock — quantity is zero</CardTitle></CardHeader><StockTable rows={shownOut}  emptyMsg="No commodities out of stock ✓" qtyClass="text-red-400"   onRowClick={store.isAdmin()?(r)=>setDrillComm({id:r.commodity_id,name:r.commodities?.name,cat:r.commodities?.category,comm:r.commodities}):undefined}/></Card>}
          {tab==='low'       && <Card><CardHeader><CardTitle>Low stock — below 2 months AMC</CardTitle></CardHeader><StockTable rows={shownLow}  emptyMsg="No commodities below threshold ✓" qtyClass="text-amber-400" onRowClick={store.isAdmin()?(r)=>setDrillComm({id:r.commodity_id,name:r.commodities?.name,cat:r.commodities?.category,comm:r.commodities}):undefined}/></Card>}
          {tab==='overstock' && <Card><CardHeader><CardTitle>Overstock — above 4 months AMC</CardTitle></CardHeader><StockTable rows={shownOver} emptyMsg="No commodities overstocked ✓" qtyClass="text-blue-400"  onRowClick={store.isAdmin()?(r)=>setDrillComm({id:r.commodity_id,name:r.commodities?.name,cat:r.commodities?.category,comm:r.commodities}):undefined}/></Card>}
        </>
      )}

      {tab==='fac-requests' && (
        <Card>
          <CardHeader>
            <CardTitle>{store.isAdmin() ? (reqView==='history' ? 'Redistribution request history' : 'Facility redistribution requests') : 'Requests & dispatch tasks'}</CardTitle>
            <div className="flex gap-2">
              {store.isAdmin() ? (
                <>
                  <button onClick={reqView==='history' ? loadHistory : loadFacReqAlerts} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">Refresh</button>
                  <Button variant="primary" size="sm" onClick={()=>{ setReqView(reqView==='history'?'active':'history'); setAssigningId(null) }}>{reqView==='history' ? '← Active requests' : 'History'}</Button>
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
                <select value={filterComm} onChange={e=>setFilterComm(e.target.value)} className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500 min-w-[160px]">
                  <option value="">All commodities</option>
                  {[...store.allCommodities].sort((a,b)=>a.name.localeCompare(b.name)).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
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
                    {['Date','Commodity','Qty','Requesting facility','LGA','Source facility','Status'].map(h=>(
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
                      <td className="px-4 py-3"><Badge type={r.status==='accepted'?'ok':r.status==='disputed'?'out':'amber'}>{r.status}</Badge></td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )
            ) : activeReqs.length===0 ? <EmptyState message="No pending redistribution requests ✓"/> : (
              activeReqs.map(req => {
                const assignFacGroups = {}
                ;(assignFacPool.length ? assignFacPool : store.allFacilities).filter(f => f.id !== req.receiving_facility_id).forEach(f => {
                  const s=f.state||'Other', l=f.lga||'Other'
                  if(!assignFacGroups[s]) assignFacGroups[s]={}
                  if(!assignFacGroups[s][l]) assignFacGroups[s][l]=[]
                  assignFacGroups[s][l].push(f)
                })
                return (
                <div key={req.id} className="px-5 py-4 border-b border-white/8 last:border-0">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="flex-1">
                      <div className="font-medium text-gray-100 mb-1">{req.commodity_name}</div>
                      <div className="text-sm text-gray-400">
                        Requested: <span className="font-medium text-gray-200">{req.qty_requested ?? req.quantity}</span>
                        {' '}· From: <span className="text-blue-400">{req.receiving_facility_name || '—'}</span>
                        {facLgaById[req.receiving_facility_id] && facLgaById[req.receiving_facility_id]!=='—' && <> · LGA: <span className="text-gray-300">{facLgaById[req.receiving_facility_id]}</span></>}
                      </div>
                      <div className="text-xs text-gray-600 mt-1">Submitted {fmtDateTime(req.initiated_at)} by {req.initiated_by||'—'}</div>
                      {req.notes && <div className="text-xs text-amber-400 mt-1 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1 inline-block">{req.notes}</div>}
                    </div>
                    {store.isStateAdmin() && (
                      <div className="flex gap-2">
                        <Button variant="primary" size="sm" onClick={()=>{ const open = assigningId===req.id; setAssigningId(open?null:req.id); setAssignFacState(''); setAssignFacLga(''); setAssignFacId(''); setAssignReviewedBy(''); setAssignQty(req.qty_requested ?? req.quantity ?? 1) }}>{assigningId===req.id ? 'Close' : 'Review & arrange'}</Button>
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
                        <Button variant="ghost" size="sm" onClick={()=>{setAssigningId(null);setAssignFacState('');setAssignFacLga('');setAssignFacId('');setAssignReviewedBy('');setAssignQty(1)}}>Cancel</Button>
                      </div>
                    </div>
                  )}
                </div>
                )
              })
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
