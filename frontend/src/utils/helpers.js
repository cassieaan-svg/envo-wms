import { api } from '../lib/api'

// ── Date formatting (Africa/Lagos timezone) ───────────────────────────────
const LAGOS = 'Africa/Lagos'

export function fmtDate(d) {
  if (!d) return '—'
  const dt = new Date(d)
  if (isNaN(dt)) return '—'
  // A pre-1900 date is the "no expiry recorded" sentinel (e.g. 0001-01-01 from the
  // baseline seed), not a real date — show it as unknown, matching the lot ledger.
  if (dt.getUTCFullYear() < 1900) return '—'
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

// A date value as a plain yyyy-mm-dd, resolved in Lagos. Null for anything that
// isn't a usable date, including the pre-2000 "no expiry recorded" sentinels.
//
// Use this before PUTTING a date into a payload or a note. The API returns expiry
// dates as timestamps, and passing one straight back is wrong twice: it records a
// timestamp where every other row holds a date, and it reads a day EARLY, because
// the value is UTC midnight and Lagos is an hour ahead — 2027-06-30 arrives as
// "2027-06-29T23:00:00.000Z" and naive slicing yields the 29th.
//
// Deliberately mirrors the backend's ymd() in lotService.js; the server normalises
// too, so a stray timestamp is corrected rather than stored, but the payload the
// form sends should be right on its own.
export function ymdLagos(d) {
  if (!d) return null
  const t = new Date(d)
  if (isNaN(t.getTime())) return null
  const s = t.toLocaleDateString('en-CA', { timeZone: LAGOS })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const year = +s.slice(0, 4)
  return year >= 2000 && year <= 2100 ? s : null
}

// Expiry entered at intake must be a REAL FUTURE date: you can't receive stock
// that's already expired, and a `<input type="date">` otherwise lets a fumbled
// year (e.g. "0001-01-01") through the non-empty "required" check. Valid when the
// date is today or later and within a sane ceiling (rejects both past dates and
// absurd far-future years like 9999). Keep in sync with the backend's
// validators.isPlausibleExpiry.
export function isPlausibleExpiry(d) {
  if (!d) return false
  const s = (typeof d === 'string' ? d : new Date(d).toISOString()).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const maxYear = new Date().getFullYear() + 30
  return s >= todayLagos() && Number(s.slice(0, 4)) <= maxYear
}

// Min/max bounds for an expiry date input — picker guardrails matching
// isPlausibleExpiry: no past dates (min = today), no absurd future year.
export function expiryDateBounds() {
  const now = new Date().getFullYear()
  return { min: todayLagos(), max: `${now + 30}-12-31` }
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

// Agree the unit with the quantity: singular for exactly 1, plural otherwise. The
// stored unit may be written either way ("pieces"/"piece", "bottles"/"bottle"), so
// first reduce it to a singular base, then re-pluralise. Handles the regular "+s"
// units (piece, bottle, roll, kit, vial, tab, card, dose…) and the "+es" ones
// (box, patch, glass); genuinely irregular plurals aren't used here.
export function pluralizeUnit(qty, unit) {
  if (!unit) return ''
  const n = Math.abs(Number(qty) || 0)
  const singular = /(xes|ches|shes|sses)$/i.test(unit)
    ? unit.slice(0, -2)          // boxes→box, patches→patch, glasses→glass
    : unit.replace(/s$/i, '')    // bottles→bottle, rolls→roll, doses→dose, pieces→piece
  if (n === 1) return singular
  return /(x|ch|sh|ss)$/i.test(singular) ? singular + 'es' : singular + 's'
}

export function fmtStockQty(qty, comm) {
  const unit = comm?.unit || getCommodityDispenseUnit(comm)
  const pluralUnit = pluralizeUnit(qty, unit)
  return `${qty?.toLocaleString()} ${pluralUnit}`
}

export function fmtDispenseQty(qty, comm) {
  const unit = comm?.unit || getCommodityDispenseUnit(comm)
  return `${qty?.toLocaleString()} ${pluralizeUnit(qty, unit)}`
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

// A DSD/SDP site must only see its OWN internal redistribution rows. Those rows are
// tagged "[DSD: <site>]" / "[SDP: <site>]" in notes and carry the site as
// receiving_facility_name. Match case-insensitively so name-casing drift doesn't
// leak one site's rows into another site at the same facility. Returns false when no
// site is set, so a row never matches by accident.
export function rowForSite(r, tag, site) {
  const s = (site || '').trim().toLowerCase()
  if (!s) return false
  const m = new RegExp(`\\[${tag}:\\s*([^\\]]+)\\]`, 'i').exec(r.notes || '')?.[1]?.trim().toLowerCase()
  return m === s || (r.receiving_facility_name || '').trim().toLowerCase() === s
}

// The human reason a transfer was cancelled/rejected or disputed, shown to the
// other parties in the request lifecycle. Cancel/reject reasons are appended to the
// notes as "[Cancelled: …]"; dispute reasons live in dispute_note (the automatic
// "stock restored" markers are not reasons, so they're ignored). Empty when none.
export function transferReason(t) {
  const d = (t?.dispute_note || '').trim()
  if (d && !/stock restored/i.test(d)) return d
  const m = /\[Cancelled:\s*([^\]]+)\]/i.exec(t?.notes || '')
  return m ? m[1].trim() : ''
}

// ── Section categories ────────────────────────────
export const SECTION_CATEGORIES = {
  pharmacy: ['Pharmacy drugs'],
  lab:      ['RTKs', 'Lab reagents', 'Lab consumables'],
}

// The new "General Consumables" category — not part of any section list, so a
// regular section-pinned facility never sees it.
export const GENERAL_CONSUMABLES = 'General Consumables'

// The COMPLETE category set a per-state "State Office Store" sees — it REPLACES the
// account's normal section list (a state office handles only lab consumables and
// general consumables, not RTKs or reagents). Mirror of the backend copy in
// constants/sections.js — keep the two in sync.
export const STATE_OFFICE_CATEGORIES = ['Lab consumables', GENERAL_CONSUMABLES]

// A facility is a per-state office store when its name reads "… State Office Store".
export const isStateOfficeName = (name) => /state office store/i.test(name || '')

// Which bucket a facility falls into in the State -> LGA -> Facility pickers.
// Most facilities have an LGA. Two kinds legitimately do not: a State Office Store
// (serves the whole state) and a cluster store (serves a whole cluster), so they get
// named buckets of their own rather than being lumped together or dropped.
export const facilityGroupLabel = (f) =>
  f?.lga || (f?.cluster ? `${f.cluster} Cluster` : 'State Office')

// The categories a section-pinned account may see. A State Office Store gets its
// bespoke set; everyone else gets their section's list. Returns null (= all) when
// there is no section restriction (admins).
export function allowedCategoriesFor(commoditySection, facilityName) {
  if (!commoditySection) return null
  if (isStateOfficeName(facilityName)) return [...STATE_OFFICE_CATEGORIES]
  return [...(SECTION_CATEGORIES[commoditySection] || [])]
}

// Per-facility grants of INDIVIDUAL commodities, on top of the category list above.
// Mirror of FACILITY_EXTRA_COMMODITIES in backend/src/constants/sections.js — the
// backend copy is the enforced one; this exists so the catalogue the UI builds
// matches what the API will actually return.
//
// By commodity NAME and keyed to ONE facility because the case it exists for cannot
// be expressed as a category: Akwa Ibom's state office handles Alere Determine, whose
// category is RTKs — granting the category would hand every RTK to every state office.
const FACILITY_EXTRA_COMMODITIES = {
  'akwa ibom state office store': ['Alere Determine'],
}

export function extraCommoditiesForFacility(name) {
  return FACILITY_EXTRA_COMMODITIES[String(name || '').trim().toLowerCase()] || []
}

// Does this account's catalogue include the commodity? Category first, then the
// facility's individual grants. `allowedCats` null = no restriction (admins).
export function allowsCommodity(allowedCats, facilityName, commodity) {
  if (!allowedCats) return true
  if (allowedCats.includes(commodity?.category)) return true
  return extraCommoditiesForFacility(facilityName).includes(commodity?.name)
}

// The name to prefill into a "Reviewed by" / signer field for the signed-in user.
//
// `reviewer_name` is a deliberate override, separate from `full_name`: full_name is
// what the sidebar shows ("LOGGED IN AS"), and several accounts are named for a role
// ("Akwa Ibom State Admin") rather than the person who actually signs off. Setting
// reviewer_name lets that account sign as a person without relabelling the session.
// Absent (the normal case) it falls back to full_name, so nothing changes for anyone
// who hasn't set one. Prefill only — the field stays editable.
export function reviewerNameOf(user) {
  const m = user?.user_metadata || {}
  return (m.reviewer_name || m.full_name || m.name || '').trim()
}

// The same name, but with NO full_name fallback — only an explicitly-set
// reviewer_name counts.
//
// Used for the sender's own "Record approved by" / "Carrier" fields on a dispatch.
// Those are a legal record of who released the stock and who carried it, so they must
// not be auto-filled with whatever the account happens to be labelled: falling back to
// full_name would put a name on every facility dispatch in the system. Returning ''
// leaves the field exactly as it is today (empty, required, typed by hand), so the
// prefill reaches only the accounts an admin has deliberately named.
export function explicitReviewerName(user) {
  return (user?.user_metadata?.reviewer_name || '').trim()
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
// Warn-only guard for dispatching expired stock to another site. Returns a short
// warning string when the dispatch would draw on expired batches, else null. Given
// the bin's raw on-hand lots (batch_number, expiry_date, quantity), the chosen
// batch (or null for FEFO), and the quantity being issued:
//   • a specific EXPIRED batch → always warn
//   • FEFO → warn only if there isn't enough UNEXPIRED stock to cover the issue,
//     i.e. the draw would necessarily reach into expired lots.
// Sending expired stock isn't blocked (per policy) — an adjustment is the proper
// way to clear it — but the caller confirms before proceeding.
export function expiredDispatchWarning(lots, chosenBatch, qty) {
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0)
  const isExpired = d => !!(d && new Date(d) < startOfToday)
  if (chosenBatch) {
    return (chosenBatch.expired || isExpired(chosenBatch.expiry_date))
      ? `Batch ${chosenBatch.batch_number || '(no batch)'} expired on ${fmtDate(chosenBatch.expiry_date)}.`
      : null
  }
  const unexpired = (lots || []).filter(l => !isExpired(l.expiry_date)).reduce((s, l) => s + (Number(l.quantity) || 0), 0)
  if (unexpired < qty) {
    return `Only ${unexpired} unexpired unit${unexpired === 1 ? '' : 's'} on hand for this dispatch of ${qty} — the rest would come from expired stock.`
  }
  return null
}

export function capExpiryBatchesToStock(batches, sohByComm) {
  const byComm = {}
  ;(batches || []).forEach(b => { (byComm[b.commodity_id] ||= []).push(b) })
  const kept = []
  Object.entries(byComm).forEach(([cid, list]) => {
    let remaining = sohByComm[cid] || 0
    // Expired batches can't be dispensed, so they physically remain — hold stock in
    // them FIRST (otherwise the FEFO estimate treats them as consumed and hides
    // them). The rest fills latest-expiry first, so the soonest-expiring non-expired
    // batches read as consumed.
    const _now = Date.now()
    const _expd = x => new Date(x.expiry_date).getTime() < _now
    const ordered = list.slice().sort((a, b) =>
      (_expd(a) !== _expd(b)) ? (_expd(a) ? -1 : 1) : (new Date(b.expiry_date) - new Date(a.expiry_date)))
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
    // Expired batches can't be dispensed, so they physically remain — hold stock in
    // them FIRST (otherwise the FEFO estimate treats them as consumed and hides
    // them). The rest fills latest-expiry first, so the soonest-expiring non-expired
    // batches read as consumed.
    const _now = Date.now()
    const _expd = x => new Date(x.expiry_date).getTime() < _now
    const ordered = list.slice().sort((a, b) =>
      (_expd(a) !== _expd(b)) ? (_expd(a) ? -1 : 1) : (new Date(b.expiry_date) - new Date(a.expiry_date)))
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
export async function loadConsumptionAmcMap({ commIds, scopeParams, section }) {
  const ids = [...new Set((commIds || []).filter(Boolean))]
  // `commIds` is still required, but only to decide whether there is anything to
  // ask about — a caller with an empty catalogue should not make the request at all.
  if (!ids.length) return {}
  let rows
  try {
    rows = await api.dispense.summary({
      ...(scopeParams || {}),
      // The ids are deliberately NOT sent. The server already restricts the
      // response to the caller's section from their token, so listing them
      // narrowed nothing while adding ~3.4 KB to the URL — the same weight that
      // pushed the stock rollup past the reverse proxy's query-string limit.
      //
      // Returning rows the caller did not ask about is harmless: every consumer
      // reads this as a lookup table, keyed by ids from its own catalogue, so
      // extra entries are never visited.
      group_by: 'commodity,lifetime',
      section: section || undefined,
    })
  } catch { return {} }
  return weeklyAmcMap(rows)
}

// ── Interim ("weekly") AMC ────────────────────────────────────────────────────
// AMC from the consumption recorded SO FAR, rather than from a fixed calendar
// window: total quantity ÷ the weeks that commodity has actually been recorded,
// scaled to a month.
//
// Why this exists: the standard AMC averages the two completed months before the
// current quarter, so anything first recorded inside the current quarter has no
// AMC at all — measured at 48 of 68 consuming commodities and 2,663
// (facility, commodity) pairs, all showing "No AMC data" and therefore no MOS and
// no stock status. Dividing by each commodity's own elapsed weeks gives every
// commodity a usable figure immediately, instead of waiting a full quarter.
//
// 4.33 = 30.44 ÷ 7, the real number of weeks in an average month. Using a flat 4
// would understate monthly consumption by ~8%, which inflates MOS and makes
// genuinely low stock read as adequate — the wrong direction to be wrong in.
export const AMC_WEEKS_PER_MONTH = 4.33

// The span is clamped to at least one week: a commodity first recorded two days
// ago would otherwise divide by ~0.3 and report a wildly overstated month.
export function weeklyAmcMap(rows, now = new Date()) {
  const out = {}
  ;(rows || []).forEach(r => {
    const first = new Date(r.first_at)
    if (!r.first_at || isNaN(first)) return
    const weeks = Math.max(1, (now.getTime() - first.getTime()) / (7 * 86400000))
    out[r.commodity_id] = ((r.qty || 0) / weeks) * AMC_WEEKS_PER_MONTH
  })
  return out
}
