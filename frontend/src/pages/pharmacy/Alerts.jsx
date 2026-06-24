import { useState, useEffect } from 'react'
import { api } from '../../lib/api'
import { subscribeRealtime } from '../../lib/realtime'
import { useAppStore } from '../../store/appStore'
import { Card, CardHeader, CardTitle, CardBody } from '../../components/ui/Card'
import { MetricGrid, Metric } from '../../components/ui/Metric'
import { Badge, CatBadge } from '../../components/ui/Badge'
import { LoadingState, EmptyState } from '../../components/ui/Loading'
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
  const [assigningId, setAssigningId]           = useState(null)
  const [assignFacState, setAssignFacState]     = useState('')
  const [assignFacLga, setAssignFacLga]         = useState('')
  const [assignFacId, setAssignFacId]           = useState('')
  const [assignReviewedBy, setAssignReviewedBy] = useState('')
  const [assignQty, setAssignQty]               = useState(1)
  const [assignLoading, setAssignLoading]       = useState(false)
  const [reqHistory, setReqHistory]   = useState([])
  const [loadingHist, setLoadingHist] = useState(false)
  const [histFrom, setHistFrom] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10))
  const [histTo, setHistTo]     = useState(() => new Date().toISOString().slice(0, 10))

  const fid     = store.currentFacility?.id
  const commIds = store.allCommodities.map(c => c.id)

  useEffect(() => {
    loadAll()
    loadFacReqAlerts()
    return subscribeRealtime(['stock_transfer_log'], (payload) => {
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
      data = await api.transfers.list({
        facility_id: fid, direction: 'incoming', status: 'pending,in_transit',
        section: commoditySection || undefined,
      }).catch(() => [])
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

  // Admin reviews a facility request and assigns a source facility to fulfil it.
  // Setting sending_facility_id hands the request off to that facility to dispatch.
  async function confirmAssignFacility(req) {
    if (!assignFacId) { toast('Select a source facility','red'); return }
    if (!assignReviewedBy.trim()) { toast('Reviewed by is required','red'); return }
    const parsedQty = parseInt(assignQty)
    if (!parsedQty || parsedQty < 1) { toast('Qty must be at least 1','red'); return }
    setAssignLoading(true)
    const srcFac = store.allFacilities.find(f => f.id === assignFacId)
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
    setReqHistory((data || []).filter(t => !t.notes?.includes('[Internal:') && !t.notes?.includes('[DSD:')))
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

    const grouped = groupStockByComm(store.stockData)
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
  useEffect(()=>{ if(store.isAdmin() && reqView==='history') loadHistory() },[reqView, histFrom, histTo])

  // ── Admin request filters (commodity + LGA) ───────────────────────────────
  const facLgaById = {}
  store.allFacilities.forEach(f => { facLgaById[f.id] = f.lga || '—' })
  const lgaOptions = [...new Set(store.allFacilities.map(f => f.lga).filter(Boolean))].sort()
  const applyReqFilters = list => list.filter(r =>
    (!filterComm || r.commodity_id === filterComm) &&
    (!filterLga  || facLgaById[r.receiving_facility_id] === filterLga))
  const activeReqs = applyReqFilters(facReqAlerts)
  const histReqs   = applyReqFilters(reqHistory)

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

  const StockTable = ({rows,emptyMsg,qtyClass}) => rows.length===0 ? <EmptyState message={emptyMsg}/> : (
    <div className="table-wrap"><table className="w-full text-sm">
      <thead><tr className="border-b border-white/8 bg-white/2">
        {['Commodity','Category','Unit','Stock on hand','AMC','MOS'].map(h=>(
          <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
        ))}
      </tr></thead>
      <tbody>{rows.map(r=>{
        const mosColor = r._mos!==null ? (r._mos<2?'text-red-400':r._mos>4?'text-blue-400':'text-green-400') : 'text-gray-500'
        return (
          <tr key={r.id} className="border-b border-white/5 hover:bg-white/2">
            <td className="px-4 py-3 font-medium text-gray-100">{r.commodities?.name||'—'}</td>
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

      <MetricGrid>
        {store.isAdmin() && <Metric label="Requests" value={facReqAlerts.length} color="amber" onClick={()=>setTab('fac-requests')} active={tab==='fac-requests'}/>}
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
        <button onClick={()=>setTab('fac-requests')}
          className={`px-4 py-2 text-sm rounded-lg border transition-colors flex items-center gap-2 ${tab==='fac-requests'?'bg-white/8 border-white/15 text-gray-100 font-medium':'border-white/10 text-gray-400 hover:text-gray-200'}`}>
          Request alerts
          {facReqAlerts.length > 0 && <span className="bg-red-500 text-white text-xs font-bold rounded-full px-1.5 py-0.5 min-w-[1.2rem] text-center">{facReqAlerts.length}</span>}
        </button>
      </div>

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
          {loading ? <LoadingState/> : expiryRows.length===0 ? <EmptyState message={`No commodities expiring within ${expiryDays} days ✓`}/> : (
            <div className="table-wrap"><table className="w-full text-sm">
              <thead><tr className="border-b border-white/8 bg-white/2">
                {['Commodity','Category','Batch','Expiry date','Days left','Qty','Urgency'].map(h=>(
                  <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                ))}
              </tr></thead>
              <tbody>{expiryRows.map(r=>{
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
          )}
        </Card>
      )}

      {tab==='out'       && <Card><CardHeader><CardTitle>Out of stock — quantity is zero</CardTitle></CardHeader><StockTable rows={stockRows.out}  emptyMsg="No commodities out of stock ✓" qtyClass="text-red-400"/></Card>}
      {tab==='low'       && <Card><CardHeader><CardTitle>Low stock — below 2 months AMC</CardTitle></CardHeader><StockTable rows={stockRows.low}  emptyMsg="No commodities below threshold ✓" qtyClass="text-amber-400"/></Card>}
      {tab==='overstock' && <Card><CardHeader><CardTitle>Overstock — above 4 months AMC</CardTitle></CardHeader><StockTable rows={stockRows.over} emptyMsg="No commodities overstocked ✓" qtyClass="text-blue-400"/></Card>}

      {tab==='fac-requests' && (
        <Card>
          <CardHeader>
            <CardTitle>{store.isAdmin() ? (reqView==='history' ? 'Redistribution request history' : 'Facility redistribution requests') : 'My redistribution requests'}</CardTitle>
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
              {(filterComm || filterLga) && (
                <button onClick={()=>{ setFilterComm(''); setFilterLga('') }} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">Clear filters</button>
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
                store.allFacilities.filter(f => f.id !== req.receiving_facility_id).forEach(f => {
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
                    <Button variant="primary" size="sm" onClick={()=>{ const open = assigningId===req.id; setAssigningId(open?null:req.id); setAssignFacState(''); setAssignFacLga(''); setAssignFacId(''); setAssignReviewedBy(''); setAssignQty(req.qty_requested ?? req.quantity ?? 1) }}>{assigningId===req.id ? 'Close' : 'Review & arrange'}</Button>
                  </div>
                  {assigningId === req.id && (
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
                      {req.sending_facility_name && <> · From: <span className="text-blue-400">{req.sending_facility_name}</span></>}
                    </div>
                    <div className="text-xs text-gray-600 mt-1">Submitted {fmtDateTime(req.initiated_at)} by {req.initiated_by||'—'}</div>
                    {req.notes && <div className="text-xs text-amber-400 mt-1 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1 inline-block">{req.notes}</div>}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {req.status === 'in_transit' ? (
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
