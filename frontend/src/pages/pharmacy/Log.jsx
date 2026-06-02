import { useState, useEffect } from 'react'
import { sb } from '../../lib/supabase'
import { useAppStore } from '../../store/appStore'
import { useStock } from '../../hooks/useStock'
import { Card, CardHeader, CardTitle, CardBody } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { LoadingState, EmptyState } from '../../components/ui/Loading'
import { EditModal } from '../../components/EditModal'
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

  const fid    = store.currentFacility?.id
  const commIds = store.allCommodities.map(c => c.id)

  useEffect(() => { loadAll() }, [fid])

  // Reload when commodity section changes to ensure proper filtering
  useEffect(() => { if(fid) loadAll() }, [store.commoditySection])

  async function loadAll() {
    setLoading(true)
    const selComm = 'commodities(name,unit,dispensing_unit,pack_size)'
    const [disp, intake, adj] = await Promise.all([
      (!typeFilter||typeFilter==='dispense') ? sec(sb.from('dispense_log').select('*,'+selComm).eq('facility_id',fid)).in('commodity_id',commIds).order('dispensed_at',{ascending:false}).limit(50).then(r=>r.data||[]) : [],
      (!typeFilter||typeFilter==='intake')   ? sec(sb.from('intake_log').select('*,'+selComm).eq('facility_id',fid)).in('commodity_id',commIds).order('received_at',{ascending:false}).limit(50).then(r=>r.data||[]) : [],
      (!typeFilter||typeFilter==='adjustment')? sec(sb.from('stock_adjustment_log').select('*,'+selComm).eq('facility_id',fid)).in('commodity_id',commIds).order('adjusted_at',{ascending:false}).limit(50).then(r=>r.data||[]) : [],
    ])
    const merged = [
      ...disp.map(r=>({...r,_type:'dispense',_time:r.dispensed_at})),
      ...intake.map(r=>({...r,_type:'intake',_time:r.received_at})),
      ...adj.map(r=>({...r,_type:'adjustment',_time:r.adjusted_at})),
    ].sort((a,b)=>new Date(b._time)-new Date(a._time)).slice(0,100)
    setAllRecords(merged)
    setLoading(false)
  }

  useEffect(() => { if(fid) loadAll() }, [typeFilter])

  const typeBadge = { dispense:'out', intake:'ok', adjustment:'info' }
  const typeLabel = { dispense:'Consumption', intake:'Intake', adjustment:'Adjustment' }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-medium text-gray-100">Activity Log</h1>
        <p className="text-sm text-gray-500 mt-1">All stock, intake and adjustment events at your facility</p>
      </div>

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
              <option value="dispense">Stock consumed</option>
              <option value="intake">Intakes</option>
              <option value="adjustment">Adjustments</option>
            </select>
            <button onClick={loadAll} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">Refresh</button>
          </div>
        </CardHeader>
        {loading ? <LoadingState/> : allRecords.length===0 ? <EmptyState message="No activity recorded yet."/> : (
          <div className="table-wrap"><table className="w-full text-sm">
            <thead><tr className="border-b border-white/8 bg-white/2">
              {['Date','Type','Commodity','Qty','Details',...(canManage?['']:[''])].map((h,i)=>(
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
                  <td className="px-4 py-3">{qty}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">{details}</td>
                  {canManage && (
                    <td className="px-4 py-3">
                      <button onClick={()=>setEditRecord(r)}
                        className="text-xs text-blue-400 border border-blue-500/30 rounded px-2 py-1 hover:bg-blue-500/10 transition-colors">
                        Edit
                      </button>
                    </td>
                  )}
                </tr>
              )
            })}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  )
}
