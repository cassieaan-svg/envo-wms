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
  status: row.adjustment_type || row.status || '',
  reason: row.reason || '',
  notes: row.notes || '',
})

const normalizeTransfer = (row, fid) => {
  const isOut = fid && row.sending_facility_id === fid
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
    status: row.status || '',
    notes: row.notes || '',
  }
}

const queryLog = async ({ sb, table, select, dateField, from, to, fid, commIds, section }) => {
  const { start, end } = toRange(from, to)

  // Fetch all records and filter on client side for reliability
  let q = sb.from(table).select(select)

  if (commIds && commIds.length) q = q.in('commodity_id', commIds)
  if (fid) q = q.eq('facility_id', fid)
  if (section) q = q.eq('section', section)

  const { data } = await q

  // Filter by date using whichever field has a value (dateField first, then created_at)
  return (data || []).filter(row => {
    const checkDate = row[dateField] || row.created_at
    if (!checkDate) return false
    const d = new Date(checkDate)
    const startDate = new Date(start)
    const endDate = new Date(end)
    return d >= startDate && d <= endDate
  })
}

export async function fetchReportRows({ sb, category = 'all', from, to, fid, commIds, section }) {
  const getDispense = async () => {
    const data = await queryLog({
      sb, table: 'dispense_log', select: '*,commodities(name,category,unit),facilities(name)',
      dateField: 'dispensed_at', from, to, fid, commIds, section,
    })
    return data.map(normalizeDispense)
  }

  const getIntake = async () => {
    const data = await queryLog({
      sb, table: 'intake_log', select: '*,commodities(name,category,unit),facilities(name)',
      dateField: 'received_at', from, to, fid, commIds, section,
    })
    return data.map(normalizeIntake)
  }

  const getAdjustment = async () => {
    const data = await queryLog({
      sb, table: 'stock_adjustment_log', select: '*,commodities(name,category,unit),facilities(name)',
      dateField: 'adjusted_at', from, to, fid, commIds, section,
    })
    return data.map(normalizeAdjustment)
  }

  const getTransfer = async () => {
    const { start, end } = toRange(from, to)
    let q = sb.from('stock_transfer_log')
      .select('*,commodities(name,category,unit)')
      .gte('initiated_at', start).lte('initiated_at', end)
    if (commIds && commIds.length) q = q.in('commodity_id', commIds)
    if (fid) q = q.or(`sending_facility_id.eq.${fid},receiving_facility_id.eq.${fid}`)
    if (section) q = q.eq('section', section)
    const { data } = await q
    return (data || []).map(row => normalizeTransfer(row, fid))
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
    csv += `S/No,Date,Facility,Category,Commodity,Unit,Quantity Received\r\n`
    rows.forEach((row, i) => {
      csv += `${i + 1},"${(row.date || '').slice(0, 10)}","${row.facility}","${row.category}","${row.commodity}","${row.unit}",${row.quantity}\r\n`
    })
    return csv
  }

  if (category === 'adjustment') {
    let csv = `${label}\r\n`
    csv += `S/No,Date,Facility,Category,Commodity,Unit,Quantity Received,Reason\r\n`
    rows.forEach((row, i) => {
      csv += `${i + 1},"${(row.date || '').slice(0, 10)}","${row.facility}","${row.category}","${row.commodity}","${row.unit}",${row.quantity},"${(row.reason || '').replace(/"/g, '""')}"\r\n`
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
    if (row.activity === 'Transfer') {
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
