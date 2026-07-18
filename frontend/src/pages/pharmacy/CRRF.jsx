import { useState } from 'react'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/appStore'
import { Card, CardHeader, CardTitle, CardBody } from '../../components/ui/Card'
import { LoadingState, EmptyState } from '../../components/ui/Loading'
import { toast } from '../../components/ui/Toast'
import { FacilityPicker } from '../../components/ui/FacilityPicker'
import { NON_CRRF_ADJ_REASONS } from '../../utils/reports'
import { CRRF_TEMPLATES } from '../../utils/crrfTemplates'
import { CRRF_ALIASES } from '../../utils/crrfAliases'

// Key a template row the same way the alias map targets it: "<name>|<unit-or-pack>".
const tKey = it => `${it.name}|${it.unit || it.pack || ''}`
const zeros = base => ({ ...base, A: 0, received: 0, dispensed: 0, adjPos: 0, adjNeg: 0, losses: 0, E: 0, F: 0, G: 0, distributed: 0 })
const withData = (base, d) => ({ ...base, A: d.A, received: d.received, dispensed: d.dispensed, adjPos: d.adjPos, adjNeg: d.adjNeg, losses: d.losses, E: d.E, F: d.F, G: d.G, distributed: d.distributed || 0 })

// Full template-ordered CRRF rows (zeros where the facility has no data). A
// commodity reports on a template row only when it maps there EXACTLY — via the
// CRRF_ALIASES map, or an exact name match. No fuzzy matching (it silently
// mis-placed lookalike names). The printed row label always comes from the
// template, never the commodity's DB name.
function buildCrrfRows(variant, allData) {
  const used = new Set()
  const rows = (CRRF_TEMPLATES[variant] || []).map(item => {
    if (item.group) return { group: item.group }
    const key = tKey(item)
    const d = allData.find(x => !used.has(x.commodity) && (CRRF_ALIASES[x.commodity] === key || x.commodity === item.name))
    if (d) used.add(d.commodity)
    const base = { name: item.name, unit: item.unit || d?.unit || '', pack: item.pack || '' }
    return d ? withData(base, d) : zeros(base)
  })
  return { rows, matched: used }
}

// Off-template commodities a facility stocks print as extra rows at the bottom of
// their section's primary form — only where there is activity/stock, so a facility
// only sees what it actually has. Categories are disjoint per variant, so a
// commodity appears as an extra on at most one form.
const EXTRA_CATEGORIES = { arv: ['Pharmacy drugs'], condom: ['Medical supplies'], cd4: ['Lab reagents'], rtk: ['RTKs'] }
const isActive = d => d.received || d.dispensed || d.adjPos || d.adjNeg || d.losses || d.soh
function extraRows(variant, allData, matched) {
  const cats = EXTRA_CATEGORIES[variant] || []
  return allData
    .filter(d => cats.includes(d.category) && isActive(d) && !matched.has(d.commodity) && !CRRF_ALIASES[d.commodity])
    .map(d => withData({ name: d.commodity, unit: d.unit || '', pack: '' }, d))
}

// National CRRF variants per section. Pharmacy: ARV/OI + Condom; Lab: CD4 + RTK/DBS.
const CRRF_VARIANTS = {
  pharmacy: [{ value: 'arv', label: 'ARVs & OIs' }, { value: 'condom', label: 'Condoms & Lubricants' }],
  lab:      [{ value: 'cd4', label: 'CD4' }, { value: 'rtk', label: 'HIV RTKs & DBS' }],
}
const CRRF_PRINTERS = { arv: 'printCrrfArv', condom: 'printCrrfCondom', cd4: 'printCrrfCd4', rtk: 'printCrrfRtk' }

const BI_MONTHLY_PERIODS = [
  { label: 'Jan – Feb', start: '01-01', end: '02', months: [0, 1] },
  { label: 'Mar – Apr', start: '03-01', end: '04', months: [2, 3] },
  { label: 'May – Jun', start: '05-01', end: '06', months: [4, 5] },
  { label: 'Jul – Aug', start: '07-01', end: '08', months: [6, 7] },
  { label: 'Sep – Oct', start: '09-01', end: '10', months: [8, 9] },
  { label: 'Nov – Dec', start: '11-01', end: '12', months: [10, 11] },
]

function getPeriodDates(year, period) {
  const from = `${year}-${period.start}`
  const endMonth = parseInt(period.end, 10)
  const lastDay = new Date(year, endMonth, 0).getDate()
  const to = `${year}-${period.end}-${String(lastDay).padStart(2, '0')}`
  return { from, to }
}

function getCurrentPeriodIndex() {
  const month = new Date().getMonth()
  return BI_MONTHLY_PERIODS.findIndex(p => p.months.includes(month))
}

function generateYears() {
  const currentYear = new Date().getFullYear()
  return [currentYear, currentYear - 1]
}

export function CRRF() {
  const store = useAppStore()
  const commoditySection = store.commoditySection
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [periodIdx, setPeriodIdx] = useState(getCurrentPeriodIndex())
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [generated, setGenerated] = useState(false)
  const [catFilter, setCatFilter] = useState('')
  const section = commoditySection === 'lab' ? 'lab' : 'pharmacy'
  const crrfVariants = CRRF_VARIANTS[section]
  const [variant, setVariant] = useState(() => crrfVariants[0].value)   // ARV/Condom (pharmacy) | CD4/RTK (lab)
  const [allData, setAllData] = useState([])       // full per-commodity computed set (for template matching)

  const fid = store.getEffectiveFacilityId?.() || store.adminFilterFacility?.id || store.currentFacility?.id
  const commIds = store.allCommodities.map(c => c.id)
  const categories = [...new Set(store.allCommodities.map(c => c.category).filter(Boolean))].sort()
  const facility = store.adminFilterFacility || store.currentFacility

  const period = BI_MONTHLY_PERIODS[periodIdx]
  const { from, to } = getPeriodDates(year, period)

  async function generate() {
    if (!fid) { toast('Select a facility first', 'red'); return }
    setLoading(true)
    setGenerated(false)

    const LOSS_REASONS = ['Expired', 'Damaged', 'Lost / Stolen']

    const sec2 = commoditySection || undefined
    const range = { from: from + 'T00:00:00', to: to + 'T23:59:59' }
    const [intakeRes, dispRes, adjRes, stockRes, dsdRes, sdpRes, transferRes] = await Promise.all([
      api.intake.history({ facility_id: fid, commodity_ids: commIds, ...range, section: sec2 }).catch(() => []),
      api.dispense.history({ facility_id: fid, commodity_ids: commIds, ...range, section: sec2 }).catch(() => []),
      api.adjustments.history({ facility_id: fid, commodity_ids: commIds, ...range, section: sec2 }).catch(() => []),
      // Ending balance = TOTAL SOH: store + dispensary (/api/stock) plus the
      // facility's DSD and SDP site stock, so internal store↔site moves net out.
      api.stock.list({ facility_ids: [fid], commodity_ids: commIds }).catch(() => []),
      api.stock.dsd.list({ facility_id: fid }).catch(() => []),
      api.stock.sdp.list({ facility_id: fid }).catch(() => []),
      // section already scopes transfers; date_field/resolved_at uses plain dates.
      api.transfers.list({ facility_id: fid, status: 'accepted', date_field: 'resolved_at', from, to, section: sec2 }).catch(() => []),
    ])

    // Build per-commodity aggregates
    const agg = {}
    store.allCommodities.forEach(c => {
      agg[c.id] = { commodity: c.name, category: c.category || '', unit: c.unit || '', received: 0, dispensed: 0, adjPos: 0, adjNeg: 0, losses: 0, soh: 0 }
    })

    ;(intakeRes || []).forEach(r => { if (agg[r.commodity_id]) agg[r.commodity_id].received += r.quantity })
    ;(dispRes || []).forEach(r => { if (agg[r.commodity_id]) agg[r.commodity_id].dispensed += r.quantity })
    ;(adjRes || []).forEach(r => {
      if (!agg[r.commodity_id]) return
      // Reasons that aren't a real inflow/outflow of the facility's inventory
      // (count reconciliations and internal store↔site redistributions) are excluded.
      if (NON_CRRF_ADJ_REASONS.includes(r.reason)) return
      if (r.adjustment_type === 'Increase')          agg[r.commodity_id].adjPos  += r.quantity
      else if (LOSS_REASONS.includes(r.reason))      agg[r.commodity_id].losses  += r.quantity
      else                                           agg[r.commodity_id].adjNeg  += r.quantity
    })
    ;(stockRes || []).forEach(r => { if (agg[r.commodity_id]) agg[r.commodity_id].soh += r.quantity })
    ;(dsdRes || []).forEach(r => { if (agg[r.commodity_id]) agg[r.commodity_id].soh += r.quantity })
    ;(sdpRes || []).forEach(r => { if (agg[r.commodity_id]) agg[r.commodity_id].soh += r.quantity })
    ;(transferRes || []).forEach(r => {
      if (!agg[r.commodity_id]) return
      // Only EXTERNAL redistribution (facility → another facility) affects the
      // CRRF positive/negative adjustment. Internal moves (Store→Dispensary,
      // same facility) and SDP/DSD dispatches (no receiving facility) are excluded.
      if (!r.sending_facility_id || !r.receiving_facility_id) return
      if (r.sending_facility_id === r.receiving_facility_id) return
      if (r.receiving_facility_id === fid)     agg[r.commodity_id].adjPos += r.quantity
      else if (r.sending_facility_id === fid)  agg[r.commodity_id].adjNeg += r.quantity
    })

    // Only include commodities that have any activity or current stock
    const result = Object.values(agg)
      .filter(r => r.received || r.dispensed || r.adjPos || r.adjNeg || r.losses || r.soh)
      .sort((a, b) => (a.category.localeCompare(b.category)) || a.commodity.localeCompare(b.commodity))
      .map((r, i) => {
        const E = r.soh
        const A = E - r.received + r.dispensed - r.adjPos + r.adjNeg + r.losses
        const F = r.dispensed * 2
        const G = Math.max(0, F - E)
        return { ...r, sno: i + 1, A, E, F, G }
      })

    setRows(result)

    // Full computed set (all commodities, incl. zero-activity) for the national
    // CRRF, which prints the whole template list. Flag active commodities that
    // don't map to any pharmacy template row (naming mismatches to reconcile).
    const full = Object.values(agg).map(r => {
      const E = r.soh, A = E - r.received + r.dispensed - r.adjPos + r.adjNeg + r.losses
      const F = r.dispensed * 2, G = Math.max(0, F - E)
      return { ...r, A, E, F, G }
    })
    setAllData(full)

    setGenerated(true)
    setLoading(false)
  }

  async function printNational() {
    if (!allData.length) { toast('Generate data first', 'red'); return }
    const { rows: tplRows, matched } = buildCrrfRows(variant, allData)
    const extra = extraRows(variant, allData, matched)
    const rowsToPrint = extra.length
      ? [...tplRows, { group: 'Additional commodities (not on the national list)' }, ...extra]
      : tplRows
    const ctx = { facilityName: facility?.name || '', lga: facility?.lga || '', state: facility?.state || '', periodStart: from, periodEnd: to }
    const mod = await import('../../utils/nationalForms')
    mod[CRRF_PRINTERS[variant]](rowsToPrint, ctx)
  }

  const shownRows = catFilter ? rows.filter(r => r.category === catFilter) : rows

  function exportCSV() {
    if (!rows.length) { toast('Generate data first', 'red'); return }
    const facilityName = facility?.name || 'Facility'
    const title = `CRRF — ${facilityName} — ${period.label} ${year}`
    let csv = `${title}\r\n`
    csv += `S/No,Drugs,Basic Unit,Beginning Balance (A),Quantity Received (B),Quantity Dispensed (C),Adj Positive (+),Adj Negative (-),Losses (D),Ending Balance / Physical Count (E),Maximum Stock Qty (F=CX2),Quantity to Order (G=F-E),Remarks\r\n`

    let currentCat = null
    shownRows.forEach(r => {
      if (r.category !== currentCat) {
        currentCat = r.category
        csv += `\r\n"${currentCat}"\r\n`
      }
      csv += `${r.sno},"${r.commodity}","${r.unit}",${r.A},${r.received},${r.dispensed},${r.adjPos},${r.adjNeg},${r.losses},${r.E},${r.F},${r.G},\r\n`
    })

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = `crrf-${year}-${period.start.slice(0,2)}.csv`
    a.click()
    toast('CRRF exported', 'green')
  }

  function printCRRF() {
    if (!rows.length) { toast('Generate data first', 'red'); return }
    const facilityName = facility?.name || 'Facility'
    const lga = facility?.lga || ''
    const state = facility?.state || ''
    const printDate = new Date().toLocaleDateString('en-GB', { day:'2-digit', month:'long', year:'numeric' })
    const title = `CRRF — ${facilityName} — ${period.label} ${year}`

    let tableRows = ''
    let lastCat = null
    shownRows.forEach(r => {
      if (r.category !== lastCat) {
        lastCat = r.category
        tableRows += `<tr class="cat-row"><td colspan="13">${r.category}</td></tr>`
      }
      tableRows += `<tr>
        <td>${r.sno}</td>
        <td>${r.commodity}</td>
        <td>${r.unit}</td>
        <td>${r.A}</td>
        <td>${r.received}</td>
        <td>${r.dispensed}</td>
        <td>${r.adjPos}</td>
        <td>${r.adjNeg}</td>
        <td>${r.losses}</td>
        <td><strong>${r.E}</strong></td>
        <td>${r.F}</td>
        <td>${r.G}</td>
        <td></td>
      </tr>`
    })

    const html = `
      <style>
        body { font-family: Arial, sans-serif; font-size: 9pt; color: #000; margin: 0; }
        h2 { margin: 0 0 2px; font-size: 13pt; }
        .meta { font-size: 8pt; color: #555; margin-bottom: 12px; }
        table { width: 100%; border-collapse: collapse; font-size: 8pt; }
        th { background: #e8e8e8; border: 1px solid #bbb; padding: 5px 6px; text-align: center; font-weight: 700; font-size: 7.5pt; }
        td { border: 1px solid #ccc; padding: 4px 6px; vertical-align: middle; }
        tr:nth-child(even) td { background: #f8f8f8; }
        tr.cat-row td { background: #d0d8e8; font-weight: 700; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.05em; padding: 5px 6px; }
        @media print { @page { size: A4 landscape; margin: 12mm; } }
        .sig-section { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; margin-top: 32px; }
        .sig-block { border: 1px solid #ccc; padding: 10px 12px; }
        .sig-block .role { font-size: 8.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 10px; }
        .sig-field { display: grid; grid-template-columns: 80px 1fr; align-items: flex-end; gap: 6px; margin-top: 10px; }
        .sig-field label { font-size: 7.5pt; color: #888; text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap; }
        .sig-field .line { border-bottom: 1px solid #000; min-height: 18px; }
      </style>
      <h2>Commodity Reporting and Requisition Form (CRRF)</h2>
      <div class="meta">
        Facility: <strong>${facilityName}</strong>${lga ? ' &nbsp;·&nbsp; LGA: ' + lga : ''}${state ? ' &nbsp;·&nbsp; State: ' + state : ''} &nbsp;·&nbsp;
        Period: <strong>${period.label} ${year}</strong> &nbsp;·&nbsp; Printed: ${printDate}
      </div>
      <table>
        <thead>
          <tr>
            <th rowspan="2">S/No</th>
            <th rowspan="2">Drugs</th>
            <th rowspan="2">Basic Unit</th>
            <th>A</th><th>B</th><th>C</th>
            <th>Adj (+)</th><th>Adj (−)</th><th>D</th>
            <th>E</th><th>F</th><th>G</th>
            <th rowspan="2">Remarks</th>
          </tr>
          <tr>
            <th>Beg. Balance</th><th>Qty Received</th><th>Qty Dispensed</th>
            <th>Positive</th><th>Negative</th><th>Losses</th>
            <th>Ending Bal.</th><th>Max Stock (C×2)</th><th>Qty to Order (F−E)</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
      <div class="sig-section">
        <div class="sig-block">
          <div class="role">Prepared by</div>
          <div class="sig-field"><label>Name</label><div class="line"></div></div>
          <div class="sig-field"><label>Signature</label><div class="line"></div></div>
          <div class="sig-field"><label>Phone no.</label><div class="line"></div></div>
          <div class="sig-field"><label>Date</label><div class="line"></div></div>
        </div>
        <div class="sig-block">
          <div class="role">Approved by</div>
          <div class="sig-field"><label>Name</label><div class="line"></div></div>
          <div class="sig-field"><label>Signature</label><div class="line"></div></div>
          <div class="sig-field"><label>Phone no.</label><div class="line"></div></div>
          <div class="sig-field"><label>Date</label><div class="line"></div></div>
        </div>
      </div>`

    const blob = new Blob([`<!DOCTYPE html><html><head><meta charset="utf-8"><title>CRRF</title></head><body style="margin:12mm">${html}</body></html>`], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    const win = window.open(url, '_blank')
    if (win) {
      win.onload = () => {
        win.focus()
        win.print()
        URL.revokeObjectURL(url)
        win.onafterprint = () => win.close()
      }
    } else {
      URL.revokeObjectURL(url)
      toast('Allow pop-ups to print', 'red')
    }
  }

  const inputCls = "bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
  const years = generateYears()

  // Off-template commodities this facility stocks — appended to the printed form.
  const currentExtras = generated && allData.length
    ? extraRows(variant, allData, buildCrrfRows(variant, allData).matched).map(r => r.name)
    : []

  // Group rows by category for rendering (honouring the category filter)
  const grouped = []
  let lastCat = null
  shownRows.forEach(r => {
    if (r.category !== lastCat) { grouped.push({ type: 'cat', label: r.category }); lastCat = r.category }
    grouped.push({ type: 'row', ...r })
  })

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-medium text-gray-100">CRRF</h1>
        <p className="text-sm text-gray-500 mt-1">Commodity Reporting and Requisition Form — bi-monthly</p>
      </div>

      <FacilityPicker />

      {facility && (
        <div className="mb-4 text-sm text-gray-400">
          <span className="text-gray-300 font-medium">{facility.name}</span>
          {facility.lga && <span> · {facility.lga}</span>}
          {facility.state && <span> · {facility.state}</span>}
        </div>
      )}

      <Card className="mb-4">
        <CardBody className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Year</label>
            <select value={year} onChange={e => { setYear(Number(e.target.value)); setGenerated(false) }} className={inputCls}>
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Bi-monthly period</label>
            <select value={periodIdx} onChange={e => { setPeriodIdx(Number(e.target.value)); setGenerated(false) }} className={inputCls}>
              {BI_MONTHLY_PERIODS.map((p, i) => <option key={i} value={i}>{p.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">CRRF type</label>
            <select value={variant} onChange={e => setVariant(e.target.value)} className={inputCls}>
              {crrfVariants.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
            </select>
          </div>
          <button onClick={generate} disabled={loading}
            className="bg-green-500 hover:bg-green-400 disabled:opacity-50 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors">
            {loading ? 'Loading…' : 'Generate'}
          </button>
          {generated && rows.length > 0 && (
            <div>
              <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Category</label>
              <select value={catFilter} onChange={e => setCatFilter(e.target.value)} className={inputCls}>
                <option value="">All categories</option>
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          )}
          {generated && rows.length > 0 && (
            <>
              <button onClick={exportCSV}
                className="border border-white/10 text-gray-400 hover:text-gray-200 rounded-lg px-4 py-2 text-sm transition-colors">
                Download CSV
              </button>
              <button onClick={printNational}
                className="border border-white/10 text-gray-400 hover:text-gray-200 rounded-lg px-4 py-2 text-sm transition-colors flex items-center gap-1.5">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                  <path d="M4 5V2h8v3M4 11H2V6h12v5h-2M4 9h8v5H4z"/>
                </svg>
                Print CRRF
              </button>
            </>
          )}
        </CardBody>
      </Card>

      {generated && currentExtras.length > 0 && (
        <div className="mb-4 text-xs text-sky-300 bg-sky-500/10 border border-sky-500/30 rounded-lg px-3 py-2">
          {currentExtras.length} stocked commodit{currentExtras.length > 1 ? 'ies are' : 'y is'} not on the national {crrfVariants.find(v => v.value === variant)?.label} list — {currentExtras.length > 1 ? 'they' : 'it'} will print as extra row{currentExtras.length > 1 ? 's' : ''} at the bottom: {currentExtras.slice(0, 8).join(', ')}{currentExtras.length > 8 ? '…' : ''}
        </div>
      )}

      {loading ? <LoadingState /> : generated ? (
        <Card>
          <CardHeader>
            <CardTitle>CRRF — {period.label} {year}</CardTitle>
          </CardHeader>
          {shownRows.length === 0 ? (
            <EmptyState message={rows.length === 0 ? "No activity recorded for this period." : `No ${catFilter} commodities in this period.`} />
          ) : (
            <div className="table-wrap">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/8 bg-white/2">
                    {['S/No','Drugs','Unit','A: Beg. Balance','B: Received','C: Dispensed','Adj +','Adj –','D: Losses','E: Ending Bal.','F: Max Stock','G: To Order','Remarks'].map(h => (
                      <th key={h} className="text-left px-3 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {grouped.map((item, idx) => item.type === 'cat' ? (
                    <tr key={`cat-${idx}`} className="bg-white/3">
                      <td colSpan={13} className="px-3 py-2 text-xs font-semibold text-gray-300 uppercase tracking-widest">{item.label}</td>
                    </tr>
                  ) : (
                    <tr key={`row-${item.sno}`} className="border-b border-white/5 hover:bg-white/2">
                      <td className="px-3 py-3 text-gray-500">{item.sno}</td>
                      <td className="px-3 py-3 font-medium text-gray-100">{item.commodity}</td>
                      <td className="px-3 py-3 text-gray-400">{item.unit}</td>
                      <td className="px-3 py-3 font-mono text-gray-300">{item.A}</td>
                      <td className="px-3 py-3 font-mono text-green-400">{item.received}</td>
                      <td className="px-3 py-3 font-mono text-blue-400">{item.dispensed}</td>
                      <td className="px-3 py-3 font-mono text-amber-400">{item.adjPos}</td>
                      <td className="px-3 py-3 font-mono text-red-400">{item.adjNeg}</td>
                      <td className="px-3 py-3 font-mono text-red-400">{item.losses}</td>
                      <td className="px-3 py-3 font-mono text-gray-100 font-medium">{item.E}</td>
                      <td className="px-3 py-3 font-mono text-gray-300">{item.F}</td>
                      <td className="px-3 py-3 font-mono text-purple-400">{item.G}</td>
                      <td className="px-3 py-3 text-gray-600">—</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}
    </div>
  )
}
