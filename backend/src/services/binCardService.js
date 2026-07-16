import { query } from '../db.js'

// A bin card is a per-commodity, per-bin running ledger. Step 1 implements the
// MAIN STORE bin; the same shape extends to dispensary / DSD / SDP later.
//
// Store-bin movements:
//   Received   = Intake; external transfer accepted INTO this facility
//   Issued     = external transfer accepted OUT; internal redistribution store→bin
//   Loss/Adj   = stock_adjustment_log (signed: Increase +, Decrease −). Returns
//                to store land here as +; the source bin mirrors them as Issued
//                (handled when we build the dispensary/site cards).
//
// Balance is reconstructed so the final row equals the authoritative store SOH:
//   opening = currentSOH − Σ(deltas); then accumulate forward.

// Transfer statuses that represent stock that actually moved (not pending/
// in-transit/disputed/cancelled). Refine against prod if other terminal
// stock-moving statuses exist.
const MOVED_STATUSES = new Set(['accepted'])

const rx = (notes, tag) => new RegExp(`\\[${tag}:\\s*([^\\]]+)\\]`).exec(notes || '')?.[1]?.trim()

export class BinCardService {
  static async getBinCard(facilityId, commodityId, location = 'store') {
    if (location !== 'store') throw new Error(`bin '${location}' not implemented yet (step 1 = store only)`)

    const facility  = (await query('select name, state, lga, code from facilities where id = $1', [facilityId])).rows[0] || {}
    const commodity = (await query('select name, unit, category, pack_size from commodities where id = $1', [commodityId])).rows[0] || {}

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
      const internal = r.sending_facility_id === r.receiving_facility_id
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

    rows.sort((a, b) => new Date(a.date) - new Date(b.date))

    const currentBalance = Number((await query(
      `select coalesce(quantity, 0) q from stock where facility_id = $1 and commodity_id = $2 and location_type = 'store'`,
      [facilityId, commodityId])).rows[0]?.q ?? 0)

    // Reconstruct running balance so the last row equals current store SOH.
    const delta = r => (r.received || 0) - (r.issued || 0) + (r.adjustment || 0)
    let bal = currentBalance - rows.reduce((s, r) => s + delta(r), 0)
    for (const r of rows) { bal += delta(r); r.balance = bal }

    return { facility, commodity, location, currentBalance, openingBalance: rows.length ? rows[0].balance - delta(rows[0]) : currentBalance, rows }
  }
}
