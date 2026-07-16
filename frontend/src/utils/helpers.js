import { api } from '../lib/api'

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

// Timestamp to store for a user-dated entry (intake / consumption). When the
// chosen date is today, use the real current time so the activity log reflects
// when it was actually recorded — the old code always anchored the picked date at
// noon, so same-day entries all showed 12:00. For a genuinely back-dated entry the
// real time is unknown, so keep anchoring at local noon (never bare midnight,
// which JS parses as UTC and can shift the calendar date across the Lagos offset).
export function entryTimestamp(dateStr) {
  if (!dateStr || dateStr === todayLagos()) return new Date().toISOString()
  return new Date(dateStr + 'T12:00:00').toISOString()
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
      map[r.commodity_id] = { ...r, storeQty: 0, dispensaryQty: 0, dsdQty: 0, _amcByFac: {} }
    }
    const g = map[r.commodity_id]
    if (r.location_type === 'store')           g.storeQty += r.quantity
    else if (r.location_type === 'dispensary') g.dispensaryQty += r.quantity
    else if (r.location_type === 'dsd')        g.dsdQty += r.quantity
    // baseline_amc is a per-facility figure, duplicated across a facility's
    // store/dispensary rows. Record one value per facility (max guards against any
    // duplicate disagreement), then sum across facilities below so multi-facility
    // (admin) views get a true scope-wide baseline AMC, not just one facility's.
    if (r.baseline_amc > 0) {
      g._amcByFac[r.facility_id] = Math.max(g._amcByFac[r.facility_id] || 0, r.baseline_amc)
    }
  })
  return Object.values(map).map(({ _amcByFac, ...r }) => ({
    ...r,
    quantity: r.storeQty + r.dispensaryQty + r.dsdQty,
    baseline_amc: Object.values(_amcByFac).reduce((s, v) => s + v, 0),
  }))
}

// Intake rows record the quantity *received* in a batch and are never decremented
// as stock is consumed or transferred, so an expiry view that prints intake.quantity
// overstates what's physically left. This caps each batch to the commodity's current
// stock on hand, allocating FEFO: stock is consumed soonest-expiry-first, so the
// remaining units are attributed to the latest-expiring batches and the soonest ones
// deplete first. Batches left with nothing are dropped. `sohByComm` maps
// commodity_id → units on hand; a commodity missing from the map is treated as 0
// (no stock row ⇒ nothing on hand ⇒ nothing to expire). Returns the kept batches
// (with `quantity` capped) sorted soonest-expiry first.
export function capExpiryBatchesToStock(batches, sohByComm) {
  const byComm = {}
  ;(batches || []).forEach(b => { (byComm[b.commodity_id] ||= []).push(b) })
  const kept = []
  Object.entries(byComm).forEach(([cid, list]) => {
    let remaining = sohByComm[cid] || 0
    // Fill latest-expiry batches first (they hold the remaining stock under FEFO).
    const ordered = list.slice().sort((a, b) => new Date(b.expiry_date) - new Date(a.expiry_date))
    ordered.forEach(b => {
      const received = Number(b.quantity) || 0
      const keep = Math.max(0, Math.min(received, remaining))
      remaining -= keep
      if (keep > 0) kept.push({ ...b, quantity: keep })
    })
  })
  return kept.sort((a, b) => new Date(a.expiry_date) - new Date(b.expiry_date))
}

// Facility-aware variant of capExpiryBatchesToStock for multi-facility (admin)
// views: batches span many facilities, so capping against a single per-commodity
// total would pool facilities together and mis-cap. This caps each batch to its
// OWN facility's stock on hand for that commodity, allocating FEFO per (facility,
// commodity). `sohByFacComm` maps `${facility_id}|${commodity_id}` → units on hand.
export function capExpiryBatchesToStockByFacility(batches, sohByFacComm) {
  const byKey = {}
  ;(batches || []).forEach(b => { (byKey[`${b.facility_id}|${b.commodity_id}`] ||= []).push(b) })
  const kept = []
  Object.entries(byKey).forEach(([key, list]) => {
    let remaining = sohByFacComm[key] || 0
    // Fill latest-expiry batches first (they hold the remaining stock under FEFO).
    const ordered = list.slice().sort((a, b) => new Date(b.expiry_date) - new Date(a.expiry_date))
    ordered.forEach(b => {
      const received = Number(b.quantity) || 0
      const keep = Math.max(0, Math.min(received, remaining))
      remaining -= keep
      if (keep > 0) kept.push({ ...b, quantity: keep })
    })
  })
  return kept.sort((a, b) => new Date(a.expiry_date) - new Date(b.expiry_date))
}

// Build a { commodity_id: amc } map of LIVE consumption over `amcWin`, scoped to
// a single facility (`fid`), a set of facilities (`scopeIds`), or — when both are
// null — every facility in the caller's token scope. Aggregates dispenses across
// the whole scope and paginates past the 1000-row cap, so an admin's aggregate AMC
// matches the summed stock. `section` adds the pharmacy/lab filter server-side.
export async function loadConsumptionAmcMap({ commIds, scopeParams, amcWin, section }) {
  const ids = [...new Set((commIds || []).filter(Boolean))]
  if (!ids.length) return {}
  // The server sums consumption by commodity + month, so we fetch a few dozen
  // rows instead of every dispense record across the scope. `scopeParams` is the
  // compact { facility_id } | { state[, lga] } | {} shape (no giant id lists).
  let monthly
  try {
    monthly = await api.dispense.summary({
      ...(scopeParams || {}),
      commodity_ids: ids,
      from: amcWin.start.toISOString(),
      to: amcWin.end.toISOString(),
      section: section || undefined,
    })
  } catch { return {} }
  // Same reduction as amcMapFromRows: sum by commodity (honouring a custom month
  // set), then divide by the window's month count.
  const sums = {}
  ;(monthly || []).forEach(r => {
    if (amcWin.monthSet && !amcWin.monthSet.has(r.ym)) return
    sums[r.commodity_id] = (sums[r.commodity_id] || 0) + (r.qty || 0)
  })
  const out = {}
  Object.entries(sums).forEach(([id, total]) => { out[id] = calcAMCFromTotal(total, amcWin.months) })
  return out
}
