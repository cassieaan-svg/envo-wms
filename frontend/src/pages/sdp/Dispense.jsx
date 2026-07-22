import { useState, useEffect } from 'react'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/appStore'
import { useStock } from '../../hooks/useStock'
import { toast } from '../../components/ui/Toast'
import { Card, CardHeader, CardTitle, CardBody } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { CommoditySelect } from '../../components/ui/CommoditySelect'
import { LoadingState, EmptyState } from '../../components/ui/Loading'
import { EditModal } from '../../components/EditModal'
import { fmtDate, fmtStockQty, fmtDispenseQty, getCommodityPackSize, getCommodityDispenseUnit, pluralizeUnit, todayLagos } from '../../utils/helpers'

export function Dispense() {
  const store = useAppStore()
  const { loadStock } = useStock()
  const canManage    = store.canManageStock()
  const sdpName      = useAppStore(s => s.sdpName)

  const [commId, setCommId]     = useState('')
  const [qty, setQty]           = useState(1)
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
  const [sdpStockRow, setSdpStockRow] = useState(null)

  const fid = store.currentFacility?.id

  useEffect(() => { loadRecent() }, [fid])
  useEffect(() => { if(fid) loadRecent() }, [historyDate])

  useEffect(() => {
    if (!fid || !sdpName || !commId) { setSdpStockRow(null); return }
    api.stock.sdp.list({ facility_id: fid, sdp_name: sdpName, commodity_id: commId })
      .then(rows => setSdpStockRow((rows && rows[0]) || null))
      .catch(() => setSdpStockRow(null))
  }, [commId, fid, sdpName])

  const selectedComm = store.allCommodities.find(c => c.id === commId)
  const packSize     = getCommodityPackSize(selectedComm)
  const dispUnit     = getCommodityDispenseUnit(selectedComm)
  const stockRow     = sdpStockRow

  // Current stock-on-hand for a commodity at this SDP. Null when no record.
  async function resolveStock(commodityId) {
    const rows = await api.stock.sdp.list({ facility_id: fid, sdp_name: sdpName, commodity_id: commodityId }).catch(() => [])
    return rows && rows[0] ? rows[0].quantity : null
  }

  // Validate the current commodity + quantity and stage it for recording.
  async function addItem() {
    setMsg(null)
    if (!fid)   { setMsg({ type:'error', text:'No facility assigned.' }); return }
    if (!commId){ setMsg({ type:'error', text:'Select a commodity.' }); return }
    const parsedQty = parseInt(qty)
    if (!parsedQty || parsedQty < 1){ setMsg({ type:'error', text:'Quantity must be at least 1.' }); return }
    const comm = store.allCommodities.find(c => c.id === commId)
    if (items.some(i => i.commodityId === commId)) {
      setMsg({ type:'error', text:`${comm?.name || 'Commodity'} is already in the list — remove it first to change the quantity.` }); return
    }
    const avail = await resolveStock(commId)
    if (avail == null || avail === 0) {
      setMsg({ type:'error', text:`No stock available for ${comm?.name || 'commodity'}.` }); return
    }
    if (avail < parsedQty) {
      setMsg({ type:'error', text:`Insufficient stock for ${comm?.name}. Available: ${avail} ${comm?.unit || 'units'}.` }); return
    }
    setItems(prev => [...prev, { commodityId: commId, quantity: parsedQty, comm, avail }])
    setCommId(''); setQty(1)
  }

  function removeItem(commodityId) {
    setItems(prev => prev.filter(i => i.commodityId !== commodityId))
  }

  async function handleSubmit(e) {
    e?.preventDefault()
    setMsg(null)
    if (!fid)   { setMsg({ type:'error', text:'No facility assigned.' }); return }
    if (!by)    { setMsg({ type:'error', text:'Recorded by is required.' }); return }

    // Record the staged list; if nothing was staged, fall back to the current picker selection.
    let batch = items
    if (batch.length === 0) {
      if (!commId){ setMsg({ type:'error', text:'Add at least one commodity.' }); return }
      const parsedQty = parseInt(qty)
      if (!parsedQty || parsedQty < 1){ setMsg({ type:'error', text:'Quantity must be at least 1.' }); return }
      const comm  = store.allCommodities.find(c => c.id === commId)
      const avail = await resolveStock(commId)
      if (avail == null || avail === 0) {
        setMsg({ type:'error', text:`No stock available for ${comm?.name || 'commodity'}.` }); return
      }
      if (avail < parsedQty) {
        setMsg({ type:'error', text:`Insufficient stock for ${comm?.name}. Available: ${avail} ${comm?.unit || 'units'}.` }); return
      }
      batch = [{ commodityId: commId, quantity: parsedQty, comm, avail }]
    }

    setSaving(true)
    // One call per commodity — each logs its own dispense record AND decrements
    // the SDP site stock (server-side).
    for (const item of batch) {
      try {
        await api.dispense.record({
          facility_id:  fid,
          commodity_id: item.commodityId,
          quantity:     item.quantity,
          dispensed_by: by || null,
          dispensed_at: date ? new Date(date).toISOString() : new Date().toISOString(),
          notes:        `[SDP: ${sdpName}]${notes ? ' ' + notes : ''}`,
          sdp_name:     sdpName,
          section:      store.commoditySection,
        })
      } catch (error) { setMsg({ type:'error', text:'Error: '+error.message }); setSaving(false); return }
    }
    setSdpStockRow(null)
    toast(`Stock recorded — ${batch.length} item(s)`, 'green')
    setMsg({ type:'success', text:`Stock saved successfully — ${batch.length} record(s).` })
    setItems([]); setCommId(''); setQty(1); setBy(''); setNotes('')
    setDate(todayLagos())
    loadRecent()
    setSaving(false)
  }

  async function loadRecent() {
    setLoadingRecent(true)
    const d = historyDate
    const data = await api.dispense.history({
      facility_id: fid, date: d, sdp_name: sdpName,
    }).catch(() => [])
    setRecent(data || [])
    setLoadingRecent(false)
  }

  const categories = {}
  store.allCommodities.forEach(c => {
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
        <p className="text-sm text-gray-500 mt-1">Record stock consumed at {sdpName}</p>
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
                <input type="number" min="1" value={qty} onChange={e => setQty(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
              </div>
            </div>

            {commId && (
              <div className={`rounded-lg px-4 py-3 text-sm border ${
                !stockRow ? 'bg-red-500/10 border-red-500/20 text-red-400' :
                stockRow.quantity === 0 ? 'bg-red-500/10 border-red-500/20 text-red-400' :
                'bg-white/5 border-white/10 text-gray-300'
              }`}>
                {!stockRow ? '⚠ No stock record — request from store' :
                 `Stock on hand: ${stockRow.quantity} ${selectedComm?.unit || 'units'}`}
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
                  const itPack = getCommodityPackSize(it.comm)
                  const itUnit = getCommodityDispenseUnit(it.comm)
                  return (
                    <div key={it.commodityId} className="flex items-center justify-between px-4 py-2.5 gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-gray-100 truncate">{it.comm?.name || '—'}</div>
                        <div className="text-xs text-gray-500">
                          {it.quantity} {pluralizeUnit(it.quantity, it.comm?.unit || itUnit)}
                          {itPack ? ` = ${(it.quantity * itPack).toLocaleString()} ${itUnit}` : ''}
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
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Recorded by</label>
                <input type="text" value={by} onChange={e => setBy(e.target.value)} placeholder="Staff name or ID"
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Date</label>
                <input type="date" value={date} onChange={e => setDate(e.target.value)}
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

            <Button type="submit" variant="success" size="lg" disabled={saving} className="w-full">
              {saving ? 'Saving…' : items.length > 1 ? `Record stock (${items.length} items)` : 'Record stock'}
            </Button>
          </form>
        </CardBody>
      </Card>

      {editRecord && (
        <EditModal record={{...editRecord, _type:'dispense'}} onClose={()=>setEditRecord(null)} onSave={()=>{setEditRecord(null);loadRecent()}}/>
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
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/8 bg-white/2">
                  {['Date','Commodity','Qty','By',...(canManage?['']:[''])].map((h,i) => (
                    <th key={i} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                  ))}
                  {canManage && <th className="px-4 py-3"/>}
                </tr>
              </thead>
              <tbody>
                {recent.map(r => (
                  <tr key={r.id} className="border-b border-white/5 hover:bg-white/2">
                    <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDate(r.dispensed_at)}</td>
                    <td className="px-4 py-3 font-medium text-gray-100">{r.commodities?.name||'—'}</td>
                    <td className="px-4 py-3 font-mono text-sm text-red-400">-{fmtDispenseQty(r.quantity, r.commodities)}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">{r.dispensed_by||'—'}</td>
                    {canManage && (
                      <td className="px-4 py-3">
                        <button onClick={()=>setEditRecord(r)} className="text-xs text-blue-400 border border-blue-500/30 rounded px-2 py-1 hover:bg-blue-500/10 transition-colors">
                          Edit
                        </button>
                      </td>
                    )}
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
