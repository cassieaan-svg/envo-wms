import { api } from '../lib/api'

// Adjustment reasons that must NOT feed the CRRF's Adj +/−/Losses columns.
// They aren't a real inflow/outflow of the facility's inventory:
//   - Physical count correction → reconciles the books to a physical count; not
//     stock entering or leaving the facility, so it is not a CRRF adjustment.
//   - Returned from Dispensary/DSD/SDP → internal store↔site redistribution
//     (the outbound store→site dispatch is likewise excluded), so both legs net
//     out and neither should register as a CRRF adjustment.
export const NON_CRRF_ADJ_REASONS = [
  'Physical count correction',
  'Returned from Dispensary',
  'Returned from DSD',
  'Returned from SDP',
]

// "Quantity Received" on the CRRF counts GHSC-PSM deliveries ONLY, not every intake.
// supplier_source is free text, so match rather than compare: the same supplier is
// entered as GHSC-PSM, GHSC/PSM, GHSCPSM, psm and (once) the typo GHSC/PSC.
//
// NOTE this deliberately breaks the form's arithmetic: roughly 90% of intakes name
// some other source (baseline stock, state office, stock taking), and that stock is
// real. A + B − C ± adj will therefore NOT equal E whenever a facility received
// anything outside GHSC-PSM. Beginning and Ending Balance are each computed from the
// stock ledger instead of being derived from B, so the gap shows up as a gap rather
// than being silently absorbed into the opening balance.
export const isGhscPsmSupplier = (s) => /ghsc|psm/i.test(String(s || ''))

// The NET change in total stock on hand that a set of movement rows represents.
// This is a STOCK question, not a CRRF-presentation one, so it counts everything that
// actually moved stock — including the physical count corrections and site returns the
// CRRF columns exclude. Leaving those out would make a rewound balance drift.
//
// Internal moves (store↔dispensary, store→DSD/SDP) are omitted because SOH here is the
// facility total across all bins: those shuffle stock between bins without changing it.
export function netStockChange({ intakes = [], dispenses = [], adjustments = [], transfers = [] }, facilityId) {
  let net = 0
  for (const r of intakes)   net += r.quantity || 0
  for (const r of dispenses) net -= r.quantity || 0
  for (const r of adjustments) {
    net += (r.adjustment_type === 'Decrease' ? -1 : 1) * (r.quantity || 0)
  }
  for (const r of transfers) {
    // External redistribution only — see above.
    if (!r.sending_facility_id || !r.receiving_facility_id) continue
    if (r.sending_facility_id === r.receiving_facility_id) continue
    if (r.receiving_facility_id === facilityId)   net += r.quantity || 0
    else if (r.sending_facility_id === facilityId) net -= r.quantity || 0
  }
  return net
}

export const REPORT_CATEGORIES = [
  { key: 'all', label: 'All' },
  { key: 'dispense', label: 'Consumption' },
  { key: 'intake', label: 'Intake' },
  { key: 'adjustment', label: 'Adjustment' },
  { key: 'transfer', label: 'Transfer' },
]

export function getReportCategoryLabel(key) {
  const category = REPORT_CATEGORIES.find(cat => cat.key === key)
  return category ? category.label : 'All'
}

const toRange = (from, to) => ({
  start: `${from}T00:00:00`,
  end: `${to}T23:59:59`,
})

const normalizeDispense = row => ({
  id: row.id,
  activity: 'Consumption',
  commodity: row.commodities?.name || row.commodity_name || 'Unknown',
  category: row.commodities?.category || 'Unknown',
  quantity: row.quantity || 0,
  unit: row.commodities?.unit || '',
  date: row.dispensed_at || row.created_at || '',
  facility: row.facilities?.name || row.facility_name || '',
  lga: row.facilities?.lga || '',
  status: row.status || '',
  notes: row.notes || '',
})

const normalizeIntake = row => ({
  id: row.id,
  activity: 'Intake',
  commodity: row.commodities?.name || row.commodity_name || 'Unknown',
  category: row.commodities?.category || 'Unknown',
  quantity: row.quantity || 0,
  unit: row.commodities?.unit || '',
  date: row.received_at || row.created_at || '',
  facility: row.facilities?.name || row.facility_name || '',
  lga: row.facilities?.lga || '',
  status: row.status || '',
  notes: row.notes || '',
  supplier: row.supplier_source || '',
})

const normalizeAdjustment = row => ({
  id: row.id,
  activity: 'Adjustment',
  commodity: row.commodities?.name || row.commodity_name || 'Unknown',
  category: row.commodities?.category || 'Unknown',
  quantity: row.adjustment_type === 'Decrease' ? -(row.quantity || 0) : (row.quantity || 0),
  unit: row.commodities?.unit || '',
  date: row.adjusted_at || row.created_at || '',
  facility: row.facilities?.name || row.facility_name || '',
  lga: row.facilities?.lga || '',
  status: row.adjustment_type || row.status || '',
  reason: row.reason || '',
  notes: row.notes || '',
})

const normalizeTransfer = (row, fid) => {
  const isOut = fid && row.sending_facility_id === fid
  // External redistribution = a move between two different facilities. Internal
  // moves (Store→Dispensary, same facility) and SDP/DSD dispatches (no
  // receiving facility) are NOT external and must not affect CRRF adjustments.
  const external = !!row.sending_facility_id && !!row.receiving_facility_id &&
                   row.sending_facility_id !== row.receiving_facility_id
  return {
    id: row.id,
    activity: 'Transfer',
    commodity: row.commodities?.name || row.commodity_name || 'Unknown',
    category: row.commodities?.category || 'Unknown',
    quantity: isOut ? -(row.quantity || 0) : (row.quantity || 0),
    unit: row.commodities?.unit || '',
    date: row.resolved_at || row.initiated_at || '',
    facility: `${row.sending_facility_name || ''} → ${row.receiving_facility_name || ''}`.trim(),
    direction: isOut ? 'Stock out' : 'Stock in',
    external,
    sendingName: row.sending_facility_name || '',
    receivingName: row.receiving_facility_name || '',
    qtyAbs: row.quantity || 0,
    status: row.status || '',
    notes: row.notes || '',
  }
}

// Pull a log table's rows over a date range, paginating past the 1000-row cap.
// `listFn` is the api history method (api.dispense.history / intake / adjustments);
// it already applies the right date field, facility scoping (server-side) and the
// nested commodity/facility objects the normalizers read. `fid` pins one facility;
// `scopeIds` is an admin's multi-facility view-filter (intersected server-side).
const queryLog = async ({ listFn, from, to, fid, scopeIds, commIds, section }) => {
  const { start, end } = toRange(from, to)
  const PAGE = 1000
  let all = []
  for (let offset = 0; ; offset += PAGE) {
    let data
    try {
      data = await listFn({
        facility_id: fid || undefined,
        facility_ids: (!fid && scopeIds && scopeIds.length) ? scopeIds : undefined,
        commodity_ids: (commIds && commIds.length) ? commIds : undefined,
        from: start, to: end,
        section: section || undefined,
        limit: PAGE, offset,
      })
    } catch { break }
    if (!data || !data.length) break
    all = all.concat(data)
    if (data.length < PAGE) break
  }
  return all
}

// ─── Paged activity feed ─────────────────────────────────────────────────────
// GET /api/activity merges the four logs server-side and returns one page. The
// row already carries the columns the table needs, so this only maps names onto
// the shape the existing renderers expect — no per-log normalizer branching.
const FEED_ACTIVITY = { dispense: 'Consumption', intake: 'Intake', adjustment: 'Adjustment', transfer: 'Transfer' }

export function normalizeFeedRow(row, fid) {
  const isOut = fid && row.sending_facility_name && row.receiving_facility_name
    && row.facility_id !== fid
  // Adjustments and outbound transfers reduce stock, so they read negative — the
  // same convention the per-log normalizers used.
  const signed = row.type === 'adjustment'
    ? (row.status === 'Decrease' ? -(row.quantity || 0) : (row.quantity || 0))
    : row.type === 'transfer' && isOut ? -(row.quantity || 0)
    : (row.quantity || 0)
  const external = row.type === 'transfer'
    && !!row.sending_facility_name && !!row.receiving_facility_name
    && row.sending_facility_name !== row.receiving_facility_name
  return {
    id: row.id,
    activity: FEED_ACTIVITY[row.type] || row.type,
    commodity: row.commodity_name || 'Unknown',
    category: row.category || 'Unknown',
    quantity: signed,
    unit: row.unit || '',
    date: row.at || '',
    facility: row.type === 'transfer'
      ? `${row.sending_facility_name || ''} → ${row.receiving_facility_name || ''}`.trim()
      : (row.facility_name || ''),
    status: row.status || '',
    notes: row.notes || '',
    external,
    qtyAbs: row.quantity || 0,
    sendingName: row.sending_facility_name || '',
    receivingName: row.receiving_facility_name || '',
  }
}

// One page of the merged feed. Returns { rows, total } so the caller can page
// without a second count query.
export async function fetchActivityPage({
  from, to, fid, scopeIds, commIds, section, types, category, externalOnly, limit = 50, offset = 0,
}) {
  const { start, end } = toRange(from, to)
  const res = await api.activity({
    facility_id: fid || undefined,
    facility_ids: (!fid && scopeIds && scopeIds.length) ? scopeIds : undefined,
    commodity_ids: (commIds && commIds.length) ? commIds : undefined,
    from: start, to: end,
    section: section || undefined,
    types: (types && types.length) ? types.join(',') : undefined,
    category: category || undefined,
    external_only: externalOnly ? 1 : undefined,
    limit, offset,
  }).catch(() => null)
  if (!res) return { rows: [], total: 0 }
  return { rows: (res.data || []).map(r => normalizeFeedRow(r, fid)), total: res.total || 0 }
}

export async function fetchReportRows({ category = 'all', from, to, fid, scopeIds, commIds, section }) {
  const getDispense = async () =>
    (await queryLog({ listFn: api.dispense.history, from, to, fid, scopeIds, commIds, section })).map(normalizeDispense)

  const getIntake = async () =>
    (await queryLog({ listFn: api.intake.history, from, to, fid, scopeIds, commIds, section })).map(normalizeIntake)

  const getAdjustment = async () =>
    (await queryLog({ listFn: api.adjustments.history, from, to, fid, scopeIds, commIds, section })).map(normalizeAdjustment)

  const getTransfer = async () => {
    // section already scopes transfers to pharmacy/lab, so no commodity filter is
    // needed. from/to are plain dates (the transfers endpoint adds the day bounds).
    const PAGE = 1000
    let all = []
    for (let offset = 0; ; offset += PAGE) {
      let data
      try {
        data = await api.transfers.list({
          facility_id: fid || undefined,
          facility_ids: (!fid && scopeIds && scopeIds.length) ? scopeIds : undefined,
          section: section || undefined,
          date_field: 'initiated_at', from, to,
          limit: PAGE, offset,
        })
      } catch { break }
      if (!data || !data.length) break
      all = all.concat(data)
      if (data.length < PAGE) break
    }
    return all.map(row => normalizeTransfer(row, fid))
  }

  if (category === 'all') {
    const [dispense, intake, adjustment, transfer] = await Promise.all([
      getDispense(), getIntake(), getAdjustment(), getTransfer(),
    ])
    return [...dispense, ...intake, ...adjustment, ...transfer].sort((a,b) => new Date(b.date) - new Date(a.date))
  }

  if (category === 'dispense') return (await getDispense()).sort((a,b) => new Date(b.date) - new Date(a.date))
  if (category === 'intake') return (await getIntake()).sort((a,b) => new Date(b.date) - new Date(a.date))
  if (category === 'adjustment') return (await getAdjustment()).sort((a,b) => new Date(b.date) - new Date(a.date))
  if (category === 'transfer') return (await getTransfer()).sort((a,b) => new Date(b.date) - new Date(a.date))

  return []
}

export function getSummaryMetrics(rows, category) {
  if (category === 'all' || !rows?.length) return []

  if (category === 'dispense') {
    return [
      { label: 'Stock consumed', value: rows.reduce((sum, r) => sum + (r.quantity || 0), 0), color: 'blue' },
      { label: 'Consumption records', value: rows.length, color: 'green' },
      { label: 'Commodities moved', value: new Set(rows.map(r => r.commodity)).size, color: 'amber' },
    ]
  }

  if (category === 'intake') {
    return [
      { label: 'Commodities received', value: rows.reduce((sum, r) => sum + (r.quantity || 0), 0), color: 'blue' },
      { label: 'Unique items', value: new Set(rows.map(r => r.commodity)).size, color: 'green' },
      { label: 'Intake records', value: rows.length, color: 'amber' },
    ]
  }

  if (category === 'transfer') {
    return [
      { label: 'Transfers made', value: rows.length, color: 'blue' },
      { label: 'Commodities transferred', value: new Set(rows.map(r => r.commodity)).size, color: 'green' },
      { label: 'Total quantity', value: rows.reduce((sum, r) => sum + (r.quantity || 0), 0), color: 'amber' },
    ]
  }

  if (category === 'adjustment') {
    return [
      { label: 'Adjustments made', value: rows.length, color: 'blue' },
      { label: 'Commodities adjusted', value: new Set(rows.map(r => r.commodity)).size, color: 'green' },
      { label: 'Total quantity', value: Math.abs(rows.reduce((sum, r) => sum + (r.quantity || 0), 0)), color: 'amber' },
    ]
  }

  return []
}

export function buildActivityCsv(rows, category, title, stockMap = {}) {
  const label = title || `${getReportCategoryLabel(category)} report`

  if (category === 'transfer') {
    let csv = `${label}\r\n`
    csv += `S/No,Date,Category,Commodity,Unit,Quantity,Direction,From,To,Status,Notes\r\n`
    rows.forEach((row, i) => {
      const [from = '', to = ''] = row.facility.includes('→') ? row.facility.split('→').map(s => s.trim()) : [row.facility, '']
      csv += `${i + 1},"${(row.date || '').slice(0, 10)}","${row.category}","${row.commodity}","${row.unit}",${Math.abs(row.quantity)},"${row.direction || ''}","${from}","${to}","${row.status}","${(row.notes || '').replace(/"/g, '""')}"\r\n`
    })
    return csv
  }

  if (category === 'dispense') {
    // Aggregate total consumed per commodity so we can show beginning/ending balance
    const totals = {}
    rows.forEach(row => {
      if (!totals[row.commodity]) totals[row.commodity] = { category: row.category, unit: row.unit, consumed: 0 }
      totals[row.commodity].consumed += row.quantity
    })
    let csv = `${label}\r\n`
    csv += `S/No,Commodity,Category,Unit,Beginning Balance,Quantity Consumed,Ending Balance\r\n`
    Object.entries(totals).sort(([a],[b]) => a.localeCompare(b)).forEach(([name, r], i) => {
      const ending = stockMap[name] ?? ''
      const beginning = ending !== '' ? ending + r.consumed : ''
      csv += `${i + 1},"${name}","${r.category}","${r.unit}",${beginning},${r.consumed},${ending}\r\n`
    })
    return csv
  }

  if (category === 'intake') {
    let csv = `${label}\r\n`
    csv += `S/No,Date,Facility,LGA,Category,Commodity,Unit,Quantity Received,Supplier\r\n`
    rows.forEach((row, i) => {
      csv += `${i + 1},"${(row.date || '').slice(0, 10)}","${row.facility}","${row.lga || ''}","${row.category}","${row.commodity}","${row.unit}",${row.quantity},"${(row.supplier || '').replace(/"/g, '""')}"\r\n`
    })
    return csv
  }

  if (category === 'adjustment') {
    let csv = `${label}\r\n`
    csv += `S/No,Date,Facility,LGA,Category,Commodity,Unit,Quantity Adjusted,Reason,Notes\r\n`
    rows.forEach((row, i) => {
      csv += `${i + 1},"${(row.date || '').slice(0, 10)}","${row.facility}","${row.lga || ''}","${row.category}","${row.commodity}","${row.unit}",${row.quantity},"${(row.reason || '').replace(/"/g, '""')}","${(row.notes || '').replace(/"/g, '""')}"\r\n`
    })
    return csv
  }

  // fallback flat
  let csv = `${label}\r\nDate,Activity,Commodity,Category,Quantity,Unit,Facility,Status,Notes\r\n`
  rows.forEach(row => {
    csv += `"${(row.date || '').slice(0, 10)}","${row.activity}","${row.commodity}","${row.category}",${row.quantity},"${row.unit}","${row.facility}","${row.status}","${(row.notes || '').replace(/"/g, '""')}"\r\n`
  })
  return csv
}

export function buildReportCsv(rows, category, title) {
  const label = title || `${getReportCategoryLabel(category)} report`
  let csv = `${label}\r\nDate,Activity,Commodity,Category,Quantity,Unit,Facility,Status,Notes\r\n`
  rows.forEach(row => {
    csv += `"${row.date || ''}","${row.activity}","${row.commodity}","${row.category}",${row.quantity},"${row.unit}","${row.facility}","${row.status}","${(row.notes || '').replace(/"/g, '""')}"\r\n`
  })
  return csv
}

export function buildCrrfCsv(rows, title, stockMap = {}) {
  const label = title || 'CRRF Summary'

  const LOSS_REASONS = ['Expired', 'Damaged', 'Lost / Stolen']

  // Aggregate rows by commodity
  const agg = {}
  rows.forEach(row => {
    const key = row.commodity
    if (!agg[key]) agg[key] = { commodity: row.commodity, category: row.category, unit: row.unit, received: 0, dispensed: 0, adjPos: 0, adjNeg: 0, losses: 0 }
    if (row.activity === 'Intake')      agg[key].received  += row.quantity
    if (row.activity === 'Consumption') agg[key].dispensed += row.quantity
    // Excluded from CRRF: physical count corrections (reconcile to a count) and
    // dispensary returns (internal store↔dispensary move, total SOH unchanged).
    if (row.activity === 'Adjustment' && !NON_CRRF_ADJ_REASONS.includes(row.reason)) {
      if (row.quantity > 0)                       agg[key].adjPos += row.quantity
      else if (LOSS_REASONS.includes(row.reason)) agg[key].losses += Math.abs(row.quantity)
      else                                        agg[key].adjNeg += Math.abs(row.quantity)
    }
    // Only external redistribution (facility → another facility) adjusts CRRF.
    if (row.activity === 'Transfer' && row.external) {
      if (row.quantity > 0) agg[key].adjPos += row.quantity
      else                  agg[key].adjNeg += Math.abs(row.quantity)
    }
  })

  let csv = `${label}\r\n`
  csv += `S/No,Drugs,Basic Unit,`
  csv += `Beginning Balance,Quantity Received,Quantity Consumed,`
  csv += `Adj Positive (+),Adj Negative (-),Losses,Ending Balance\r\n`

  const items = Object.values(agg).sort((a, b) => a.category.localeCompare(b.category) || a.commodity.localeCompare(b.commodity))
  let sno = 1
  let currentCat = null

  items.forEach(r => {
    if (r.category !== currentCat) {
      currentCat = r.category
      csv += `\r\n"${currentCat}"\r\n`
    }
    const E = stockMap[r.commodity] ?? ''
    const A = E !== '' ? E - r.received + r.dispensed - r.adjPos + r.adjNeg + r.losses : ''
    csv += `${sno},"${r.commodity}","${r.unit}",${A},${r.received},${r.dispensed},${r.adjPos},${r.adjNeg},${r.losses},${E}\r\n`
    sno++
  })

  return csv
}

// Per-facility CRRF for an admin spanning multiple facilities: one section per
// facility (with its LGA) instead of one rolled-up total per commodity.
//   facStock:  { facilityName: { commodityName: SOH } }
//   lgaByName: { facilityName: lga }
// `allFacilities` (optional [{name, lga}]): when provided, EVERY listed facility
// gets a row even with no activity in the period — a silent facility shows its
// stock balances (Ending = Beginning, zero movement) for commodities it holds.
// `allCommodities` (optional [name]): when provided, EVERY commodity gets its own
// column block even if nothing touched it, so the grid is complete. In this
// "all" mode a commodity with no activity shows zeros (its stock as Begin=End
// where the facility holds it) instead of blanks.
// Omit both for the default "active facilities/commodities only" export.
export function buildCrrfByFacilityCsv(rows, title, facStock = {}, lgaByName = {}, allFacilities = null, allCommodities = null) {
  const allMode = Boolean(allFacilities || allCommodities)
  const LOSS_REASONS = ['Expired', 'Damaged', 'Lost / Stolen']
  const agg = {}   // facilityName → commodityName → tallies
  const ensure = (fac, commodity, category, unit) => {
    if (!fac) return null
    if (!agg[fac]) agg[fac] = {}
    if (!agg[fac][commodity]) agg[fac][commodity] = { commodity, category, unit, received: 0, dispensed: 0, adjPos: 0, adjNeg: 0, losses: 0 }
    return agg[fac][commodity]
  }

  rows.forEach(row => {
    if (row.activity === 'Transfer') {
      if (!row.external) return   // internal moves / SDP-DSD dispatches don't count
      const qty = row.qtyAbs || 0
      const s = ensure(row.sendingName, row.commodity, row.category, row.unit);   if (s) s.adjNeg += qty
      const r = ensure(row.receivingName, row.commodity, row.category, row.unit); if (r) r.adjPos += qty
      return
    }
    const a = ensure(row.facility, row.commodity, row.category, row.unit)
    if (!a) return
    if (row.activity === 'Intake')           a.received  += row.quantity
    else if (row.activity === 'Consumption') a.dispensed += row.quantity
    // Excluded from CRRF: physical count corrections (reconcile to a count) and
    // dispensary returns (internal store↔dispensary move, total SOH unchanged).
    else if (row.activity === 'Adjustment' && !NON_CRRF_ADJ_REASONS.includes(row.reason)) {
      if (row.quantity > 0)                       a.adjPos += row.quantity
      else if (LOSS_REASONS.includes(row.reason)) a.losses += Math.abs(row.quantity)
      else                                        a.adjNeg += Math.abs(row.quantity)
    }
  })

  // "All facilities" mode: seed every in-scope facility so silent ones appear.
  if (Array.isArray(allFacilities)) {
    allFacilities.forEach(f => { if (f && f.name && !agg[f.name]) agg[f.name] = {} })
  }

  // Wide pivot: one row per facility (with LGA), seven columns per commodity
  // (the CRRF columns), plus a per-commodity totals row.
  const commodities = new Set()
  Object.values(agg).forEach(byComm => Object.keys(byComm).forEach(c => commodities.add(c)))
  if (Array.isArray(allCommodities)) allCommodities.forEach(c => { if (c) commodities.add(c) })
  const comms = [...commodities].sort((a, b) => a.localeCompare(b))
  const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const SUB = ['Beginning Balance', 'Quantity Received', 'Quantity Consumed', 'Adj Positive (+)', 'Adj Negative (-)', 'Losses', 'Ending Balance']

  // Two-row grouped header: the commodity name spans its seven sub-columns (name
  // in the first cell of the block, the rest blank), with the CRRF sub-headers on
  // the row below — so a spreadsheet shows the commodity as a group over its block.
  const groupRow = ['LGA', 'Facility']
  comms.forEach(c => { groupRow.push(c); for (let i = 1; i < SUB.length; i++) groupRow.push('') })
  const subRow = ['', '']
  comms.forEach(() => SUB.forEach(s => subRow.push(s)))

  let csv = `${title}\r\n`
  csv += groupRow.map(esc).join(',') + '\r\n'
  csv += subRow.map(esc).join(',') + '\r\n'

  const facs = Object.keys(agg).sort((a, b) => (lgaByName[a] || '').localeCompare(lgaByName[b] || '') || a.localeCompare(b))
  const totals = {}
  comms.forEach(c => { totals[c] = { B: 0, received: 0, dispensed: 0, adjPos: 0, adjNeg: 0, losses: 0, E: 0 } })

  facs.forEach(fac => {
    const cells = [lgaByName[fac] || '', fac]
    const stock = facStock[fac] || {}
    comms.forEach(c => {
      const r = agg[fac][c]
      const E = stock[c]
      const hasE = E != null
      if (!r) {
        // No activity for this commodity. In "all" mode show the ending balance
        // (= beginning, no movement) where the facility holds stock, otherwise zeros
        // so every commodity column is filled; blanks only in the default export.
        if (allMode && hasE) {
          cells.push(E, 0, 0, 0, 0, 0, E)
          totals[c].B += E; totals[c].E += E
        } else if (allMode) {
          cells.push(0, 0, 0, 0, 0, 0, 0)
        } else {
          cells.push('', '', '', '', '', '', '')
        }
        return
      }
      const B = hasE ? E - r.received + r.dispensed - r.adjPos + r.adjNeg + r.losses : ''
      cells.push(B, r.received, r.dispensed, r.adjPos, r.adjNeg, r.losses, hasE ? E : '')
      totals[c].received += r.received; totals[c].dispensed += r.dispensed
      totals[c].adjPos += r.adjPos; totals[c].adjNeg += r.adjNeg; totals[c].losses += r.losses
      if (hasE) { totals[c].B += B; totals[c].E += E }
    })
    csv += cells.map(esc).join(',') + '\r\n'
  })

  const totalRow = ['', 'TOTAL']
  comms.forEach(c => { const t = totals[c]; totalRow.push(t.B, t.received, t.dispensed, t.adjPos, t.adjNeg, t.losses, t.E) })
  csv += totalRow.map(esc).join(',') + '\r\n'

  return csv
}

// Per-facility consumption summary for a multi-facility admin export.
// Wide pivot (mirrors the DHIS2 SOH-dashboard shape): one row per facility with
// its LGA, and THREE columns per commodity — "<name> — Beginning Balance",
// "<name> — Qty Consumed", "<name> — Ending Balance" — plus a per-commodity
// totals row at the bottom. Ending = current SOH (facStock); Beginning =
// Ending + Consumed (assumes no other movement in the window, matching the
// prior report's logic). Blank cell = the facility consumed none of that
// commodity in the period.
export function buildConsumptionByFacilityCsv(rows, title, facStock = {}, lgaByName = {}) {
  const agg = {}           // facility → commodity → consumed
  const commSet = new Set()
  rows.forEach(row => {
    if (row.activity !== 'Consumption' || !row.facility) return
    if (!agg[row.facility]) agg[row.facility] = {}
    agg[row.facility][row.commodity] = (agg[row.facility][row.commodity] || 0) + row.quantity
    commSet.add(row.commodity)
  })
  const commodities = [...commSet].sort((a, b) => a.localeCompare(b))
  const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }

  const header = ['LGA', 'Facility']
  commodities.forEach(c => header.push(`${c}, Beginning Balance`, `${c}, Qty Consumed`, `${c}, Ending Balance`))

  let csv = `${title}\r\n`
  csv += header.map(esc).join(',') + '\r\n'

  const facs = Object.keys(agg).sort((a, b) =>
    (lgaByName[a] || '').localeCompare(lgaByName[b] || '') || a.localeCompare(b))

  const totals = {}
  commodities.forEach(c => { totals[c] = { begin: 0, consumed: 0, ending: 0 } })

  facs.forEach(fac => {
    const cells = [lgaByName[fac] || '', fac]
    const stock = facStock[fac] || {}
    commodities.forEach(c => {
      const consumed = agg[fac][c]
      if (consumed == null) { cells.push('', '', ''); return }
      const ending = stock[c]
      const hasEnd = ending != null
      cells.push(hasEnd ? ending + consumed : '', consumed, hasEnd ? ending : '')
      totals[c].consumed += consumed
      if (hasEnd) { totals[c].begin += ending + consumed; totals[c].ending += ending }
    })
    csv += cells.map(esc).join(',') + '\r\n'
  })

  const totalRow = ['', 'TOTAL']
  commodities.forEach(c => totalRow.push(totals[c].begin, totals[c].consumed, totals[c].ending))
  csv += totalRow.map(esc).join(',') + '\r\n'

  return csv
}
