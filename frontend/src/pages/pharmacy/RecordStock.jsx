import { useState, useEffect, useRef } from 'react'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/appStore'
import { useStock } from '../../hooks/useStock'
import { toast } from '../../components/ui/Toast'
import { Card, CardHeader, CardTitle, CardBody } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { CommoditySelect } from '../../components/ui/CommoditySelect'
import { BatchSelect } from '../../components/ui/BatchSelect'
import { LotEditor } from '../../components/LotEditor'
import { LoadingState, EmptyState } from '../../components/ui/Loading'
import { EditModal } from '../../components/EditModal'
import { EditHistoryModal } from '../../components/EditHistoryModal'
import { fmtDate, fmtStockQty, fmtDispenseQty, getCommodityPackSize, getCommodityDispenseUnit, pluralizeUnit, todayLagos, entryTimestamp } from '../../utils/helpers'

export function RecordStock() {
  const store = useAppStore()
  const commoditySection = useAppStore(s => s.commoditySection)
  const { loadStock } = useStock()
  const canManage    = store.canManageStock()
  const facilityRole = useAppStore(s => s.facilityRole)
  const accessLevel  = useAppStore(s => s.accessLevel)
  const dsdSiteName  = useAppStore(s => s.dsdSiteName)
  const isDSD = accessLevel === 'facility' && facilityRole === 'dsd'

  const [commId, setCommId]     = useState('')
  // The batch the user chose for the commodity currently in the picker. Facility
  // dispensing only (DSD site stock carries no batch), reported by BatchSelect.
  const [pickerBatch, setPickerBatch] = useState(null)
  // The bin's raw lots, so we can prompt when any has no expiry recorded.
  const [binLots, setBinLots] = useState([])
  const [lotsRefresh, setLotsRefresh] = useState(0)
  const [showLotEditor, setShowLotEditor] = useState(false)
  const qtyRef                  = useRef(1)
  const [items, setItems]       = useState([])   // staged commodities to record together
  const [by, setBy]             = useState('')
  const [date, setDate]         = useState(todayLagos())
  const [notes, setNotes]       = useState('')
  const [saving, setSaving]     = useState(false)
  const [msg, setMsg]           = useState(null)
  const [recent, setRecent]     = useState([])
  const [loadingRecent, setLoadingRecent] = useState(true)
  const [historyDate, setHistoryDate] = useState(todayLagos())
  const [showDatePicker, setShowDatePicker] = useState(false)
  const [editRecord, setEditRecord] = useState(null)
  const [historyRecord, setHistoryRecord] = useState(null)
  const [dsdStockRow, setDsdStockRow] = useState(null)

  const fid = store.currentFacility?.id

  useEffect(() => { loadRecent() }, [fid])
  useEffect(() => { if(fid) loadRecent() }, [historyDate])

  useEffect(() => {
    if (!isDSD || !fid || !dsdSiteName || !commId) { setDsdStockRow(null); return }
    api.stock.dsd.list({ facility_id: fid, dsd_site_name: dsdSiteName, commodity_id: commId })
      .then(rows => setDsdStockRow((rows && rows[0]) || null))
      .catch(() => setDsdStockRow(null))
  }, [commId, isDSD, fid, dsdSiteName])

  const selectedComm = store.allCommodities.find(c => c.id === commId)
  const packSize     = getCommodityPackSize(selectedComm)
  const dispUnit     = getCommodityDispenseUnit(selectedComm)
  const stockRow     = isDSD ? dsdStockRow : store.stockData.find(r => r.commodity_id === commId && (!fid || r.facility_id === fid) && r.location_type === 'dispensary')

  // Resolve current stock-on-hand for a commodity in this mode. Returns a number, or null if no record.
  async function resolveStock(commodityId) {
    if (isDSD) {
      const rows = await api.stock.dsd.list({ facility_id: fid, dsd_site_name: dsdSiteName, commodity_id: commodityId }).catch(() => [])
      return rows && rows[0] ? rows[0].quantity : null
    }
    const row = store.stockData.find(s => s.commodity_id === commodityId && s.facility_id === fid && s.location_type === 'dispensary')
    return row ? row.quantity : null
  }

  // Validate the current commodity + quantity and stage it for recording.
  async function addItem() {
    setMsg(null)
    if (!fid)   { setMsg({ type:'error', text:'No facility assigned.' }); return }
    if (!commId){ setMsg({ type:'error', text:'Select a commodity.' }); return }
    const qty = parseInt(qtyRef.current?.value || 0)
    if (isNaN(qty) || qty < 0){ setMsg({ type:'error', text:'Quantity cannot be negative.' }); return }
    const comm = store.allCommodities.find(c => c.id === commId)
    if (items.some(i => i.commodityId === commId)) {
      setMsg({ type:'error', text:`${comm?.name || 'Commodity'} is already in the list — remove it first to change the quantity.` }); return
    }
    const avail = await resolveStock(commId)
    // Zero is a valid "nothing consumed today" record: skip the stock, insufficiency
    // and expired-batch checks (nothing leaves stock) and attach no batch.
    if (qty > 0) {
      if (avail == null || avail === 0) {
        setMsg({ type:'error', text:`No stock for ${comm?.name || 'commodity'}.` }); return
      }
      if (avail < qty) {
        setMsg({ type:'error', text:`Insufficient stock for ${comm?.name}. Available: ${avail} ${comm?.unit || 'units'}.` }); return
      }
      if (pickerBatch?.expired) {
        setMsg({ type:'error', text:'This batch is expired — move it back to store (Returned from Dispensary) and adjust it out before deducting it.' }); return
      }
    }
    setItems(prev => [...prev, { commodityId: commId, quantity: qty, comm, avail, batch: (qty > 0 && !isDSD) ? pickerBatch : null }])
    setCommId(''); setPickerBatch(null); if (qtyRef.current) qtyRef.current.value = '1'
  }

  function removeItem(commodityId) {
    setItems(prev => prev.filter(i => i.commodityId !== commodityId))
  }

  async function handleSubmit(e) {
    e?.preventDefault()
    setMsg(null)
    if (!fid)   { setMsg({ type:'error', text:'No facility assigned.' }); return }
    if (!by)    { setMsg({ type:'error', text:'Recorded by is required.' }); return }
    if (date && date > todayLagos()) { setMsg({ type:'error', text:'Date cannot be in the future.' }); return }

    // Record the staged list; if nothing was staged, fall back to the current picker selection.
    let batch = items
    if (batch.length === 0) {
      if (!commId){ setMsg({ type:'error', text:'Add at least one commodity.' }); return }
      const qty = parseInt(qtyRef.current?.value || 0)
      if (isNaN(qty) || qty < 0){ setMsg({ type:'error', text:'Quantity cannot be negative.' }); return }
      const comm  = store.allCommodities.find(c => c.id === commId)
      const avail = await resolveStock(commId)
      // Zero consumption skips the stock / expiry checks and attaches no batch.
      if (qty > 0) {
        if (avail == null || avail === 0) {
          setMsg({ type:'error', text:`No stock for ${comm?.name || 'commodity'}.` }); return
        }
        if (avail < qty) {
          setMsg({ type:'error', text:`Insufficient stock for ${comm?.name}. Available: ${avail} ${comm?.unit || 'units'}.` }); return
        }
        if (pickerBatch?.expired) {
          setMsg({ type:'error', text:'This batch is expired — move it back to store (Returned from Dispensary) and adjust it out before deducting it.' }); return
        }
      }
      batch = [{ commodityId: commId, quantity: qty, comm, avail, batch: (qty > 0 && !isDSD) ? pickerBatch : null }]
    }

    setSaving(true)
    // One call per commodity — each becomes its own dispense record for the day.
    for (const item of batch) {
      try {
        await api.dispense.record({
          facility_id:   fid,
          commodity_id:  item.commodityId,
          quantity:      item.quantity,
          dispensed_by:  by || null,
          dispensed_at:  entryTimestamp(date),
          ...(isDSD
            ? { notes: `[DSD: ${dsdSiteName}]${notes ? ' ' + notes : ''}`, dsd_site_name: dsdSiteName }
            : { notes: notes || null, location_type: 'dispensary',
                // A picked lot sends its batch, using '' for the "(no batch)" lot so the
                // server debits THAT lot. `|| undefined` dropped the field entirely, so
                // the server fell back to FEFO and could retire a different batch than
                // the one the dispenser actually took off the shelf.
                batch_number: item.batch ? (item.batch.batch_number || '') : undefined,
                expiry_date:  item.batch?.expiry_date  || undefined }),
          section:       commoditySection,
        })
      } catch (error) { setMsg({ type:'error', text:'Error: '+error.message }); setSaving(false); return }
    }

    toast(`Stock recorded — ${batch.length} item(s)`, 'green')
    setMsg({ type:'success', text:`Stock saved successfully — ${batch.length} record(s).` })
    setItems([]); setCommId(''); if (qtyRef.current) qtyRef.current.value = '1'; setBy(''); setNotes('')
    setDate(todayLagos())
    if (!isDSD) await loadStock()
    loadRecent()
    setSaving(false)
  }

  async function loadRecent() {
    setLoadingRecent(true)
    const d = historyDate
    const data = await api.dispense.history({
      facility_id: fid, date: d, section: commoditySection || undefined,
    }).catch(() => [])
    setRecent(data || [])
    setLoadingRecent(false)
  }

  // Essential Commodities: you can only consume what you hold, so offer just the
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

  const qtyLabel = selectedComm?.unit
    ? packSize
      ? `Quantity (${selectedComm.unit}, 1 ${selectedComm.unit} = ${packSize} ${dispUnit})`
      : `Quantity (${selectedComm.unit})`
    : 'Quantity'

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-medium text-gray-100">Record Stock Consumed</h1>
        <p className="text-sm text-gray-500 mt-1">{isDSD ? `Record stock consumed at ${dsdSiteName}` : 'Record daily commodity stock consumed at this facility'}</p>
      </div>

      <Card>
        <CardHeader><CardTitle>Stock details</CardTitle></CardHeader>
        <CardBody>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">
                  Commodity
                </label>
                <CommoditySelect categories={categories} value={commId} onChange={setCommId} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">
                  {qtyLabel}
                </label>
                <input type="number" min="0" defaultValue={1} ref={qtyRef}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
              </div>
            </div>

            {/* Stock preview */}
            {commId && (
              <div className={`rounded-lg px-4 py-3 text-sm border ${
                !stockRow ? 'bg-red-500/10 border-red-500/20 text-red-400' :
                stockRow.quantity === 0 ? 'bg-red-500/10 border-red-500/20 text-red-400' :
                'bg-white/5 border-white/10 text-gray-300'
              }`}>
                {!stockRow ? '⚠ No stock record — request from store' :
                 isDSD ? `Stock on hand: ${stockRow.quantity} ${selectedComm?.unit || 'units'}` :
                 `Stock on hand: ${fmtStockQty(stockRow.quantity, selectedComm)}`}
              </div>
            )}

            {/* Batch to consume (facility dispensing only — DSD site stock has no
                batch). Defaults to the FEFO lot; override to consume another. */}
            {!isDSD && commId && stockRow && stockRow.quantity > 0 && (
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Batch to consume</label>
                <BatchSelect key={commId} facilityId={fid} commodityId={commId} locationType="dispensary"
                  value={pickerBatch?.key} onSelect={setPickerBatch}
                  onLotsLoaded={setBinLots} refreshToken={lotsRefresh} />
                {/* Some stock carries no expiry (the ledger seed had no receipt to
                    take one from). Prompt here — this is where it's noticed. */}
                {binLots.some(l => !l.expiry_date) && (
                  <div className="mt-2 rounded-lg px-3 py-2 text-xs bg-amber-500/10 border border-amber-500/20 text-amber-300 flex items-center justify-between gap-3 flex-wrap">
                    <span>
                      {binLots.filter(l => !l.expiry_date).reduce((s, l) => s + l.quantity, 0)}{' '}
                      {selectedComm?.unit || 'units'} have no expiry recorded
                      {canManage ? '.' : ' — ask your store manager to record it.'}
                    </span>
                    {canManage && (
                      <button type="button" onClick={() => setShowLotEditor(true)}
                        className="text-amber-200 underline underline-offset-2 hover:text-amber-100 shrink-0">
                        Record batch &amp; expiry
                      </button>
                    )}
                  </div>
                )}
                {pickerBatch?.expired && (
                  <div className="mt-2 rounded-lg px-3 py-2 text-xs bg-red-500/10 border border-red-500/20 text-red-300">
                    ⚠ This batch expired{pickerBatch.expiry_date ? ` on ${fmtDate(pickerBatch.expiry_date)}` : ''}. Move it back to store (adjustment: “Returned from Dispensary”) and adjust it out before deducting — expired stock can’t be dispensed.
                  </div>
                )}
              </div>
            )}

            {/* Add-to-list */}
            <div className="flex justify-end">
              <Button type="button" variant="default" size="md" onClick={addItem}>
                + Add commodity
              </Button>
            </div>

            {/* Staged commodities to record together */}
            {items.length > 0 && (
              <div className="rounded-lg border border-white/10 divide-y divide-white/5">
                <div className="px-4 py-2 text-xs text-gray-500 uppercase tracking-widest">
                  {items.length} commodit{items.length === 1 ? 'y' : 'ies'} to record
                </div>
                {items.map(it => {
                  const packSize = getCommodityPackSize(it.comm)
                  const dispUnit = getCommodityDispenseUnit(it.comm)
                  return (
                    <div key={it.commodityId} className="flex items-center justify-between px-4 py-2.5 gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-gray-100 truncate">{it.comm?.name || '—'}</div>
                        <div className="text-xs text-gray-500">
                          {it.quantity} {pluralizeUnit(it.quantity, it.comm?.unit || dispUnit)}
                          {packSize ? ` = ${(it.quantity * packSize).toLocaleString()} ${dispUnit}` : ''}
                          {it.batch?.batch_number && (
                            <span className="text-gray-400"> · batch {it.batch.batch_number}{it.batch.expiry_date ? ` · exp ${fmtDate(it.batch.expiry_date)}` : ''}</span>
                          )}
                        </div>
                      </div>
                      <button type="button" onClick={() => removeItem(it.commodityId)}
                        className="text-xs text-gray-500 hover:text-red-400 border border-white/10 rounded px-2 py-1 transition-colors shrink-0">
                        Remove
                      </button>
                    </div>
                  )
                })}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Recorded by *</label>
                <input type="text" value={by} onChange={e => setBy(e.target.value)} placeholder="Staff name or ID" required
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Date</label>
                <input type="date" value={date} max={todayLagos()} onChange={e => setDate(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
              </div>
            </div>

            <div>
              <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Notes (optional)</label>
              <input type="text" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Additional details"
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
            </div>

            {msg && (
              <div className={`rounded-lg px-4 py-3 text-sm ${msg.type==='error' ? 'bg-red-500/10 border border-red-500/20 text-red-400' : 'bg-green-500/10 border border-green-500/20 text-green-400'}`}>
                {msg.text}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button type="submit" variant="success" size="lg" disabled={saving}>
                {saving ? 'Saving…' : items.length > 1 ? `Record stock (${items.length} items)` : 'Record stock'}
              </Button>
              {!isDSD && (
                <Button type="button" variant="ghost" size="md" onClick={() => { store.setCurrentReportCategory('dispense'); store.setPendingReportsTab(true); store.setCurrentPage('log') }}>
                  Export summary
                </Button>
              )}
            </div>
          </form>
        </CardBody>
      </Card>

      {editRecord && (
        <EditModal record={{...editRecord, _type:'dispense'}} onClose={()=>setEditRecord(null)} onSave={()=>{setEditRecord(null);loadRecent()}}/>
      )}
      {showLotEditor && commId && (
        <LotEditor facilityId={fid} commodityId={commId} commodityName={selectedComm?.name}
          locationType="dispensary" canEdit={canManage}
          onClose={()=>setShowLotEditor(false)} onSaved={()=>setLotsRefresh(n=>n+1)} />
      )}
      {historyRecord && (
        <EditHistoryModal record={historyRecord} onClose={()=>setHistoryRecord(null)}/>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Dispense records for {historyDate}</CardTitle>
          <div className="flex gap-2">
            <button onClick={()=>setShowDatePicker(!showDatePicker)} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5 transition-colors">History</button>
            {showDatePicker && (
              <input type="date" value={historyDate} onChange={e=>setHistoryDate(e.target.value)} className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500"/>
            )}
            <button onClick={loadRecent} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5 transition-colors">Refresh</button>
          </div>
        </CardHeader>
        {loadingRecent ? <LoadingState /> : recent.length === 0 ? <EmptyState message="No dispense records for this date" /> : (
          <div className="table-wrap">
            <table className="w-full text-sm cards-sm">
              <thead>
                <tr className="border-b border-white/8 bg-white/2">
                  {['Date','Commodity','Qty','By','Actions'].map((h,i) => (
                    <th key={i} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recent.map(r => (
                  <tr key={r.id} className="border-b border-white/5 hover:bg-white/2">
                    <td data-label="Date" className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDate(r.dispensed_at)}</td>
                    <td data-label="Commodity" className="px-4 py-3 font-medium text-gray-100">{r.commodities?.name||'—'}</td>
                    <td data-label="Qty" className="px-4 py-3 font-mono text-sm text-red-400">-{fmtDispenseQty(r.quantity, r.commodities)}</td>
                    <td data-label="By" className="px-4 py-3 text-xs text-gray-500">{r.dispensed_by||'—'}</td>
                    <td data-label="" className="px-4 py-3">
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
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
