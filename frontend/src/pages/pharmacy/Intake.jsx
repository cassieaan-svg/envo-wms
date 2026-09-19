import { useState, useEffect } from 'react'
import { api } from '../../lib/api'
import { offlineIntake } from '../../lib/offlineWrite'
import { useAppStore } from '../../store/appStore'
import { useStock } from '../../hooks/useStock'
import { toast } from '../../components/ui/Toast'
import { Card, CardHeader, CardTitle, CardBody } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { CommoditySelect } from '../../components/ui/CommoditySelect'
import { LoadingState, EmptyState } from '../../components/ui/Loading'
import { EditModal } from '../../components/EditModal'
import { EditHistoryModal } from '../../components/EditHistoryModal'
import { fmtDate, getCommodityPackSize, getCommodityDispenseUnit, allowedCategoriesFor, todayLagos, entryTimestamp, isPlausibleExpiry, expiryDateBounds } from '../../utils/helpers'

export function Intake() {
  const store = useAppStore()
  const commoditySection = useAppStore(s => s.commoditySection)
  const { loadStock } = useStock()
  const canManage = store.canManageStock()

  const [commId, setCommId]       = useState('')
  const [qty, setQty]             = useState(1)
  const [supplier, setSupplier]   = useState('')
  const [supplierOther, setSupplierOther] = useState('')
  const [batch, setBatch]         = useState('')
  const [expiry, setExpiry]       = useState('')
  const [deliveryRef, setRef]     = useState('')
  const [condition, setCondition] = useState('Good')
  const defaultReceivedBy = store.user?.user_metadata?.full_name || store.user?.user_metadata?.name || ''
  const [receivedBy, setRecBy]    = useState(defaultReceivedBy)
  const [receivedDate, setRecDate]= useState(todayLagos())
  const [notes, setNotes]         = useState('')
  const [saving, setSaving]       = useState(false)
  const [msg, setMsg]             = useState(null)
  const [recent, setRecent]       = useState([])
  const [loadingR, setLoadingR]   = useState(true)
  const [historyDate, setHistoryDate] = useState(todayLagos())
  const [showDatePicker, setShowDatePicker] = useState(false)
  const [editRecord, setEditRecord] = useState(null)
  const [historyRecord, setHistoryRecord] = useState(null)


  const fid = store.currentFacility?.id

  useEffect(() => { loadRecent() }, [fid])
  useEffect(() => { loadRecent() }, [historyDate])
  useEffect(() => {
    if (!receivedBy) setRecBy(store.user?.user_metadata?.full_name || store.user?.user_metadata?.name || '')
  }, [store.user])

  // Ensure commodities are filtered by section on load
  useEffect(() => { refreshCommodities() }, [store.commoditySection])

  const selectedComm = store.allCommodities.find(c => c.id === commId)
  const packSize     = getCommodityPackSize(selectedComm)
  const dispUnit     = getCommodityDispenseUnit(selectedComm)

  const categories = {}
  store.allCommodities.forEach(c => {
    if (!categories[c.category]) categories[c.category] = []
    categories[c.category].push(c)
  })

  const sectionCats = allowedCategoriesFor(
    store.commoditySection, store.currentFacility?.name,
    store.user?.user_metadata?.essential === true) || []

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

  async function refreshCommodities() {
    // allowedCategoriesFor, not a raw SECTION_CATEGORIES lookup: it folds in the
    // per-login Essential grant and the hub-store override, so this list matches
    // what the API will actually return.
    const cats = allowedCategoriesFor(
      store.commoditySection, store.currentFacility?.name,
      store.user?.user_metadata?.essential === true) || []
    const comms = await api.commodities.list().catch(() => null)
    if (!comms) return
    const filtered = cats.length
      ? comms.filter(c => cats.includes(c.category))
      : comms
    store.setAllCommodities(filtered)
  }

  async function handleSubmit(e) {
    e?.preventDefault()
    setMsg(null)
    if (!commId)     { setMsg({type:'error',text:'Select a commodity.'}); return }
    if (qty < 1)     { setMsg({type:'error',text:'Quantity must be at least 1.'}); return }
    if (!supplier)   { setMsg({type:'error',text:'Select a supplier.'}); return }
    if (supplier === 'Other' && !supplierOther.trim()) { setMsg({type:'error',text:'Specify the other supplier.'}); return }
    if (!batch)      { setMsg({type:'error',text:'Batch / lot number is required.'}); return }
    if (!expiry)     { setMsg({type:'error',text:'Expiry date is required.'}); return }
    if (!isPlausibleExpiry(expiry)) { setMsg({type:'error',text:'Expiry date must be in the future — you can\'t receive already-expired stock.'}); return }
    if (!receivedDate) { setMsg({type:'error',text:'Date received is required.'}); return }
    if (receivedDate > todayLagos()) { setMsg({type:'error',text:'Date received can\'t be in the future.'}); return }
    if (!receivedBy) { setMsg({type:'error',text:'Received by is required.'}); return }
    if (!fid)        { setMsg({type:'error',text:'No facility assigned.'}); return }

    const supplierSource = supplier === 'Other' ? supplierOther.trim() : supplier

    setSaving(true)
    // One call records the intake AND credits the store stock (transactional, server-side).
    // offlineIntake is a no-op passthrough outside the Essential module — HIV's
    // behaviour here is unchanged (see lib/offlineWrite.js).
    let result
    try {
      result = await offlineIntake({
        facility_id: fid, commodity_id: commId, quantity: qty,
        supplier_source: supplierSource || null,
        batch_number: batch || null, expiry_date: expiry || null,
        delivery_note_ref: deliveryRef || null, condition_on_arrival: condition,
        received_by: receivedBy || null,
        // Real time when recorded today; local noon for back-dated entries.
        received_at: entryTimestamp(receivedDate),
        notes: notes || null,
        section: commoditySection,
      })
    } catch (e1) { setMsg({type:'error',text:'Error: '+e1.message}); setSaving(false); return }

    if (result?.queued) {
      toast(`Intake of ${qty} ${selectedComm?.unit || dispUnit} recorded, waiting to sync`, 'amber')
      setMsg({type:'success',text:'Saved on this device. No connection right now; it will sync automatically.'})
    } else {
      toast(`Intake of ${qty} ${selectedComm?.unit || dispUnit} recorded`, 'green')
      setMsg({type:'success',text:'Intake saved. Stock updated.'})
    }
    setCommId(''); setQty(1); setSupplier(''); setSupplierOther(''); setBatch('')
    setExpiry(''); setRef(''); setCondition('Good'); setRecBy(defaultReceivedBy); setNotes('')
    setRecDate(todayLagos())
    setDispUnitInput(''); setPackSzInput(''); setShowDispDetails(false)
    await loadStock()
    loadRecent()
    setSaving(false)
  }

  async function loadRecent(dateStr) {
    setLoadingR(true)
    const d    = dateStr || historyDate
    // allowedCategoriesFor, not a raw SECTION_CATEGORIES lookup: it folds in the
    // per-login Essential grant and the hub-store override, so this list matches
    // what the API will actually return.
    const cats = allowedCategoriesFor(
      store.commoditySection, store.currentFacility?.name,
      store.user?.user_metadata?.essential === true) || []
    const commodity_ids = cats.length ? store.allCommodities.map(c => c.id) : undefined
    const data = await api.intake.history({
      facility_id: fid, date: d, commodity_ids, section: commoditySection || undefined,
    }).catch(() => [])
    setRecent(data || [])
    setLoadingR(false)
  }

  const condColor = c => c==='Good'?'text-green-400':c==='Damaged'?'text-red-400':'text-amber-400'
  const inputCls = 'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500'

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-medium text-gray-100">Stock Intake</h1>
        <p className="text-sm text-gray-500 mt-1">Record stock received — warehouse deliveries</p>
      </div>

      <Card>
        <CardHeader><CardTitle>What was received</CardTitle></CardHeader>
        <CardBody>
          <form onSubmit={handleSubmit} className="space-y-4">

            {/* Commodity selector + new commodity toggle */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Commodity *</label>
                <div className="flex gap-1.5">
                  <CommoditySelect categories={categories} value={commId} onChange={setCommId} className={inputCls} />
                  {commId && (
                    <button type="button" onClick={() => { setCommId(''); setShowDispDetails(false); setDispUnitInput(''); setPackSzInput('') }}
                      className="shrink-0 text-gray-500 hover:text-gray-300 border border-white/10 rounded-lg px-2.5 transition-colors text-sm" title="Clear">
                      ✕
                    </button>
                  )}
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">
                  {selectedComm?.unit ? `Quantity (${selectedComm.unit}) *` : 'Quantity *'}
                </label>
                <input type="number" min="1" value={qty} onChange={e=>setQty(e.target.value)} required className={inputCls}/>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Supplier *</label>
                <select value={supplier} onChange={e=>setSupplier(e.target.value)} required className={inputCls}>
                  <option value="">Select supplier…</option>
                  <option>GHSC-PSM</option><option>Other</option>
                </select>
              </div>
              {supplier === 'Other' && (
                <div>
                  <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Specify supplier *</label>
                  <input type="text" value={supplierOther} onChange={e=>setSupplierOther(e.target.value)}
                    placeholder="Enter supplier name" className={inputCls}/>
                </div>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Batch / lot number *</label>
                <input type="text" value={batch} onChange={e=>setBatch(e.target.value)} placeholder="e.g. LOT2024A001" required className={inputCls}/>
              </div>
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Expiry date *</label>
                <input type="date" value={expiry} min={expiryDateBounds().min} max={expiryDateBounds().max} onChange={e=>setExpiry(e.target.value)} required className={inputCls}/>
              </div>
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Delivery note ref</label>
                <input type="text" value={deliveryRef} onChange={e=>setRef(e.target.value)} placeholder="e.g. DN-2024-001" className={inputCls}/>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Condition on arrival *</label>
                <select value={condition} onChange={e=>setCondition(e.target.value)} required className={inputCls}>
                  <option>Good</option><option>Damaged</option><option>Partial</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Date received *</label>
                {/* Editable, so a delivery can be recorded on the day it actually
                    arrived. max = today: no future receipts. entryTimestamp() stamps a
                    same-day entry with the real time and a back-dated one at local noon. */}
                <input type="date" value={receivedDate} max={todayLagos()}
                  onChange={e=>setRecDate(e.target.value)} required className={inputCls}/>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Received by (GON staff name) *</label>
                <input type="text" value={receivedBy} onChange={e=>setRecBy(e.target.value)} placeholder="GON staff name" required className={inputCls}/>
              </div>
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Notes (optional)</label>
                <input type="text" value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Additional information" className={inputCls}/>
              </div>
            </div>

            {msg && (
              <div className={`rounded-lg px-4 py-3 text-sm ${msg.type==='error'?'bg-red-500/10 border border-red-500/20 text-red-400':'bg-green-500/10 border border-green-500/20 text-green-400'}`}>
                {msg.text}
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button type="submit" variant="success" size="lg" disabled={saving}>
                {saving ? 'Saving…' : 'Confirm intake'}
              </Button>
              <Button type="button" variant="ghost" size="md" onClick={() => { store.setCurrentReportCategory('intake'); store.setPendingReportsTab(true); store.setCurrentPage('log') }}>
                Export summary
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <Card>
        {editRecord && (
          <EditModal
            record={{ ...editRecord, _type: 'intake' }}
            onClose={() => setEditRecord(null)}
            onSave={() => { setEditRecord(null); loadRecent() }}
          />
        )}
        {historyRecord && (
          <EditHistoryModal record={historyRecord} onClose={() => setHistoryRecord(null)} />
        )}
        <CardHeader>
          <CardTitle>Entries for {historyDate === new Date().toISOString().split('T')[0] ? 'today' : fmtDate(historyDate)}</CardTitle>
          <div className="flex items-center gap-2">
            {showDatePicker && (
              <input
                type="date"
                value={historyDate}
                max={new Date().toISOString().split('T')[0]}
                onChange={e => { setHistoryDate(e.target.value); setShowDatePicker(false) }}
                className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
              />
            )}
            <button onClick={() => setShowDatePicker(v => !v)} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">
              {showDatePicker ? 'Cancel' : 'History'}
            </button>
            <button onClick={() => loadRecent()} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">Refresh</button>
          </div>
        </CardHeader>
        {loadingR ? <LoadingState/> : recent.length===0 ? <EmptyState message="No intake records for this date."/> : (
          <div className="table-wrap"><table className="w-full text-sm">
            <thead><tr className="border-b border-white/8 bg-white/2">
              {['Date','Commodity','Qty','Supplier','Batch','Expiry','Condition','By','Actions'].map(h=>(
                <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
              ))}
            </tr></thead>
            <tbody>{recent.map(r=>(
              <tr key={r.id} className="border-b border-white/5 hover:bg-white/2">
                <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDate(r.received_at)}</td>
                <td className="px-4 py-3 font-medium text-gray-100">{r.commodities?.name||'—'}</td>
                <td className="px-4 py-3 font-mono text-sm text-green-400">+{r.quantity} {r.commodities?.unit||''}</td>
                <td className="px-4 py-3 text-xs text-gray-500">{r.supplier_source||'—'}</td>
                <td className="px-4 py-3 text-xs text-gray-500">{r.batch_number||'—'}</td>
                <td className="px-4 py-3 text-xs text-gray-500">{r.expiry_date?fmtDate(r.expiry_date):'—'}</td>
                <td className={`px-4 py-3 text-xs font-medium ${condColor(r.condition_on_arrival)}`}>{r.condition_on_arrival}</td>
                <td className="px-4 py-3 text-xs text-gray-500">{r.received_by||'—'}</td>
                <td className="px-4 py-3">
                  <div className="flex gap-2">
                    <button onClick={() => setHistoryRecord(r)} className="text-xs text-gray-400 border border-white/10 rounded px-2 py-1 hover:bg-white/5 transition-colors">History</button>
                    {canManage && (
                      <button onClick={() => setEditRecord(r)} className="text-xs text-blue-400 border border-blue-500/30 rounded px-2 py-1 hover:bg-blue-500/10 transition-colors">Edit</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  )
}
