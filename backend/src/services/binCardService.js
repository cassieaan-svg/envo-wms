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

// Transfer statuses that represent stock that actually moved. INBOUND (we're the
// receiver) only lands on 'accepted' — that's when the stock reaches us. OUTBOUND
// (we're the sender) leaves our store the moment it's DISPATCHED, so a still-in-
// transit dispatch has already reduced our stock and must show as Issued — otherwise
// its quantity silently disappears into a negative opening balance. 'disputed' is
// excluded from OUTBOUND: a dispute returns the stock to the sender.
const MOVED_STATUSES = new Set(['accepted'])
const OUTBOUND_MOVED = new Set(['in_transit', 'dispatched', 'accepted'])

// Pull "[TAG: value]" out of a notes string (used both to route redistributions/
// dispenses to a site bin and to label the store's outgoing redistributions).
const rx = (notes, tag) => new RegExp(`\\[${tag}:\\s*([^\\]]+)\\]`, 'i').exec(notes || '')?.[1]?.trim()
const isSiteTagged = notes => !!(rx(notes, 'DSD') || rx(notes, 'SDP'))
// The genuine free-text note a person typed for a movement — strip the machine
// tags ([Batch: …], [DSD: …], [Internal:] …) and the derived balance:/required:
// tokens, leaving only what was entered by hand. Empty when there was none. The
// bin card's Remarks column shows only this, not status/reason/regimen chatter.
const freeNote = notes => String(notes || '')
  .replace(/\[[^\]]*\]/g, ' ')
  .replace(/\b(balance|required)\s*:\s*-?\d+/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim()
const tagMatches = (notes, tag, site) => {
  const v = rx(notes, tag)
  return v != null && v.toLowerCase() === String(site).trim().toLowerCase()
}
// Site named in a "Returned from <DSD/SDP site>: <name>" adjustment note.
const returnSite = notes => /Returned from [^:]*:\s*([^—]+)/i.exec(notes || '')?.[1]?.trim() || null

// location string → { kind, site }
function parseLocation(location) {
  if (location === 'dispensary') return { kind: 'dispensary' }
  const m = /^(dsd|sdp):(.+)$/i.exec(location || '')
  if (m) return { kind: m[1].toLowerCase(), site: m[2].trim() }
  return { kind: 'store' }
}

// ── FEFO batch attribution ────────────────────────────────────────────────
// EnVo records a batch only on intakes, adjustments and external transfers (in
// their notes). Internal redistributions and dispenses carry no batch, so the
// batch they moved is ESTIMATED first-expiry-first-out from what's on hand. The
// rule: a movement that recorded its own batch keeps it and consumes exactly
// that batch; only movements with no recorded batch are FEFO-estimated.
const recvOf = r => (r.received || 0) + Math.max(0, r.adjustment || 0)
const issOf  = r => (r.issued || 0) + Math.max(0, -(r.adjustment || 0))
const expKey = e => e ? new Date(e).toISOString().slice(0, 10) : ''

function makeLots() {
  const pool = []   // { batch, expiry, rem }
  return {
    add(batch, expiry, qty) {
      if (!(qty > 0)) return
      const b = batch || '', k = `${b}|${expKey(expiry)}`
      let l = pool.find(x => x.k === k)
      if (!l) { l = { k, batch: b, expiry: expiry || null, rem: 0 }; pool.push(l) }
      l.rem += qty
    },
    // Draw from a recorded batch (or expiry) when given, otherwise soonest-expiry first.
    draw(qty, m = {}) {
      const taken = []
      let pick = pool.filter(l => l.rem > 1e-9)
      if (m.batch)        pick = pick.filter(l => l.batch === m.batch)
      else if (m.expiry)  pick = pick.filter(l => expKey(l.expiry) === expKey(m.expiry))
      else                pick = pick.sort((a, b) => new Date(a.expiry || '9999-12-31') - new Date(b.expiry || '9999-12-31'))
      for (const l of pick) {
        if (qty <= 1e-9) break
        const t = Math.min(l.rem, qty); l.rem -= t; qty -= t
        taken.push({ batch: l.batch, expiry: l.expiry, qty: t })
      }
      return taken
    },
    // What's left after all movements — the lots physically on hand, soonest-expiry
    // first. This is exactly the opening balance for the lot ledger seed.
    residuals() {
      return pool.filter(l => l.rem > 1e-9)
        .sort((a, b) => new Date(a.expiry || '9999-12-31') - new Date(b.expiry || '9999-12-31'))
        .map(l => ({ batch: l.batch || null, expiry: l.expiry || null, qty: Math.round(l.rem) }))
    },
  }
}

// Attribute batches across a bin's rows via FEFO. Receipts seed lots (a
// redistribution-in uses `_seedLots`, the batch breakdown handed down from the
// store; others seed their own recorded batch). Issues with a recorded batch
// consume that exact batch and keep it displayed; issues with none are set to
// what FEFO drew. Returns Map(transferId → drawn lots) so sub-bins can inherit
// which batch each redistribution carried. Never overrides a recorded batch.
// `out` (optional) receives the lots pool as out.lots, so a caller can read the
// residual holdings after attribution (used to seed the lot ledger) without
// changing the return value existing callers rely on.
function fefoAttribute(rows, out) {
  const lots = makeLots()
  const order = [...rows].sort((a, b) => (new Date(a.date) - new Date(b.date)) || (recvOf(b) - recvOf(a)))
  const drawnByTid = new Map()
  for (const r of order) {
    if (recvOf(r) > 0) {
      if (r._seedLots?.length) for (const s of r._seedLots) lots.add(s.batch, s.expiry, s.qty)
      else lots.add(r.batch, r.expiry, recvOf(r))
    } else if (issOf(r) > 0) {
      // A movement that recorded its own batch or expiry keeps it (and consumes
      // that lot); only a movement that recorded neither is FEFO-estimated.
      const recorded = !!(r.batch || r.expiry)
      const taken = recorded ? lots.draw(issOf(r), { batch: r.batch, expiry: r.expiry }) : lots.draw(issOf(r))
      if (!recorded && taken.length) {
        r.batch = [...new Set(taken.map(t => t.batch).filter(Boolean))].join(', ')
        r.expiry = taken.length === 1 ? taken[0].expiry : ''
      }
      if (r._tid) drawnByTid.set(r._tid, taken)
    }
  }
  if (out) out.lots = lots
  return drawnByTid
}

export class BinCardService {
  // The bins that exist for a facility, for the location selector. Bins are
  // section-specific: pharmacy dispenses from the Dispensary and DSD sites; lab
  // dispenses at its SDP site(s) (e.g. "Main Lab"). So a lab caller must not see
  // the Dispensary and a pharmacy caller must not see SDP sites. `section` is the
  // caller's commodity_section ('pharmacy' | 'lab'); null (overall/state admin,
  // sees both) shows every bin. Always includes Main Store.
  static async getBins(facilityId, section = null) {
    const bins = [{ value: 'store', label: 'Main Store' }]
    const wantPharm = section == null || section === 'pharmacy'
    const wantLab   = section == null || section === 'lab'
    if (wantPharm) {
      const hasDisp = (await query(
        `select 1 from stock where facility_id = $1 and location_type = 'dispensary' limit 1`, [facilityId])).rows.length
      if (hasDisp) bins.push({ value: 'dispensary', label: 'Dispensary' })
      for (const r of (await query(
        `select distinct dsd_site_name s from dsd_stock where facility_id = $1 and coalesce(dsd_site_name,'') <> '' order by 1`,
        [facilityId])).rows) bins.push({ value: `dsd:${r.s}`, label: `DSD — ${r.s}` })
    }
    if (wantLab) {
      for (const r of (await query(
        `select distinct sdp_name s from sdp_stock where facility_id = $1 and coalesce(sdp_name,'') <> '' order by 1`,
        [facilityId])).rows) bins.push({ value: `sdp:${r.s}`, label: `SDP — ${r.s}` })
    }
    return bins
  }

  static async getBinCard(facilityId, commodityId, location = 'store') {
    const { kind, site } = parseLocation(location)

    const facility  = (await query('select name, state, lga, code from facilities where id = $1', [facilityId])).rows[0] || {}
    const commodity = (await query('select name, unit, category, pack_size from commodities where id = $1', [commodityId])).rows[0] || {}

    // The store ledger is built (and FEFO-attributed) always: its per-redistribution
    // batch attribution is what a sub-bin's incoming stock inherits.
    const storeRows = await BinCardService._storeRows(facilityId, commodityId)
    const redistBatches = fefoAttribute(storeRows)   // Map(transferId → drawn lots); also sets store rows' batches

    let rows, currentBalance
    if (kind === 'store') {
      rows = storeRows
      currentBalance = await BinCardService._soh(
        `select coalesce(quantity,0) q from stock where facility_id=$1 and commodity_id=$2 and location_type='store'`,
        [facilityId, commodityId])
    } else {
      if (kind === 'dispensary') {
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
      // Each redistribution INTO this bin carries whatever batch(es) FEFO drew out
      // of the store for that transfer. Seed those, then FEFO the bin's dispenses.
      for (const r of rows) {
        if (r._tid && recvOf(r) > 0 && !r.batch && !r.expiry) {
          const taken = redistBatches.get(r._tid)
          if (taken?.length) {
            r._seedLots = taken
            r.batch = [...new Set(taken.map(t => t.batch).filter(Boolean))].join(', ')
            r.expiry = taken.length === 1 ? taken[0].expiry : ''
          }
        }
      }
      fefoAttribute(rows)
    }

    // An explicitly recorded opening balance is a real line on the card, not the
    // silent plug below. Where one exists the plug collapses to 0 and the baseline
    // becomes visible and attributable. Record-only: the stock is already counted in
    // currentBalance, so this must not also move stock.
    const opening = (await query(
      `select quantity, opened_at, recorded_by, notes from bin_opening
        where facility_id=$1 and commodity_id=$2 and location_type=$3
          and coalesce(site_name,'') = coalesce($4,'')`,
      [facilityId, commodityId, kind, site || null])).rows[0]
    if (opening && opening.quantity !== 0) {
      rows.push({
        date: opening.opened_at, type: 'Opening balance', ref: '', party: '',
        batch: '', expiry: '',
        received: opening.quantity > 0 ? opening.quantity : 0,
        issued: opening.quantity < 0 ? -opening.quantity : 0,
        adjustment: 0, by: opening.recorded_by,
        remarks: opening.notes || 'Balance on hand before the first recorded movement',
      })
    }

    rows.sort((a, b) => new Date(a.date) - new Date(b.date))

    // Reconstruct running balance so the last row equals the bin's current SOH.
    const delta = r => (r.received || 0) - (r.issued || 0) + (r.adjustment || 0)
    let bal = currentBalance - rows.reduce((s, r) => s + delta(r), 0)
    for (const r of rows) { bal += delta(r); r.balance = bal; delete r._tid; delete r._seedLots }

    return {
      facility, commodity, location, currentBalance,
      openingBalance: rows.length ? rows[0].balance - delta(rows[0]) : currentBalance,
      rows,
    }
  }

  static async _soh(sql, params) {
    return Number((await query(sql, params)).rows[0]?.q ?? 0)
  }

  // FEFO-estimated batch/expiry each of this commodity's redistributions drew from
  // the store, keyed by transfer id. Used to pre-fill the Internal RIRV; the
  // estimate is never written back to the transfer's notes.
  static async redistBatches(facilityId, commodityId) {
    const storeRows = await BinCardService._storeRows(facilityId, commodityId)
    const drawn = fefoAttribute(storeRows)   // Map(transferId → taken lots)
    const out = {}
    for (const [tid, taken] of drawn) {
      if (!taken?.length) continue
      out[tid] = {
        batch: [...new Set(taken.map(t => t.batch).filter(Boolean))].join(', '),
        expiry: taken.length === 1 ? taken[0].expiry : null,
      }
    }
    return out
  }

  // The lots physically remaining in ONE bin (store / dispensary / a DSD or SDP
  // site), reconstructed with the same FEFO engine that drives the bin card:
  // receipts seed lots, issues draw them (honouring any recorded batch), and what
  // is left is the on-hand holding by batch+expiry. This is the opening balance
  // the lot ledger seeds from — no new estimation logic, so the seed matches what
  // the bin card already shows. Returns [{ batch, expiry, qty }], soonest-expiry
  // first. The caller reconciles the total to the bin's actual stock quantity.
  static async residualLots(facilityId, commodityId, location) {
    const { kind, site } = parseLocation(location)
    const storeRows = await BinCardService._storeRows(facilityId, commodityId)
    const storeOut = {}
    const redistBatches = fefoAttribute(storeRows, storeOut)   // also attributes storeRows
    if (kind === 'store') return storeOut.lots.residuals()

    const rows = kind === 'dispensary'
      ? await BinCardService._dispensaryRows(facilityId, commodityId)
      : await BinCardService._siteRows(facilityId, commodityId, kind.toUpperCase(), site)
    // Each redistribution INTO this bin carries whatever batch(es) FEFO drew from
    // the store for that transfer (same seeding getBinCard does before attributing).
    for (const r of rows) {
      if (r._tid && recvOf(r) > 0 && !r.batch && !r.expiry) {
        const taken = redistBatches.get(r._tid)
        if (taken?.length) {
          r._seedLots = taken
          r.batch = [...new Set(taken.map(t => t.batch).filter(Boolean))].join(', ')
          r.expiry = taken.length === 1 ? taken[0].expiry : ''
        }
      }
    }
    const out = {}
    fefoAttribute(rows, out)
    return out.lots.residuals()
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
        by: r.received_by || '', remarks: freeNote(r.notes),
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
        by: r.adjusted_by || '', remarks: freeNote(r.notes),   // reason already shows in the party column
      })
    }

    // 3) Transfers that moved stock and touch this facility
    for (const r of (await query(
      `select id, sending_facility_id, sending_facility_name, receiving_facility_id, receiving_facility_name,
              quantity, status, resolved_at, initiated_at, resolved_by, notes
       from stock_transfer_log
       where commodity_id = $2 and (sending_facility_id = $1 or receiving_facility_id = $1)`, [facilityId, commodityId])).rows) {
      // Internal redistribution store→(dispensary/DSD/SDP) is recorded with the
      // sending facility = us and receiving_facility_id null (or, older rows, = us).
      const internal = r.sending_facility_id === facilityId &&
        (r.receiving_facility_id == null || r.receiving_facility_id === facilityId)
      const outbound = r.sending_facility_id === facilityId          // we're the source (external out or store→site)
      const inbound  = r.receiving_facility_id === facilityId && r.sending_facility_id !== facilityId
      // Outbound counts once dispatched (stock left our store); inbound only on accept.
      if (outbound ? !OUTBOUND_MOVED.has(r.status) : !MOVED_STATUSES.has(r.status)) continue
      const date = r.resolved_at || r.initiated_at
      // A dispatched-but-unaccepted outbound is real stock in transit — label it so the
      // Issued row is clearly a pending delivery, not a completed handover.
      const transit = outbound && r.status !== 'accepted' ? `⏳ in transit — awaiting ${r.receiving_facility_name || 'receiver'} acceptance` : ''
      const remarks = [freeNote(r.notes), transit].filter(Boolean).join(' · ')
      const batch = rx(r.notes, 'Batch') || '', expiry = rx(r.notes, 'Expiry') || ''
      if (internal) {
        // store → dispensary / DSD / SDP : store is Issued. Batch is FEFO-estimated.
        const dest = rx(r.notes, 'DSD') || rx(r.notes, 'SDP') || 'Dispensary'
        rows.push({ _tid: r.id, date, type: 'Redistribution', ref: '', party: dest, batch, expiry,
          received: 0, issued: r.quantity, adjustment: 0, by: r.resolved_by || '', remarks })
      } else if (inbound) {
        rows.push({ _tid: r.id, date, type: 'Transfer in', ref: '', party: `from ${r.sending_facility_name || '—'}`, batch, expiry,
          received: r.quantity, issued: 0, adjustment: 0, by: r.resolved_by || '', remarks })
      } else {
        rows.push({ _tid: r.id, date, type: 'Transfer out', ref: '', party: `to ${r.receiving_facility_name || '—'}`, batch, expiry,
          received: 0, issued: r.quantity, adjustment: 0, by: r.resolved_by || '', remarks })
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
      rows.push({ _tid: r.id, date: r.resolved_at || r.initiated_at, type: 'Redistribution', ref: '', party: 'from Main Store',
        batch: rx(r.notes, 'Batch') || '', expiry: rx(r.notes, 'Expiry') || '',
        received: r.quantity, issued: 0, adjustment: 0, by: r.resolved_by || '', remarks: freeNote(r.notes) })
    }
    // Dispensing (untagged = from dispensary) → Issued
    for (const r of await BinCardService._dispenses(facilityId, commodityId)) {
      if (isSiteTagged(r.notes)) continue
      rows.push(BinCardService._dispenseRow(r))
    }
    // "Returned from Dispensary" adjustments credit the store (an Increase adj), so
    // they LEAVE the dispensary → Issued here. Without this the dispensary opening
    // goes negative by the returned amount (the store side already shows the +).
    for (const r of (await query(
      `select adjusted_at "date", quantity, reference_number, adjusted_by, notes, batch_number, expiry_date
         from stock_adjustment_log
        where facility_id = $1 and commodity_id = $2 and reason = 'Returned from Dispensary'`, [facilityId, commodityId])).rows) {
      rows.push({ date: r.date, type: 'Return to store', ref: r.reference_number || '', party: 'to Main Store',
        batch: r.batch_number || '', expiry: r.expiry_date || '',
        received: 0, issued: r.quantity, adjustment: 0, by: r.adjusted_by || '', remarks: freeNote(r.notes) })
    }
    return rows
  }

  // ---- DSD / SDP site ledger ---------------------------------------------
  static async _siteRows(facilityId, commodityId, tag, site) {
    const rows = []
    for (const r of await BinCardService._internalRedistributions(facilityId, commodityId)) {
      if (!tagMatches(r.notes, tag, site)) continue
      rows.push({ _tid: r.id, date: r.resolved_at || r.initiated_at, type: 'Redistribution', ref: '', party: 'from Main Store',
        batch: rx(r.notes, 'Batch') || '', expiry: rx(r.notes, 'Expiry') || '',
        received: r.quantity, issued: 0, adjustment: 0, by: r.resolved_by || '', remarks: freeNote(r.notes) })
    }
    for (const r of await BinCardService._dispenses(facilityId, commodityId)) {
      if (!tagMatches(r.notes, tag, site)) continue
      rows.push(BinCardService._dispenseRow(r))
    }
    // "Returned from DSD/SDP: <site>" adjustments credit the store, so they LEAVE
    // this site → Issued here (matched by the site named in the note).
    for (const r of (await query(
      `select adjusted_at "date", quantity, reference_number, adjusted_by, notes, batch_number, expiry_date
         from stock_adjustment_log
        where facility_id = $1 and commodity_id = $2 and reason in ('Returned from DSD', 'Returned from SDP')`, [facilityId, commodityId])).rows) {
      const rs = returnSite(r.notes)
      if (!rs || rs.toLowerCase() !== String(site).trim().toLowerCase()) continue
      rows.push({ date: r.date, type: 'Return to store', ref: r.reference_number || '', party: 'to Main Store',
        batch: r.batch_number || '', expiry: r.expiry_date || '',
        received: 0, issued: r.quantity, adjustment: 0, by: r.adjusted_by || '', remarks: freeNote(r.notes) })
    }
    return rows
  }

  // Accepted internal redistributions out of the store (receiving_facility_id
  // null, or = us on older rows). Destination bin is read from the notes tag.
  static async _internalRedistributions(facilityId, commodityId) {
    return (await query(
      `select id, quantity, status, resolved_at, initiated_at, resolved_by, notes
       from stock_transfer_log
       where commodity_id = $2 and sending_facility_id = $1
         and (receiving_facility_id is null or receiving_facility_id = $1)`, [facilityId, commodityId])).rows
      .filter(r => MOVED_STATUSES.has(r.status))
  }

  static async _dispenses(facilityId, commodityId) {
    return (await query(
      `select dispensed_at "date", quantity, dispensed_to, dispensed_by, regimen_name, notes, batch_number, expiry_date
       from dispense_log where facility_id = $1 and commodity_id = $2`, [facilityId, commodityId])).rows
  }

  static _dispenseRow(r) {
    // Prefer the batch the user actually chose at dispense (recorded columns);
    // fall back to a legacy notes-encoded batch; leave blank so FEFO estimates
    // when neither exists.
    return {
      date: r.date, type: 'Dispense', ref: '', party: r.dispensed_to || '',
      batch: r.batch_number || rx(r.notes, 'Batch') || '',
      expiry: r.expiry_date || rx(r.notes, 'Expiry') || '',
      received: 0, issued: r.quantity, adjustment: 0, by: r.dispensed_by || '',
      remarks: freeNote(r.notes),
    }
  }
}
