import { useState, useEffect } from 'react'
import { sb } from '../../lib/supabase'
import { useAppStore } from '../../store/appStore'
import { useStock } from '../../hooks/useStock'
import { toast } from '../../components/ui/Toast'
import { Card, CardHeader, CardTitle, CardBody } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { LoadingState, EmptyState } from '../../components/ui/Loading'
import { EditModal } from '../../components/EditModal'
import { EditHistoryModal } from '../../components/EditHistoryModal'
import { fmtDate, fmtStockQty, todayLagos } from '../../utils/helpers'

// Returns stock from a DSD site back to the store: positive adjustment to the
// store, negative adjustment to the selected site's stock.
const RETURN_REASON = 'Returned from DSD'
const SITE_CFG = { table: 'dsd_stock', col: 'dsd_site_name', label: 'DSD site' }

const RULES = {
  'Expired':                   { type:'Decrease', lock:true,  label:'Negative — cannot increase expired stock' },
  'Damaged':                   { type:'Decrease', lock:true,  label:'Negative — cannot increase damaged stock' },
  'Lost / Stolen':             { type:'Decrease', lock:true,  label:'Negative — cannot increase lost/stolen stock' },
  'Physical count correction': { type:null,       lock:false, label:'Can be positive or negative' },
  'Returned to store':         { type:'Increase', lock:true,  label:'Positive — stock is being returned' },
  [RETURN_REASON]:             { type:'Increase', lock:true,  label:'Positive to store — deducts from the selected DSD site' },
  'State Office':              { type:'Increase', lock:true,  label:'Positive — stock adjustment from state office' },
  'Other':                     { type:null,       lock:false, label:'Specify type manually' },
}

export function Adjustment() {
  const store = useAppStore()
  const commoditySection = useAppStore(s => s.commoditySection)
  const sec = q => commoditySection ? q.eq('section', commoditySection) : q
  const { loadStock } = useStock()
  const canManage = store.canManageStock()

  const [commId, setCommId]   = useState('')
  const [qty, setQty]         = useState(1)
  const [reason, setReason]   = useState('')
  const [adjType, setAdjType] = useState('')
  const [adjBy, setAdjBy]     = useState('')
  const [adjRef, setAdjRef]   = useState('')
  const [adjNotes, setAdjNotes]= useState('')
  const [adjExpiry, setAdjExpiry] = useState('')
  const [adjBatch, setAdjBatch]   = useState('')
  const [returnSite, setReturnSite] = useState('')
  const [siteOptions, setSiteOptions] = useState([])
  const [loadingSites, setLoadingSites] = useState(false)
  const [saving, setSaving]   = useState(false)
  const [msg, setMsg]         = useState(null)
  const [recent, setRecent]   = useState([])
  const [loadingR, setLoadingR] = useState(true)
  const [historyDate, setHistoryDate] = useState(todayLagos())
  const [showDatePicker, setShowDatePicker] = useState(false)
  const [editRecord, setEditRecord] = useState(null)
  const [historyRecord, setHistoryRecord] = useState(null)

  const fid = store.currentFacility?.id
  const isReturn = reason === RETURN_REASON

  useEffect(() => { loadRecent() }, [fid])
  useEffect(() => { if(fid) loadRecent() }, [historyDate])

  // For a "Returned from site" adjustment, list the sites that currently hold
  // the selected commodity (the valid return sources) with their available qty.
  useEffect(() => {
    let active = true
    if (!isReturn || !fid || !commId) { setSiteOptions([]); return }
    setLoadingSites(true)
    sb.from(SITE_CFG.table).select(`${SITE_CFG.col},quantity`)
      .eq('facility_id', fid).eq('commodity_id', commId)
      .then(({ data }) => {
        if (!active) return
        const opts = (data || [])
          .filter(r => r.quantity > 0)
          .map(r => ({ site: r[SITE_CFG.col], quantity: r.quantity }))
          .sort((a, b) => b.quantity - a.quantity)
        setSiteOptions(opts)
        setReturnSite(prev => opts.some(o => o.site === prev) ? prev : '')
        setLoadingSites(false)
      })
    return () => { active = false }
  }, [isReturn, fid, commId])

  const rule      = RULES[reason]
  // Adjustments target the main store inventory. Prefer the 'store' location
  // row, but fall back to any matching row so the preview always reflects
  // exactly what the submit will adjust.
  const stockRow  = store.stockData.find(r => r.commodity_id === commId && r.location_type === 'store' && (!fid || r.facility_id === fid))
    || store.stockData.find(r => r.commodity_id === commId && (!fid || r.facility_id === fid))
  const selectedComm = store.allCommodities.find(c => c.id === commId)

  const categories = {}
  store.allCommodities.forEach(c => {
    if (!categories[c.category]) categories[c.category] = []
    categories[c.category].push(c)
  })

  function onReasonChange(r) {
    setReason(r)
    const rule = RULES[r]
    if (rule?.type) setAdjType(rule.type)
    else setAdjType('')
    if (r !== RETURN_REASON) { setReturnSite(''); setSiteOptions([]) }
  }

  if (!canManage) return (
    <div>
      <div className="mb-6"><h1 className="text-xl font-medium text-gray-100">Access Restricted</h1></div>
      <Card><CardBody className="text-center py-12">
        <div className="text-5xl mb-4">🔒</div>
        <div className="font-medium text-gray-100 mb-2">Store Manager access required</div>
        <div className="text-sm text-gray-500">Contact your store manager to perform this action.</div>
      </CardBody></Card>
    </div>
  )

  async function handleSubmit(e) {
    e?.preventDefault()
    setMsg(null)
    if (!fid)    { setMsg({type:'error',text:'No facility assigned.'}); return }
    if (!commId) { setMsg({type:'error',text:'Select a commodity.'}); return }
    if (qty < 1) { setMsg({type:'error',text:'Quantity must be at least 1.'}); return }
    if (!reason) { setMsg({type:'error',text:'Select a reason.'}); return }
    if (!adjType){ setMsg({type:'error',text:'Select adjustment type.'}); return }
    if (!adjBy)  { setMsg({type:'error',text:'Adjusted by is required.'}); return }
    if (!adjExpiry) { setMsg({type:'error',text:'Expiry date is required.'}); return }
    if (rule?.lock && rule.type && adjType !== rule.type) {
      setMsg({type:'error',text:`${reason} must be a ${rule.type} adjustment.`}); return
    }

    const qtyN = parseInt(qty)

    // ── Returned from a DSD site ──────────────────────────────────────────
    // Credits the store and debits the chosen site. Validate the site holds
    // enough before mutating either side.
    if (isReturn) {
      if (!returnSite) { setMsg({type:'error',text:`Select the ${SITE_CFG.label} the stock is returned from.`}); return }
      setSaving(true)
      const { data: siteStk } = await sb.from(SITE_CFG.table).select('id,quantity')
        .eq('facility_id', fid).eq(SITE_CFG.col, returnSite).eq('commodity_id', commId).maybeSingle()
      if (!siteStk || siteStk.quantity < qtyN) {
        setMsg({type:'error',text:`${returnSite} only has ${siteStk?.quantity || 0} in stock — cannot return ${qtyN}.`}); setSaving(false); return
      }

      const returnNote = `Returned from ${SITE_CFG.label}: ${returnSite}${adjNotes ? ' — ' + adjNotes : ''}`
      const { error: logErr } = await sb.from('stock_adjustment_log').insert({
        facility_id:fid, commodity_id:commId, quantity:qtyN,
        adjustment_type:'Increase', reason, adjusted_by:adjBy||null,
        reference_number:adjRef||null, notes:returnNote, adjusted_at:new Date().toISOString(),
        expiry_date:adjExpiry||null, batch_number:adjBatch||null,
        section:commoditySection,
      })
      if (logErr) { setMsg({type:'error',text:'Error: '+logErr.message}); setSaving(false); return }

      // Credit the store (create the row if the store holds none yet).
      const { data: storeStk } = await sb.from('stock').select('id,quantity')
        .eq('facility_id', fid).eq('commodity_id', commId).eq('location_type', 'store').maybeSingle()
      const newStoreQty = (storeStk?.quantity || 0) + qtyN
      if (storeStk) {
        await sb.from('stock').update({ quantity:newStoreQty, updated_at:new Date().toISOString() }).eq('id', storeStk.id)
      } else {
        await sb.from('stock').insert({ facility_id:fid, commodity_id:commId, quantity:qtyN, location_type:'store', updated_at:new Date().toISOString() })
      }

      // Debit the site.
      await sb.from(SITE_CFG.table).update({ quantity: Math.max(0, siteStk.quantity - qtyN), updated_at:new Date().toISOString() }).eq('id', siteStk.id)

      toast('Return recorded','green')
      setMsg({type:'success',text:`Returned ${fmtStockQty(qtyN, selectedComm)} from ${returnSite} to store. Store stock: ${fmtStockQty(newStoreQty, selectedComm)}`})
      setCommId(''); setQty(1); setReason(''); setAdjType(''); setAdjBy(''); setAdjRef(''); setAdjNotes(''); setAdjExpiry(''); setAdjBatch(''); setReturnSite(''); setSiteOptions([])
      await loadStock(); loadRecent(); setSaving(false)
      return
    }

    setSaving(true)
    // Adjust the exact stock row shown in the preview. Re-querying by
    // facility+commodity with maybeSingle() fails when a commodity has
    // multiple location rows (store/dispensary/dsd); use the row id instead.
    if (!stockRow) { setMsg({type:'error',text:'No stock record found.'}); setSaving(false); return }
    const { data: stk } = await sb.from('stock').select('id,quantity').eq('id', stockRow.id).maybeSingle()
    if (!stk) { setMsg({type:'error',text:'No stock record found.'}); setSaving(false); return }

    const newQty = adjType==='Increase' ? stk.quantity + parseInt(qty) : Math.max(0, stk.quantity - parseInt(qty))

    const { error } = await sb.from('stock_adjustment_log').insert({
      facility_id:fid, commodity_id:commId, quantity:parseInt(qty),
      adjustment_type:adjType, reason, adjusted_by:adjBy||null,
      reference_number:adjRef||null, notes:adjNotes||null, adjusted_at:new Date().toISOString(),
      expiry_date:adjExpiry||null, batch_number:adjBatch||null,
      section:commoditySection,
    })
    if (error) { setMsg({type:'error',text:'Error: '+error.message}); setSaving(false); return }

    await sb.from('stock').update({quantity:newQty, updated_at:new Date().toISOString()}).eq('id',stk.id)

    toast('Adjustment saved','green')
    setMsg({type:'success',text:`Adjustment saved. New stock: ${fmtStockQty(newQty, selectedComm)}`})
    setCommId(''); setQty(1); setReason(''); setAdjType(''); setAdjBy(''); setAdjRef(''); setAdjNotes(''); setAdjExpiry(''); setAdjBatch('')
    await loadStock()
    loadRecent()
    setSaving(false)
  }

  async function loadRecent() {
    setLoadingR(true)
    const d = historyDate
    let q = sb.from('stock_adjustment_log')
      .select('*,commodities(name,unit,dispensing_unit,pack_size),facilities(name)')
      .eq('facility_id',fid)
      .gte('adjusted_at', `${d}T00:00:00`)
      .lte('adjusted_at', `${d}T23:59:59`)
      .order('adjusted_at', { ascending: false })
    q = sec(q)
    const { data } = await q
    setRecent(data||[])
    setLoadingR(false)
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-medium text-gray-100">Stock Adjustment</h1>
        <p className="text-sm text-gray-500 mt-1">Record expired, damaged, lost stock or physical count corrections</p>
      </div>

      <Card>
        <CardHeader><CardTitle>Adjustment details</CardTitle></CardHeader>
        <CardBody>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Commodity</label>
                <select value={commId} onChange={e=>setCommId(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500">
                  <option value="">Select commodity…</option>
                  {Object.entries(categories).sort().map(([cat,comms])=>(
                    <optgroup key={cat} label={cat}>
                      {comms.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
                    </optgroup>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Quantity</label>
                <input type="number" min="1" value={qty} onChange={e=>setQty(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"/>
              </div>
            </div>

            {commId && (
              <div className={`rounded-lg px-4 py-3 text-sm border ${!stockRow?'bg-red-500/10 border-red-500/20 text-red-400':'bg-white/5 border-white/10 text-gray-300'}`}>
                {!stockRow ? '⚠ No stock record' : `Current stock: ${fmtStockQty(stockRow.quantity, selectedComm)}`}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Reason</label>
                <select value={reason} onChange={e=>onReasonChange(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500">
                  <option value="">Select reason…</option>
                  {Object.keys(RULES).map(r=><option key={r}>{r}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Adjustment type</label>
                <select value={adjType} onChange={e=>setAdjType(e.target.value)}
                  disabled={rule?.lock}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500 disabled:opacity-50">
                  <option value="">{reason ? '— auto-set by reason —' : '— select reason first —'}</option>
                  <option value="Increase">+ Positive adjustment (stock added)</option>
                  <option value="Decrease">− Negative adjustment (stock removed)</option>
                </select>
                {rule && <p className={`text-xs mt-1 ${rule.type==='Increase'?'text-green-400':rule.type==='Decrease'?'text-red-400':'text-gray-500'}`}>{rule.label}</p>}
              </div>
            </div>

            {isReturn && (
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">{SITE_CFG.label} *</label>
                <select value={returnSite} onChange={e=>setReturnSite(e.target.value)}
                  disabled={!commId || loadingSites}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500 disabled:opacity-50">
                  <option value="">{!commId ? 'Select a commodity first…' : loadingSites ? 'Loading sites…' : siteOptions.length ? `Select ${SITE_CFG.label}…` : `No ${SITE_CFG.label} holds this commodity`}</option>
                  {siteOptions.map(o => <option key={o.site} value={o.site}>{o.site} — {fmtStockQty(o.quantity, selectedComm)} available</option>)}
                </select>
                <p className="text-xs text-gray-500 mt-1">Adds to store stock and deducts the same quantity from the selected {SITE_CFG.label}.</p>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Expiry date *</label>
                <input type="date" value={adjExpiry} onChange={e=>setAdjExpiry(e.target.value)} required
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"/>
              </div>
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Batch / lot number (optional)</label>
                <input type="text" value={adjBatch} onChange={e=>setAdjBatch(e.target.value)} placeholder="e.g. LOT2024A001"
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"/>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Adjusted by *</label>
                <input type="text" value={adjBy} onChange={e=>setAdjBy(e.target.value)} placeholder="Staff name or ID" required
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"/>
              </div>
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Reference number (optional)</label>
                <input type="text" value={adjRef} onChange={e=>setAdjRef(e.target.value)} placeholder="e.g. approval ref"
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"/>
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Notes</label>
              <input type="text" value={adjNotes} onChange={e=>setAdjNotes(e.target.value)} placeholder="Additional details"
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"/>
            </div>

            {msg && (
              <div className={`rounded-lg px-4 py-3 text-sm ${msg.type==='error'?'bg-red-500/10 border border-red-500/20 text-red-400':'bg-green-500/10 border border-green-500/20 text-green-400'}`}>
                {msg.text}
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button type="submit" variant="success" size="lg" disabled={saving}>
                {saving ? 'Saving…' : 'Save adjustment'}
              </Button>
              <Button type="button" variant="ghost" size="md" onClick={() => { store.setCurrentReportCategory('adjustment'); store.setCurrentPage('reports') }}>
                Export summary
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      {editRecord && (
        <EditModal record={{...editRecord, _type:'adjustment'}} onClose={()=>setEditRecord(null)} onSave={()=>{setEditRecord(null);loadRecent()}}/>
      )}
      {historyRecord && (
        <EditHistoryModal record={historyRecord} onClose={()=>setHistoryRecord(null)}/>
      )}

      <Card>
        <CardHeader><CardTitle>Adjustment records for {historyDate}</CardTitle>
          <div className="flex gap-2">
            <button onClick={()=>setShowDatePicker(!showDatePicker)} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5 transition-colors">History</button>
            {showDatePicker && (
              <input type="date" value={historyDate} onChange={e=>setHistoryDate(e.target.value)} className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500"/>
            )}
            <button onClick={loadRecent} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5 transition-colors">Refresh</button>
          </div>
        </CardHeader>
        {loadingR ? <LoadingState/> : recent.length===0 ? <EmptyState message="No adjustments for this date."/> : (
          <div className="table-wrap"><table className="w-full text-sm">
            <thead><tr className="border-b border-white/8 bg-white/2">
              {['Date','Commodity','Type','Qty','Reason','Expiry','By','Actions'].map((h,i)=>(
                <th key={i} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
              ))}
            </tr></thead>
            <tbody>{recent.map(r=>{
              const isInc = r.adjustment_type==='Increase'
              return (
                <tr key={r.id} className="border-b border-white/5 hover:bg-white/2">
                  <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDate(r.adjusted_at)}</td>
                  <td className="px-4 py-3 font-medium text-gray-100">{r.commodities?.name||'—'}</td>
                  <td className={`px-4 py-3 text-sm font-medium ${isInc?'text-green-400':'text-red-400'}`}>{r.adjustment_type}</td>
                  <td className={`px-4 py-3 font-mono text-sm ${isInc?'text-green-400':'text-red-400'}`}>{isInc?'+':'-'}{r.quantity} {r.commodities?.unit||''}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">{r.reason}</td>
                  <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{r.expiry_date ? fmtDate(r.expiry_date) : '—'}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">{r.adjusted_by||'—'}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      <button onClick={()=>setHistoryRecord(r)} className="text-xs text-gray-400 border border-white/10 rounded px-2 py-1 hover:bg-white/5 transition-colors">
                        History
                      </button>
                      {canManage && (
                        <button onClick={()=>setEditRecord(r)} className="text-xs text-blue-400 border border-blue-500/30 rounded px-2 py-1 hover:bg-blue-500/10 transition-colors">
                          Edit
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  )
}
