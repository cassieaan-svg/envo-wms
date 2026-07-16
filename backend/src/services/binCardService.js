import { query } from '../db.js'

// A bin card is a per-commodity, per-bin running ledger. Bins:
//   store       — the facility Main Store          (stock.location_type='store')
//   dispensary  — the dispensing bench             (stock.location_type='dispensary')
//   dsd:<site>  — a Decentralised Service Delivery site   (dsd_stock per site)
//   sdp:<site>  — a Service Delivery Point / testing point (sdp_stock per site)
//
// Movements per bin:
//   Main Store — Received = intake + external transfer IN; Issued = external
//     transfer OUT + internal redistribution store→(dispensary/DSD/SDP);
//     Loss/Adj = stock_adjustment_log (intake and adjustments have no bin column,
//     so they belong to the store — the authoritative on-hand for the facility).
//   Dispensary — Received = internal redistribution store→dispensary (untagged);
//     Issued = dispensing (dispense_log rows NOT tagged [DSD:]/[SDP:]).
//   DSD/SDP    — Received = redistribution tagged [DSD:/SDP: site]; Issued =
//     dispensing tagged for that site.
//
// Balance is reconstructed so the final row equals the bin's authoritative SOH:
//   opening = currentSOH − Σ(deltas); then accumulate forward. So adjustments the
//   dispensary/site bins can't attribute are absorbed into the opening balance and
//   the closing balance still ties out to stock on hand.

// Transfer statuses that represent stock that actually moved (not pending/
// in-transit/disputed/cancelled). Refine against prod if other terminal
// stock-moving statuses exist.
const MOVED_STATUSES = new Set(['accepted'])

// Pull "[TAG: value]" out of a notes string (used both to route redistributions/
// dispenses to a site bin and to label the store's outgoing redistributions).
const rx = (notes, tag) => new RegExp(`\\[${tag}:\\s*([^\\]]+)\\]`, 'i').exec(notes || '')?.[1]?.trim()
const isSiteTagged = notes => !!(rx(notes, 'DSD') || rx(notes, 'SDP'))
const tagMatches = (notes, tag, site) => {
  const v = rx(notes, tag)
  return v != null && v.toLowerCase() === String(site).trim().toLowerCase()
}

// location string → { kind, site }
function parseLocation(location) {
  if (location === 'dispensary') return { kind: 'dispensary' }
  const m = /^(dsd|sdp):(.+)$/i.exec(location || '')
  if (m) return { kind: m[1].toLowerCase(), site: m[2].trim() }
  return { kind: 'store' }
}

export class BinCardService {
  // The bins that exist for a facility, for the location selector. Always Main
  // Store; dispensary and each DSD/SDP site are included only when present in the
  // stock tables, so the selector shows exactly the bins that hold (or held) stock.
  static async getBins(facilityId) {
    const bins = [{ value: 'store', label: 'Main Store' }]
    const hasDisp = (await query(
      `select 1 from stock where facility_id = $1 and location_type = 'dispensary' limit 1`, [facilityId])).rows.length
    if (hasDisp) bins.push({ value: 'dispensary', label: 'Dispensary' })
    for (const r of (await query(
      `select distinct dsd_site_name s from dsd_stock where facility_id = $1 and coalesce(dsd_site_name,'') <> '' order by 1`,
      [facilityId])).rows) bins.push({ value: `dsd:${r.s}`, label: `DSD — ${r.s}` })
    for (const r of (await query(
      `select distinct sdp_name s from sdp_stock where facility_id = $1 and coalesce(sdp_name,'') <> '' order by 1`,
      [facilityId])).rows) bins.push({ value: `sdp:${r.s}`, label: `SDP — ${r.s}` })
    return bins
  }

  static async getBinCard(facilityId, commodityId, location = 'store') {
    const { kind, site } = parseLocation(location)

    const facility  = (await query('select name, state, lga, code from facilities where id = $1', [facilityId])).rows[0] || {}
    const commodity = (await query('select name, unit, category, pack_size from commodities where id = $1', [commodityId])).rows[0] || {}

    let rows, currentBalance
    if (kind === 'store') {
      rows = await BinCardService._storeRows(facilityId, commodityId)
      currentBalance = await BinCardService._soh(
        `select coalesce(quantity,0) q from stock where facility_id=$1 and commodity_id=$2 and location_type='store'`,
        [facilityId, commodityId])
    } else if (kind === 'dispensary') {
      rows = await BinCardService._dispensaryRows(facilityId, commodityId)
      currentBalance = await BinCardService._soh(
        `select coalesce(quantity,0) q from stock where facility_id=$1 and commodity_id=$2 and location_type='dispensary'`,
        [facilityId, commodityId])
    } else {
      const table = kind === 'dsd' ? 'dsd_stock' : 'sdp_stock'
      const col   = kind === 'dsd' ? 'dsd_site_name' : 'sdp_name'
      rows = await BinCardService._siteRows(facilityId, commodityId, kind.toUpperCase(), site)
      currentBalance = await BinCardService._soh(
        `select coalesce(quantity,0) q from ${table}
          where facility_id=$1 and commodity_id=$2 and lower(btrim(${col}))=lower(btrim($3))`,
        [facilityId, commodityId, site])
    }

    rows.sort((a, b) => new Date(a.date) - new Date(b.date))

    // Reconstruct running balance so the last row equals the bin's current SOH.
    const delta = r => (r.received || 0) - (r.issued || 0) + (r.adjustment || 0)
    let bal = currentBalance - rows.reduce((s, r) => s + delta(r), 0)
    for (const r of rows) { bal += delta(r); r.balance = bal }

    return {
      facility, commodity, location, currentBalance,
      openingBalance: rows.length ? rows[0].balance - delta(rows[0]) : currentBalance,
      rows,
    }
  }

  static async _soh(sql, params) {
    return Number((await query(sql, params)).rows[0]?.q ?? 0)
  }

  // ---- Main Store ledger --------------------------------------------------
  static async _storeRows(facilityId, commodityId) {
    const rows = []

    // 1) Intake → Received
    for (const r of (await query(
      `select received_at "date", quantity, supplier_source, batch_number, expiry_date, delivery_note_ref, received_by, notes
       from intake_log where facility_id = $1 and commodity_id = $2`, [facilityId, commodityId])).rows) {
      rows.push({
        date: r.date, type: 'Intake', ref: r.delivery_note_ref || '', party: r.supplier_source || '',
        batch: r.batch_number || '', expiry: r.expiry_date || '',
        received: r.quantity, issued: 0, adjustment: 0,
        by: r.received_by || '', remarks: r.notes || '',
      })
    }

    // 2) Adjustments → signed Loss/Adj
    for (const r of (await query(
      `select adjusted_at "date", quantity, adjustment_type, reason, reference_number, adjusted_by, notes, batch_number, expiry_date
       from stock_adjustment_log where facility_id = $1 and commodity_id = $2`, [facilityId, commodityId])).rows) {
      const signed = r.adjustment_type === 'Decrease' ? -r.quantity : r.quantity
      rows.push({
        date: r.date, type: 'Adjustment', ref: r.reference_number || '', party: r.reason || '',
        batch: r.batch_number || '', expiry: r.expiry_date || '',
        received: 0, issued: 0, adjustment: signed,
        by: r.adjusted_by || '', remarks: [r.reason, r.notes].filter(Boolean).join(' — '),
      })
    }

    // 3) Transfers that moved stock and touch this facility
    for (const r of (await query(
      `select sending_facility_id, sending_facility_name, receiving_facility_id, receiving_facility_name,
              quantity, status, resolved_at, initiated_at, resolved_by, notes
       from stock_transfer_log
       where commodity_id = $2 and (sending_facility_id = $1 or receiving_facility_id = $1)`, [facilityId, commodityId])).rows) {
      if (!MOVED_STATUSES.has(r.status)) continue
      const date = r.resolved_at || r.initiated_at
      // Internal redistribution store→(dispensary/DSD/SDP) is recorded with the
      // sending facility = us and receiving_facility_id null (or, older rows, = us).
      const internal = r.sending_facility_id === facilityId &&
        (r.receiving_facility_id == null || r.receiving_facility_id === facilityId)
      if (internal) {
        // store → dispensary / DSD / SDP : store is Issued
        const dest = rx(r.notes, 'DSD') || rx(r.notes, 'SDP') || 'Dispensary'
        rows.push({ date, type: 'Redistribution', ref: '', party: `→ ${dest}`, batch: '', expiry: '',
          received: 0, issued: r.quantity, adjustment: 0, by: r.resolved_by || '', remarks: r.notes || '' })
      } else if (r.receiving_facility_id === facilityId) {
        rows.push({ date, type: 'Transfer in', ref: '', party: `from ${r.sending_facility_name || '—'}`, batch: '', expiry: '',
          received: r.quantity, issued: 0, adjustment: 0, by: r.resolved_by || '', remarks: r.status })
      } else {
        rows.push({ date, type: 'Transfer out', ref: '', party: `to ${r.receiving_facility_name || '—'}`, batch: '', expiry: '',
          received: 0, issued: r.quantity, adjustment: 0, by: r.resolved_by || '', remarks: r.status })
      }
    }
    return rows
  }

  // ---- Dispensary ledger --------------------------------------------------
  static async _dispensaryRows(facilityId, commodityId) {
    const rows = []
    // Internal redistribution store→dispensary (untagged) → Received
    for (const r of await BinCardService._internalRedistributions(facilityId, commodityId)) {
      if (isSiteTagged(r.notes)) continue
      rows.push({ date: r.resolved_at || r.initiated_at, type: 'Redistribution', ref: '', party: 'from Main Store',
        batch: '', expiry: '', received: r.quantity, issued: 0, adjustment: 0, by: r.resolved_by || '', remarks: r.notes || '' })
    }
    // Dispensing (untagged = from dispensary) → Issued
    for (const r of await BinCardService._dispenses(facilityId, commodityId)) {
      if (isSiteTagged(r.notes)) continue
      rows.push(BinCardService._dispenseRow(r))
    }
    return rows
  }

  // ---- DSD / SDP site ledger ---------------------------------------------
  static async _siteRows(facilityId, commodityId, tag, site) {
    const rows = []
    for (const r of await BinCardService._internalRedistributions(facilityId, commodityId)) {
      if (!tagMatches(r.notes, tag, site)) continue
      rows.push({ date: r.resolved_at || r.initiated_at, type: 'Redistribution', ref: '', party: 'from Main Store',
        batch: '', expiry: '', received: r.quantity, issued: 0, adjustment: 0, by: r.resolved_by || '', remarks: r.notes || '' })
    }
    for (const r of await BinCardService._dispenses(facilityId, commodityId)) {
      if (!tagMatches(r.notes, tag, site)) continue
      rows.push(BinCardService._dispenseRow(r))
    }
    return rows
  }

  // Accepted internal redistributions out of the store (receiving_facility_id
  // null, or = us on older rows). Destination bin is read from the notes tag.
  static async _internalRedistributions(facilityId, commodityId) {
    return (await query(
      `select quantity, status, resolved_at, initiated_at, resolved_by, notes
       from stock_transfer_log
       where commodity_id = $2 and sending_facility_id = $1
         and (receiving_facility_id is null or receiving_facility_id = $1)`, [facilityId, commodityId])).rows
      .filter(r => MOVED_STATUSES.has(r.status))
  }

  static async _dispenses(facilityId, commodityId) {
    return (await query(
      `select dispensed_at "date", quantity, dispensed_to, dispensed_by, regimen_name, notes
       from dispense_log where facility_id = $1 and commodity_id = $2`, [facilityId, commodityId])).rows
  }

  static _dispenseRow(r) {
    return {
      date: r.date, type: 'Dispense', ref: '', party: r.dispensed_to || '', batch: '', expiry: '',
      received: 0, issued: r.quantity, adjustment: 0, by: r.dispensed_by || '',
      remarks: [r.regimen_name, r.notes].filter(Boolean).join(' · '),
    }
  }
}
