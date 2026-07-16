import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { LoadingState, EmptyState, Spinner } from './ui/Loading'
import { exportCsv, exportPdf } from '../utils/download'
import { fmtDate } from '../utils/helpers'

// Digitised bin/stock card: a per-commodity, per-bin running ledger. Opened from
// the Activity Log by clicking a commodity, or (for store managers) from the
// "Bin Card" button with a commodity picker so any commodity's card is reachable,
// not just ones that appear in the log. The location selector lists the facility's
// bins — Main Store, Dispensary, and each DSD / SDP site.
const DEFAULT_BINS = [{ value: 'store', label: 'Main Store' }]

const HEADERS = ['Date', 'Ref', 'From / To', 'Batch', 'Expiry', 'Received', 'Issued', 'Loss & Adj', 'Balance', 'By', 'Remarks']
const RIGHT = new Set([5, 6, 7, 8])   // numeric columns

// `commodities` (optional [{id,name,category}]) turns on the in-modal commodity
// picker (with a category filter); `commodityId` is then just the initial selection.
export function BinCardModal({ facilityId, commodityId, commodityName, commodities, onClose }) {
  const [location, setLocation] = useState('store')
  const [bins, setBins] = useState(DEFAULT_BINS)
  const [category, setCategory] = useState('')
  const [cid, setCid] = useState(commodityId || null)
  const [card, setCard] = useState(null)
  const [loading, setLoading] = useState(!!(commodityId))
  const [error, setError] = useState(null)

  // Bins available at this facility (Main Store / Dispensary / DSD / SDP sites).
  useEffect(() => {
    let active = true
    api.binCardBins({ facility_id: facilityId })
      .then(d => { if (active && d?.length) setBins(d) })
      .catch(() => {})
    return () => { active = false }
  }, [facilityId])

  useEffect(() => {
    if (!cid) { setCard(null); setLoading(false); return }
    let active = true
    setLoading(true); setError(null)
    api.binCard({ facility_id: facilityId, commodity_id: cid, location })
      .then(d => { if (active) { setCard(d); setLoading(false) } })
      .catch(e => { if (active) { setError(e.message); setLoading(false) } })
    return () => { active = false }
  }, [facilityId, cid, location])

  const categories = [...new Set((commodities || []).map(c => c.category).filter(Boolean))].sort()
  const shownCommodities = category ? (commodities || []).filter(c => c.category === category) : (commodities || [])

  const num = n => (n === 0 || n == null || n === '') ? '' : Number(n).toLocaleString()
  const signed = n => n > 0 ? `+${num(n)}` : n < 0 ? num(n) : ''
  // Numeric-column variants that render 0 (muted) rather than a blank, so the
  // ledger reads as a full grid.
  const num0 = n => Number(n || 0).toLocaleString()
  const signed0 = n => n > 0 ? `+${num(n)}` : n < 0 ? num(n) : '0'
  const dstr = d => d ? fmtDate(d) : ''

  const pickedName = card?.commodity?.name || commodities?.find(c => c.id === cid)?.name || commodityName || ''
  const locLabel = bins.find(l => l.value === location)?.label || location
  const title = `Bin Card — ${pickedName}`
  const subtitle = card ? `${card.facility?.name || ''} · ${locLabel} · Unit: ${card.commodity?.unit || '—'} · Current SOH: ${card.currentBalance ?? '—'}` : ''
  const exportRows = () => (card?.rows || []).map(r => [dstr(r.date), r.ref, r.party, r.batch, dstr(r.expiry), r.received || 0, r.issued || 0, r.adjustment || 0, r.balance, r.by, r.remarks])
  const base = (card?.commodity?.name || 'commodity').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '')
  const doCsv = () => exportCsv(`bincard_${base}_${location}.csv`, HEADERS, exportRows())
  const doPdf = () => exportPdf(title, subtitle, HEADERS, exportRows(), RIGHT)

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-white/10 rounded-2xl w-full max-w-5xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between p-5 border-b border-white/8">
          <div>
            <h2 className="text-lg font-medium text-gray-100">Bin Card{pickedName ? ` — ${pickedName}` : ''}</h2>
            <div className="text-xs text-gray-500 mt-1 flex flex-wrap gap-x-4 gap-y-1">
              <span>{card?.facility?.name || ''}{card?.facility?.lga ? ` — ${card.facility.lga}` : ''}</span>
              <span>Unit: {card?.commodity?.unit || '—'}</span>
              <span>Category: {card?.commodity?.category || '—'}</span>
              <span>Current SOH: <span className="text-gray-300">{card?.currentBalance ?? '—'}</span></span>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl leading-none">✕</button>
        </div>

        <div className="flex gap-2 items-center flex-wrap px-5 py-3 border-b border-white/5">
          {commodities?.length > 0 && (
            <>
              {categories.length > 1 && (
                <select value={category} onChange={e => setCategory(e.target.value)} title="Filter commodities by category"
                  className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500">
                  <option value="">All categories</option>
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              )}
              <label className="text-xs text-gray-500 uppercase tracking-widest">Commodity</label>
              <select value={shownCommodities.some(c => c.id === cid) ? cid : ''} onChange={e => setCid(e.target.value || null)}
                className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500 max-w-xs">
                <option value="">Select commodity…</option>
                {shownCommodities.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </>
          )}
          <label className="text-xs text-gray-500 uppercase tracking-widest">Location</label>
          <select value={location} onChange={e => setLocation(e.target.value)}
            className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500">
            {bins.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
          {loading && <Spinner size="sm" />}
          <div className="ml-auto flex gap-2">
            <button onClick={doCsv} disabled={!card?.rows?.length}
              className="text-xs text-gray-300 hover:text-white border border-white/10 rounded px-3 py-1.5 disabled:opacity-50">Download CSV</button>
            <button onClick={doPdf} disabled={!card?.rows?.length}
              className="text-xs text-gray-300 hover:text-white border border-white/10 rounded px-3 py-1.5 disabled:opacity-50">Print / Save as PDF</button>
          </div>
        </div>

        {!cid ? <EmptyState message="Select a commodity to view its bin card." /> : loading ? <LoadingState /> : error ? <EmptyState message={`Could not load bin card: ${error}`} /> : !card?.rows?.length ? <EmptyState message="No movements recorded for this bin." /> : (
          <div className="table-wrap"><table className="w-full text-sm">
            <thead><tr className="border-b border-white/8 bg-white/2">
              {HEADERS.map((h, i) => (
                <th key={i} className={`px-3 py-2 text-xs text-gray-500 uppercase tracking-wider font-medium ${RIGHT.has(i) ? 'text-right' : 'text-left'}`}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              <tr className="border-b border-white/5 bg-white/2">
                <td className="px-3 py-2 text-xs text-gray-500 italic" colSpan={8}>Opening balance</td>
                <td className="px-3 py-2 text-right font-mono text-gray-400">{num0(card.openingBalance)}</td>
                <td colSpan={2}></td>
              </tr>
              {card.rows.map((r, i) => (
                <tr key={i} className="border-b border-white/5 hover:bg-white/2">
                  <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">{dstr(r.date)}</td>
                  <td className="px-3 py-2 text-xs text-gray-500">{r.ref}</td>
                  <td className="px-3 py-2 text-gray-200">{r.party}</td>
                  <td className="px-3 py-2 text-xs text-gray-500">{r.batch}</td>
                  <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">{dstr(r.expiry)}</td>
                  <td className={`px-3 py-2 text-right font-mono ${r.received ? 'text-green-400' : 'text-gray-600'}`}>{num0(r.received)}</td>
                  <td className={`px-3 py-2 text-right font-mono ${r.issued ? 'text-red-400' : 'text-gray-600'}`}>{num0(r.issued)}</td>
                  <td className={`px-3 py-2 text-right font-mono ${r.adjustment > 0 ? 'text-green-400' : r.adjustment < 0 ? 'text-red-400' : 'text-gray-600'}`}>{signed0(r.adjustment)}</td>
                  <td className="px-3 py-2 text-right font-mono text-gray-200">{num0(r.balance)}</td>
                  <td className="px-3 py-2 text-xs text-gray-500">{r.by}</td>
                  <td className="px-3 py-2 text-xs text-gray-500">{r.remarks}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
    </div>
  )
}
