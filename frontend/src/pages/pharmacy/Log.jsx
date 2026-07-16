import { useState, useEffect, useRef } from 'react'
import { api } from '../../lib/api'
import { subscribeRealtime } from '../../lib/realtime'
import { useAppStore } from '../../store/appStore'
import { useStock } from '../../hooks/useStock'
import { Card, CardHeader, CardTitle } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { LoadingState, EmptyState, Spinner } from '../../components/ui/Loading'
import { EditModal } from '../../components/EditModal'
import { BinCardModal } from '../../components/BinCardModal'
import { FacilityPicker } from '../../components/ui/FacilityPicker'
import { Reports } from './Reports'
import { fmtDateTime, fmtDate, fmtDispenseQty, fmtStockQty, getCommodityPackSize } from '../../utils/helpers'

export function Log() {
  const store     = useAppStore()
  const canManage = store.canManageStock()
  const commoditySection = store.commoditySection
  const [typeFilter, setTypeFilter] = useState('')
  const [catFilter, setCatFilter]   = useState('')
  const [period, setPeriod]         = useState(0)   // 0 = all time; otherwise days back
  const [allRecords, setAllRecords] = useState([])
  const [loading, setLoading]       = useState(true)
  const [editRecord, setEditRecord] = useState(null)
  const [binCard, setBinCard]       = useState(null)   // { fid, cid, name } → open bin card
  // Weekly/Monthly now lives here as a second tab. The one-shot store flag lets
  // the operation pages' "Export summary" buttons open straight onto it.
  const [view, setView] = useState(store.pendingReportsTab ? 'reports' : 'activity')
  useEffect(() => { if (store.pendingReportsTab) store.setPendingReportsTab(false) }, [])

  const fid    = store.currentFacility?.id
  const commIds = store.allCommodities.map(c => c.id)
  const categories = [...new Set(store.allCommodities.map(c => c.category).filter(Boolean))].sort()
  const isAdmin = store.isAdmin()
  // Admins see a cross-facility feed across their whole jurisdiction by default.
  // The FacilityPicker narrows it: a single facility pins the log to it; an
  // LGA/state selection scopes it to that set (facility_ids) without requiring a
  // facility pick.
  const adminFid   = store.adminFilterFacility?.id || null
  const adminLga   = store.adminFilterLGA || null
  const adminState = store.adminFilterState || null
  const scopedFacIds = (isAdmin && !adminFid && (adminLga || adminState))
    ? store.allFacilities.filter(f => (!adminState || f.state === adminState) && (!adminLga || f.lga === adminLga)).map(f => f.id)
    : null
  // Edits belong to the facility's own store manager. Admins are read-only here.
  const canEdit = canManage && !isAdmin

  useEffect(() => { loadAll() }, [fid, adminFid, adminLga, adminState])

  // Reload when commodity section changes to ensure proper filtering
  useEffect(() => { if(fid || isAdmin) loadAll() }, [store.commoditySection])

  async function loadAll() {
    setLoading(true)
    // Admins span a filtered facility set and both sections, so don't scope by
    // the full commodity list.
    const scopeFid = isAdmin ? adminFid : fid
    const from = period ? new Date(Date.now() - period*86400000).toISOString() : undefined
    const rowLimit = period ? 500 : 50
    const logParams = {
      facility_id: scopeFid || undefined,
      facility_ids: scopedFacIds || undefined,
      commodity_ids: !isAdmin ? commIds : undefined,
      section: commoditySection || undefined,
      from,
      limit: rowLimit,
    }
    const [disp, intake, adj, transfers] = await Promise.all([
      (!typeFilter||typeFilter==='dispense')    ? api.dispense.history(logParams).catch(()=>[]) : [],
      (!typeFilter||typeFilter==='intake')      ? api.intake.history(logParams).catch(()=>[]) : [],
      (!typeFilter||typeFilter==='adjustment')  ? api.adjustments.history(logParams).catch(()=>[]) : [],
      // section already scopes transfers; facility_id covers both sending/receiving sides.
      (!typeFilter||typeFilter==='transfer')    ? api.transfers.list({ facility_id: scopeFid || undefined, section: commoditySection || undefined, date_field: from?'initiated_at':undefined, from, limit: rowLimit }).catch(()=>[]) : [],
    ])
    // Admins get a cross-facility feed; hide internal movements — store→dispensary
    // (same facility) and store→DSD/SDP site dispatches (e.g. "Main Lab", which have
    // no distinct receiving facility) — so the feed isn't bulky. External
    // redistributions have two different facilities and are kept.
    const extTransfers = isAdmin
      ? transfers.filter(t => t.sending_facility_id && t.receiving_facility_id && t.sending_facility_id !== t.receiving_facility_id)
      : transfers
    let merged = [
      ...disp.map(r=>({...r,_type:'dispense',_time:r.dispensed_at})),
      ...intake.map(r=>({...r,_type:'intake',_time:r.received_at})),
      ...adj.map(r=>({...r,_type:'adjustment',_time:r.adjusted_at})),
      ...extTransfers.map(r=>({...r,_type:'transfer',_time:r.resolved_at||r.initiated_at})),
    ].sort((a,b)=>new Date(b._time)-new Date(a._time))
    // Client-side narrow to the selected LGA/state set (covers transfers, whose
    // route scopes by jurisdiction rather than the facility_ids view-filter).
    if (scopedFacIds) {
      const set = new Set(scopedFacIds)
      merged = merged.filter(r => r._type==='transfer'
        ? (set.has(r.sending_facility_id) || set.has(r.receiving_facility_id))
        : set.has(r.facility_id))
    }
    merged = merged.slice(0, period ? 500 : 100)
    setAllRecords(merged)
    setLoading(false)
  }

  useEffect(() => { if(fid || isAdmin) loadAll() }, [typeFilter, period])

  // Keep a ref to the latest loader so the realtime subscription always reloads
  // with the current filters/scope without re-subscribing on every change.
  const loadAllRef = useRef(loadAll)
  loadAllRef.current = loadAll

  // Live updates: refresh the log in place whenever a dispense, intake or
  // adjustment row changes anywhere in the viewer's scope (RLS-filtered).
  useEffect(() => {
    const reload = () => loadAllRef.current()
    return subscribeRealtime(['dispense_log', 'intake_log', 'stock_adjustment_log', 'stock_transfer_log'], reload)
  }, [])

  const typeBadge = { dispense:'out', intake:'ok', adjustment:'info', transfer:'low' }
  const typeLabel = { dispense:'Consumption', intake:'Intake', adjustment:'Adjustment', transfer:'Transfer' }
  const shownRecords = catFilter ? allRecords.filter(r => (r.commodities?.category) === catFilter) : allRecords

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-medium text-gray-100">{view === 'reports' ? 'Reports' : 'Activity Log'}</h1>
        <p className="text-sm text-gray-500 mt-1">{view === 'reports' ? 'Weekly and monthly activity summaries' : isAdmin ? 'Stock, intake, transfer and adjustment events across facilities in your scope' : 'All stock, intake, transfer and adjustment events at your facility'}</p>
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
      {/* Optional admin filter (State → LGA → Facility) that narrows the feed;
          with nothing selected the whole jurisdiction shows. No-op for facilities. */}
      <FacilityPicker />

      <>
      {binCard && (
        <BinCardModal facilityId={binCard.fid} commodityId={binCard.cid} commodityName={binCard.name} onClose={()=>setBinCard(null)} />
      )}
      {canEdit && editRecord && (
        <EditModal record={editRecord} onClose={()=>setEditRecord(null)} onSave={()=>{setEditRecord(null);loadAll()}}/>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
          <div className="flex gap-2 flex-wrap">
            <select value={period} onChange={e=>setPeriod(parseInt(e.target.value))}
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500">
              <option value={0}>All time</option>
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={180}>Last 6 months</option>
            </select>
            <select value={typeFilter} onChange={e=>{setTypeFilter(e.target.value)}}
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500">
              <option value="">All activity</option>
              <option value="dispense">Stock consumed</option>
              <option value="intake">Intakes</option>
              <option value="adjustment">Adjustments</option>
              <option value="transfer">Transfers</option>
            </select>
            <select value={catFilter} onChange={e=>setCatFilter(e.target.value)}
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500">
              <option value="">All categories</option>
              {categories.map(c=><option key={c} value={c}>{c}</option>)}
            </select>
            <button onClick={loadAll} disabled={loading} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5 disabled:opacity-60 inline-flex items-center gap-1.5">
              {loading && <Spinner size="sm"/>}{loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </CardHeader>
        {loading && allRecords.length===0 ? <LoadingState/> : shownRecords.length===0 ? <EmptyState message={catFilter ? `No ${catFilter} activity in this view.` : "No activity recorded yet."}/> : (
          <div className="table-wrap"><table className="w-full text-sm">
            <thead><tr className="border-b border-white/8 bg-white/2">
              {['Date','Type','Commodity',...(isAdmin?['Facility']:[]),'Qty','Details'].map((h,i)=>(
                <th key={i} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
              ))}
              {canEdit && <th className="px-4 py-3"/>}
            </tr></thead>
            <tbody>{shownRecords.map(r=>{
              let qty='', details=''
              if (r._type==='dispense') {
                qty = <span className="font-mono text-sm text-red-400">-{fmtDispenseQty(r.quantity,r.commodities)}</span>
                details = r.dispensed_by ? `By: ${r.dispensed_by}` : '—'
              } else if (r._type==='intake') {
                qty = <span className="font-mono text-sm text-green-400">+{r.quantity} {r.commodities?.unit||''}</span>
                details = [r.supplier_source, r.notes].filter(Boolean).join(' · ') || '—'
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
                  <td className="px-4 py-3">
                    {(() => {
                      const bcFid = r.facility_id || r.sending_facility_id || fid
                      const cid = r.commodity_id || r.commodities?.id
                      return bcFid && cid
                        ? <button onClick={()=>setBinCard({ fid: bcFid, cid, name: r.commodities?.name })}
                            className="font-medium text-gray-100 hover:text-blue-400 text-left" title="Open bin card">{r.commodities?.name||'—'}</button>
                        : <span className="font-medium text-gray-100">{r.commodities?.name||'—'}</span>
                    })()}
                  </td>
                  {isAdmin && <td className="px-4 py-3 text-xs text-gray-400">{r._type==='transfer' ? `${r.sending_facility_name||'—'} → ${r.receiving_facility_name||'—'}` : (r.facilities?.name||'—')}</td>}
                  <td className="px-4 py-3">{qty}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">{details}</td>
                  {canEdit && (
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
      </>
      )}
    </div>
  )
}
