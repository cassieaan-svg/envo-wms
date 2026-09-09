import { query } from '../db.js';
import { postRequestStatus, postPriceUpdate } from '../lib/envoClient.js';
import { pushTransaction, pushRequestStatus, pushPrice } from '../lib/cloudClient.js';
import { SyncService } from './syncService.js';
import { RequestStatusService } from './requestStatusService.js';
import { PriceService } from './priceService.js';

// Durable delivery of outbound calls to EnVo.
//
// Callbacks used to be fire-and-forget: three quick retries, then the failure was swallowed
// into a log line. A dispatch made while the link was down never reached EnVo, and the
// facility saw its request stuck forever with the stock already gone. Now the call is
// written to `outbox` in the same transaction as the state change it describes, and a
// worker delivers it whenever EnVo is reachable again — surviving an outage overnight or a
// process restart.

const BATCH = 20;
const BASE_BACKOFF_SECONDS = 30;
const MAX_BACKOFF_SECONDS = 3600;

// What each `kind` means. Adding a new outbound call means adding a sender here.
const SENDERS = {
  request_status: (payload) => postRequestStatus(payload, { attempts: 1 }),
  commodity_price: (payload) => postPriceUpdate(payload, { attempts: 1 }),

  // CMS -> Cloud. The envelope is built at SEND time, not at enqueue time, so a transaction
  // that was corrected before it ever synced (an order edited while the link was down) goes
  // up in its final state rather than as a stale snapshot followed by a correction.
  sync_transaction: async (payload) => {
    const envelope = await SyncService.buildEnvelope(payload.clientTxnId);
    if (!envelope) {
      // The transaction no longer exists locally. Nothing to send, and retrying forever
      // would block every later row for the same batch behind it.
      return { skipped: 'transaction no longer present locally' };
    }
    const res = await pushTransaction(envelope);
    await SyncService.markSynced(payload.clientTxnId);
    return res;
  },

  // CMS -> Cloud, for the transitions that move no stock and so have no inventory
  // transaction to travel inside.
  sync_request_status: async (payload) => {
    const envelope = await RequestStatusService.envelope(payload.eventUid);
    if (!envelope) return { skipped: 'status event no longer present locally' };
    const res = await pushRequestStatus(envelope);
    await RequestStatusService.markSynced(payload.eventUid);
    return res;
  },

  // CMS -> Cloud. CMS is the price authority (see priceService.js) but has no relationship
  // with EnVo; this is how a price it decides reaches the system that does.
  sync_price: async (payload) => {
    const envelope = await PriceService.envelope(payload.priceUid);
    if (!envelope) return { skipped: 'price no longer present locally' };
    const res = await pushPrice(envelope);
    await PriceService.markSynced(payload.priceUid);
    return res;
  },
};

export class OutboxService {
  // Pass the transaction client so the enqueue commits atomically with the change it
  // describes — a dispatch that commits must never leave its callback unqueued.
  static async enqueue(kind, payload, client = null) {
    if (!SENDERS[kind]) throw new Error(`unknown outbox kind: ${kind}`);
    const run = client ? (t, p) => client.query(t, p) : query;

    const { rows } = await run(
      `INSERT INTO outbox (kind, payload) VALUES ($1, $2::jsonb) RETURNING id`,
      [kind, JSON.stringify(payload)]
    );
    return rows[0].id;
  }

  // One pass over whatever is due.
  //
  // Two things matter as much as delivery itself, because EnVo applies whatever status it
  // is handed without checking the transition:
  //
  //  * Order. Ordering by next_attempt_at alone is not deterministic when rows share a
  //    timestamp — three callbacks queued in the same second could arrive
  //    submitted -> dispatched -> picking, leaving EnVo showing a dispatched order as
  //    still being picked. `id` is the serial insertion order, so it gives strict FIFO.
  //  * Causality per request. Even ordered, if 'picking' fails and 'dispatched' then
  //    succeeds, EnVo ends up wrong. A row is skipped while any earlier row for the same
  //    request is still undelivered, so a stuck callback holds its own successors back
  //    rather than letting them overtake it.
  //
  // SKIP LOCKED means a second process, or a tick overlapping a slow one, can never claim
  // the same row and double-send.
  static async drainOnce() {
    const { rows: claimed } = await query(
      `UPDATE outbox SET attempts = attempts + 1
        WHERE id IN (
          SELECT o.id FROM outbox o
           WHERE o.delivered_at IS NULL
             AND o.next_attempt_at <= now()
             AND NOT EXISTS (
               SELECT 1 FROM outbox earlier
                WHERE earlier.delivered_at IS NULL
                  AND earlier.id < o.id
                  AND COALESCE(earlier.payload->>'envoRequestId', earlier.payload->>'causeKey')
                      IS NOT DISTINCT FROM
                      COALESCE(o.payload->>'envoRequestId', o.payload->>'causeKey')
             )
           ORDER BY o.id
           LIMIT ${BATCH}
           FOR UPDATE OF o SKIP LOCKED
        )
        RETURNING id, kind, payload, attempts`
    );

    let delivered = 0;
    let failed = 0;

    for (const row of claimed) {
      try {
        await SENDERS[row.kind](row.payload);
        await query('UPDATE outbox SET delivered_at = now(), last_error = NULL WHERE id = $1', [row.id]);
        delivered += 1;
      } catch (err) {
        // Exponential backoff to an hour. Deliberately no dead-letter: a warehouse can be
        // legitimately offline for a long stretch, and giving up would lose the dispatch.
        await query(
          `UPDATE outbox
              SET next_attempt_at = now() + (LEAST(POWER(2, $2)::numeric * $3, $4) || ' seconds')::interval,
                  last_error = $5
            WHERE id = $1`,
          [row.id, row.attempts, BASE_BACKOFF_SECONDS, MAX_BACKOFF_SECONDS, String(err.message).slice(0, 500)]
        );
        failed += 1;
      }
    }

    return { claimed: claimed.length, delivered, failed };
  }

  /**
   * Drop delivered rows older than `days`. Undelivered rows are NEVER removed, however old:
   * an undelivered callback is a thing EnVo still does not know, and age makes that more
   * important rather than less. Delivered rows are an audit trail whose value decays, so
   * they are kept for a season and then let go.
   */
  static async prune({ days = 90 } = {}) {
    const { rowCount } = await query(
      `DELETE FROM outbox
        WHERE delivered_at IS NOT NULL
          AND delivered_at < now() - ($1 || ' days')::interval`,
      [days]
    );
    return rowCount;
  }

  // Callbacks EnVo has still not received. `stuckHours` is the age past which a pending row
  // stops being "the link is down for a bit" and becomes something to look at: EnVo is
  // showing a facility a request that the warehouse believes it has already dispatched.
  static async stuck({ stuckHours = 6 } = {}) {
    const { rows } = await query(
      `SELECT id, kind, attempts, last_error, created_at, next_attempt_at
         FROM outbox
        WHERE delivered_at IS NULL
          AND created_at < now() - ($1 || ' hours')::interval
        ORDER BY id`,
      [stuckHours]
    );
    return rows;
  }

  // Surfaced so staff can see whether anything is stuck waiting for EnVo.
  static async status() {
    const { rows } = await query(
      `SELECT COUNT(*) FILTER (WHERE delivered_at IS NULL)::int AS pending,
              COUNT(*) FILTER (WHERE delivered_at IS NULL AND attempts > 0)::int AS retrying,
              MIN(created_at) FILTER (WHERE delivered_at IS NULL) AS oldest_pending_at,
              MAX(delivered_at) AS last_delivered_at
         FROM outbox`
    );
    return rows[0];
  }
}
