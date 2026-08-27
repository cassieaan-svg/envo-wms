import { query, withTransaction } from '../db.js';
import { IS_CLOUD } from '../lib/role.js';

// Requests travel EnVo → Cloud → CMS, and their fulfilment travels back CMS → Cloud → EnVo.
//
// A request must be on the local database BEFORE the link drops, or the warehouse cannot
// dispatch it — you cannot fulfil an order you have never seen. That is why this pull runs
// often when connectivity exists: every request replicated while online is a request that
// stays dispatchable through the next outage.
//
// Only OPEN requests are replicated. Once a request is dispatched, rejected or cancelled the
// warehouse has no further work to do on it, and copying the whole history down would grow
// without bound for no operational benefit. The local copy of a finished request stays where
// it is; it simply stops being refreshed.
//
// CMS mirrors Cloud's integer ids verbatim here, as it does for master data — Cloud is the
// sole author of requests, so there is nothing for CMS to collide with.

const OPEN_STATUSES = ['pending', 'picking'];

export class RequestSyncService {
  /** Cloud: the requests CMS still has work to do on. */
  static async openRequests() {
    if (!IS_CLOUD) {
      const e = new Error('only the Cloud instance serves requests'); e.status = 403; throw e;
    }
    const { rows: requests } = await query(
      `SELECT id, uid, envo_request_id, envo_facility_id, facility_id, status, total_amount,
              notes, created_at, requested_by, requester_phone, picked_by, picked_at, scheme
         FROM requests WHERE status = ANY($1) ORDER BY id`, [OPEN_STATUSES]);

    const ids = requests.map((r) => r.id);
    const { rows: items } = ids.length
      ? await query(
          `SELECT id, uid, request_id, commodity_id, quantity, unit_price, line_total, qty_dispatched
             FROM request_items WHERE request_id = ANY($1) ORDER BY id`, [ids])
      : { rows: [] };

    return { generatedAt: new Date().toISOString(), requests, items };
  }

  /**
   * CMS: apply the open-request snapshot.
   *
   * A request already dispatched locally is NOT overwritten. That is the important case: the
   * warehouse shipped it while offline, Cloud has not heard yet and still believes it open,
   * and letting Cloud's stale view reset the local status would hide a dispatch that has
   * physically happened. The outbound sync will tell Cloud shortly; until then the local
   * status is the true one.
   */
  static async apply(snapshot) {
    if (!snapshot?.requests) {
      const e = new Error('snapshot has no requests'); e.status = 400; throw e;
    }

    return withTransaction(async (client) => {
      let applied = 0, skippedLocallyAhead = 0;

      for (const r of snapshot.requests) {
        const { rows: local } = await client.query(
          'SELECT status FROM requests WHERE id = $1', [r.id]);
        if (local[0] && !OPEN_STATUSES.includes(local[0].status)) {
          skippedLocallyAhead += 1;
          continue;
        }

        await client.query(
          `INSERT INTO requests
             (id, uid, envo_request_id, envo_facility_id, facility_id, status, total_amount,
              notes, created_at, requested_by, requester_phone, picked_by, picked_at, scheme)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status, total_amount = EXCLUDED.total_amount,
             notes = EXCLUDED.notes, requested_by = EXCLUDED.requested_by,
             requester_phone = EXCLUDED.requester_phone, scheme = EXCLUDED.scheme`,
          [r.id, r.uid, r.envo_request_id, r.envo_facility_id, r.facility_id, r.status,
           r.total_amount, r.notes, r.created_at, r.requested_by, r.requester_phone,
           r.picked_by, r.picked_at, r.scheme]);
        applied += 1;
      }

      const openIds = new Set(snapshot.requests.map((r) => r.id));
      for (const it of snapshot.items || []) {
        if (!openIds.has(it.request_id)) continue;
        await client.query(
          `INSERT INTO request_items
             (id, uid, request_id, commodity_id, quantity, unit_price, line_total, qty_dispatched)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (id) DO UPDATE SET quantity = EXCLUDED.quantity,
             unit_price = EXCLUDED.unit_price, line_total = EXCLUDED.line_total`,
          [it.id, it.uid, it.request_id, it.commodity_id, it.quantity, it.unit_price,
           it.line_total, it.qty_dispatched]);
      }

      await client.query(
        `INSERT INTO sync_state (stream, cursor, last_success_at, last_attempt_at, last_error, detail, updated_at)
         VALUES ('requests', $1, now(), now(), NULL, $2::jsonb, now())
         ON CONFLICT (stream) DO UPDATE SET cursor=EXCLUDED.cursor,
           last_success_at=now(), last_attempt_at=now(), last_error=NULL,
           detail=EXCLUDED.detail, updated_at=now()`,
        [snapshot.generatedAt,
         JSON.stringify({ applied, skippedLocallyAhead, offered: snapshot.requests.length })]);

      return { applied, skippedLocallyAhead, offered: snapshot.requests.length };
    });
  }
}
