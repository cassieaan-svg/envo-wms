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

// ── AMC (atypical — avg of 2 highest months) ──────
export function calcAtypicalAMC(dispenseRows) {
  const monthly = {}
  dispenseRows.forEach(d => {
    const key = d.dispensed_at?.slice(0, 7)
    if (key) monthly[key] = (monthly[key] || 0) + d.quantity
  })
  const vals = Object.values(monthly).sort((a, b) => b - a)
  if (vals.length >= 2) return (vals[0] + vals[1]) / 2
  if (vals.length === 1) return vals[0]
  return 0
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
