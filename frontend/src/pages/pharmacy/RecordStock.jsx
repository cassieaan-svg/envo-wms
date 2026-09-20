import { useState, useEffect, useRef } from 'react'
import { api } from '../../lib/api'
import { offlineDispense } from '../../lib/offlineWrite'
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
import { fmtDate, fmtStockQty, fmtDispenseQty, getCommodityPackSize, getCommodityDispenseUnit, pluralizeUnit, todayLagos, entryTimestamp, naira, essentialCommodities } from '../../utils/helpers'

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
  // Batches built up inline for the commodity currently in the picker, before it's
  // committed to the staged list. The transfers-style flow: pick a commodity once,
  // add several batches under it, then add the whole commodity in one go.
  const [pendingBatches, setPendingBatches] = useState([])
  // The bin's raw lots, so we can prompt when any has no expiry recorded.
  const [binLots, setBinLots] = useState([])
  const [lotsRefresh, setLotsRefresh] = useState(0)
  const [showLotEditor, setShowLotEditor] = useState(false)
  const qtyRef                  = useRef(1)
  // Live preview only — the server independently snapshots the price at write time
  // (LogService.recordDispense), so this is never trusted as the figure that gets
  // recorded. It just lets the person recording the consumption see the total as
  // they type, the way a till does.
  const [liveQty, setLiveQty]   = useState(1)
  const batchBoxRef             = useRef(null)   // wraps the batch dropdown, for the "+ Add batch" cue
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

  // A different commodity means the inline batches no longer apply — start fresh.
  // (pickerBatch is left to BatchSelect, which remounts per commodity.) Editing a
  // staged commodity sets commId AND pendingBatches together in the same render,
  // so it flips this ref to skip the reset just that once.
  const skipBatchResetRef = useRef(false)
  useEffect(() => {
    if (skipBatchResetRef.current) { skipBatchResetRef.current = false; return }
    setPendingBatches([])
  }, [commId])

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

  // Picking a batch adds it straight to the inline list — no separate "add batch"
  // step. The quantity box is the TOTAL still to consume: the batch takes what it can
  // (up to what it holds), the remainder stays in the box for the next batch, and the
  // dropdown resets so you can pick again. Selecting "Select batch" (FEFO) clears.
  function handleSelectBatch(opt) {
    setMsg(null)
    if (!opt) { setPickerBatch(null); return }
    if (pendingBatches.some(b => b.batch.key === opt.key)) {
      setMsg({ type:'error', text:`Batch ${opt.batch_number || '(no batch)'} is already added — remove it below to change its quantity.` }); return
    }
    if (opt.expired) { setPickerBatch(opt); return }   // let the expired warning show
    const qty = parseInt(qtyRef.current?.value || 0)
    if (isNaN(qty) || qty <= 0) { setPickerBatch(opt); setMsg({ type:'error', text:'Enter the quantity to consume first.' }); return }
    const take = Math.min(qty, opt.remaining)
    setPendingBatches(prev => [...prev, { key: opt.key, batch: opt, quantity: take }])
    setPickerBatch(null)
    const leftover = qty - take
    if (qtyRef.current) qtyRef.current.value = String(leftover)   // leftover to allocate
    setLiveQty(leftover)
  }

  function removePendingBatch(key) {
    // Give the removed batch's quantity back to the box, so it can be re-allocated.
    const removed = pendingBatches.find(b => b.key === key)
    if (removed && qtyRef.current) {
      const restored = (parseInt(qtyRef.current.value || 0) || 0) + removed.quantity
      qtyRef.current.value = String(restored)
      setLiveQty(restored)
    }
    setPendingBatches(prev => prev.filter(b => b.key !== key))
  }

  // Commit the commodity in the picker to the staged list. Gathers the batches added
  // inline (plus the one still selected, if any) into one grouped entry; with no
  // specific batch it stages a single automatic (FEFO) line, as before.
  async function addItem() {
    setMsg(null)
    if (!fid)   { setMsg({ type:'error', text:'No facility assigned.' }); return }
    if (!commId){ setMsg({ type:'error', text:'Select a commodity.' }); return }
    const comm = store.allCommodities.find(c => c.id === commId)
    if (items.some(i => i.commodityId === commId)) {
      setMsg({ type:'error', text:`${comm?.name} is already in the list below — remove it there to change its batches.` }); return
    }

    // Batches for this commodity: the inline list, plus the current selection if one
    // is picked with a quantity and not already in the list.
    const batches = [...pendingBatches]
    const curQty = parseInt(qtyRef.current?.value || 0)
    if (pickerBatch && curQty > 0 && !batches.some(b => b.batch.key === pickerBatch.key)) {
      if (pickerBatch.expired) { setMsg({ type:'error', text:'The selected batch is expired — remove it before recording.' }); return }
      if (curQty > pickerBatch.remaining) { setMsg({ type:'error', text:`Only ${pickerBatch.remaining} left in batch ${pickerBatch.batch_number || '(no batch)'} — use “+ Add batch” to take it, then add another batch for the rest.` }); return }
      batches.push({ key: pickerBatch.key, batch: pickerBatch, quantity: curQty })
    }

    if (batches.length && !isDSD) {
      // Specific-batch path: one staged line per batch, grouped under the commodity.
      const avail = await resolveStock(commId)
      const total = batches.reduce((s, b) => s + b.quantity, 0)
      if (avail == null || avail === 0) { setMsg({ type:'error', text:`No stock for ${comm?.name || 'commodity'}.` }); return }
      if (avail < total) { setMsg({ type:'error', text:`Insufficient stock for ${comm?.name}. Available: ${avail} ${comm?.unit || 'units'}.` }); return }
      setItems(prev => [...prev, ...batches.map(b => ({
        key: `${commId}|${b.batch.key}`, commodityId: commId, quantity: b.quantity, comm, avail, batch: b.batch,
      }))])
      setCommId(''); setPickerBatch(null); setPendingBatches([])
      if (qtyRef.current) qtyRef.current.value = '1'
      setLiveQty(1)
      return
    }

    // No specific batch — automatic (FEFO) / DSD / zero-consumption single line.
    const qty = curQty
    if (isNaN(qty) || qty < 0){ setMsg({ type:'error', text:'Quantity cannot be negative.' }); return }
    const avail = await resolveStock(commId)
    if (qty > 0) {
      if (avail == null || avail === 0) { setMsg({ type:'error', text:`No stock for ${comm?.name || 'commodity'}.` }); return }
      if (avail < qty) { setMsg({ type:'error', text:`Insufficient stock for ${comm?.name}. Available: ${avail} ${comm?.unit || 'units'}.` }); return }
    }
    setItems(prev => [...prev, { key: `${commId}|fefo`, commodityId: commId, quantity: qty, comm, avail, batch: null }])
    setCommId(''); setPickerBatch(null); setPendingBatches([])
    if (qtyRef.current) qtyRef.current.value = '1'
    setLiveQty(1)
  }

  function removeItem(key) {
    setItems(prev => prev.filter(i => i.key !== key))
  }

  function removeCommodity(commodityId) {
    setItems(prev => prev.filter(i => i.commodityId !== commodityId))
  }

  // Pull a staged commodity back into the picker so its quantity/batches can be
  // changed, instead of removing it and re-entering everything from scratch.
  function editCommodity(commodityId) {
    const lines = items.filter(i => i.commodityId === commodityId)
    if (!lines.length) return
    const batched = lines.some(l => l.batch)
    skipBatchResetRef.current = true
    setCommId(commodityId)
    if (batched) {
      setPendingBatches(lines.map(l => ({ key: l.batch.key, batch: l.batch, quantity: l.quantity })))
      if (qtyRef.current) qtyRef.current.value = '0'
      setLiveQty(0)
    } else {
      const qty = lines.reduce((s, l) => s + l.quantity, 0)
      setPendingBatches([])
      if (qtyRef.current) qtyRef.current.value = String(qty)
      setLiveQty(qty)
    }
    removeCommodity(commodityId)
  }

  async function handleSubmit(e) {
    e?.preventDefault()
    setMsg(null)
    if (!fid)   { setMsg({ type:'error', text:'No facility assigned.' }); return }
    if (!by)    { setMsg({ type:'error', text:'Recorded by is required.' }); return }
    if (date && date > todayLagos()) { setMsg({ type:'error', text:'Date cannot be in the future.' }); return }

    // Record the staged list; if nothing was staged, fall back to the current picker
    // selection — including any batches added inline but not yet committed.
    let batch = items
    if (batch.length === 0) {
      if (!commId){ setMsg({ type:'error', text:'Add at least one commodity.' }); return }
      const comm  = store.allCommodities.find(c => c.id === commId)
      const avail = await resolveStock(commId)

      // Gather inline batches plus the current selection, as "+ Add commodity" would.
      const curQty = parseInt(qtyRef.current?.value || 0)
      const batches = [...pendingBatches]
      if (pickerBatch && curQty > 0 && !batches.some(b => b.batch.key === pickerBatch.key)) {
        batches.push({ key: pickerBatch.key, batch: pickerBatch, quantity: curQty })
      }
      if (batches.length && !isDSD) {
        const total = batches.reduce((s, b) => s + b.quantity, 0)
        if (avail == null || avail === 0) { setMsg({ type:'error', text:`No stock for ${comm?.name || 'commodity'}.` }); return }
        if (avail < total) { setMsg({ type:'error', text:`Insufficient stock for ${comm?.name}. Available: ${avail} ${comm?.unit || 'units'}.` }); return }
        if (batches.some(b => b.batch.expired)) { setMsg({ type:'error', text:'A selected batch is expired — remove it before recording.' }); return }
        batch = batches.map(b => ({ commodityId: commId, quantity: b.quantity, comm, avail, batch: b.batch }))
      } else {
        // Automatic (FEFO) / DSD / zero-consumption single line.
        const qty = curQty
        if (isNaN(qty) || qty < 0){ setMsg({ type:'error', text:'Quantity cannot be negative.' }); return }
        if (qty > 0) {
          if (avail == null || avail === 0) {
            setMsg({ type:'error', text:`No stock for ${comm?.name || 'commodity'}.` }); return
          }
          if (avail < qty) {
            setMsg({ type:'error', text:`Insufficient stock for ${comm?.name}. Available: ${avail} ${comm?.unit || 'units'}.` }); return
          }
        }
        batch = [{ commodityId: commId, quantity: qty, comm, avail, batch: null }]
      }
    }

    setSaving(true)
    // One call per commodity — each becomes its own dispense record for the day.
    // offlineDispense is a no-op passthrough outside the Essential module (see
    // lib/offlineWrite.js) — HIV's behaviour here is unchanged.
    let anyQueued = false
    for (const item of batch) {
      try {
        const result = await offlineDispense({
          facility_id:   fid,
          commodity_id:  item.commodityId,
          quantity:      item.quantity,
          dispensed_by:  by || null,
          dispensed_at:  entryTimestamp(date),
          ...(isDSD
            ? { notes: `[DSD: ${dsdSiteName}]${notes ? ' ' + notes : ''}`, dsd_site_name: dsdSiteName }
            : { notes: notes || null, location_type: 'dispensary',
                // A picked lot sends its batch, using '' for the "(no batch)" lot so the
                // server debits THAT lot. `|| undefined` dropped the field entirely, so the
                // server fell back to FEFO and could retire a different batch than the one
                // actually taken off the shelf.
                batch_number: item.batch ? (item.batch.batch_number || '') : undefined,
                expiry_date:  item.batch?.expiry_date  || undefined }),
          section:       commoditySection,
        })
        if (result?.queued) anyQueued = true
      } catch (error) { setMsg({ type:'error', text:'Error: '+error.message }); setSaving(false); return }
    }

    if (anyQueued) {
      toast(`Recorded — ${batch.length} item(s), waiting to sync`, 'amber')
      setMsg({ type:'success', text:`Saved on this device — ${batch.length} record(s). No connection right now; it will sync automatically.` })
    } else {
      toast(`Stock recorded — ${batch.length} item(s)`, 'green')
      setMsg({ type:'success', text:`Stock saved successfully — ${batch.length} record(s).` })
    }
    setItems([]); setCommId(''); setPickerBatch(null); setPendingBatches([]); if (qtyRef.current) qtyRef.current.value = '1'; setLiveQty(1); setBy(''); setNotes('')
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
    ? essentialCommodities(store.allCommodities, id => stockedIds.has(id))
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
                  onChange={e => setLiveQty(parseInt(e.target.value) || 0)}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
              </div>
            </div>

            {/* Unit price × quantity = total sold, live as the quantity changes. Only
                shows for a priced commodity — most of HIV carries no catalogue price,
                and there's nothing to preview for those. Display only: the server
                independently snapshots the price it actually charges at write time. */}
            {commId && selectedComm?.unit_price != null && (
              <div className="rounded-lg px-4 py-3 text-sm border border-white/10 bg-white/3 flex items-center justify-between gap-3">
                <span className="text-gray-400">
                  Unit price <span className="text-gray-200 font-medium">{naira(selectedComm.unit_price)}</span>
                  {selectedComm.unit ? ` / ${selectedComm.unit}` : ''}
                </span>
                <span className="text-gray-400">
                  Total <span className="text-gray-100 font-semibold">
                    {naira(selectedComm.unit_price * ((liveQty || 0) + pendingBatches.reduce((s, b) => s + b.quantity, 0)))}
                  </span>
                </span>
              </div>
            )}

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
                <div ref={batchBoxRef}>
                  <BatchSelect key={commId} facilityId={fid} commodityId={commId} locationType="dispensary"
                    value={pickerBatch?.key} onSelect={handleSelectBatch}
                    onLotsLoaded={setBinLots} refreshToken={lotsRefresh} />
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <button type="button" onClick={() => batchBoxRef.current?.querySelector('select')?.focus()}
                    className="text-xs font-medium text-blue-400 hover:text-blue-300">+ Add batch</button>
                  <span className="text-xs text-gray-500">pick a batch to add it — pick another to split across batches</span>
                </div>
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
                {/* Batches built up inline for this commodity — like the transfers
                    screen, you add several batches under one commodity before adding
                    the whole commodity to the list below. */}
                {pendingBatches.length > 0 && (
                  <div className="mt-3 rounded-lg border border-white/10 divide-y divide-white/5">
                    <div className="px-3 py-1.5 text-xs text-gray-500 uppercase tracking-widest">
                      Batches for {selectedComm?.name}
                    </div>
                    {pendingBatches.map(b => (
                      <div key={b.key} className="flex items-center justify-between px-3 py-2 gap-3">
                        <div className="text-xs text-gray-300">
                          {b.quantity} {pluralizeUnit(b.quantity, selectedComm?.unit || 'units')}
                          <span className="text-gray-500"> · batch {b.batch.batch_number || '(no batch)'}{b.batch.expiry_date ? ` · exp ${fmtDate(b.batch.expiry_date)}` : ''}</span>
                        </div>
                        <button type="button" onClick={() => removePendingBatch(b.key)}
                          className="text-xs text-gray-500 hover:text-red-400 border border-white/10 rounded px-2 py-0.5 transition-colors shrink-0">Remove</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Batches are added by picking them above; this commits the commodity
                (with its batches, or automatic FEFO when none was picked). */}
            <div className="flex justify-end">
              <Button type="button" variant="default" size="md" onClick={addItem}>
                + Add commodity
              </Button>
            </div>

            {/* Staged commodities to record together. Batch lines are grouped under
                their commodity, so a commodity split across batches shows once. */}
            {items.length > 0 && (() => {
              const groups = []
              items.forEach(it => {
                let g = groups.find(x => x.commodityId === it.commodityId)
                if (!g) { g = { commodityId: it.commodityId, comm: it.comm, lines: [] }; groups.push(g) }
                g.lines.push(it)
              })
              const grandTotal = items.reduce((s, it) => s + (it.comm?.unit_price != null ? it.comm.unit_price * it.quantity : 0), 0)
              const anyPriced = items.some(it => it.comm?.unit_price != null)
              return (
                <div className="rounded-lg border border-white/10 divide-y divide-white/5">
                  <div className="px-4 py-2 flex items-center justify-between gap-3">
                    <span className="text-xs text-gray-500 uppercase tracking-widest">
                      {groups.length} commodit{groups.length === 1 ? 'y' : 'ies'} to record
                    </span>
                    {anyPriced && (
                      <span className="text-xs text-gray-400">
                        Total <span className="text-gray-100 font-semibold">{naira(grandTotal)}</span>
                      </span>
                    )}
                  </div>
                  {groups.map(g => {
                    const packSize = getCommodityPackSize(g.comm)
                    const dispUnit = getCommodityDispenseUnit(g.comm)
                    const total = g.lines.reduce((s, l) => s + l.quantity, 0)
                    const batched = g.lines.some(l => l.batch)
                    return (
                      <div key={g.commodityId} className="px-4 py-2.5">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-gray-100 truncate">{g.comm?.name || '—'}</div>
                            <div className="text-xs text-gray-500">
                              {total} {pluralizeUnit(total, g.comm?.unit || dispUnit)}
                              {packSize ? ` = ${(total * packSize).toLocaleString()} ${dispUnit}` : ''}
                              {batched ? ` · ${g.lines.length} batch${g.lines.length === 1 ? '' : 'es'}` : ''}
                              {g.comm?.unit_price != null ? ` · ${naira(g.comm.unit_price * total)}` : ''}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <button type="button" onClick={() => editCommodity(g.commodityId)}
                              className="text-xs text-gray-500 hover:text-blue-400 border border-white/10 rounded px-2 py-1 transition-colors">
                              Edit
                            </button>
                            <button type="button" onClick={() => removeCommodity(g.commodityId)}
                              className="text-xs text-gray-500 hover:text-red-400 border border-white/10 rounded px-2 py-1 transition-colors">
                              Remove
                            </button>
                          </div>
                        </div>
                        {batched && (
                          <div className="mt-1.5 pl-3 border-l border-white/10 space-y-1">
                            {g.lines.map(l => (
                              <div key={l.key} className="flex items-center justify-between gap-2 text-xs text-gray-500">
                                <span>batch {l.batch?.batch_number || '(no batch)'}{l.batch?.expiry_date ? ` · exp ${fmtDate(l.batch.expiry_date)}` : ''} — {l.quantity}</span>
                                {g.lines.length > 1 && (
                                  <button type="button" onClick={() => removeItem(l.key)}
                                    className="text-gray-600 hover:text-red-400 shrink-0">✕</button>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            })()}

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
                {saving ? 'Saving…' : (() => { const n = new Set(items.map(i => i.commodityId)).size; return n > 1 ? `Record stock (${n} items)` : 'Record stock' })()}
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
