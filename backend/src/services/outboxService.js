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

// One sender per `kind`. Each throws on a non-2xx so the row is retried with backoff.
const SENDERS = {
  // Tell the WMS who signed for a delivery once the facility confirms receipt.
  //   payload: { envoRequestId, receivedBy, receivedAt }
  wms_receipt: async (payload) => {
    const res = await fetch(`${WMS_API_URL}/inbound/requests/receipt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-token': SERVICE_TOKEN || '' },
      body: JSON.stringify(payload),
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
  // double-send. Each row is independent (a receipt per request, terminal), so no
  // per-request causality gate is needed here.
  static async drainOnce() {
    const { rows: claimed } = await query(
      `update outbox set attempts = attempts + 1
        where id in (
          select id from outbox
           where delivered_at is null and next_attempt_at <= now()
           order by id
           limit ${BATCH}
           for update skip locked
        )
        returning id, kind, payload, attempts`
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
