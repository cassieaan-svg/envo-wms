import { Badge } from './ui/Badge'
import { fmtStockQty } from '../utils/helpers'

// Column-aware stock table shared by Stock Levels and the Dashboard.
// Pharmacy rows show Dispensary + DSD SOH; lab rows show SDP SOH. A mixed
// set (admin viewing all categories) shows whichever columns are present.
//
// Each row must carry: commodities, storeQty, dispensaryQty, sdpQty, dsdQty,
// quantity, amc, mos, status, _isLab.

const statusBadge = { out:'out', low:'low', ok:'ok', over:'over', unknown:'unknown' }
const statusLabel = { out:'Out of stock', low:'Low stock', ok:'In stock', over:'Overstock', unknown:'No AMC data' }
const mosColor    = { out:'text-red-400', low:'text-red-400', ok:'text-green-400', over:'text-blue-400', unknown:'text-gray-500' }

function buildCols(items) {
  const hasLab   = items.some(r => r._isLab)
  const hasPharm = items.some(r => !r._isLab)
  const cols = [
    { key:'name',  label:'Commodity' },
    { key:'unit',  label:'Unit' },
    { key:'store', label:'Store SOH' },
  ]
  if (hasPharm) cols.push({ key:'dispensary', label:'Dispensary SOH' })
  if (hasLab)   cols.push({ key:'sdp', label:'SDP SOH' })
  if (hasPharm) cols.push({ key:'dsd', label:'DSD SOH' })
  cols.push(
    { key:'total',  label:'Total SOH' },
    { key:'amc',    label:'AMC' },
    { key:'mos',    label:'MOS' },
    { key:'status', label:'Status' },
  )
  return cols
}

function renderCell(r, key) {
  switch (key) {
    case 'name':       return <td key={key} className="px-4 py-3 font-medium text-gray-100">{r.commodities?.name||'—'}</td>
    case 'unit':       return <td key={key} className="px-4 py-3 text-xs text-gray-400">{r.commodities?.unit||'—'}</td>
    case 'store':      return <td key={key} className={`px-4 py-3 font-mono text-sm ${r.storeQty===0?'text-gray-500':'text-gray-200'}`}>{fmtStockQty(r.storeQty, r.commodities)}</td>
    case 'dispensary': return <td key={key} className={`px-4 py-3 font-mono text-sm ${r.dispensaryQty===0?'text-gray-500':'text-blue-300'}`}>{fmtStockQty(r.dispensaryQty, r.commodities)}</td>
    case 'sdp':        return <td key={key} className={`px-4 py-3 font-mono text-sm ${(r.sdpQty||0)===0?'text-gray-500':'text-blue-300'}`}>{fmtStockQty(r.sdpQty||0, r.commodities)}</td>
    case 'dsd':        return <td key={key} className={`px-4 py-3 font-mono text-sm ${(r.dsdQty||0)===0?'text-gray-500':'text-purple-300'}`}>{fmtStockQty(r.dsdQty||0, r.commodities)}</td>
    case 'total':      return <td key={key} className="px-4 py-3 font-mono text-sm text-gray-200">{fmtStockQty(r.quantity, r.commodities)}</td>
    case 'amc':        return <td key={key} className="px-4 py-3 font-mono text-xs text-gray-500">{r.amc > 0 ? r.amc : '—'}</td>
    case 'mos':        return <td key={key} className={`px-4 py-3 font-mono text-sm font-medium ${mosColor[r.status]}`}>{r.mos !== null && r.mos !== undefined ? `${r.mos}mo` : '—'}</td>
    case 'status':     return <td key={key} className="px-4 py-3"><Badge type={statusBadge[r.status]}>{statusLabel[r.status]}</Badge></td>
    default:           return <td key={key} />
  }
}

export function StockLevelsTable({ items }) {
  const cols = buildCols(items)
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-white/8 bg-white/2">
          {cols.map(c => (
            <th key={c.key} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{c.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.map(r => (
          <tr key={r.id} className="border-b border-white/5 hover:bg-white/2">
            {cols.map(c => renderCell(r, c.key))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
