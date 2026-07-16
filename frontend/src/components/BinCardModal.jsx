import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { LoadingState, EmptyState, Spinner } from './ui/Loading'
import { exportCsv, exportPdf } from '../utils/download'
import { fmtDate } from '../utils/helpers'

// Digitised bin/stock card: a per-commodity, per-bin running ledger. Opened from
// the Activity Log by clicking a commodity. Step 2 = Main Store only; the
// location selector fills out (Dispensary / DSD / SDP) once the backend adds
// those bins.
const LOCATIONS = [{ value: 'store', label: 'Main Store' }]

const HEADERS = ['Date', 'Ref', 'From / To', 'Batch', 'Expiry', 'Received', 'Issued', 'Loss & Adj', 'Balance', 'By', 'Remarks']
const RIGHT = new Set([5, 6, 7, 8])   // numeric columns

export function BinCardModal({ facilityId, commodityId, commodityName, onClose }) {
  const [location, setLocation] = useState('store')
  const [card, setCard] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let active = true
    setLoading(true); setError(null)
    api.binCard({ facility_id: facilityId, commodity_id: commodityId, location })
      .then(d => { if (active) { setCard(d); setLoading(false) } })
      .catch(e => { if (active) { setError(e.message); setLoading(false) } })
    return () => { active = false }
  }, [facilityId, commodityId, location])

  const num = n => (n === 0 || n == null || n === '') ? '' : Number(n).toLocaleString()
  const signed = n => n > 0 ? `+${num(n)}` : n < 0 ? num(n) : ''
  const dstr = d => d ? fmtDate(d) : ''

  const locLabel = LOCATIONS.find(l => l.value === location)?.label || location
  const title = `Bin Card — ${card?.commodity?.name || commodityName || ''}`
  const subtitle = card ? `${card.facility?.name || ''} · ${locLabel} · Unit: ${card.commodity?.unit || '—'} · Current SOH: ${card.currentBalance ?? '—'}` : ''
  const exportRows = () => (card?.rows || []).map(r => [dstr(r.date), r.ref, r.party, r.batch, dstr(r.expiry), r.received || '', r.issued || '', r.adjustment || '', r.balance, r.by, r.remarks])
  const base = (card?.commodity?.name || 'commodity').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '')
  const doCsv = () => exportCsv(`bincard_${base}_${location}.csv`, HEADERS, exportRows())
  const doPdf = () => exportPdf(title, subtitle, HEADERS, exportRows(), RIGHT)

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-white/10 rounded-2xl w-full max-w-5xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between p-5 border-b border-white/8">
          <div>
            <h2 className="text-lg font-medium text-gray-100">Bin Card — {card?.commodity?.name || commodityName || '…'}</h2>
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
          <label className="text-xs text-gray-500 uppercase tracking-widest">Location</label>
          <select value={location} onChange={e => setLocation(e.target.value)}
            className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500">
            {LOCATIONS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
          {loading && <Spinner size="sm" />}
          <div className="ml-auto flex gap-2">
            <button onClick={doCsv} disabled={!card?.rows?.length}
              className="text-xs text-gray-300 hover:text-white border border-white/10 rounded px-3 py-1.5 disabled:opacity-50">Download CSV</button>
            <button onClick={doPdf} disabled={!card?.rows?.length}
              className="text-xs text-gray-300 hover:text-white border border-white/10 rounded px-3 py-1.5 disabled:opacity-50">Print / Save as PDF</button>
          </div>
        </div>

        {loading ? <LoadingState /> : error ? <EmptyState message={`Could not load bin card: ${error}`} /> : !card?.rows?.length ? <EmptyState message="No movements recorded for this bin." /> : (
          <div className="table-wrap"><table className="w-full text-sm">
            <thead><tr className="border-b border-white/8 bg-white/2">
              {HEADERS.map((h, i) => (
                <th key={i} className={`px-3 py-2 text-xs text-gray-500 uppercase tracking-wider font-medium ${RIGHT.has(i) ? 'text-right' : 'text-left'}`}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              <tr className="border-b border-white/5 bg-white/2">
                <td className="px-3 py-2 text-xs text-gray-500 italic" colSpan={8}>Opening balance</td>
                <td className="px-3 py-2 text-right font-mono text-gray-400">{num(card.openingBalance) || 0}</td>
                <td colSpan={2}></td>
              </tr>
              {card.rows.map((r, i) => (
                <tr key={i} className="border-b border-white/5 hover:bg-white/2">
                  <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">{dstr(r.date)}</td>
                  <td className="px-3 py-2 text-xs text-gray-500">{r.ref}</td>
                  <td className="px-3 py-2 text-gray-200">{r.party}</td>
                  <td className="px-3 py-2 text-xs text-gray-500">{r.batch}</td>
                  <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">{dstr(r.expiry)}</td>
                  <td className="px-3 py-2 text-right font-mono text-green-400">{num(r.received)}</td>
                  <td className="px-3 py-2 text-right font-mono text-red-400">{num(r.issued)}</td>
                  <td className={`px-3 py-2 text-right font-mono ${r.adjustment > 0 ? 'text-green-400' : r.adjustment < 0 ? 'text-red-400' : ''}`}>{signed(r.adjustment)}</td>
                  <td className="px-3 py-2 text-right font-mono text-gray-200">{num(r.balance)}</td>
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
