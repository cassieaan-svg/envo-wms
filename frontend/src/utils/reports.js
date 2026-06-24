import { api } from '../lib/api'

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
      { label: 'Individuals served', value: rows.length, color: 'green' },
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
    csv += `S/No,Date,Facility,LGA,Category,Commodity,Unit,Quantity Received\r\n`
    rows.forEach((row, i) => {
      csv += `${i + 1},"${(row.date || '').slice(0, 10)}","${row.facility}","${row.lga || ''}","${row.category}","${row.commodity}","${row.unit}",${row.quantity}\r\n`
    })
    return csv
  }

  if (category === 'adjustment') {
    let csv = `${label}\r\n`
    csv += `S/No,Date,Facility,LGA,Category,Commodity,Unit,Quantity Received,Reason\r\n`
    rows.forEach((row, i) => {
      csv += `${i + 1},"${(row.date || '').slice(0, 10)}","${row.facility}","${row.lga || ''}","${row.category}","${row.commodity}","${row.unit}",${row.quantity},"${(row.reason || '').replace(/"/g, '""')}"\r\n`
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
    if (row.activity === 'Adjustment') {
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
export function buildCrrfByFacilityCsv(rows, title, facStock = {}, lgaByName = {}) {
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
    else if (row.activity === 'Adjustment') {
      if (row.quantity > 0)                       a.adjPos += row.quantity
      else if (LOSS_REASONS.includes(row.reason)) a.losses += Math.abs(row.quantity)
      else                                        a.adjNeg += Math.abs(row.quantity)
    }
  })

  let csv = `${title}\r\n`
  const facs = Object.keys(agg).sort((a, b) => (lgaByName[a] || '').localeCompare(lgaByName[b] || '') || a.localeCompare(b))
  facs.forEach(fac => {
    csv += `\r\n"${fac}${lgaByName[fac] ? ' — ' + lgaByName[fac] : ''}"\r\n`
    csv += `S/No,Drugs,Basic Unit,Beginning Balance,Quantity Received,Quantity Consumed,Adj Positive (+),Adj Negative (-),Losses,Ending Balance\r\n`
    const stock = facStock[fac] || {}
    const items = Object.values(agg[fac]).sort((a, b) => a.category.localeCompare(b.category) || a.commodity.localeCompare(b.commodity))
    items.forEach((r, i) => {
      const E = stock[r.commodity] ?? ''
      const A = E !== '' ? E - r.received + r.dispensed - r.adjPos + r.adjNeg + r.losses : ''
      csv += `${i + 1},"${r.commodity}","${r.unit}",${A},${r.received},${r.dispensed},${r.adjPos},${r.adjNeg},${r.losses},${E}\r\n`
    })
  })
  return csv
}

// Per-facility consumption summary for a multi-facility admin export.
export function buildConsumptionByFacilityCsv(rows, title, facStock = {}, lgaByName = {}) {
  const agg = {}   // facilityName → commodityName → { category, unit, consumed }
  rows.forEach(row => {
    if (row.activity !== 'Consumption' || !row.facility) return
    if (!agg[row.facility]) agg[row.facility] = {}
    if (!agg[row.facility][row.commodity]) agg[row.facility][row.commodity] = { commodity: row.commodity, category: row.category, unit: row.unit, consumed: 0 }
    agg[row.facility][row.commodity].consumed += row.quantity
  })

  let csv = `${title}\r\n`
  const facs = Object.keys(agg).sort((a, b) => (lgaByName[a] || '').localeCompare(lgaByName[b] || '') || a.localeCompare(b))
  facs.forEach(fac => {
    csv += `\r\n"${fac}${lgaByName[fac] ? ' — ' + lgaByName[fac] : ''}"\r\n`
    csv += `S/No,Commodity,Category,Unit,Beginning Balance,Quantity Consumed,Ending Balance\r\n`
    const stock = facStock[fac] || {}
    const items = Object.values(agg[fac]).sort((a, b) => a.commodity.localeCompare(b.commodity))
    items.forEach((r, i) => {
      const ending = stock[r.commodity] ?? ''
      const beginning = ending !== '' ? ending + r.consumed : ''
      csv += `${i + 1},"${r.commodity}","${r.category}","${r.unit}",${beginning},${r.consumed},${ending}\r\n`
    })
  })
  return csv
}
