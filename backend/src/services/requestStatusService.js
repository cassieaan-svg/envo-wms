import { query } from '../db.js';
import { ORIGIN, INSTANCE_ID } from '../lib/instance.js';
import { IS_CLOUD, IS_CMS } from '../lib/role.js';

// Request status transitions, as events that can travel.
//
// A dispatch reaches Cloud because it is an inventory transaction. Picking and rejecting move
// no stock, so nothing carried them, and EnVo saw a request go from 'submitted' straight to
// 'dispatched' — losing the two states the facility most wants to see, since they are the
// ones that say somebody has picked up the job.
//
// Each transition is recorded as a row with its own uid. That uid is what makes delivery
// idempotent: a re-sent event is recognised and ignored rather than told to EnVo twice. The
// events also carry their own order, so a 'picking' that was queued behind a dead link still
// reaches EnVo before the 'dispatched' that followed it.

export class RequestStatusService {
  /**
   * Record a transition. Called inside the transaction that performed it, so the event and
   * the status change commit together — a request that is 'picking' locally always has the
   * event that says so.
   */
  static async record(client, { requestId, envoRequestId, status, actor, note }) {
    const { rows } = await client.query(
      `INSERT INTO request_status_events
         (request_id, envo_request_id, status, actor, note, origin, source_instance)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, uid`,
      [requestId, envoRequestId ?? null, status, actor ?? null, note ?? null, ORIGIN, INSTANCE_ID]);

    // Only CMS ships these anywhere. On Cloud the event is history: Cloud tells EnVo directly
    // through its own outbox, as it always has.
    if (IS_CMS) {
      await client.query(
        `INSERT INTO outbox (kind, payload) VALUES ('sync_request_status', $1::jsonb)`,
        [JSON.stringify({
          eventUid: rows[0].uid,
          // Causality is per request, so 'picking' can never overtake the 'dispatched' that
          // followed it, or vice versa.
          causeKey: `request:${requestId}`,
        })]);
    }
    return rows[0];
  }

  /** The event as it travels. Built at send time, like an inventory envelope. */
  static async envelope(eventUid) {
    const { rows } = await query(
      `SELECT e.uid, e.status, e.actor, e.note, e.occurred_at, e.origin, e.source_instance,
              e.envo_request_id, r.uid AS request_uid,
              r.picked_by, r.carrier_name, r.carrier_phone, r.total_amount
         FROM request_status_events e
         JOIN requests r ON r.id = e.request_id
        WHERE e.uid = $1`, [eventUid]);
    if (!rows[0]) return null;
    return { envelopeVersion: 1, event: rows[0] };
  }

  static async markSynced(eventUid) {
    await query(
      'UPDATE request_status_events SET synced_at = now() WHERE uid = $1 AND synced_at IS NULL',
      [eventUid]);
  }

  static async pendingCount() {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS pending, MIN(occurred_at) AS oldest
         FROM request_status_events WHERE synced_at IS NULL`);
    return rows[0];
  }

  /**
   * Cloud: apply an event from CMS, and tell EnVo.
   *
   * Idempotent on the event uid — a re-delivered event is recognised and produces no second
   * callback, which is what stops EnVo being told the same thing twice.
   *
   * The status is applied to Cloud's copy of the request, but never backwards: a 'picking'
   * arriving after the 'dispatched' that superseded it records the history without undoing
   * the later state. Out-of-order delivery should not happen — the outbox serialises per
   * request — but a status machine that can be driven backwards by a late retry is not one
   * to rely on.
   */
  static async ingest(envelope) {
    if (!IS_CLOUD) {
      const e = new Error('only the Cloud instance ingests status events'); e.status = 403; throw e;
    }
    const ev = envelope?.event;
    if (!ev?.uid || !ev?.status) {
      const e = new Error('malformed status event'); e.status = 400; throw e;
    }
    if (ev.origin !== 'cms') {
      const e = new Error(
        `refusing a status event with origin "${ev.origin}": Cloud only mirrors what CMS reports`);
      e.status = 403; e.code = 'BAD_ORIGIN'; throw e;
    }

    const { withTransaction } = await import('../db.js');
    return withTransaction(async (client) => {
      const { rows: seen } = await client.query(
        'SELECT id FROM request_status_events WHERE uid = $1', [ev.uid]);
      if (seen[0]) return { applied: false, duplicate: true, uid: ev.uid };

      const { rows: reqRows } = await client.query(
        'SELECT id, status FROM requests WHERE envo_request_id = $1 FOR UPDATE',
        [ev.envo_request_id]);
      const request = reqRows[0];
      if (!request) {
        const e = new Error(`no request here with envo id ${ev.envo_request_id}`);
        e.status = 404; throw e;
      }

      await client.query(
        `INSERT INTO request_status_events
           (uid, request_id, envo_request_id, status, actor, note, occurred_at,
            origin, source_instance)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (uid) DO NOTHING`,
        [ev.uid, request.id, ev.envo_request_id, ev.status, ev.actor, ev.note,
         ev.occurred_at, ev.origin, ev.source_instance]);

      // Terminal states are not walked back by a late arrival.
      const TERMINAL = new Set(['dispatched', 'rejected', 'cancelled']);
      if (!TERMINAL.has(request.status)) {
        await client.query(
          `UPDATE requests SET status = $2,
                  picked_by = COALESCE($3, picked_by),
                  picked_at = CASE WHEN $2 = 'picking' THEN COALESCE(picked_at, $4) ELSE picked_at END
            WHERE id = $1`,
          [request.id, ev.status, ev.picked_by ?? ev.actor ?? null, ev.occurred_at]);
      }

      // EnVo speaks the language of its own statuses: a warehouse rejection cancels the
      // request there, which is what lets the facility raise it again once stock arrives.
      const envoStatus = ev.status === 'rejected' ? 'cancelled' : ev.status;
      await client.query(
        `INSERT INTO outbox (kind, payload) VALUES ('request_status', $1::jsonb)`,
        [JSON.stringify({
          envoRequestId: ev.envo_request_id,
          wmsRequestId: request.id,
          status: envoStatus,
          pickedBy: ev.picked_by ?? ev.actor ?? null,
          reason: ev.note ?? undefined,
          causeKey: ev.envo_request_id,
        })]);

      return { applied: true, duplicate: false, uid: ev.uid, status: ev.status };
    });
  }
}
