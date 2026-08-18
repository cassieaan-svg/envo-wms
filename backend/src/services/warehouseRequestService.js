import { query, withTransaction } from '../db.js'
import { StockService } from './stockService.js'
import { OutboxService } from './outboxService.js'

const WMS_API_URL = process.env.WMS_API_URL || 'http://localhost:5100'
const SERVICE_TOKEN = process.env.SERVICE_TOKEN

function round2(v) { return Math.round(Number(v) * 100) / 100 }

// A valid Nigerian phone number is 11 digits starting with 0 (e.g. 08031234567).
// Spaces / dashes are stripped first; a +234... form is normalised to its 0-leading 11.
export function normalizeNgPhone(raw) {
  let d = String(raw || '').replace(/[^\d+]/g, '')
  if (d.startsWith('+234')) d = '0' + d.slice(4)
  else if (d.startsWith('234')) d = '0' + d.slice(3)
  return /^0\d{10}$/.test(d) ? d : null
}

// Facility-raised, priced requests to the central warehouse (envo-wms). See
// db/migrations/20260801_warehouse_requests.sql for the lifecycle.
export class WarehouseRequestService {
  // Build a request from { facilityId, items:[{ commodityId, quantity }] }. Prices are
  // snapshotted from the essential catalogue (unit_price, synced from the WMS); the WMS
  // recomputes the authoritative total when it accepts. Unpriced commodities are rejected
  // — they can't carry a line total. Writes the request 'pending', then tries to submit
  // to the WMS; a submit failure leaves it 'pending' (resubmittable), it is not lost.
  static async create({ facilityId, items, requestedBy, requesterPhone, notes }) {
    if (!Array.isArray(items) || items.length === 0) {
      const e = new Error('At least one line item is required'); e.status = 400; throw e
    }
    if (!requestedBy || !requestedBy.trim()) {
      const e = new Error('A requester name is required'); e.status = 400; throw e
    }
    const phone = normalizeNgPhone(requesterPhone)
    if (!phone) {
      const e = new Error('A valid Nigerian phone number (11 digits, e.g. 08031234567) is required'); e.status = 400; throw e
    }

    // Resolve each line against the essential catalogue.
    const ids = items.map(i => i.commodityId)
    const { rows: comms } = await query(
      `select id, name, wms_commodity_id, unit_price
         from commodities where id = any($1) and module = 'essential'`,
      [ids]
    )
    const byId = new Map(comms.map(c => [c.id, c]))

    const lines = []
    for (const item of items) {
      const c = byId.get(item.commodityId)
      const qty = parseInt(item.quantity)
      if (!c) { const e = new Error(`Commodity ${item.commodityId} is not an essential commodity`); e.status = 400; throw e }
      if (!(qty > 0)) { const e = new Error(`Invalid quantity for ${c.name}`); e.status = 400; throw e }
      if (c.unit_price == null) { const e = new Error(`${c.name} has no price yet and can't be requested`); e.status = 400; throw e }
      // The requester's cost-per-unit is prefilled from the catalogue but may be adjusted;
      // fall back to the catalogue price if none/invalid was sent. The WMS still recomputes
      // the authoritative total on submit.
      const unitPrice = (item.unitPrice != null && Number(item.unitPrice) >= 0) ? Number(item.unitPrice) : Number(c.unit_price)
      lines.push({
        commodityId: c.id,
        wmsCommodityId: c.wms_commodity_id,
        qty,
        unitPrice,
        lineTotal: round2(qty * unitPrice),
      })
    }
    const total = round2(lines.reduce((s, l) => s + l.lineTotal, 0))

    const request = await withTransaction(async exec => {
      const { rows } = await exec(
        `insert into warehouse_requests
           (facility_id, status, total_amount, requested_by, requester_phone, notes)
         values ($1, 'pending', $2, $3, $4, $5) returning *`,
        [facilityId, total, requestedBy.trim(), phone, notes ?? null]
      )
      const req = rows[0]
      for (const l of lines) {
        await exec(
          `insert into warehouse_request_items
             (request_id, commodity_id, wms_commodity_id, qty_requested, unit_price, line_total)
           values ($1, $2, $3, $4, $5, $6)`,
          [req.id, l.commodityId, l.wmsCommodityId, l.qty, l.unitPrice, l.lineTotal]
        )
      }
      return req
    })

    // Fire the request at the warehouse. Best-effort: on failure it stays 'pending'.
    await this._submitToWms(request.id).catch(err =>
      console.warn(`[warehouse-request] submit ${request.id} deferred: ${err.message}`))

    return this.getById(request.id)
  }

  // POST the request to the WMS inbound queue. On a 2xx, record the wms_request_id and
  // flip to 'submitted'. Throws on any failure so the caller can leave it 'pending'.
  static async _submitToWms(requestId) {
    const req = await this.getById(requestId)
    if (!req || req.status !== 'pending') return req

    const { rows: fac } = await query('select code, name, state, lga from facilities where id = $1', [req.facility_id])
    const facility = fac[0] || {}

    const res = await fetch(`${WMS_API_URL}/inbound/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-token': SERVICE_TOKEN || '' },
      body: JSON.stringify({
        envoRequestId: req.id,
        envoFacilityId: facility.code,
        facilityName: facility.name,
        requestedBy: req.requested_by,
        requesterPhone: req.requester_phone,
        notes: req.notes,
        items: req.items.map(i => ({ wmsCommodityId: i.wms_commodity_id, quantity: i.qty_requested })),
      }),
    })
    if (!res.ok) throw new Error(`WMS /api/requests -> ${res.status}`)
    const body = await res.json().catch(() => ({}))
    const wmsId = body?.requestId ?? body?.data?.id ?? null

    const { rows } = await query(
      `update warehouse_requests set status = 'submitted', wms_request_id = $2, submitted_at = now()
       where id = $1 and status = 'pending' returning *`,
      [requestId, wmsId]
    )
    return rows[0] || req
  }

  // Retry a still-'pending' submit (WMS was down when it was raised).
  static async resubmit(requestId) {
    return this._submitToWms(requestId)
  }

  static async getById(id, exec = query) {
    const { rows } = await exec(
      `select r.*, f.name as facility_name, f.state, f.lga
         from warehouse_requests r join facilities f on f.id = r.facility_id
        where r.id = $1`, [id])
    const req = rows[0]
    if (!req) return null
    const { rows: items } = await exec(
      `select i.*, c.name as commodity_name, c.category, c.unit
         from warehouse_request_items i join commodities c on c.id = i.commodity_id
        where i.request_id = $1 order by c.category, c.name`, [id])
    return { ...req, items }
  }

  // List requests for a facility (or, for an admin scope, a set of facilities). Summary
  // rows (no line detail) for the list view.
  static async list({ facilityId = null, facilityIds = null, status = null } = {}) {
    const conds = [], params = []
    if (facilityId) { params.push(facilityId); conds.push(`r.facility_id = $${params.length}`) }
    else if (Array.isArray(facilityIds)) {
      if (facilityIds.length === 0) return []
      params.push(facilityIds); conds.push(`r.facility_id = any($${params.length})`)
    }
    if (status) { params.push(status); conds.push(`r.status = $${params.length}`) }
    const where = conds.length ? `where ${conds.join(' and ')}` : ''
    const { rows } = await query(
      `select r.id, r.facility_id, f.name as facility_name, r.status, r.total_amount,
              r.wms_request_id, r.requested_by, r.requested_at, r.dispatched_at, r.received_at,
              count(i.id)::int as line_count, coalesce(sum(i.qty_requested),0)::int as total_quantity
         from warehouse_requests r
         join facilities f on f.id = r.facility_id
         left join warehouse_request_items i on i.request_id = r.id
         ${where}
         group by r.id, f.name
         order by r.requested_at desc`, params)
    return rows
  }

  static async cancel(id, { cancelledBy } = {}) {
    const { rows } = await query(
      `update warehouse_requests set status = 'cancelled', notes = coalesce(notes,'') || $2
         where id = $1 and status in ('pending','submitted') returning *`,
      [id, cancelledBy ? ` [Cancelled by: ${cancelledBy}]` : ' [Cancelled]'])
    return rows[0] || null
  }

  // How far through the lifecycle each status is. A callback that would move a request
  // backwards is ignored rather than applied: the WMS delivers these through a queue, and
  // a delayed 'picking' arriving after 'dispatched' would otherwise leave a shipped order
  // reading as still being picked. 'received' and 'cancelled' are ours, not the WMS's, and
  // are terminal as far as its callbacks are concerned.
  static WMS_STATUS_RANK = {
    pending: 0, submitted: 1, picking: 2, dispatched: 3, received: 4, cancelled: 4,
  }

  // WMS status callback: picking / dispatched (with per-line dispatched quantities and
  // the authoritative total). Matched by our envoRequestId.
  static async applyWmsStatus({ envoRequestId, wmsRequestId, status, totalAmount, reason, items }) {
    return withTransaction(async exec => {
      const { rows } = await exec('select * from warehouse_requests where id = $1 for update', [envoRequestId])
      const req = rows[0]
      if (!req) { const e = new Error('request not found'); e.status = 404; throw e }

      const from = this.WMS_STATUS_RANK[req.status] ?? -1
      const to = this.WMS_STATUS_RANK[status] ?? -1
      if (to < from) {
        console.warn(`[warehouse request ${envoRequestId}] ignoring late '${status}' callback; already '${req.status}'`)
        return req
      }

      if (Array.isArray(items)) {
        for (const it of items) {
          await exec(
            `update warehouse_request_items set qty_dispatched = $3
               where request_id = $1 and wms_commodity_id = $2`,
            [envoRequestId, it.wmsCommodityId, it.qtyDispatched ?? null])
        }
      }
      const dispatchedAt = status === 'dispatched' ? 'now()' : 'dispatched_at'
      // When the warehouse rejects, record why alongside the cancellation.
      const note = reason && status === 'cancelled' ? ` [Warehouse rejected: ${reason}]` : null
      const { rows: upd } = await exec(
        `update warehouse_requests
            set status = $2,
                wms_request_id = coalesce($3, wms_request_id),
                total_amount = coalesce($4, total_amount),
                dispatched_at = ${dispatchedAt},
                notes = case when $5::text is not null then coalesce(notes, '') || $5 else notes end
          where id = $1 returning *`,
        [envoRequestId, status, wmsRequestId ?? null, totalAmount ?? null, note])
      return upd[0]
    })
  }

  // Facility confirms receipt: mark received and credit the facility's essential store
  // stock (qty_dispatched when the WMS reported it, else qty_requested). upsertStock
  // reconciles the lot ledger so the stock==lots invariant holds.
  static async confirmReceipt(id, { receivedBy } = {}) {
    const updated = await withTransaction(async exec => {
      const req = await this.getById(id, exec)
      if (!req) return null
      if (req.status !== 'dispatched') { const e = new Error('Only a dispatched request can be received'); e.status = 409; throw e }

      for (const it of req.items) {
        const qty = it.qty_dispatched ?? it.qty_requested
        if (!(qty > 0)) continue
        const existing = await StockService.getStockByFacilityAndCommodity(req.facility_id, it.commodity_id, 'store', exec)
        await StockService.upsertStock(
          { facility_id: req.facility_id, commodity_id: it.commodity_id, location_type: 'store', quantity: (existing?.quantity || 0) + qty },
          exec)
      }
      const { rows } = await exec(
        `update warehouse_requests set status = 'received', received_at = now(), received_by = $2
           where id = $1 returning *`, [id, receivedBy ?? null])
      const row = rows[0]

      // Close the loop in the WMS through the outbox, in this same transaction — so if the
      // WMS is down when the facility confirms, the recipient still reaches it once it's
      // back, rather than being lost to a fire-and-forget call.
      await OutboxService.enqueue('wms_receipt', {
        envoRequestId: id,
        receivedBy: row?.received_by ?? receivedBy ?? null,
        receivedAt: row?.received_at ?? null,
      }, exec)

      return row
    })

    return updated
  }
}
