import { useState, useEffect } from 'react'
import { sb } from '../../lib/supabase'
import { useAppStore } from '../../store/appStore'
import { Card, CardHeader, CardTitle } from '../../components/ui/Card'
import { MetricGrid, Metric } from '../../components/ui/Metric'
import { Badge, CatBadge } from '../../components/ui/Badge'
import { LoadingState, EmptyState } from '../../components/ui/Loading'
import { toast } from '../../components/ui/Toast'
import { Button } from '../../components/ui/Button'
import { fmtDate, fmtDateTime, resolveAmcWindow, amcMapFromRows, getMOS, getStockStatus, groupStockByComm } from '../../utils/helpers'

export function Alerts() {
  const store = useAppStore()
  const commoditySection = useAppStore(s => s.commoditySection)
  const sec = q => commoditySection ? q.eq('section', commoditySection) : q
  const [tab, setTab]           = useState('expiry')
  const [expiryDays, setDays]   = useState(180)
  const [expiryRows, setExpiry] = useState([])
  const [stockRows, setStock]   = useState({ out:[], low:[], over:[] })
  const [loading, setLoading]   = useState(true)
  // Facility request alerts (non-admin: facility users seeing their own pending requests)
  const [facReqAlerts, setFacReqAlerts] = useState([])
  const [acceptingId, setAcceptingId]             = useState(null)
  const [acceptReceiverName, setAcceptReceiverName] = useState('')
  const [acceptLoading, setAcceptLoading]         = useState(false)

  const fid     = store.currentFacility?.id
  const commIds = store.allCommodities.map(c => c.id)

  useEffect(() => {
    loadAll()
    if (!store.isAdmin() && fid) loadFacReqAlerts()
    const channel = sb.channel(`alerts-transfers-${fid}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stock_transfer_log' },
        (payload) => {
          const row = payload.new?.receiving_facility_id ? payload.new : (payload.old || {})
          if ((row.receiving_facility_id === fid || row.sending_facility_id === fid) && !store.isAdmin() && fid) loadFacReqAlerts()
        })
      .subscribe()
    return () => sb.removeChannel(channel)
  }, [fid])

  async function loadAll() {
    setLoading(true)
    await Promise.all([loadExpiry(), loadStockAlerts()])
    setLoading(false)
  }

  async function loadFacReqAlerts() {
    let q = sb.from('stock_transfer_log')
      .select('*').in('status',['pending','in_transit'])
      .eq('receiving_facility_id', fid)
      .order('initiated_at',{ascending:false})
    q = sec(q)
    const { data } = await q
    setFacReqAlerts(data||[])
  }

  async function cancelFacRequest(id) {
    const confirmed = window.confirm('Cancel this redistribution request?')
    if (!confirmed) return
    const { error } = await sb.from('stock_transfer_log').update({
      status: 'cancelled', resolved_at: new Date().toISOString(), resolved_by: store.user?.email||'',
    }).eq('id', id)
    if (error) { toast('Error cancelling request','red'); return }
    toast('Request cancelled','green')
    loadFacReqAlerts()
  }

  async function confirmAccept(req) {
    if (!acceptReceiverName.trim()) { toast('Receiver name is required','red'); return }
    setAcceptLoading(true)
    // The sending facility's stock was already deducted when it dispatched the
    // transfer (confirmDispatch). The receiver only credits its own stock — it
    // cannot read another facility's stock rows under RLS, which previously made
    // this re-check see 0 and wrongly report "insufficient stock".
    const { data: recStk } = await sb.from('stock').select('id,quantity')
      .eq('facility_id', req.receiving_facility_id).eq('commodity_id', req.commodity_id).eq('location_type','store').maybeSingle()
    if (recStk) {
      await sb.from('stock').update({ quantity: recStk.quantity + req.quantity, updated_at: new Date().toISOString() }).eq('id', recStk.id)
    } else {
      await sb.from('stock').insert({ facility_id: req.receiving_facility_id, commodity_id: req.commodity_id, quantity: req.quantity, location_type: 'store', updated_at: new Date().toISOString() })
    }
    await sb.from('intake_log').insert({
      facility_id: req.receiving_facility_id, commodity_id: req.commodity_id, quantity: req.quantity,
      supplier_source: req.sending_facility_name, condition_on_arrival: 'Good', received_by: acceptReceiverName.trim(),
      received_at: new Date().toISOString(), notes: 'Facility transfer in from ' + req.sending_facility_name,
      section: commoditySection,
    })
    const { error: updateErr } = await sb.from('stock_transfer_log').update({
      status: 'accepted', resolved_at: new Date().toISOString(), resolved_by: acceptReceiverName.trim(),
    }).eq('id', req.id)
    if (updateErr) { toast('Error updating transfer: ' + updateErr.message,'red'); setAcceptLoading(false); return }
    setAcceptingId(null); setAcceptReceiverName(''); setAcceptLoading(false)
    toast('Transfer accepted — stock updated','green')
    loadFacReqAlerts()
  }

  async function disputeTransfer(req) {
    await sb.from('stock_transfer_log').update({
      status: 'disputed', resolved_at: new Date().toISOString(), resolved_by: store.user?.email||'', dispute_note: 'Disputed by receiver',
    }).eq('id', req.id)
    toast('Transfer marked as disputed','amber')
    loadFacReqAlerts()
  }

  async function loadExpiry() {
    const today  = new Date()
    const cutoff = new Date(today.getTime()+expiryDays*86400000).toISOString().split('T')[0]
    const todayS = today.toISOString().split('T')[0]
    let q = sb.from('intake_log')
      .select('*,commodities(name,category,unit)')
      .not('expiry_date','is',null)
      .lte('expiry_date',cutoff).gte('expiry_date',todayS)
      .gt('quantity',0).eq('facility_id',fid).in('commodity_id',commIds)
      .order('expiry_date',{ascending:true})
    q = sec(q)
    const { data } = await q
    setExpiry(data||[])
  }

  async function loadStockAlerts() {
    const amcWin = resolveAmcWindow(store.amcWindows[fid])
    let amcMap = {}
    if (commIds.length && fid) {
      let q = sb.from('dispense_log')
        .select('commodity_id,quantity,dispensed_at')
        .gte('dispensed_at',amcWin.start.toISOString())
        .lt('dispensed_at',amcWin.end.toISOString())
        .in('commodity_id',commIds).eq('facility_id',fid)
      q = sec(q)
      const { data } = await q
      amcMap = amcMapFromRows(data, amcWin)
    }

    // Aggregate SDP stock (lab total = store + SDP) so totals match the Dashboard.
    let sdpMap = {}
    if (fid) {
      const { data: sdpData } = await sb.from('sdp_stock').select('commodity_id,quantity').eq('facility_id', fid)
      ;(sdpData||[]).forEach(d=>{ sdpMap[d.commodity_id]=(sdpMap[d.commodity_id]||0)+d.quantity })
    }

    const grouped = groupStockByComm(store.stockData)
    const gMap = {}
    grouped.forEach(g=>{ gMap[g.commodity_id]=g })

    // Seed from every tracked commodity (not just those with a stock row) so
    // zero-stock / out-of-stock items are counted — keeps these alerts
    // consistent with the Dashboard.
    const enriched = store.allCommodities.map(c=>{
      const g        = gMap[c.id] || {}
      const comm     = g.commodities || c
      const storeQty = g.storeQty || 0
      const quantity = storeQty + (sdpMap[c.id]||0)
      const amc      = amcMap[c.id]&&amcMap[c.id]>0?amcMap[c.id]:(g.baseline_amc||0)
      return { id:c.id, commodity_id:c.id, commodities:comm, storeQty, quantity,
               _amc:amc, _mos:getMOS(quantity,amc), _status:getStockStatus(quantity,amc) }
    })
    setStock({
      out:  enriched.filter(r=>r._status==='out'),
      low:  enriched.filter(r=>r._status==='low'),
      over: enriched.filter(r=>r._status==='over'),
    })
  }

  useEffect(()=>{ if(fid) loadExpiry() },[expiryDays])

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
        <Metric label="Out of stock"   value={stockRows.out.length}   color="red"/>
        <Metric label="Low stock"      value={stockRows.low.length}   color="amber"/>
        <Metric label="Overstock"      value={stockRows.over.length}  color="blue"/>
        <Metric label="Expiry alerts"  value={expiryRows.filter(r=>(new Date(r.expiry_date)-today)/86400000<=30).length} color="red"/>
      </MetricGrid>

      <div className="flex gap-2 mb-4 flex-wrap">
        <TabBtn id="expiry"    label="Expiry alerts"/>
        <TabBtn id="out"       label={`Out of stock (${stockRows.out.length})`}/>
        <TabBtn id="low"       label={`Low stock (${stockRows.low.length})`}/>
        <TabBtn id="overstock" label={`Overstock (${stockRows.over.length})`}/>
        {!store.isAdmin() && (
          <button onClick={()=>setTab('fac-requests')}
            className={`px-4 py-2 text-sm rounded-lg border transition-colors flex items-center gap-2 ${tab==='fac-requests'?'bg-white/8 border-white/15 text-gray-100 font-medium':'border-white/10 text-gray-400 hover:text-gray-200'}`}>
            Request alerts
            {facReqAlerts.length > 0 && <span className="bg-red-500 text-white text-xs font-bold rounded-full px-1.5 py-0.5 min-w-[1.2rem] text-center">{facReqAlerts.length}</span>}
          </button>
        )}
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

      {tab==='fac-requests' && !store.isAdmin() && (
        <Card>
          <CardHeader>
            <CardTitle>My redistribution requests</CardTitle>
            <div className="flex gap-2">
              <button onClick={loadFacReqAlerts} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">Refresh</button>
              <Button variant="primary" size="sm" onClick={()=>store.setCurrentPage('transfers')}>Submit new request</Button>
            </div>
          </CardHeader>
          {facReqAlerts.length===0 ? <EmptyState message="No pending redistribution requests ✓"/> : (
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
