import { useState, useEffect, useRef } from 'react'
import { sb } from '../../lib/supabase'
import { useAppStore } from '../../store/appStore'
import { useStock } from '../../hooks/useStock'
import { toast } from '../../components/ui/Toast'
import { Card, CardHeader, CardTitle, CardBody } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { LoadingState, EmptyState, Spinner } from '../../components/ui/Loading'
import { EditModal } from '../../components/EditModal'
import { Reports } from './Reports'
import { fmtDateTime, fmtDate, fmtDispenseQty, fmtStockQty, getCommodityPackSize } from '../../utils/helpers'

export function Log() {
  const store     = useAppStore()
  const canManage = store.canManageStock()
  const commoditySection = store.commoditySection
  const sec = q => commoditySection ? q.eq('section', commoditySection) : q
  const [typeFilter, setTypeFilter] = useState('')
  const [allRecords, setAllRecords] = useState([])
  const [loading, setLoading]       = useState(true)
  const [editRecord, setEditRecord] = useState(null)
  // Weekly/Monthly now lives here as a second tab. The one-shot store flag lets
  // the operation pages' "Export summary" buttons open straight onto it.
  const [view, setView] = useState(store.pendingReportsTab ? 'reports' : 'activity')
  useEffect(() => { if (store.pendingReportsTab) store.setPendingReportsTab(false) }, [])

  const fid    = store.currentFacility?.id
  const commIds = store.allCommodities.map(c => c.id)
  const isAdmin = store.isAdmin()

  useEffect(() => { loadAll() }, [fid, store.adminFilterFacility?.id])

  // Reload when commodity section changes to ensure proper filtering
  useEffect(() => { if(fid) loadAll() }, [store.commoditySection])

  async function loadAll() {
    setLoading(true)
    const selComm = 'commodities(name,unit,dispensing_unit,pack_size),facilities(name)'
    // Admins span every facility (or the one they've filtered to) and both
    // sections, so don't scope by a single facility or the full commodity list.
    const scopeFid = isAdmin ? (store.adminFilterFacility?.id || null) : fid
    const loadTable = (table, dateField) => {
      let q = sec(sb.from(table).select('*,'+selComm))
      if (scopeFid) q = q.eq('facility_id', scopeFid)
      if (!isAdmin) q = q.in('commodity_id', commIds)
      return q.order(dateField, { ascending: false }).limit(50).then(r => r.data || [])
    }
    // Transfers live in stock_transfer_log as a sending/receiving pair (no
    // single facility_id) with denormalized facility names, so they need their
    // own query scoped to either side of the move.
    const loadTransfers = () => {
      let q = sec(sb.from('stock_transfer_log').select('*,commodities(name,unit,dispensing_unit,pack_size)'))
      if (scopeFid) q = q.or(`sending_facility_id.eq.${scopeFid},receiving_facility_id.eq.${scopeFid}`)
      if (!isAdmin) q = q.in('commodity_id', commIds)
      return q.order('initiated_at', { ascending: false }).limit(50).then(r => r.data || [])
    }
    const [disp, intake, adj, transfers] = await Promise.all([
      (!typeFilter||typeFilter==='dispense')    ? loadTable('dispense_log','dispensed_at') : [],
      (!typeFilter||typeFilter==='intake')      ? loadTable('intake_log','received_at') : [],
      (!typeFilter||typeFilter==='adjustment')  ? loadTable('stock_adjustment_log','adjusted_at') : [],
      (!typeFilter||typeFilter==='transfer')    ? loadTransfers() : [],
    ])
    const merged = [
      ...disp.map(r=>({...r,_type:'dispense',_time:r.dispensed_at})),
      ...intake.map(r=>({...r,_type:'intake',_time:r.received_at})),
      ...adj.map(r=>({...r,_type:'adjustment',_time:r.adjusted_at})),
      ...transfers.map(r=>({...r,_type:'transfer',_time:r.resolved_at||r.initiated_at})),
    ].sort((a,b)=>new Date(b._time)-new Date(a._time)).slice(0,100)
    setAllRecords(merged)
    setLoading(false)
  }

  useEffect(() => { if(fid || isAdmin) loadAll() }, [typeFilter])

  // Keep a ref to the latest loader so the realtime subscription always reloads
  // with the current filters/scope without re-subscribing on every change.
  const loadAllRef = useRef(loadAll)
  loadAllRef.current = loadAll

  // Live updates: refresh the log in place whenever a dispense, intake or
  // adjustment row changes anywhere in the viewer's scope (RLS-filtered).
  useEffect(() => {
    const reload = () => loadAllRef.current()
    const channel = sb.channel('activity-log-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dispense_log' }, reload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'intake_log' }, reload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stock_adjustment_log' }, reload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stock_transfer_log' }, reload)
      .subscribe()
    return () => sb.removeChannel(channel)
  }, [])

  const typeBadge = { dispense:'out', intake:'ok', adjustment:'info', transfer:'low' }
  const typeLabel = { dispense:'Utilization', intake:'Intake', adjustment:'Adjustment', transfer:'Transfer' }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-medium text-gray-100">{view === 'reports' ? 'Reports' : 'Activity Log'}</h1>
        <p className="text-sm text-gray-500 mt-1">{view === 'reports' ? 'Weekly and monthly activity summaries' : 'All stock, intake, transfer and adjustment events at your facility'}</p>
      </div>

      <div className="flex gap-2 mb-4">
        {[['activity','Activity Log'],['reports','Weekly / Monthly']].map(([id,label]) => (
          <button key={id} onClick={() => setView(id)}
            className={`px-4 py-2 text-sm rounded-lg border transition-colors ${view===id ? 'bg-white/8 border-white/15 text-gray-100 font-medium' : 'border-white/10 text-gray-400 hover:text-gray-200'}`}>
            {label}
          </button>
        ))}
      </div>

      {view === 'reports' ? <Reports embedded /> : (
      <>
      {editRecord && (
        <EditModal record={editRecord} onClose={()=>setEditRecord(null)} onSave={()=>{setEditRecord(null);loadAll()}}/>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
          <div className="flex gap-2">
            <select value={typeFilter} onChange={e=>{setTypeFilter(e.target.value)}}
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500">
              <option value="">All activity</option>
              <option value="dispense">Stock utilized</option>
              <option value="intake">Intakes</option>
              <option value="adjustment">Adjustments</option>
              <option value="transfer">Transfers</option>
            </select>
            <button onClick={loadAll} disabled={loading} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5 disabled:opacity-60 inline-flex items-center gap-1.5">
              {loading && <Spinner size="sm"/>}{loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </CardHeader>
        {loading && allRecords.length===0 ? <LoadingState/> : allRecords.length===0 ? <EmptyState message="No activity recorded yet."/> : (
          <div className="table-wrap"><table className="w-full text-sm">
            <thead><tr className="border-b border-white/8 bg-white/2">
              {['Date','Type','Commodity',...(isAdmin?['Facility']:[]),'Qty','Details',...(canManage?['']:[''])].map((h,i)=>(
                <th key={i} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
              ))}
              {canManage && <th className="px-4 py-3"/>}
            </tr></thead>
            <tbody>{allRecords.map(r=>{
              let qty='', details=''
              if (r._type==='dispense') {
                qty = <span className="font-mono text-sm text-red-400">-{fmtDispenseQty(r.quantity,r.commodities)}</span>
                details = r.dispensed_by ? `By: ${r.dispensed_by}` : '—'
              } else if (r._type==='intake') {
                qty = <span className="font-mono text-sm text-green-400">+{r.quantity} {r.commodities?.unit||''}</span>
                details = r.source_type||'—'
              } else if (r._type==='transfer') {
                // Direction is relative to the viewer's facility; admins span
                // both sides, so show a neutral quantity and the route + status.
                const route = `${r.sending_facility_name||'—'} → ${r.receiving_facility_name||'—'}`
                if (isAdmin) {
                  qty = <span className="font-mono text-sm text-blue-400">{r.quantity} {r.commodities?.unit||''}</span>
                  details = r.status || '—'
                } else {
                  const isOut = fid && r.sending_facility_id === fid
                  qty = <span className={`font-mono text-sm ${isOut?'text-red-400':'text-green-400'}`}>{isOut?'-':'+'}{r.quantity} {r.commodities?.unit||''}</span>
                  details = r.status ? `${route} · ${r.status}` : route
                }
              } else {
                const isInc = r.adjustment_type==='Increase'
                qty = <span className={`font-mono text-sm ${isInc?'text-green-400':'text-red-400'}`}>{isInc?'+':'-'}{r.quantity} {r.commodities?.unit||''}</span>
                details = r.reason||'—'
              }
              return (
                <tr key={r.id} className="border-b border-white/5 hover:bg-white/2">
                  <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDateTime(r._time)}</td>
                  <td className="px-4 py-3"><Badge type={typeBadge[r._type]}>{typeLabel[r._type]}</Badge></td>
                  <td className="px-4 py-3 font-medium text-gray-100">{r.commodities?.name||'—'}</td>
                  {isAdmin && <td className="px-4 py-3 text-xs text-gray-400">{r._type==='transfer' ? `${r.sending_facility_name||'—'} → ${r.receiving_facility_name||'—'}` : (r.facilities?.name||'—')}</td>}
                  <td className="px-4 py-3">{qty}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">{details}</td>
                  {canManage && (
                    <td className="px-4 py-3">
                      {r._type!=='transfer' && (
                        <button onClick={()=>setEditRecord(r)}
                          className="text-xs text-blue-400 border border-blue-500/30 rounded px-2 py-1 hover:bg-blue-500/10 transition-colors">
                          Edit
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              )
            })}</tbody>
          </table></div>
        )}
      </Card>
      </>
      )}
    </div>
  )
}
