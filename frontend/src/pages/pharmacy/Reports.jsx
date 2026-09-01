import { useState, useEffect } from 'react'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/appStore'
import { Card, CardHeader, CardTitle, CardBody } from '../../components/ui/Card'
import { MetricGrid, Metric } from '../../components/ui/Metric'
import { Badge, CatBadge } from '../../components/ui/Badge'
import { Pagination } from '../../components/ui/Pagination'
import { FacilityPicker } from '../../components/ui/FacilityPicker'

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
import { REPORT_CATEGORIES, getReportCategoryLabel, fetchActivityPage, fetchReportRows, buildCrrfCsv, buildActivityCsv, buildCrrfByFacilityCsv, buildConsumptionByFacilityCsv, getSummaryMetrics } from '../../utils/reports'

export function Reports({ embedded = false } = {}) {
  const store = useAppStore()
  const [tab, setTab]       = useState('weekly')
  const now   = new Date()
  const dayOfWeek = now.getDay() || 7
  const monday = new Date(now); monday.setDate(now.getDate()-dayOfWeek+1)
  const sunday = new Date(monday); sunday.setDate(monday.getDate()+6)
  const wFrom0 = monday.toISOString().split('T')[0]
  const wTo0   = sunday.toISOString().split('T')[0]
  // The last day of the week that starts on `from` (inclusive, so +6 days). Built in
  // UTC so it cannot slide a day across the timezone offset.
  const weekEnd = (from) => {
    const d = new Date(`${from}T00:00:00Z`)
    if (isNaN(d)) return from
    d.setUTCDate(d.getUTCDate() + 6)
    return d.toISOString().slice(0, 10)
  }
  const month0 = now.toISOString().slice(0,7)

  const [wFrom, setWFrom]     = useState(wFrom0)
  const [wTo, setWTo]         = useState(wTo0)
  const [month, setMonth]     = useState(month0)
  const [summary, setSummary] = useState(null)
  // The table now shows ONE page fetched from /api/activity instead of every row
  // for the period. A month is ~23,000 rows across four logs — previously drained
  // in ~24 sequential requests to fill one screen.
  const [range, setRange]     = useState(null)   // { from, to, label }
  const [feed, setFeed]       = useState(null)   // { rows, total }
  const [feedPage, setFeedPage] = useState(0)
  const [feedLoading, setFeedLoading] = useState(false)
  const [loading, setLoading] = useState(false)
  const [selectedActivities, setSelectedActivities] = useState(new Set())
  const [selectedActivityTypes, setSelectedActivityTypes] = useState(() => {
    const c = store.currentReportCategory
    return ['dispense','intake','adjustment','transfer'].includes(c) ? new Set([c]) : new Set(['dispense','intake','adjustment','transfer'])
  })
  const [showActivityDropdown, setShowActivityDropdown] = useState(false)
  const [catFilter, setCatFilter] = useState('')   // admin: commodity category ('' = all)

  // The Activity Types selector is the single source of truth for the report:
  // exactly one type loads that activity; multiple (or all) load everything and
  // the table/CSV are narrowed to the ticked types.
  const category = selectedActivityTypes.size === 1 ? [...selectedActivityTypes][0] : 'all'

  // Admins span both sections, so don't scope by a section commodity list
  // (the huge IN() filter silently drops rows). The facility scope follows the
  // hierarchical filter (facility / LGA / state / all). Facility users stay
  // scoped to their facility + section commodities.
  const isAdmin = store.isAdmin()
  const { fid, scopeIds } = store.getAdminStockScope()
  const commIds = isAdmin ? null : store.allCommodities.map(c => c.id)
  // A section-scoped admin (HQ viewer) filters reports to its section; commIds
  // stays null and `section` does the filtering server-side (avoids a huge IN()).
  const commoditySection = store.commoditySection

  // Reset the loaded summary whenever the facility scope changes so the report
  // is reloaded against the new selection.
  useEffect(() => { setSummary(null) }, [fid, store.adminFilterState, store.adminFilterLGA])

  // Admin commodity-category options (both sections).
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
  // Admins get a cross-facility view; internal moves (Store→Dispensary and
  // SDP/DSD site dispatches, which aren't external redistributions) would just
  // crowd it, so drop them. CRRF already counts external transfers only.
  const notInternalForAdmin = row => !(isAdmin && row.activity === 'Transfer' && !row.external)

  // A "week" is the seven days from the chosen start. The two inputs were free, so
  // any span could be loaded and still be titled Weekly — a five-week range exported
  // as "All Weekly Report" reads as one week's activity to whoever opens the file.
  // Clamp here and say so, rather than mislabel the result.
  async function loadWeekly() {
    setFeedPage(0)
    const end = weekEnd(wFrom)
    if (wTo !== end) {
      setWTo(end)
      toast(`A week runs ${wFrom} to ${end} — end date adjusted`, 'amber')
    }
    setRange({ from: wFrom, to: end, label: `${wFrom} to ${end}` })
  }

  async function loadMonthly() {
    setFeedPage(0)
    const from = month + '-01'
    const lastDay = new Date(month.split('-')[0], month.split('-')[1], 0).getDate()
    setRange({ from, to: `${month}-${String(lastDay).padStart(2,'0')}`, label: month })
  }

  // The activity types the checkboxes leave selected, as feed `types`. Filtering
  // server-side is what keeps the page count honest: dropping rows in the browser
  // would leave "page 2 of 24" counting rows that are never shown.
  const feedTypes = ['dispense','intake','adjustment','transfer'].filter(t => selectedActivityTypes.has(t))
  const feedTypesKey = feedTypes.join(',')
  const scopeIdsKey = (scopeIds && scopeIds.length) ? scopeIds.join(',') : ''

  useEffect(() => {
    if (!range) { setFeed(null); return }
    let live = true
    setFeedLoading(true)
    fetchActivityPage({
      from: range.from, to: range.to, fid, scopeIds, commIds,
      section: commoditySection,
      types: category === 'all' ? feedTypes : [category],
      category: catFilter || undefined,
      externalOnly: isAdmin,
      limit: 50, offset: feedPage * 50,
    }).then(res => {
      if (!live) return
      setFeed(res)
      setSummary({ rows: res.rows, label: range.label })
      setFeedLoading(false)
    })
    return () => { live = false }
  }, [range?.from, range?.to, feedPage, category, catFilter, fid, scopeIdsKey, feedTypesKey])

  // Download helper.
  function downloadCsv(csv, name) {
    // Prepend a UTF-8 BOM so Excel decodes special characters (—, →, accents)
    // correctly instead of showing mojibake in place of the em dash.
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = name
    a.click()
    toast('CSV exported','green')
  }

  async function exportCSV(includeAll = false) {
    if (!range) { toast('Load data first','red'); return }
    // The TABLE shows one page; an export must not. Fetch the whole period here
    // rather than exporting `summary.rows`, which is now just the visible 50 —
    // a silent truncation would be far worse than a slow download.
    setLoading(true)
    const allRows = await fetchReportRows({
      category, from: range.from, to: range.to, fid, scopeIds, commIds, section: commoditySection,
    }).catch(() => [])
    setLoading(false)
    const rows = allRows.filter(r => rowMatchesFilter(r) && matchesCategory(r) && notInternalForAdmin(r))
    if (!rows.length) { toast('Nothing to export for this selection','red'); return }
    const title = `${getReportCategoryLabel(category)} ${tab === 'weekly' ? 'Weekly' : 'Monthly'} Report, ${range.label}`
    const commLookup = {}
    store.allCommodities.forEach(c => { commLookup[c.id] = c.name })

    // Admin spanning multiple facilities: break the CRRF / Consumption summary
    // down per facility (with LGA) rather than one rolled-up total.
    if (isAdmin && !fid && (category === 'all' || category === 'dispense')) {
      const facStock = {}   // facilityName → { commodityName → SOH }
      const lgaByName = {}
      store.allFacilities.forEach(f => { lgaByName[f.name] = f.lga || '' })
      const PAGE = 1000
      const addFac = (r) => {
        const fname = r.facilities?.name, cname = commLookup[r.commodity_id]
        if (!fname || !cname) return
        if (!facStock[fname]) facStock[fname] = {}
        facStock[fname][cname] = (facStock[fname][cname] || 0) + r.quantity
      }
      // CRRF ending balance = total SOH: store + dispensary (/api/stock) plus the
      // facility's DSD + SDP site stock. Consumption keeps store + dispensary only.
      const facFns = category === 'all'
        ? [api.stock.list, api.stock.dsd.list, api.stock.sdp.list]
        : [api.stock.list]
      for (const listFn of facFns) {
        for (let offset = 0; ; offset += PAGE) {
          let data
          try { data = await listFn({ facility_ids: (scopeIds && scopeIds.length) ? scopeIds : undefined, limit: PAGE, offset }) } catch { break }
          if (!data || !data.length) break
          data.forEach(addFac)
          if (data.length < PAGE) break
        }
      }
      // "All facilities" mode (CRRF only): seed every in-scope facility so those
      // with no activity in the period still appear, showing their stock balances.
      const allFacs = (includeAll && category === 'all')
        ? (store.allFacilities || [])
            .filter(f => !(scopeIds && scopeIds.length) || scopeIds.includes(f.id))
            .map(f => ({ name: f.name, lga: f.lga || '' }))
        : null
      // All-facilities export also lists EVERY commodity as a column, even unused ones.
      const allComms = (includeAll && category === 'all') ? store.allCommodities.map(c => c.name) : null
      const csv = category === 'dispense'
        ? buildConsumptionByFacilityCsv(rows, title, facStock, lgaByName)
        : buildCrrfByFacilityCsv(rows, title, facStock, lgaByName, allFacs, allComms)
      downloadCsv(csv, `${tab}-${category}-by-facility${allFacs ? '-all-facilities' : ''}-${summary.label}.csv`)
      return
    }

    // Single facility (or per-transaction activity): commodity total + balance.
    // CRRF ending balance = total SOH (store + dispensary + DSD + SDP); other
    // activity reports keep store + dispensary only.
    const stockMap = {}
    if (fid || isAdmin) {
      const PAGE = 1000
      const stParams = { facility_id: fid || undefined, facility_ids: (!fid && scopeIds && scopeIds.length) ? scopeIds : undefined }
      const stFns = category === 'all'
        ? [api.stock.list, api.stock.dsd.list, api.stock.sdp.list]
        : [api.stock.list]
      for (const listFn of stFns) {
        for (let offset = 0; ; offset += PAGE) {
          let data
          try { data = await listFn({ ...stParams, limit: PAGE, offset }) } catch { break }
          if (!data || !data.length) break
          data.forEach(r => { const name = commLookup[r.commodity_id]; if (name) stockMap[name] = (stockMap[name] || 0) + r.quantity })
          if (data.length < PAGE) break
        }
      }
    }

    const csv = category === 'all'
      ? buildCrrfCsv(rows, title, stockMap)
      : buildActivityCsv(rows, category, title, stockMap)
    downloadCsv(csv, `${tab}-${category}-report-${summary.label}.csv`)
  }

  const categoryLabel = getReportCategoryLabel(category)
  const filteredRows = (summary?.rows || []).filter(r => rowMatchesFilter(r) && matchesCategory(r) && notInternalForAdmin(r))
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

      <FacilityPicker />

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
                <input type="date" value={wFrom}
                  onChange={e => { setWFrom(e.target.value); setWTo(weekEnd(e.target.value)) }}
                  className={inputCls} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">To</label>
                {/* Derived from the start date: a weekly report covers exactly seven days. */}
                <input type="date" value={wTo} readOnly disabled
                  className={`${inputCls} opacity-70 cursor-not-allowed`} />
              </div>
            </>
          ) : (
            <div>
              <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Month</label>
              <input type="month" value={month} onChange={e => setMonth(e.target.value)} className={inputCls} />
            </div>
          )}
          <button onClick={tab === 'weekly' ? loadWeekly : loadMonthly} disabled={loading || feedLoading}
            className="bg-green-500 hover:bg-green-400 disabled:opacity-50 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors">
            Load
          </button>
          {summary && <button onClick={() => exportCSV(false)}
            className="border border-white/10 text-gray-400 hover:text-gray-200 rounded-lg px-4 py-2 text-sm transition-colors">
            Download CSV
          </button>}
          {summary && isAdmin && !fid && category === 'all' && (
            <button onClick={() => exportCSV(true)}
              className="border border-white/10 text-gray-400 hover:text-gray-200 rounded-lg px-4 py-2 text-sm transition-colors">
              Download all facilities
            </button>
          )}
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
                  <span className="text-xs text-gray-400">{selectedActivities.size > 0 ? `${selectedActivities.size} selected` : 'Select all on this page'}</span>
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
                {/* Page numbers come from the server's `total`, so this counts the
                    whole period rather than the rows currently in memory. */}
                <Pagination
                  pager={{
                    page: feedPage,
                    pages: Math.max(1, Math.ceil((feed?.total || 0) / 50)),
                    total: feed?.total || 0,
                    from: (feed?.total || 0) ? feedPage * 50 + 1 : 0,
                    to: Math.min(feed?.total || 0, (feedPage + 1) * 50),
                  }}
                  onPage={setFeedPage}
                  unit="records"/>
              </>
            ) : <EmptyState message={`No ${category === 'all' ? 'activity' : categoryLabel.toLowerCase()} recorded for this ${tab}.`} />}
          </Card>
        </>
      )}
    </div>
  )
}
