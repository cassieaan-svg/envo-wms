import { query } from '../db.js'

// Durable delivery of outbound calls to the WMS. A call is written to `outbox` in the same
// transaction as the state change it describes, and a worker (lib/outboxWorker.js) delivers
// it whenever the WMS is reachable — surviving an outage or a process restart. Mirrors the
// WMS's own outbox for the opposite direction.

const WMS_API_URL = process.env.WMS_API_URL || 'http://localhost:5100'
const SERVICE_TOKEN = process.env.SERVICE_TOKEN

const BATCH = 20
const BASE_BACKOFF_SECONDS = 30
const MAX_BACKOFF_SECONDS = 3600

const svcHeaders = { 'Content-Type': 'application/json', 'x-service-token': SERVICE_TOKEN || '' }

// One sender per `kind`. Each throws on a non-2xx so the row is retried with backoff.
const SENDERS = {
  // Deliver a facility's request to the WMS. Idempotent there (keyed on envoRequestId), and
  // the request body is rebuilt from the current DB state so it's always up to date. Skips a
  // request cancelled before it ever reached the warehouse.  payload: { envoRequestId }
  wms_submit: async ({ envoRequestId }) => {
    const { rows: r } = await query(
      `select r.id, r.status, r.requested_by, r.requester_phone, r.notes,
              f.code as facility_code, f.name as facility_name
         from warehouse_requests r join facilities f on f.id = r.facility_id
        where r.id = $1`, [envoRequestId])
    const req = r[0]
    if (!req) return {}                       // request gone
    if (req.status === 'cancelled') return {} // cancelled before it reached the WMS
    const { rows: items } = await query(
      'select wms_commodity_id, qty_requested from warehouse_request_items where request_id = $1', [envoRequestId])
    const res = await fetch(`${WMS_API_URL}/inbound/requests`, {
      method: 'POST', headers: svcHeaders,
      body: JSON.stringify({
        envoRequestId: req.id, envoFacilityId: req.facility_code, facilityName: req.facility_name,
        requestedBy: req.requested_by, requesterPhone: req.requester_phone, notes: req.notes,
        items: items.map(i => ({ wmsCommodityId: i.wms_commodity_id, quantity: i.qty_requested })),
      }),
    })
    if (!res.ok) throw new Error(`WMS /inbound/requests -> ${res.status}`)
    return res.json().catch(() => ({}))
  },

  // Tell the WMS the facility cancelled the request, so it drops it from the queue.
  //   payload: { envoRequestId, reason }
  wms_cancel: async (payload) => {
    const res = await fetch(`${WMS_API_URL}/inbound/requests/cancel`, {
      method: 'POST', headers: svcHeaders, body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error(`WMS cancel hook returned ${res.status}`)
    return res.json().catch(() => ({}))
  },

  // Tell the WMS who signed for a delivery once the facility confirms receipt.
  //   payload: { envoRequestId, receivedBy, receivedAt }
  wms_receipt: async (payload) => {
    const res = await fetch(`${WMS_API_URL}/inbound/requests/receipt`, {
      method: 'POST', headers: svcHeaders, body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error(`WMS receipt hook returned ${res.status}`)
    return res.json().catch(() => ({}))
  },
}

export class OutboxService {
  // Pass the transaction's `exec` so the enqueue commits atomically with the change it
  // describes. `exec` is the (text, params) helper withTransaction hands to its callback.
  static async enqueue(kind, payload, exec = query) {
    if (!SENDERS[kind]) throw new Error(`unknown outbox kind: ${kind}`)
    const { rows } = await exec(
      `insert into outbox (kind, payload) values ($1, $2::jsonb) returning id`,
      [kind, JSON.stringify(payload)]
    )
    return rows[0].id
  }

  // One pass over whatever is due. FIFO by id; SKIP LOCKED so overlapping ticks never
  // double-send. A row is held back while an earlier undelivered row for the SAME request
  // exists, so a request's calls stay in order (submit before cancel/receipt) even if the
  // first attempt fails.
  static async drainOnce() {
    const { rows: claimed } = await query(
      `update outbox o set attempts = attempts + 1
        where o.id in (
          select c.id from outbox c
           where c.delivered_at is null and c.next_attempt_at <= now()
             and not exists (
               select 1 from outbox earlier
                where earlier.delivered_at is null
                  and earlier.id < c.id
                  and earlier.payload->>'envoRequestId' is not distinct from c.payload->>'envoRequestId'
             )
           order by c.id
           limit ${BATCH}
           for update of c skip locked
        )
        returning o.id, o.kind, o.payload, o.attempts`
    )

    let delivered = 0, failed = 0
    for (const row of claimed) {
      try {
        await SENDERS[row.kind](row.payload)
        await query('update outbox set delivered_at = now(), last_error = null where id = $1', [row.id])
        delivered += 1
      } catch (err) {
        // Exponential backoff to an hour; no dead-letter — the WMS can be offline a while.
        await query(
          `update outbox
              set next_attempt_at = now() + (least(power(2, $2)::numeric * $3, $4) || ' seconds')::interval,
                  last_error = $5
            where id = $1`,
          [row.id, row.attempts, BASE_BACKOFF_SECONDS, MAX_BACKOFF_SECONDS, String(err.message).slice(0, 500)]
        )
        failed += 1
      }
    }
    return { claimed: claimed.length, delivered, failed }
  }
}
