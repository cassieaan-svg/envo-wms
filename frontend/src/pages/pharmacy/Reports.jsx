import { useState } from 'react'
import { sb } from '../../lib/supabase'
import { useAppStore } from '../../store/appStore'
import { Card, CardHeader, CardTitle, CardBody } from '../../components/ui/Card'
import { MetricGrid, Metric } from '../../components/ui/Metric'
import { Badge, CatBadge } from '../../components/ui/Badge'

// Activity Log colour scheme reused for the report table.
const ACTIVITY_BADGE = { Consumption: 'out', Intake: 'ok', Adjustment: 'info', Transfer: 'low' }
function renderQty(row) {
  const n = Math.abs(row.quantity || 0)
  if (row.activity === 'Consumption') return <span className="font-mono text-sm text-red-400">-{n} {row.unit || ''}</span>
  if (row.activity === 'Intake')      return <span className="font-mono text-sm text-green-400">+{n} {row.unit || ''}</span>
  const pos = (row.quantity || 0) >= 0   // Adjustment / Transfer keep their sign
  return <span className={`font-mono text-sm ${pos ? 'text-green-400' : 'text-red-400'}`}>{pos ? '+' : '-'}{n} {row.unit || ''}</span>
}
import { LoadingState, EmptyState } from '../../components/ui/Loading'
import { toast } from '../../components/ui/Toast'
import { REPORT_CATEGORIES, getReportCategoryLabel, fetchReportRows, buildCrrfCsv, buildActivityCsv, getSummaryMetrics } from '../../utils/reports'

export function Reports({ embedded = false } = {}) {
  const store = useAppStore()
  const [tab, setTab]       = useState('weekly')
  const now   = new Date()
  const dayOfWeek = now.getDay() || 7
  const monday = new Date(now); monday.setDate(now.getDate()-dayOfWeek+1)
  const sunday = new Date(monday); sunday.setDate(monday.getDate()+6)
  const wFrom0 = monday.toISOString().split('T')[0]
  const wTo0   = sunday.toISOString().split('T')[0]
  const month0 = now.toISOString().slice(0,7)

  const [wFrom, setWFrom]     = useState(wFrom0)
  const [wTo, setWTo]         = useState(wTo0)
  const [month, setMonth]     = useState(month0)
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(false)
  const [selectedActivities, setSelectedActivities] = useState(new Set())
  const [selectedActivityTypes, setSelectedActivityTypes] = useState(() => {
    const c = store.currentReportCategory
    return ['dispense','intake','adjustment','transfer'].includes(c) ? new Set([c]) : new Set(['dispense','intake','adjustment','transfer'])
  })
  const [showActivityDropdown, setShowActivityDropdown] = useState(false)
  const [facFilter, setFacFilter] = useState('')   // admin: facility id ('' = all facilities)
  const [catFilter, setCatFilter] = useState('')   // admin: commodity category ('' = all)

  // The Activity Types selector is the single source of truth for the report:
  // exactly one type loads that activity; multiple (or all) load everything and
  // the table/CSV are narrowed to the ticked types.
  const category = selectedActivityTypes.size === 1 ? [...selectedActivityTypes][0] : 'all'

  // Admins aggregate across every facility and both sections, so don't scope
  // the query to one facility or to a section's commodity list — passing the
  // full catalogue as a `commodity_id` IN() filter is huge and silently drops
  // every row, which is why the admin report came back empty. Facility users
  // stay scoped to their facility + section commodities.
  const isAdmin = store.isAdmin()
  const fid     = isAdmin ? (facFilter || null) : store.currentFacility?.id
  const commIds = isAdmin ? null : store.allCommodities.map(c => c.id)

  // Admin scoping options: every facility they oversee + every commodity
  // category across both sections.
  const facilityOptions = isAdmin ? store.allFacilities : []
  const categoryOptions = isAdmin
    ? [...new Set(store.allCommodities.map(c => c.category).filter(Boolean))].sort()
    : []
  const matchesCategory = row => !catFilter || row.category === catFilter

  const activityTypes = [
    { key: 'dispense', label: 'Consumption' },
    { key: 'intake', label: 'Intake' },
    { key: 'adjustment', label: 'Adjustment' },
    { key: 'transfer', label: 'Transfer' },
  ]

  // Report rows store the display label (e.g. 'Consumption') while the
  // filter set stores keys (e.g. 'dispense') — map between them.
  const activityLabelToKey = {
    Consumption: 'dispense',
    Intake: 'intake',
    Adjustment: 'adjustment',
    Transfer: 'transfer',
  }
  const rowMatchesFilter = row => selectedActivityTypes.has(activityLabelToKey[row.activity])

  async function loadWeekly() {
    setLoading(true)
    const rows = await fetchReportRows({ sb, category, from: wFrom, to: wTo, fid, commIds })
    setSummary({ rows, label: `${wFrom} → ${wTo}` })
    setLoading(false)
  }

  async function loadMonthly() {
    setLoading(true)
    const from = month + '-01'
    const lastDay = new Date(month.split('-')[0], month.split('-')[1], 0).getDate()
    const to = `${month}-${String(lastDay).padStart(2,'0')}`
    const rows = await fetchReportRows({ sb, category, from, to, fid, commIds })
    setSummary({ rows, label: month })
    setLoading(false)
  }

  async function exportCSV() {
    if (!summary?.rows) { toast('Load data first','red'); return }

    // Build stock map (commodity name → total SOH) for the ending-balance
    // column. A single facility uses its own rows; an admin viewing "All
    // facilities" aggregates every overseen facility's stock. Paginate past the
    // 1000-row PostgREST cap so the cross-facility totals are complete.
    const stockMap = {}
    if (fid || isAdmin) {
      const commLookup = {}
      store.allCommodities.forEach(c => { commLookup[c.id] = c.name })
      // State/LGA admins aggregate only their facilities; overall admin = all.
      const scopeIds = (!fid && !store.isOverallAdmin()) ? store.allFacilities.map(f => f.id) : null
      const PAGE = 1000
      for (let offset = 0; ; offset += PAGE) {
        let sq = sb.from('stock').select('commodity_id,quantity').range(offset, offset + PAGE - 1)
        if (fid) sq = sq.eq('facility_id', fid)
        else if (scopeIds && scopeIds.length) sq = sq.in('facility_id', scopeIds)
        const { data, error } = await sq
        if (error || !data || !data.length) break
        data.forEach(r => {
          const name = commLookup[r.commodity_id]
          if (name) stockMap[name] = (stockMap[name] || 0) + r.quantity
        })
        if (data.length < PAGE) break
      }
    }

    const rows = summary.rows.filter(r => rowMatchesFilter(r) && matchesCategory(r))
    const title = `${getReportCategoryLabel(category)} ${tab === 'weekly' ? 'Weekly' : 'Monthly'} Report — ${summary.label}`
    const csv = category === 'all'
      ? buildCrrfCsv(rows, title, stockMap)
      : buildActivityCsv(rows, category, title, stockMap)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = `${tab}-${category}-report-${summary.label}.csv`
    a.click()
    toast('CSV exported','green')
  }

  const categoryLabel = getReportCategoryLabel(category)
  const filteredRows = (summary?.rows || []).filter(r => rowMatchesFilter(r) && matchesCategory(r))
  const metrics = getSummaryMetrics(filteredRows, category)

  const TabBtn = ({id,label}) => (
    <button onClick={()=>setTab(id)}
      className={`px-4 py-2 text-sm rounded-lg border transition-colors ${tab===id?'bg-white/8 border-white/15 text-gray-100 font-medium':'border-white/10 text-gray-400 hover:text-gray-200'}`}>
      {label}
    </button>
  )

  const inputCls = "bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500 w-40"

  return (
    <div>
      {!embedded && (
        <div className="mb-6">
          <h1 className="text-xl font-medium text-gray-100">Reports</h1>
          <p className="text-sm text-gray-500 mt-1">Weekly and monthly activity reports for {categoryLabel.toLowerCase()}</p>
        </div>
      )}

      <Card className="mb-20 overflow-visible">
        <CardBody className="overflow-visible">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="relative pt-4">
              <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Activity Types</label>
              <button onClick={() => setShowActivityDropdown(!showActivityDropdown)}
                className={`${inputCls} text-left flex items-center justify-between cursor-pointer hover:bg-white/10`}>
                <span>{selectedActivityTypes.size === 0 ? 'Select activities' : `${selectedActivityTypes.size} selected`}</span>
                <span className="text-xs">▼</span>
              </button>
              {showActivityDropdown && (
                <div className="absolute top-full left-0 mt-1 bg-gray-900 border border-white/20 rounded-lg p-2 z-50 min-w-48 shadow-xl">
                  {activityTypes.map(act => (
                    <label key={act.key} className="flex items-center gap-2 px-2 py-1.5 hover:bg-white/5 rounded cursor-pointer">
                      <input type="checkbox"
                        checked={selectedActivityTypes.has(act.key)}
                        onChange={(e) => {
                          const newSet = new Set(selectedActivityTypes)
                          if (e.target.checked) {
                            newSet.add(act.key)
                          } else {
                            newSet.delete(act.key)
                          }
                          setSelectedActivityTypes(newSet)
                          setSummary(null)
                        }}
                        className="w-4 h-4 cursor-pointer"
                      />
                      <span className="text-sm text-gray-200">{act.label}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            {isAdmin && (
              <div className="pt-4">
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Facility</label>
                <select value={facFilter} onChange={e => { setFacFilter(e.target.value); setSummary(null) }} className={inputCls}>
                  <option value="">All facilities</option>
                  {facilityOptions.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </div>
            )}

            {isAdmin && (
              <div className="pt-4">
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Category</label>
                <select value={catFilter} onChange={e => setCatFilter(e.target.value)} className={inputCls}>
                  <option value="">All categories</option>
                  {categoryOptions.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            )}
          </div>
        </CardBody>
      </Card>

      <div className="flex gap-2 mb-4">
        <TabBtn id="weekly" label="Weekly"/><TabBtn id="monthly" label="Monthly"/>
      </div>

      <Card>
        <CardBody className="flex gap-3 items-end flex-wrap">
          {tab === 'weekly' ? (
            <>
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Week from</label>
                <input type="date" value={wFrom} onChange={e => setWFrom(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">To</label>
                <input type="date" value={wTo} onChange={e => setWTo(e.target.value)} className={inputCls} />
              </div>
            </>
          ) : (
            <div>
              <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Month</label>
              <input type="month" value={month} onChange={e => setMonth(e.target.value)} className={inputCls} />
            </div>
          )}
          <button onClick={tab === 'weekly' ? loadWeekly : loadMonthly} disabled={loading}
            className="bg-green-500 hover:bg-green-400 disabled:opacity-50 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors">
            Load
          </button>
          {summary && <button onClick={exportCSV}
            className="border border-white/10 text-gray-400 hover:text-gray-200 rounded-lg px-4 py-2 text-sm transition-colors">
            Download CSV
          </button>}
        </CardBody>
      </Card>

      {loading ? <LoadingState /> : (
        <>
          {metrics.length > 0 && (
            <MetricGrid>
              {metrics.map(m => <Metric key={m.label} label={m.label} value={m.value} color={m.color} />)}
            </MetricGrid>
          )}

          <Card>
            <CardHeader>
              <CardTitle>{tab === 'weekly' ? 'Weekly' : 'Monthly'} {categoryLabel} summary</CardTitle>
            </CardHeader>
            {filteredRows.length ? (
              <>
                <div className="px-4 py-3 flex gap-2 items-center border-b border-white/5">
                  <input type="checkbox"
                    checked={selectedActivities.size === filteredRows.length && filteredRows.length > 0}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedActivities(new Set(filteredRows.map((_, i) => i)))
                      } else {
                        setSelectedActivities(new Set())
                      }
                    }}
                    className="w-4 h-4 cursor-pointer"
                  />
                  <span className="text-xs text-gray-400">{selectedActivities.size > 0 ? `${selectedActivities.size} selected` : 'Select all'}</span>
                </div>
                <div className="table-wrap"><table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/8 bg-white/2">
                      <th className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium w-8"></th>
                      {['Date','Activity','Commodity','Category','Quantity','Unit','Facility','Status','Notes'].map(label => (
                        <th key={label} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map((row, index) => {
                      const isSelected = selectedActivities.has(index)
                      return (
                        <tr key={`${row.id}-${index}`} className={`border-b border-white/5 hover:bg-white/2 ${isSelected ? 'bg-white/5' : ''}`}>
                          <td className="px-4 py-3">
                            <input type="checkbox"
                              checked={isSelected}
                              onChange={(e) => {
                                const newSet = new Set(selectedActivities)
                                if (e.target.checked) {
                                  newSet.add(index)
                                } else {
                                  newSet.delete(index)
                                }
                                setSelectedActivities(newSet)
                              }}
                              className="w-4 h-4 cursor-pointer"
                            />
                          </td>
                          <td className="px-4 py-3 font-medium text-gray-100">{row.date?.slice(0,10) || '—'}</td>
                          <td className="px-4 py-3"><Badge type={ACTIVITY_BADGE[row.activity] || 'info'}>{row.activity}</Badge></td>
                          <td className="px-4 py-3 font-medium text-gray-100">{row.commodity}</td>
                          <td className="px-4 py-3"><CatBadge>{row.category}</CatBadge></td>
                          <td className="px-4 py-3">{renderQty(row)}</td>
                          <td className="px-4 py-3 text-gray-300">{row.unit}</td>
                          <td className="px-4 py-3 text-gray-300">{row.facility}</td>
                          <td className="px-4 py-3 text-gray-300">{row.status}</td>
                          <td className="px-4 py-3 text-gray-300">{row.notes}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table></div>
              </>
            ) : <EmptyState message={`No ${category === 'all' ? 'activity' : categoryLabel.toLowerCase()} recorded for this ${tab}.`} />}
          </Card>
        </>
      )}
    </div>
  )
}
