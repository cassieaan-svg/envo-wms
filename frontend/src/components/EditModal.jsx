import { useState } from 'react'
import { api } from '../lib/api'
import { useAppStore } from '../store/appStore'
import { useStock } from '../hooks/useStock'
import { toast } from './ui/Toast'

export function EditModal({ record, onClose, onSave }) {
  const store = useAppStore()
  const { loadStock } = useStock()
  const normalizedSupplier = record.supplier_source === 'GHSC' ? 'GHSC-PSM' : (record.supplier_source || '')
  const knownSuppliers = ['GHSC-PSM']
  const [qty, setQty]           = useState(record.quantity)
  const [date, setDate]         = useState(record.dispensed_at?.slice(0,10)||record.received_at?.slice(0,10)||record.adjusted_at?.slice(0,10)||'')
  const [notes, setNotes]       = useState(record.notes||'')
  const [expiry, setExpiry]     = useState(record.expiry_date||'')
  const [batch, setBatch]       = useState(record.batch_number||'')
  const [supplier, setSupplier] = useState(knownSuppliers.includes(normalizedSupplier) ? normalizedSupplier : (normalizedSupplier ? 'Other' : ''))
  const [supplierOther, setSupplierOther] = useState(knownSuppliers.includes(normalizedSupplier) ? '' : normalizedSupplier)
  const [condition, setCondition]= useState(record.condition_on_arrival||'Good')
  const [reason, setReason]     = useState(record.reason||'')
  const [editedBy, setEditedBy] = useState(record.edited_by || store.user?.email || '')
  const [saving, setSaving]     = useState(false)
  const [err, setErr]           = useState('')

  const fid = store.currentFacility?.id

  // Stock is NOT adjusted here. The server moves it inside the same transaction that
  // updates the log row (LogService.updateLog), so the record and the stock can never
  // disagree. Writing it from here — a second, separate request that set the stock
  // figure directly — is what put stock and records out of step and produced opening
  // balances on bins that had reconciled the day before. It also always targeted the
  // STORE, so editing a dispensary, SDP or DSD record moved the wrong bin.

  async function save() {
    if (qty < 1) { setErr('Quantity must be at least 1.'); return }
    if (!editedBy) { setErr('Edited by is required.'); return }
    setSaving(true)

    const newQty = parseInt(qty)
    const oldQty = record.quantity
    let table = '', updateData = {}

    if (record._type === 'dispense') {
      table = 'dispense_log'
      updateData = { quantity:newQty, dispensed_at:date?new Date(date).toISOString():record.dispensed_at, notes:notes||null, edited_by:editedBy||null }
    } else if (record._type === 'intake') {
      const supplierSource = supplier === 'Other' ? supplierOther.trim() : supplier
      if (!supplierSource) { setErr('Supplier is required.'); setSaving(false); return }
      table = 'intake_log'
      updateData = { quantity:newQty, batch_number:batch.trim()||null, expiry_date:expiry||null, supplier_source:supplierSource||null, condition_on_arrival:condition, edited_by:editedBy||null }
    } else {
      table = 'stock_adjustment_log'
      updateData = { quantity:newQty, reason, notes:notes||null, batch_number:batch.trim()||null, expiry_date:expiry||null, edited_by:editedBy||null }
    }

    const apiByType = { dispense: api.dispense, intake: api.intake, adjustment: api.adjustments }
    try {
      await apiByType[record._type].update(record.id, updateData)
    } catch (e) { setErr('Error: '+e.message); setSaving(false); return }

    // Record the change in the audit trail (best-effort — won't block the save).
    const noteForTrail = record._type === 'adjustment' ? reason : notes
    try {
      await api.editHistory.create({
        record_id:     record.id,
        record_type:   record._type,
        facility_id:   fid,
        commodity_id:  record.commodity_id,
        old_quantity:  oldQty,
        new_quantity:  newQty,
        quantity_diff: newQty - oldQty,
        edited_by:     editedBy || null,
        note:          noteForTrail || null,
      })
    } catch { /* audit insert is best-effort — ignore */ }

    toast('Record updated','green')
    await loadStock()
    setSaving(false)
    onSave()
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-white/10 rounded-2xl p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-medium text-gray-100">Edit {record._type} record</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Commodity</label>
            <input disabled value={record.commodities?.name||'—'} className="w-full bg-white/3 border border-white/8 rounded-lg px-3 py-2 text-sm text-gray-500"/>
          </div>
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Quantity</label>
            <input type="number" min="1" value={qty} onChange={e=>setQty(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"/>
          </div>
          {record._type==='dispense' && <>
            <div>
              <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Date</label>
              <input type="date" value={date} onChange={e=>setDate(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"/>
            </div>
            <div>
              <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Notes</label>
              <input type="text" value={notes} onChange={e=>setNotes(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"/>
            </div>
          </>}
          {record._type==='intake' && <>
            <div>
              <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Batch / lot number</label>
              <input type="text" value={batch} onChange={e=>setBatch(e.target.value)} placeholder="e.g. LOT2024A001" className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"/>
            </div>
            <div>
              <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Expiry date</label>
              <input type="date" value={expiry} onChange={e=>setExpiry(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"/>
            </div>
            <div>
              <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Supplier</label>
              <select value={supplier} onChange={e=>setSupplier(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500">
                <option value="">Select supplier…</option>
                <option>GHSC-PSM</option><option>Other</option>
              </select>
              {supplier === 'Other' && (
                <div className="mt-3">
                  <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Specify supplier</label>
                  <input type="text" value={supplierOther} onChange={e=>setSupplierOther(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
                </div>
              )}
            </div>
            <div>
              <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Condition on arrival</label>
              <select value={condition} onChange={e=>setCondition(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500">
                <option>Good</option><option>Damaged</option><option>Expired</option>
              </select>
            </div>
          </>}
          {record._type==='adjustment' && <>
            <div>
              <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Reason</label>
              <select value={reason} onChange={e=>setReason(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500">
                <option>Expired</option><option>Damaged</option><option>Lost / Stolen</option>
                <option>Physical count correction</option><option>Returned to store</option><option>Other</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Batch / lot number</label>
              <input type="text" value={batch} onChange={e=>setBatch(e.target.value)} placeholder="e.g. LOT2024A001" className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"/>
            </div>
            <div>
              <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Expiry date</label>
              <input type="date" value={expiry} onChange={e=>setExpiry(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"/>
            </div>
            <div>
              <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Notes</label>
              <input type="text" value={notes} onChange={e=>setNotes(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"/>
            </div>
          </>}
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Edited by *</label>
            <input type="text" value={editedBy} onChange={e=>setEditedBy(e.target.value)} placeholder="Your name or email" required className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"/>
          </div>
          {err && <div className="text-sm text-red-400">{err}</div>}
        </div>
        <div className="flex gap-2 mt-4">
          <button onClick={save} disabled={saving} className="flex-1 bg-green-500 hover:bg-green-400 disabled:opacity-50 text-white font-semibold rounded-lg py-2.5 text-sm transition-colors">
            {saving?'Saving…':'Save changes'}
          </button>
          <button onClick={onClose} className="px-4 py-2.5 border border-white/10 rounded-lg text-sm text-gray-400 hover:text-gray-200 transition-colors">Cancel</button>
        </div>
      </div>
    </div>
  )
}
