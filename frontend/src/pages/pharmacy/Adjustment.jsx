import { useState, useEffect } from 'react'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/appStore'
import { useStock } from '../../hooks/useStock'
import { toast } from '../../components/ui/Toast'
import { Card, CardHeader, CardTitle, CardBody } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { CommoditySelect } from '../../components/ui/CommoditySelect'
import { LoadingState, EmptyState } from '../../components/ui/Loading'
import { BatchSelect } from '../../components/ui/BatchSelect'
import { EditModal } from '../../components/EditModal'
import { EditHistoryModal } from '../../components/EditHistoryModal'
import { fmtDate, fmtStockQty, todayLagos } from '../../utils/helpers'

// Returns stock from a DSD site back to the store: positive adjustment to the
// store, negative adjustment to the selected site's stock.
const RETURN_REASON = 'Returned from DSD'
const SITE_CFG = { table: 'dsd_stock', col: 'dsd_site_name', label: 'DSD site' }
// Internal move: dispensary → store. Credits the store, debits the dispensary
// (both are the facility's own on-hand), so it is excluded from CRRF adjustments.
const DISP_RETURN_REASON = 'Returned from Dispensary'

const RULES = {
  'Expired':                   { type:'Decrease', lock:true,  label:'Negative — cannot increase expired stock', binSelect:true },
  'Damaged':                   { type:'Decrease', lock:true,  label:'Negative — cannot increase damaged stock', binSelect:true },
  'Lost / Stolen':             { type:'Decrease', lock:true,  label:'Negative — cannot increase lost/stolen stock', binSelect:true, requireNotes:true },
  // A DELTA, like every other reason here: enter the difference you are correcting,
  // not the shelf total. Entering the total is what produced the phantom openings in
  // production (Apapa General: -1766/-1746/-1723 against a shelf of ~1,800 — one
  // count entered three times). Two things guard against that now: notes are
  // compulsory, so every correction carries a written explanation and a name; and
  // it must say WHICH bin it corrects, so it lands on the right bin card.
  'Physical count correction': { type:null, lock:false, label:'Can be positive or negative', requireNotes:true, binSelect:true },
  'Returned to store':         { type:'Increase', lock:true,  label:'Positive — stock is being returned' },
  [DISP_RETURN_REASON]:        { type:'Increase', lock:true,  label:'Positive to store — deducts from the dispensary' },
  [RETURN_REASON]:             { type:'Increase', lock:true,  label:'Positive to store — deducts from the selected DSD site' },
  'State Office':              { type:'Increase', lock:true,  label:'Positive — stock adjustment from state office' },
  'Other':                     { type:null,       lock:false, label:'Specify type manually', binSelect:true, requireNotes:true },
}

export function Adjustment() {
  const store = useAppStore()
  const commoditySection = useAppStore(s => s.commoditySection)
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
  const [selectedLot, setSelectedLot] = useState(null)
  // Which bin a count correction applies to. Adjustments used to always hit the
  // store, so correcting a dispensary/site shelf silently moved the wrong bin.
  const [adjBin, setAdjBin] = useState('store')
  const [adjBinSite, setAdjBinSite] = useState('')
  const [binSites, setBinSites] = useState([])
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
  const isDispReturn = reason === DISP_RETURN_REASON
  // A "Returned from ..." adjustment moves the source's OWN stock back to the store,
  // so the batch is chosen from that source's ledger — a DSD site, or the dispensary.
  const returnBin = isReturn && returnSite ? { locationType: 'dsd', siteName: returnSite }
    : isDispReturn ? { locationType: 'dispensary', siteName: null } : null
  const isReturnReason = isReturn || isDispReturn

  useEffect(() => { loadRecent() }, [fid])
  useEffect(() => { if(fid) loadRecent() }, [historyDate])

  // For a "Returned from site" adjustment, list the sites that currently hold
  // the selected commodity (the valid return sources) with their available qty.
  useEffect(() => {
    let active = true
    if (!isReturn || !fid || !commId) { setSiteOptions([]); return }
    setLoadingSites(true)
    api.stock.dsd.list({ facility_id: fid, commodity_id: commId })
      .then(data => {
        if (!active) return
        const opts = (data || [])
          .filter(r => r.quantity > 0)
          .map(r => ({ site: r[SITE_CFG.col], quantity: r.quantity }))
          .sort((a, b) => b.quantity - a.quantity)
        setSiteOptions(opts)
        setReturnSite(prev => opts.some(o => o.site === prev) ? prev : '')
        setLoadingSites(false)
      })
      .catch(() => { if (active) { setSiteOptions([]); setLoadingSites(false) } })
    return () => { active = false }
  }, [isReturn, fid, commId])

  // Sites that could be counted for this commodity, with what EnVo thinks they hold.
  useEffect(() => {
    let active = true
    if (adjBin !== 'dsd' || !fid || !commId) { setBinSites([]); return }
    api.stock.dsd.list({ facility_id: fid, commodity_id: commId })
      .then(data => {
        if (!active) return
        setBinSites((data || []).map(r => ({ site: r[SITE_CFG.col], quantity: r.quantity })).sort((a, b) => a.site.localeCompare(b.site)))
      })
      .catch(() => { if (active) setBinSites([]) })
    return () => { active = false }
  }, [adjBin, fid, commId])

  const rule      = RULES[reason]
  // Adjustments target the main store inventory. Prefer the 'store' location
  // row, but fall back to any matching row so the preview always reflects
  // exactly what the submit will adjust.
  const stockRow  = store.stockData.find(r => r.commodity_id === commId && r.location_type === 'store' && (!fid || r.facility_id === fid))
    || store.stockData.find(r => r.commodity_id === commId && (!fid || r.facility_id === fid))
  const selectedComm = store.allCommodities.find(c => c.id === commId)

  // The bin this adjustment will actually move, and what it currently holds.
  // Reasons without a bin picker always act on the store (a client return, a state
  // office issue, a return FROM a site into the store).
  const picksBin = !!rule?.binSelect
  const binChosen = !picksBin || adjBin !== 'dsd' || !!adjBinSite
  const dispRow = store.stockData.find(r => r.commodity_id === commId && r.location_type === 'dispensary' && (!fid || r.facility_id === fid))
  const binStock =
    !picksBin || adjBin === 'store' ? (stockRow ? stockRow.quantity : null)
    : adjBin === 'dispensary'       ? (dispRow ? dispRow.quantity : null)
    : (binSites.find(o => o.site === adjBinSite)?.quantity ?? null)
  const binStockLabel =
    !picksBin || adjBin === 'store' ? 'Main Store'
    : adjBin === 'dispensary'       ? 'the Dispensary'
    : adjBinSite || 'DSD site'

  // Essential Commodities: you can only adjust what you hold, so offer just the
  // commodities on the facility's stock levels. HIV keeps the full catalogue.
  const stockedIds = new Set(store.stockData.map(r => r.commodity_id))
  const commSource = store.module === 'essential'
    ? store.allCommodities.filter(c => stockedIds.has(c.id))
    : store.allCommodities

  const categories = {}
  commSource.forEach(c => {
    if (!categories[c.category]) categories[c.category] = []
    categories[c.category].push(c)
  })

  function onReasonChange(r) {
    setReason(r)
    if (!RULES[r]?.binSelect) { setAdjBin('store'); setAdjBinSite('') }
    const rule = RULES[r]
    if (rule?.type) setAdjType(rule.type)
    else setAdjType('')
    if (r !== RETURN_REASON) { setReturnSite(''); setSiteOptions([]) }
  }

  // A Decrease removes stock already on the shelf, so the batch is CHOSEN from the
  // store's lot ledger (not typed) — picking one fills in its exact expiry.
  function onPickLot(lot) {
    setSelectedLot(lot)
    setAdjBatch(lot?.batch_number || '')
    setAdjExpiry(lot?.expiry_date ? String(lot.expiry_date).slice(0, 10) : '')
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
    // Compulsory for reasons that would otherwise be unexplainable after the fact.
    // The backend enforces this too — the client check is only for a fast message.
    if (RULES[reason]?.binSelect && adjBin==='dsd' && !adjBinSite) {
      setMsg({type:'error',text:'Select which DSD site you are correcting.'}); return
    }
    if (RULES[reason]?.requireNotes && !adjNotes.trim()) {
      setMsg({type:'error',text:`Notes are required for "${reason}" — say what was counted and why the figure differs.`}); return
    }
    // Picker-based adjustments — a Decrease, or a return from a site — must name an
    // on-hand batch, and the pick fills in its expiry. A manual Increase still needs
    // a typed expiry.
    if (adjType === 'Decrease' || returnBin) {
      if (!selectedLot) { setMsg({type:'error',text:'Select the batch you are adjusting.'}); return }
      if (parseInt(qty) > selectedLot.remaining) {
        setMsg({type:'error',text:`Only ${fmtStockQty(selectedLot.remaining, selectedComm)} of that batch on hand.`}); return
      }
    } else if (isReturn) {
      setMsg({type:'error',text:`Select the ${SITE_CFG.label} first.`}); return
    } else if (!adjExpiry) {
      setMsg({type:'error',text:'Expiry date is required.'}); return
    }
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
      const siteRows = await api.stock.dsd.list({ facility_id: fid, dsd_site_name: returnSite, commodity_id: commId }).catch(() => [])
      const siteStk = siteRows && siteRows[0]
      if (!siteStk || siteStk.quantity < qtyN) {
        setMsg({type:'error',text:`${returnSite} only has ${siteStk?.quantity || 0} in stock — cannot return ${qtyN}.`}); setSaving(false); return
      }

      const returnNote = `Returned from ${SITE_CFG.label}: ${returnSite}${adjNotes ? ' — ' + adjNotes : ''}`
      // Records the adjustment AND credits the store stock (transactional, server-side).
      try {
        await api.adjustments.record({
          facility_id:fid, commodity_id:commId, quantity:qtyN,
          adjustment_type:'Increase', reason, adjusted_by:adjBy||null,
          reference_number:adjRef||null, notes:returnNote, adjusted_at:new Date().toISOString(),
          expiry_date:adjExpiry||null, batch_number:adjBatch||null,
          section:commoditySection,
        })
      } catch (logErr) { setMsg({type:'error',text:'Error: '+logErr.message}); setSaving(false); return }

      // Debit the site (the server already credited the store).
      await api.stock.dsd.setQuantity(siteStk.id, Math.max(0, siteStk.quantity - qtyN))

      const prevStore = store.stockData.find(r => r.commodity_id === commId && r.facility_id === fid && r.location_type === 'store')?.quantity || 0
      const newStoreQty = prevStore + qtyN
      toast('Return recorded','green')
      setMsg({type:'success',text:`Returned ${fmtStockQty(qtyN, selectedComm)} from ${returnSite} to store. Store stock: ${fmtStockQty(newStoreQty, selectedComm)}`})
      setCommId(''); setQty(1); setReason(''); setAdjType(''); setAdjBy(''); setAdjRef(''); setAdjNotes(''); setAdjExpiry(''); setAdjBatch(''); setSelectedLot(null); setReturnSite(''); setSiteOptions([])
      await loadStock(); loadRecent(); setSaving(false)
      return
    }

    // ── Returned from the Dispensary ──────────────────────────────────────
    // Internal move: credits the store and debits the dispensary. Both are the
    // facility's own on-hand, so total SOH is unchanged (and this reason is
    // excluded from CRRF adjustments). Validate the dispensary holds enough first.
    if (isDispReturn) {
      const dispRow = store.stockData.find(r => r.commodity_id === commId && r.location_type === 'dispensary' && r.facility_id === fid)
      const dispQty = dispRow?.quantity || 0
      if (!dispRow || dispQty < qtyN) {
        setMsg({type:'error',text:`Dispensary only has ${fmtStockQty(dispQty, selectedComm)} — cannot return ${qtyN}.`}); return
      }
      setSaving(true)
      const returnNote = `Returned from Dispensary${adjNotes ? ' — ' + adjNotes : ''}`
      // Records the adjustment AND credits the store stock (transactional, server-side).
      try {
        await api.adjustments.record({
          facility_id:fid, commodity_id:commId, quantity:qtyN,
          adjustment_type:'Increase', reason, adjusted_by:adjBy||null,
          reference_number:adjRef||null, notes:returnNote, adjusted_at:new Date().toISOString(),
          expiry_date:adjExpiry||null, batch_number:adjBatch||null,
          section:commoditySection,
        })
      } catch (logErr) { setMsg({type:'error',text:'Error: '+logErr.message}); setSaving(false); return }

      // Debit the dispensary (the server already credited the store).
      await api.stock.update(dispRow.id, Math.max(0, dispQty - qtyN))

      const prevStore = store.stockData.find(r => r.commodity_id === commId && r.facility_id === fid && r.location_type === 'store')?.quantity || 0
      toast('Return recorded','green')
      setMsg({type:'success',text:`Returned ${fmtStockQty(qtyN, selectedComm)} from dispensary to store. Store stock: ${fmtStockQty(prevStore + qtyN, selectedComm)}`})
      setCommId(''); setQty(1); setReason(''); setAdjType(''); setAdjBy(''); setAdjRef(''); setAdjNotes(''); setAdjExpiry(''); setAdjBatch(''); setSelectedLot(null)
      await loadStock(); loadRecent(); setSaving(false)
      return
    }

    setSaving(true)
    // Adjust the exact stock row shown in the preview. Re-querying by
    // facility+commodity with maybeSingle() fails when a commodity has
    // multiple location rows (store/dispensary/dsd); use the row id instead.
    // Guard the bin being adjusted, not the store. A site can hold stock the
    // store has no row for, and blocking on the store's row made those
    // corrections impossible to record.
    if (binStock == null) { setMsg({type:'error',text:`No stock record for ${binStockLabel}.`}); setSaving(false); return }

    // Records the adjustment AND applies it to the store stock (transactional, server-side).
    try {
      await api.adjustments.record({
        facility_id:fid, commodity_id:commId, quantity:parseInt(qty),
        adjustment_type:adjType, reason, adjusted_by:adjBy||null,
        reference_number:adjRef||null, notes:adjNotes||null, adjusted_at:new Date().toISOString(),
        expiry_date:adjExpiry||null, batch_number:adjBatch||null,
        section:commoditySection,
        location_type:adjBin, site_name:adjBin==='dsd' ? adjBinSite : null,
      })
    } catch (error) { setMsg({type:'error',text:'Error: '+error.message}); setSaving(false); return }

    const newQty = adjType==='Increase' ? binStock + parseInt(qty) : Math.max(0, binStock - parseInt(qty))
    toast('Adjustment saved','green')
    setMsg({type:'success',text:`Adjustment saved. ${binStockLabel} now holds ${fmtStockQty(newQty, selectedComm)}.`})
    setCommId(''); setQty(1); setReason(''); setAdjType(''); setAdjBy(''); setAdjRef(''); setAdjNotes(''); setAdjExpiry(''); setAdjBatch(''); setSelectedLot(null)
    await loadStock()
    loadRecent()
    setSaving(false)
  }

  async function loadRecent() {
    setLoadingR(true)
    const d = historyDate
    const data = await api.adjustments.history({
      facility_id: fid, date: d, section: commoditySection || undefined,
    }).catch(() => [])
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
                <CommoditySelect categories={categories} value={commId} onChange={setCommId} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Quantity</label>
                <input type="number" min="1" value={qty} onChange={e=>setQty(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"/>
              </div>
            </div>

            {/* Shows the stock of the bin being adjusted, not always the store. For a
                reason that picks a bin it stays hidden until one is chosen, so the
                figure on screen is never the wrong shelf's. */}
            {commId && binChosen && (
              <div className={`rounded-lg px-4 py-3 text-sm border ${binStock==null?'bg-red-500/10 border-red-500/20 text-red-400':'bg-white/5 border-white/10 text-gray-300'}`}>
                {binStock == null ? '⚠ No stock record' : `Current stock in ${binStockLabel}: ${fmtStockQty(binStock, selectedComm)}`}
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

            {adjType === 'Decrease' ? (
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Batch to adjust *</label>
                {/* Read the lots of the bin being adjusted. Fixed to "store" this offered
                    store batches while the backend debited the selected site's ledger,
                    so an expiry recorded at an SDP drew from the wrong shelf. */}
                <BatchSelect key={`${commId}|${adjBin}|${adjBinSite}`} facilityId={fid} commodityId={commId}
                  locationType={adjBin} siteName={adjBin === 'dsd' ? adjBinSite : null}
                  value={selectedLot?.key} onSelect={onPickLot} />
                <p className="text-xs text-gray-500 mt-1">
                  {!commId ? 'Select a commodity first.'
                    : selectedLot ? `Expiry ${selectedLot.expiry_date ? fmtDate(selectedLot.expiry_date) : '—'} · ${fmtStockQty(selectedLot.remaining, selectedComm)} on hand`
                    : 'Choose the exact batch being removed — its expiry fills in automatically.'}
                </p>
              </div>
            ) : isReturnReason ? (
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Batch being returned *</label>
                {returnBin ? (
                  <BatchSelect key={`${commId}|${returnBin.siteName || 'dispensary'}`} facilityId={fid} commodityId={commId}
                    locationType={returnBin.locationType} siteName={returnBin.siteName || undefined}
                    value={selectedLot?.key} onSelect={onPickLot} />
                ) : (
                  <div className="text-xs text-gray-500 bg-white/5 border border-white/10 rounded-lg px-3 py-2">Select the {SITE_CFG.label} above first.</div>
                )}
                <p className="text-xs text-gray-500 mt-1">
                  {selectedLot ? `Expiry ${selectedLot.expiry_date ? fmtDate(selectedLot.expiry_date) : '—'} · ${fmtStockQty(selectedLot.remaining, selectedComm)} ${isDispReturn ? 'in dispensary' : `at ${returnSite}`}`
                    : 'Choose the batch being returned — its expiry fills in automatically.'}
                </p>
              </div>
            ) : (
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
            )}

            {/* Which shelf this correction applies to. Without it every correction
                hit the store, so counting a dispensary or site shelf moved the wrong
                bin card and left the one you counted unchanged. */}
            {rule?.binSelect && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Which stock are you correcting? *</label>
                  <select value={adjBin} onChange={e=>{setAdjBin(e.target.value); setAdjBinSite('')}}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500">
                    <option value="store">Main Store</option>
                    <option value="dispensary">Dispensary</option>
                    <option value="dsd">DSD site</option>
                  </select>
                </div>
                {adjBin === 'dsd' && (
                  <div>
                    <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">DSD site *</label>
                    <select value={adjBinSite} onChange={e=>setAdjBinSite(e.target.value)} disabled={!commId}
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500">
                      <option value="">{commId ? 'Select a site…' : 'Choose a commodity first'}</option>
                      {binSites.map(o => <option key={o.site} value={o.site}>{o.site}</option>)}
                    </select>
                  </div>
                )}
              </div>
            )}

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
              <Button type="button" variant="ghost" size="md" onClick={() => { store.setCurrentReportCategory('adjustment'); store.setPendingReportsTab(true); store.setCurrentPage('log') }}>
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
