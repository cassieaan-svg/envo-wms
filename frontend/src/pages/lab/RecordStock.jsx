import { useState, useEffect, useRef } from 'react'
import { sb } from '../../lib/supabase'
import { useAppStore } from '../../store/appStore'
import { useStock } from '../../hooks/useStock'
import { toast } from '../../components/ui/Toast'
import { Card, CardHeader, CardTitle, CardBody } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { CommoditySelect } from '../../components/ui/CommoditySelect'
import { LoadingState, EmptyState } from '../../components/ui/Loading'
import { EditModal } from '../../components/EditModal'
import { EditHistoryModal } from '../../components/EditHistoryModal'
import { fmtDate, fmtStockQty, fmtDispenseQty, getCommodityPackSize, getCommodityDispenseUnit, todayLagos } from '../../utils/helpers'

export function RecordStock() {
  const store = useAppStore()
  const commoditySection = useAppStore(s => s.commoditySection)
  const sec = q => commoditySection ? q.eq('section', commoditySection) : q
  const { loadStock } = useStock()
  const canManage    = store.canManageStock()
  const facilityRole = useAppStore(s => s.facilityRole)
  const accessLevel  = useAppStore(s => s.accessLevel)
  const sdpName      = useAppStore(s => s.sdpName)
  const dsdSiteName  = useAppStore(s => s.dsdSiteName)
  const isSDP = accessLevel === 'facility' && facilityRole === 'sdp'
  const isDSD = accessLevel === 'facility' && facilityRole === 'dsd'

  const [commId, setCommId]     = useState('')
  const qtyRef                  = useRef(1)
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
  const [sdpStockRow, setSdpStockRow] = useState(null)
  const [dsdStockRow, setDsdStockRow] = useState(null)

  // Regular facility users select which Service Delivery Point the stock was utilized at.
  const [recordSdp, setRecordSdp]     = useState('')   // selected SDP (e.g. 'OPD', or 'CT')
  const [recordSdpCt, setRecordSdpCt] = useState('')   // custom CT name when 'CT' is chosen
  const [recordSdpStockRow, setRecordSdpStockRow] = useState(null)

  const fid = store.currentFacility?.id
  // Resolve the effective SDP name ('CT' becomes 'CT <name>')
  const effectiveSdp = recordSdp === 'CT' ? (recordSdpCt.trim() ? `CT ${recordSdpCt.trim()}` : '') : recordSdp

  useEffect(() => { loadRecent() }, [fid])
  useEffect(() => { if(fid) loadRecent() }, [historyDate])

  // For SDP users: load their stock from sdp_stock when commodity changes
  useEffect(() => {
    if (!isSDP || !fid || !sdpName || !commId) { setSdpStockRow(null); return }
    sb.from('sdp_stock').select('id,quantity')
      .eq('facility_id', fid).eq('sdp_name', sdpName).eq('commodity_id', commId)
      .maybeSingle()
      .then(({ data }) => setSdpStockRow(data || null))
  }, [commId, isSDP, fid, sdpName])

  // For DSD users: load their stock from dsd_stock when commodity changes
  useEffect(() => {
    if (!isDSD || !fid || !dsdSiteName || !commId) { setDsdStockRow(null); return }
    sb.from('dsd_stock').select('id,quantity')
      .eq('facility_id', fid).eq('dsd_site_name', dsdSiteName).eq('commodity_id', commId)
      .maybeSingle()
      .then(({ data }) => setDsdStockRow(data || null))
  }, [commId, isDSD, fid, dsdSiteName])

  // Regular facility users: load stock for the chosen Service Delivery Point
  useEffect(() => {
    if (isSDP || isDSD || !fid || !commId || !effectiveSdp) { setRecordSdpStockRow(null); return }
    sb.from('sdp_stock').select('id,quantity')
      .eq('facility_id', fid).eq('sdp_name', effectiveSdp).eq('commodity_id', commId)
      .maybeSingle()
      .then(({ data }) => setRecordSdpStockRow(data || null))
  }, [commId, effectiveSdp, isSDP, isDSD, fid])

  const selectedComm = store.allCommodities.find(c => c.id === commId)
  const packSize     = getCommodityPackSize(selectedComm)
  const dispUnit     = getCommodityDispenseUnit(selectedComm)
  const stockRow     = isSDP ? sdpStockRow : isDSD ? dsdStockRow : recordSdpStockRow

  async function handleSubmit(e) {
    e?.preventDefault()
    setMsg(null)
    if (!fid)   { setMsg({ type:'error', text:'No facility assigned.' }); return }
    if (!commId){ setMsg({ type:'error', text:'Select a commodity.' }); return }
    const parsedQty = parseInt(qtyRef.current?.value || 0)
    if (parsedQty < 1){ setMsg({ type:'error', text:'Quantity must be at least 1.' }); return }
    if (!by)    { setMsg({ type:'error', text:'Recorded by is required.' }); return }

    if (isSDP) {
      // Validate against sdp_stock
      if (!sdpStockRow || sdpStockRow.quantity === 0) {
        setMsg({ type:'error', text:`No stock available for ${selectedComm?.name || 'commodity'}.` }); return
      }
      if (sdpStockRow.quantity < parsedQty) {
        setMsg({ type:'error', text:`Insufficient stock. Available: ${sdpStockRow.quantity} ${selectedComm?.unit || 'units'}.` }); return
      }
      setSaving(true)
      const { error } = await sb.from('dispense_log').insert({
        facility_id:  fid,
        commodity_id: commId,
        quantity:     parsedQty,
        dispensed_by: by || null,
        dispensed_at: date ? new Date(date + 'T12:00:00').toISOString() : new Date().toISOString(),
        notes:        `[SDP: ${sdpName}]${notes ? ' ' + notes : ''}`,
        section:      commoditySection,
      })
      if (error) { setMsg({ type:'error', text:'Error: '+error.message }); setSaving(false); return }
      // Deduct from sdp_stock
      await sb.from('sdp_stock').update({
        quantity:   Math.max(0, sdpStockRow.quantity - parsedQty),
        updated_at: new Date().toISOString(),
      }).eq('id', sdpStockRow.id)
      setSdpStockRow(prev => prev ? { ...prev, quantity: Math.max(0, prev.quantity - parsedQty) } : null)
      toast('Stock recorded', 'green')
      setMsg({ type:'success', text:'Stock saved successfully.' })
      setCommId(''); if (qtyRef.current) qtyRef.current.value = '1'; setBy(''); setNotes('')
      setDate(todayLagos())
      loadRecent()
      setSaving(false)
      return
    }

    if (isDSD) {
      if (!dsdStockRow || dsdStockRow.quantity === 0) {
        setMsg({ type:'error', text:`No stock available for ${selectedComm?.name || 'commodity'}.` }); return
      }
      if (dsdStockRow.quantity < parsedQty) {
        setMsg({ type:'error', text:`Insufficient stock. Available: ${dsdStockRow.quantity} ${selectedComm?.unit || 'units'}.` }); return
      }
      setSaving(true)
      const { error } = await sb.from('dispense_log').insert({
        facility_id:  fid,
        commodity_id: commId,
        quantity:     parsedQty,
        dispensed_by: by || null,
        dispensed_at: date ? new Date(date + 'T12:00:00').toISOString() : new Date().toISOString(),
        notes:        `[DSD: ${dsdSiteName}]${notes ? ' ' + notes : ''}`,
        section:      commoditySection,
      })
      if (error) { setMsg({ type:'error', text:'Error: '+error.message }); setSaving(false); return }
      await sb.from('dsd_stock').update({
        quantity:   Math.max(0, dsdStockRow.quantity - parsedQty),
        updated_at: new Date().toISOString(),
      }).eq('id', dsdStockRow.id)
      setDsdStockRow(prev => prev ? { ...prev, quantity: Math.max(0, prev.quantity - parsedQty) } : null)
      toast('Stock recorded', 'green')
      setMsg({ type:'success', text:'Stock saved successfully.' })
      setCommId(''); if (qtyRef.current) qtyRef.current.value = '1'; setBy(''); setNotes('')
      setDate(todayLagos())
      loadRecent()
      setSaving(false)
      return
    }

    // Non-SDP / Non-DSD flow — record utilization against a chosen Service Delivery Point
    if (!effectiveSdp) {
      setMsg({ type:'error', text: recordSdp === 'CT' ? 'Enter the CT name.' : 'Select a service delivery point.' }); return
    }
    if (!recordSdpStockRow || recordSdpStockRow.quantity === 0) {
      setMsg({ type:'error', text:`No stock available for ${selectedComm?.name || 'commodity'} at ${effectiveSdp}.` }); return
    }
    if (recordSdpStockRow.quantity < parsedQty) {
      setMsg({ type:'error', text:`Insufficient stock at ${effectiveSdp}. Available: ${recordSdpStockRow.quantity} ${selectedComm?.unit || 'units'}.` }); return
    }

    setSaving(true)
    const { error } = await sb.from('dispense_log').insert({
      facility_id:  fid,
      commodity_id: commId,
      quantity:     parsedQty,
      dispensed_by: by || null,
      dispensed_at: date ? new Date(date + 'T12:00:00').toISOString() : new Date().toISOString(),
      notes:        `[SDP: ${effectiveSdp}]${notes ? ' ' + notes : ''}`,
      section:      commoditySection,
    })
    if (error) { setMsg({ type:'error', text:'Error: '+error.message }); setSaving(false); return }

    await sb.from('sdp_stock').update({
      quantity:   Math.max(0, recordSdpStockRow.quantity - parsedQty),
      updated_at: new Date().toISOString(),
    }).eq('id', recordSdpStockRow.id)
    setRecordSdpStockRow(prev => prev ? { ...prev, quantity: Math.max(0, prev.quantity - parsedQty) } : null)

    toast('Stock recorded', 'green')
    setMsg({ type:'success', text:`Stock saved successfully for ${effectiveSdp}.` })
    setCommId(''); if (qtyRef.current) qtyRef.current.value = '1'; setBy(''); setNotes('')
    setDate(todayLagos())
    await loadStock()
    loadRecent()
    setSaving(false)
  }

  async function loadRecent() {
    setLoadingRecent(true)
    const d = historyDate
    let q = sb.from('dispense_log')
      .select('*,commodities(name,unit,dispensing_unit,pack_size)')
      .eq('facility_id', fid)
      .gte('dispensed_at', `${d}T00:00:00`)
      .lte('dispensed_at', `${d}T23:59:59`)
      .order('dispensed_at', { ascending: false })
    q = sec(q)
    const { data } = await q
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

  const stockQty = isSDP ? sdpStockRow?.quantity : isDSD ? dsdStockRow?.quantity : recordSdpStockRow?.quantity

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-medium text-gray-100">Record Stock Utilized</h1>
        <p className="text-sm text-gray-500 mt-1">
          {isSDP ? `Record stock utilized at ${sdpName}` : isDSD ? `Record stock utilized at ${dsdSiteName}` : 'Record daily commodity stock utilized at this facility'}
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle>Stock details</CardTitle></CardHeader>
        <CardBody>
          <form onSubmit={handleSubmit} className="space-y-4">
            {!isSDP && !isDSD && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Service Delivery Point *</label>
                  <select value={recordSdp} onChange={e => { setRecordSdp(e.target.value); setRecordSdpCt('') }}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500">
                    <option value="">Select service delivery point…</option>
                    {['OPD','ANC','Labour Ward',"Children's Ward",'Immunization','TB Dot','Male Ward','Female Ward','A & E','Family Planning','CT'].map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
                {recordSdp === 'CT' && (
                  <div>
                    <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">CT Name *</label>
                    <input type="text" value={recordSdpCt} onChange={e => setRecordSdpCt(e.target.value)} placeholder="Enter CT name"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
                  </div>
                )}
              </div>
            )}
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
                <input type="number" min="1" defaultValue={1} ref={qtyRef}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
              </div>
            </div>

            {/* Stock preview */}
            {commId && (isSDP || isDSD || effectiveSdp) && (
              <div className={`rounded-lg px-4 py-3 text-sm border ${
                stockQty == null ? 'bg-red-500/10 border-red-500/20 text-red-400' :
                stockQty === 0   ? 'bg-red-500/10 border-red-500/20 text-red-400' :
                'bg-white/5 border-white/10 text-gray-300'
              }`}>
                {stockQty == null ? `⚠ No stock record${!isSDP && !isDSD ? ` at ${effectiveSdp}` : ''} — request from store` :
                 (isSDP || isDSD) ? `Stock on hand: ${stockQty} ${selectedComm?.unit || 'units'}` :
                 `Stock on hand at ${effectiveSdp}: ${stockQty} ${selectedComm?.unit || 'units'}`}
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

            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button type="submit" variant="success" size="lg" disabled={saving}>
                {saving ? 'Saving…' : 'Record stock'}
              </Button>
              {!isSDP && !isDSD && (
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
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/8 bg-white/2">
                  {['Date','Commodity','Service Delivery Point','Qty','By','Actions'].map((h,i) => (
                    <th key={i} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recent.map(r => {
                  const sdpMatch = r.notes?.match(/\[SDP:\s*([^\]]+)\]/)
                  return (
                  <tr key={r.id} className="border-b border-white/5 hover:bg-white/2">
                    <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDate(r.dispensed_at)}</td>
                    <td className="px-4 py-3 font-medium text-gray-100">{r.commodities?.name||'—'}</td>
                    <td className="px-4 py-3 text-xs text-gray-400">{sdpMatch ? sdpMatch[1].trim() : '—'}</td>
                    <td className="px-4 py-3 font-mono text-sm text-red-400">-{fmtDispenseQty(r.quantity, r.commodities)}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">{r.dispensed_by||'—'}</td>
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
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
