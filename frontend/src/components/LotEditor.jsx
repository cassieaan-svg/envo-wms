import { useState, useEffect } from 'react'
import { api } from '../lib/api'
import { toast } from './ui/Toast'
import { Button } from './ui/Button'
import { fmtDate, todayLagos } from '../utils/helpers'

// Record the batch / expiry of the lots in one bin (store, dispensary, or a
// DSD/SDP site). METADATA ONLY — quantities are never edited here, so nothing
// this does can change a stock balance.
//
// Its main job is labelling the "unknown expiry" lots the ledger seed produced
// where no receipt carried a usable expiry: those are real stock, but with no
// expiry they can't be expiry-checked and FEFO can only use them last.
//
// bin: { facilityId, commodityId, commodityName, locationType, siteName }.
// `canEdit` gates the inputs (store managers); everyone else sees a read-only list.
export function LotEditor({ facilityId, commodityId, commodityName, locationType, siteName, canEdit = false, onClose, onSaved }) {
  const [lots, setLots] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)     // lot index being edited
  const [batch, setBatch] = useState('')
  const [expiry, setExpiry] = useState('')
  const [saving, setSaving] = useState(false)

  async function load() {
    setLoading(true)
    const rows = await api.stock.lots({
      facility_id: facilityId, commodity_id: commodityId,
      location_type: locationType, site_name: siteName || undefined,
    }).catch(() => [])
    setLots(rows || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [facilityId, commodityId, locationType, siteName])

  function startEdit(i, lot) {
    setEditing(i)
    setBatch(lot.batch_number || '')
    setExpiry(lot.expiry_date ? String(lot.expiry_date).slice(0, 10) : '')
  }

  async function save(lot) {
    if (!expiry && !batch.trim()) { toast('Enter a batch or an expiry date', 'red'); return }
    setSaving(true)
    try {
      await api.stock.relabelLot(lot.id, { batch_number: batch.trim() || null, expiry_date: expiry || null })
    } catch (e) { toast('Could not save: ' + e.message, 'red'); setSaving(false); return }
    toast('Batch details recorded', 'green')
    setEditing(null); setSaving(false)
    await load()
    onSaved?.()
  }

  const missing = lots.filter(l => !l.expiry_date).length

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-[#0e1524] border border-white/10 rounded-xl w-full max-w-2xl max-h-[85vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-white/8 flex items-start justify-between gap-4">
          <div>
            <div className="font-medium text-gray-100">Batches on hand</div>
            <div className="text-xs text-gray-500 mt-0.5">
              {commodityName || 'Commodity'}
              {siteName ? ` · ${siteName}` : locationType === 'dispensary' ? ' · Dispensary' : ' · Main Store'}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-200 text-sm">✕</button>
        </div>

        {missing > 0 && (
          <div className="mx-5 mt-4 rounded-lg px-4 py-3 text-sm bg-amber-500/10 border border-amber-500/20 text-amber-300">
            {missing} batch{missing > 1 ? 'es have' : ' has'} no expiry recorded.
            {canEdit ? ' Record it below so the stock can be expiry-checked.' : ' Ask your store manager to record it.'}
          </div>
        )}

        {loading ? (
          <div className="px-5 py-8 text-sm text-gray-500">Loading batches…</div>
        ) : lots.length === 0 ? (
          <div className="px-5 py-8 text-sm text-gray-500">No stock on hand in this bin.</div>
        ) : (
          <div className="p-5 space-y-2">
            {lots.map((lot, i) => (
              <div key={lot.id} className={`rounded-lg border p-3 ${lot.expiry_date ? 'border-white/10 bg-white/3' : 'border-amber-500/25 bg-amber-500/5'}`}>
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="text-sm">
                    <span className="text-gray-100 font-medium">{lot.batch_number || '(no batch)'}</span>
                    <span className="text-gray-500"> · exp {lot.expiry_date ? fmtDate(lot.expiry_date) : '—'}</span>
                    <span className="text-gray-400"> · {lot.quantity} on hand</span>
                  </div>
                  {canEdit && editing !== i && (
                    <Button variant="default" size="sm" onClick={() => startEdit(i, lot)}>
                      {lot.expiry_date ? 'Edit' : 'Record batch & expiry'}
                    </Button>
                  )}
                </div>

                {canEdit && editing === i && (
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Batch / lot no.</label>
                      <input type="text" value={batch} onChange={e => setBatch(e.target.value)} placeholder="e.g. QBO2401"
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Expiry date</label>
                      <input type="date" value={expiry} min={todayLagos()} onChange={e => setExpiry(e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
                    </div>
                    <div className="sm:col-span-2 flex items-center gap-2">
                      <Button variant="success" size="sm" disabled={saving} onClick={() => save(lot)}>
                        {saving ? 'Saving…' : 'Save'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>Cancel</Button>
                      <span className="text-xs text-gray-600">Quantity is not changed — this only records the batch details.</span>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
