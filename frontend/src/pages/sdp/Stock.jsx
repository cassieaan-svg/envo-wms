import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/appStore'
import { Card } from '../../components/ui/Card'
import { LoadingState, EmptyState } from '../../components/ui/Loading'

export function Stock() {
  const store = useAppStore()
  const sdpName = useAppStore(s => s.sdpName)
  const fid = store.currentFacility?.id
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  useEffect(() => { loadData() }, [fid, sdpName])

  async function loadData() {
    setLoading(true)
    if (!fid || !sdpName) { setRows([]); setLoading(false); return }
    const data = await api.stock.sdp.list({ facility_id: fid, sdp_name: sdpName }).catch(() => [])
    setRows(data || [])
    setLoading(false)
  }

  const filtered = rows.filter(r =>
    !search || (r.commodities?.name || '').toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-medium text-gray-100">Stock Levels</h1>
        <p className="text-sm text-gray-500 mt-1">Stock on hand for {sdpName}</p>
      </div>

      <Card className="mb-4">
        <div className="px-4 py-3 flex gap-2 flex-wrap items-center">
          <button onClick={loadData} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">Refresh</button>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search commodity…"
            className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 placeholder:text-gray-600 focus:outline-none focus:border-blue-500 flex-1 min-w-[200px] max-w-xs" />
        </div>
      </Card>

      {loading ? <LoadingState /> : filtered.length === 0 ? <EmptyState message="No stock records found." /> : (
        <Card>
          <div className="table-wrap">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/8 bg-white/2">
                  {['Commodity','Unit','Stock on Hand'].map(h => (
                    <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => (
                  <tr key={r.id} className="border-b border-white/5 hover:bg-white/2">
                    <td className="px-4 py-3 font-medium text-gray-100">{r.commodities?.name || '—'}</td>
                    <td className="px-4 py-3 text-xs text-gray-400">{r.commodities?.unit || '—'}</td>
                    <td className={`px-4 py-3 font-mono text-sm ${r.quantity === 0 ? 'text-gray-500' : 'text-gray-200'}`}>{r.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}
