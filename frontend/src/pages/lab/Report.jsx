import { useState, useEffect } from 'react'
import { sb } from '../../lib/supabase'
import { useAppStore } from '../../store/appStore'
import { Card, CardHeader, CardTitle, CardBody } from '../../components/ui/Card'
import { MetricGrid, Metric } from '../../components/ui/Metric'
import { CatBadge } from '../../components/ui/Badge'
import { LoadingState, EmptyState } from '../../components/ui/Loading'
import { toast } from '../../components/ui/Toast'
import { REPORT_CATEGORIES, getReportCategoryLabel, fetchReportRows, buildCrrfCsv, buildActivityCsv, getSummaryMetrics } from '../../utils/reports'
import { todayLagos } from '../../utils/helpers'

export function Report() {
  const store = useAppStore()
  const [category, setCategory] = useState(store.currentReportCategory || 'all')
  const [date, setDate] = useState(todayLagos())
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)

  const fid = store.currentFacility?.id
  const commIds = store.allCommodities.map(c => c.id)

  async function loadReport() {
    setLoading(true)
    const data = await fetchReportRows({ sb, category, from: date, to: date, fid, commIds })
    setRows(data)
    setLoading(false)
  }

  useEffect(() => {
    loadReport()
  }, [fid, category, date])

  async function exportCSV() {
    if (!rows.length) { toast('No data to export','red'); return }

    const stockMap = {}
    if (fid) {
      const { data: stockRows } = await sb.from('stock').select('commodity_id,quantity').eq('facility_id', fid)
      const commLookup = {}
      store.allCommodities.forEach(c => { commLookup[c.id] = c.name })
      ;(stockRows || []).forEach(r => {
        const name = commLookup[r.commodity_id]
        if (name) stockMap[name] = (stockMap[name] || 0) + r.quantity
      })
    }

    const title = `Daily ${getReportCategoryLabel(category)} Report — ${date}`
    const csv = category === 'all'
      ? buildCrrfCsv(rows, title, stockMap)
      : buildActivityCsv(rows, category, title, stockMap)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = `daily-${category}-report-${date}.csv`
    a.click()
    toast('CSV exported','green')
  }

  const categoryLabel = getReportCategoryLabel(category)
  const metrics = getSummaryMetrics(rows, category)

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-medium text-gray-100">Daily report</h1>
        <p className="text-sm text-gray-500 mt-1">{categoryLabel} summary for {new Date(date).toLocaleDateString('en-GB')}</p>
      </div>

      <Card className="mb-4">
        <CardBody className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Activity</label>
            <select value={category} onChange={e => { setCategory(e.target.value); store.setCurrentReportCategory(e.target.value) }}
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500 w-48">
              {REPORT_CATEGORIES.map(cat => <option key={cat.key} value={cat.key}>{cat.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Date</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
          </div>
          <button onClick={exportCSV} className="bg-green-500 hover:bg-green-400 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors">
            Export CSV
          </button>
        </CardBody>
      </Card>

      {metrics.length > 0 && (
        <MetricGrid>
          {metrics.map(m => <Metric key={m.label} label={m.label} value={m.value} color={m.color} />)}
        </MetricGrid>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Daily {categoryLabel} activity</CardTitle>
        </CardHeader>
        {loading ? <LoadingState /> : rows.length === 0 ? <EmptyState message="No records found for this date." /> : (
          <div className="table-wrap"><table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/8 bg-white/2">
                {['Time','Activity','Commodity','Category','Quantity','Unit','Facility','Status','Notes'].map(h => (
                  <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${row.id}-${index}`} className="border-b border-white/5 hover:bg-white/2">
                  <td className="px-4 py-3 font-medium text-gray-100">{row.date?.slice(11,19) || '—'}</td>
                  <td className="px-4 py-3">{row.activity}</td>
                  <td className="px-4 py-3 font-medium text-gray-100">{row.commodity}</td>
                  <td className="px-4 py-3"><CatBadge>{row.category}</CatBadge></td>
                  <td className="px-4 py-3 font-mono text-sm text-gray-100">{row.quantity}</td>
                  <td className="px-4 py-3 text-gray-300">{row.unit}</td>
                  <td className="px-4 py-3 text-gray-300">{row.facility}</td>
                  <td className="px-4 py-3 text-gray-300">{row.status}</td>
                  <td className="px-4 py-3 text-gray-300">{row.notes}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
    </div>
  )
}
