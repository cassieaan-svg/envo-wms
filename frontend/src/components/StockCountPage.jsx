import { useState, useEffect } from 'react'
import { api } from '../lib/api'
import { useAppStore } from '../store/appStore'
import { useStock } from '../hooks/useStock'
import { toast } from './ui/Toast'
import { Card, CardHeader, CardTitle, CardBody } from './ui/Card'
import { Button } from './ui/Button'
import { CommoditySelect } from './ui/CommoditySelect'
import { LoadingState, EmptyState } from './ui/Loading'
import { fmtDate, todayLagos } from '../utils/helpers'

// Stock Count — enter WHAT YOU COUNTED, not the difference.
//
// This replaces the retired 'Physical count correction' adjustment, which asked for
// a delta ("remove 200"). That put the arithmetic on the user, gave no way to tell a
// double-submit from a genuine second variance, and silently over-deducted when the
// delta exceeded the stock on hand — the difference then resurfaced as a phantom
// bin-card opening balance (Apapa General: three ~1,750 decreases on one shelf).
//
// Here the user types the counted figure and the server derives the correction. The
// same count entered twice is a no-op the second time, because the system figure has
// already moved to match. Counts also address dispensary/DSD/SDP bins, which the
// store-only adjustment form could never correct.
const BINS = [
  { key: 'store',      label: 'Main Store' },
  { key: 'dispensary', label: 'Dispensary' },
  { key: 'dsd',        label: 'DSD site' },
  { key: 'sdp',        label: 'SDP site' },
]

export function StockCountPage() {
  const store = useAppStore()
  const commoditySection = useAppStore(s => s.commoditySection)
  const { loadStock } = useStock()
  const canManage = store.canManageStock()

  const [commId, setCommId]     = useState('')
  const [binType, setBinType]   = useState('store')
  const [siteName, setSiteName] = useState('')
  const [siteOptions, setSiteOptions] = useState([])
  const [counted, setCounted]   = useState('')
  const [countedBy, setCountedBy] = useState('')
  const [countedAt, setCountedAt] = useState(todayLagos())
  const [notes, setNotes]       = useState('')
  const [siteSoh, setSiteSoh]   = useState(null)
  const [saving, setSaving]     = useState(false)
  const [recent, setRecent]     = useState([])
  const [loadingR, setLoadingR] = useState(true)

  const fid = store.currentFacility?.id
  const isSite = binType === 'dsd' || binType === 'sdp'
  const selectedComm = store.allCommodities.find(c => c.id === commId)

  useEffect(() => { if (fid) loadRecent() }, [fid])

  async function loadRecent() {
    if (!fid) return
    setLoadingR(true)
    try { setRecent(await api.stockCounts.history({ facility_id: fid, limit: 50 }) || []) }
    catch { setRecent([]) }
    finally { setLoadingR(false) }
  }

  // Site bins live in their own tables, so their stock on hand is fetched rather
  // than read from the store-level stockData already in the app store.
  useEffect(() => {
    let active = true
    setSiteSoh(null)
    if (!isSite || !fid || !commId) { setSiteOptions([]); return }
    const src = binType === 'dsd' ? api.stock.dsd : api.stock.sdp
    const col = binType === 'dsd' ? 'dsd_site_name' : 'sdp_name'
    src.list({ facility_id: fid, commodity_id: commId })
      .then(data => {
        if (!active) return
        const opts = (data || []).map(r => ({ site: r[col], quantity: r.quantity }))
          .sort((a, b) => a.site.localeCompare(b.site))
        setSiteOptions(opts)
        setSiteName(prev => opts.some(o => o.site === prev) ? prev : '')
      })
      .catch(() => { if (active) setSiteOptions([]) })
    return () => { active = false }
  }, [isSite, binType, fid, commId])

  useEffect(() => {
    if (!isSite) { setSiteSoh(null); return }
    setSiteSoh(siteOptions.find(o => o.site === siteName)?.quantity ?? null)
  }, [siteName, siteOptions, isSite])

  // What the system currently believes for the chosen bin. Shown so the user can
  // see the gap before committing — but it is NEVER sent: the server re-reads it
  // inside the transaction so the variance cannot be stale or tampered with.
  const storeRow = store.stockData.find(r => r.commodity_id === commId
    && r.location_type === binType && (!fid || r.facility_id === fid))
  const systemQty = isSite ? siteSoh : (storeRow?.quantity ?? (commId ? 0 : null))

  const countedNum = counted === '' ? null : parseInt(counted)
  const variance = (countedNum == null || systemQty == null) ? null : countedNum - systemQty
  const ready = commId && countedNum != null && countedNum >= 0 && countedBy.trim()
    && (!isSite || siteName) && canManage

  async function submit() {
    if (!ready || saving) return
    setSaving(true)
    try {
      const res = await api.stockCounts.record({
        facility_id: fid,
        commodity_id: commId,
        location_type: binType,
        site_name: isSite ? siteName : undefined,
        counted_quantity: countedNum,
        counted_by: countedBy.trim(),
        counted_at: countedAt,
        notes: notes.trim(),
        section: commoditySection,
      })
      const v = res?.variance ?? 0
      toast.success(v === 0
        ? 'Count recorded — system already matched the shelf, no correction needed.'
        : `Count recorded — stock corrected by ${v > 0 ? '+' : ''}${v}.`)
      setCounted(''); setNotes('')
      await Promise.all([loadStock(), loadRecent()])
    } catch (err) {
      toast.error(err?.message || 'Could not record the count')
    } finally {
      setSaving(false)
    }
  }

  const commSource = store.allCommodities
  const categories = {}
  commSource.forEach(c => {
    if (!categories[c.category]) categories[c.category] = []
    categories[c.category].push(c)
  })

  const lbl = 'block text-xs text-gray-500 uppercase tracking-widest mb-1.5'
  const inp = 'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500'

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-100">Stock Count</h1>
        <p className="text-sm text-gray-400 mt-1">
          Enter what you physically counted on the shelf. EnVo works out the correction itself —
          you never enter the difference.
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle>Count details</CardTitle></CardHeader>
        <CardBody className="space-y-4">
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className={lbl}>Commodity *</label>
              <CommoditySelect value={commId} onChange={setCommId} categories={categories} />
            </div>
            <div>
              <label className={lbl}>Location counted *</label>
              <select value={binType} onChange={e => { setBinType(e.target.value); setSiteName('') }} className={inp}>
                {BINS.map(b => <option key={b.key} value={b.key}>{b.label}</option>)}
              </select>
            </div>
          </div>

          {isSite && (
            <div>
              <label className={lbl}>{binType === 'dsd' ? 'DSD site' : 'SDP site'} *</label>
              <select value={siteName} onChange={e => setSiteName(e.target.value)} className={inp} disabled={!commId}>
                <option value="">{commId ? 'Select a site…' : 'Choose a commodity first'}</option>
                {siteOptions.map(o => <option key={o.site} value={o.site}>{o.site} — EnVo has {o.quantity}</option>)}
              </select>
            </div>
          )}

          {/* The comparison, made explicit before submitting. */}
          {commId && (isSite ? siteName : true) && (
            <div className="grid grid-cols-3 gap-3 rounded-lg border border-white/10 bg-white/5 p-4">
              <div>
                <div className="text-xs text-gray-500 uppercase tracking-widest mb-1">EnVo says</div>
                <div className="text-xl font-semibold text-gray-300">{systemQty ?? '—'}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500 uppercase tracking-widest mb-1">You counted</div>
                <div className="text-xl font-semibold text-gray-100">{countedNum ?? '—'}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500 uppercase tracking-widest mb-1">Difference</div>
                <div className={`text-xl font-semibold ${
                  variance == null ? 'text-gray-500' : variance === 0 ? 'text-gray-300'
                  : variance > 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {variance == null ? '—' : variance === 0 ? 'None' : `${variance > 0 ? '+' : ''}${variance}`}
                </div>
              </div>
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className={lbl}>Quantity counted * {selectedComm?.unit ? `(${selectedComm.unit})` : ''}</label>
              <input type="number" min="0" value={counted} onChange={e => setCounted(e.target.value)}
                     placeholder="What is on the shelf" className={inp} />
            </div>
            <div>
              <label className={lbl}>Counted by *</label>
              <input value={countedBy} onChange={e => setCountedBy(e.target.value)}
                     placeholder="Staff name or ID" className={inp} />
            </div>
            <div>
              <label className={lbl}>Date counted</label>
              <input type="date" value={countedAt} onChange={e => setCountedAt(e.target.value)} className={inp} />
            </div>
            <div>
              <label className={lbl}>Notes (optional)</label>
              <input value={notes} onChange={e => setNotes(e.target.value)}
                     placeholder="Anything worth recording" className={inp} />
            </div>
          </div>

          {variance != null && variance !== 0 && (
            <p className="text-xs text-gray-400">
              Submitting will set {BINS.find(b => b.key === binType)?.label}
              {isSite && siteName ? ` (${siteName})` : ''} to <strong className="text-gray-200">{countedNum}</strong> and
              record a {variance > 0 ? 'increase' : 'decrease'} of {Math.abs(variance)} against this count.
            </p>
          )}

          <div className="flex items-center gap-3">
            <Button onClick={submit} disabled={!ready || saving}>
              {saving ? 'Recording…' : 'Record count'}
            </Button>
            {!canManage && <span className="text-xs text-gray-500">You do not have permission to record counts.</span>}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>Recent counts</CardTitle></CardHeader>
        <CardBody>
          {loadingR ? <LoadingState /> : !recent.length ? (
            <EmptyState message="No stock counts recorded yet." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-500 uppercase tracking-widest text-left">
                    <th className="py-2 pr-4">Date</th>
                    <th className="py-2 pr-4">Commodity</th>
                    <th className="py-2 pr-4">Location</th>
                    <th className="py-2 pr-4 text-right">EnVo said</th>
                    <th className="py-2 pr-4 text-right">Counted</th>
                    <th className="py-2 pr-4 text-right">Difference</th>
                    <th className="py-2">By</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map(r => (
                    <tr key={r.id} className="border-t border-white/5 text-gray-300">
                      <td className="py-2 pr-4 whitespace-nowrap">{fmtDate(r.counted_at)}</td>
                      <td className="py-2 pr-4">{r.commodity_name || '—'}</td>
                      <td className="py-2 pr-4">
                        {BINS.find(b => b.key === r.location_type)?.label || r.location_type}
                        {r.site_name ? ` — ${r.site_name}` : ''}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">{r.system_quantity}</td>
                      <td className="py-2 pr-4 text-right tabular-nums text-gray-100">{r.counted_quantity}</td>
                      <td className={`py-2 pr-4 text-right tabular-nums ${
                        r.variance === 0 ? 'text-gray-500' : r.variance > 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {r.variance === 0 ? '—' : `${r.variance > 0 ? '+' : ''}${r.variance}`}
                      </td>
                      <td className="py-2">{r.counted_by}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
