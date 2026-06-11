// ── Date formatting (Africa/Lagos timezone) ───────────────────────────────
const LAGOS = 'Africa/Lagos'

export function fmtDate(d) {
  if (!d) return '—'
  const dt = new Date(d)
  if (isNaN(dt)) return '—'
  return dt.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric', timeZone: LAGOS })
}

export function fmtDateTime(iso) {
  if (!iso) return '—'
  const dt = new Date(iso)
  if (isNaN(dt)) return '—'
  return dt.toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', hour12:false, timeZone: LAGOS })
}

export function todayLagos() {
  return new Date().toLocaleDateString('en-CA', { timeZone: LAGOS })
}

// ── Commodity helpers ─────────────────────────────
export function getCommodityPackSize(comm) {
  return (comm?.pack_size && comm.pack_size > 1) ? comm.pack_size : null
}

export function getCommodityDispenseUnit(comm) {
  return comm?.dispensing_unit || comm?.unit || 'units'
}

export function pluralizeUnit(qty, unit) {
  if (!unit) return ''
  if (qty === 1) return unit
  return unit.endsWith('s') ? unit : unit + 's'
}

export function fmtStockQty(qty, comm) {
  const unit = comm?.unit || getCommodityDispenseUnit(comm)
  const pluralUnit = pluralizeUnit(qty, unit)
  return `${qty?.toLocaleString()} ${pluralUnit}`
}

export function fmtDispenseQty(qty, comm) {
  const unit = comm?.unit || getCommodityDispenseUnit(comm)
  return `${qty?.toLocaleString()} ${unit}`
}

// ── Stock status ──────────────────────────────────
export function getStockStatus(qty, amc) {
  if (qty === 0) return 'out'
  if (!amc || amc <= 0) return 'unknown'
  const mos = qty / amc
  if (mos < 2)  return 'low'
  if (mos > 4)  return 'over'
  return 'ok'
}

export function getMOS(qty, amc) {
  if (!amc || amc <= 0) return null
  return +(qty / amc).toFixed(1)
}

// ── AMC ── Average Monthly Consumption: total quantity dispensed over the 2
// most recent COMPLETED months preceding the current calendar quarter, divided
// by 2. The value is still anchored to fixed calendar quarters (Jan, Apr, Jul,
// Oct), so it stays fixed within a quarter and only refreshes every 3 months —
// but it drops the stale oldest month to reduce lag.
export const AMC_WINDOW_MONTHS = 2 // months of consumption averaged
export const AMC_DIVISOR = 2
const QUARTER_MONTHS = 3 // cadence: AMC refreshes once per quarter

// Start of the calendar quarter containing `from`.
function quarterStart(from) {
  const m = Math.floor(from.getMonth() / QUARTER_MONTHS) * QUARTER_MONTHS
  return new Date(from.getFullYear(), m, 1)
}

// AMC window = the 2 months immediately before the current quarter, i.e.
// [end - 2mo, end). `end` is the current quarter start, so the window only
// moves at quarter boundaries (e.g. on Jun 8 → [Feb 1, Apr 1) = Feb + Mar).
export function amcWindowStart(from = new Date()) {
  const end = quarterStart(from)
  return new Date(end.getFullYear(), end.getMonth() - AMC_WINDOW_MONTHS, 1)
}
export function amcWindowEnd(from = new Date()) {
  return quarterStart(from)
}

// Total dispensed over the window ÷ 2. Accepts dispense rows or a raw total.
export function calcAMC(dispenseRowsOrTotal) {
  const total = Array.isArray(dispenseRowsOrTotal)
    ? dispenseRowsOrTotal.reduce((s, d) => s + (d.quantity || 0), 0)
    : (dispenseRowsOrTotal || 0)
  return total / AMC_DIVISOR
}

// ── Custom per-facility AMC months ─────────────────
// A facility may override the default quarterly window by picking specific
// months (an arbitrary set, not necessarily contiguous — e.g. Jan, Mar, Jun).
// The AMC formula is unchanged — total dispensed across the chosen months ÷
// number of months — only the months (and therefore the divisor) are chosen by
// the user. Months are stored as 'YYYY-MM' strings.

// First day of the month for a 'YYYY-MM' / 'YYYY-MM-DD' string or a Date, in
// LOCAL time (avoids the UTC-parse off-by-one that shifts to the prior month).
function monthFloor(d) {
  if (typeof d === 'string') {
    const [y, m] = d.split('-').map(Number)
    return new Date(y, (m || 1) - 1, 1)
  }
  const x = new Date(d)
  return new Date(x.getFullYear(), x.getMonth(), 1)
}

// Resolve a facility's AMC window from its saved setting ({ months: [...] }) or
// fall back to the default quarterly window. Returns:
//   start, end  — query bounds [start, end) spanning the earliest→latest month
//   monthSet    — Set of allowed 'YYYY-MM' to filter rows by (null = accept all)
//   months      — the divisor to average by
// For non-contiguous selections the caller queries [start, end) then keeps only
// rows whose month is in `monthSet`.
export function resolveAmcWindow(win, from = new Date()) {
  const picked = win && Array.isArray(win.months)
    ? [...new Set(win.months.filter(Boolean))].sort()
    : []
  if (picked.length) {
    const start = monthFloor(`${picked[0]}-01`)
    const last = monthFloor(`${picked[picked.length - 1]}-01`)
    const end = new Date(last.getFullYear(), last.getMonth() + 1, 1) // exclusive
    return { start, end, monthSet: new Set(picked), months: picked.length, custom: true }
  }
  return { start: amcWindowStart(from), end: amcWindowEnd(from), monthSet: null, months: AMC_DIVISOR, custom: false }
}

// Sum dispensed quantity per commodity over an already-fetched set of rows,
// honouring the window's month filter, then divide each total by the window's
// month count. Returns a { [commodity_id]: amc } map.
export function amcMapFromRows(rows, amcWin) {
  const sums = {}
  ;(rows || []).forEach(d => {
    if (amcWin.monthSet && !amcWin.monthSet.has((d.dispensed_at || '').slice(0, 7))) return
    sums[d.commodity_id] = (sums[d.commodity_id] || 0) + (d.quantity || 0)
  })
  const out = {}
  Object.entries(sums).forEach(([id, total]) => { out[id] = calcAMCFromTotal(total, amcWin.months) })
  return out
}

// AMC from a precomputed total and the window's month count (the divisor).
export function calcAMCFromTotal(total, months) {
  return months > 0 ? (total || 0) / months : 0
}

// ── Section categories ────────────────────────────
export const SECTION_CATEGORIES = {
  pharmacy: ['Pharmacy drugs', 'Medical supplies'],
  lab:      ['RTKs', 'Lab reagents', 'Lab consumables'],
}

// A commodity category belongs to the lab section (uses SDP, no dispensary/DSD).
export const isLabCategory = (category) => (SECTION_CATEGORIES.lab || []).includes(category)

export function filterByCommoditySection(rows, commoditySection, key = 'commodities') {
  if (!commoditySection) return rows
  const cats = SECTION_CATEGORIES[commoditySection]
  if (!cats) return rows
  return rows.filter(r => cats.includes(r[key]?.category))
}

export function groupStockByComm(stockRows) {
  const map = {}
  stockRows.forEach(r => {
    if (!map[r.commodity_id]) {
      map[r.commodity_id] = { ...r, storeQty: 0, dispensaryQty: 0, dsdQty: 0 }
    }
    if (r.location_type === 'store')           map[r.commodity_id].storeQty += r.quantity
    else if (r.location_type === 'dispensary') map[r.commodity_id].dispensaryQty += r.quantity
    else if (r.location_type === 'dsd')        map[r.commodity_id].dsdQty += r.quantity
  })
  return Object.values(map).map(r => ({
    ...r,
    quantity: r.storeQty + r.dispensaryQty + r.dsdQty,
  }))
}
