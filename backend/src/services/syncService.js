import { query, withTransaction } from '../db.js';
import { ORIGIN, INSTANCE_ID } from '../lib/instance.js';
import { IS_CLOUD, IS_CMS } from '../lib/role.js';

// CMS → Cloud transactional sync.
//
// THE SHAPE. One `inventory_transactions` row and everything it produced travel together as
// a single envelope. Cloud applies the whole envelope or none of it, so its mirror can never
// hold a dispatch whose movements are missing — the exact state the balance guard exists to
// prevent locally.
//
// IDENTITY ON THE WIRE. Rows are named by `uid`, never by integer id: the two instances mint
// ids from disjoint ranges and neither may assume the other's numbering. Master data is the
// one exception, and deliberately so — CMS copies Cloud's ids verbatim for commodities,
// facilities and requests, so those references need no translation.
//
// IDEMPOTENCE. `client_txn_id` is the key. Cloud ingests through the same claim used by
// every write since Phase 1: a replayed envelope returns the original result and writes
// nothing. That is what makes an interrupted sync safe to simply retry.
//
// SINGLE WRITER. Cloud's mirror is only ever advanced by ingest. There is no merge, no
// conflict resolution and no last-write-wins, because there is only one writer of warehouse
// stock and Cloud is not it.

export class SyncService {
  // ── CMS side: build the envelope ──────────────────────────────────────────
  /**
   * Everything Cloud needs to reproduce one transaction, addressed by uid.
   *
   * Read on one connection so the envelope is a consistent picture of a committed
   * transaction rather than a series of unrelated reads.
   */
  static async buildEnvelope(clientTxnId, exec = query) {
    const { rows: txns } = await exec(
      'SELECT * FROM inventory_transactions WHERE client_txn_id = $1', [clientTxnId]);
    const txn = txns[0];
    if (!txn) return null;

    const { rows: movements } = await exec(
      `SELECT m.uid, m.movement_type, m.quantity, m.reason, m.note, m.created_by, m.created_at,
              m.origin, m.source_instance,
              b.uid  AS batch_uid,
              f.envo_facility_id, f.id AS facility_id,
              o.uid  AS dispatch_order_uid,
              i.uid  AS dispatch_order_item_uid
         FROM batch_movements m
         JOIN commodity_batches b ON b.id = m.batch_id
         LEFT JOIN facilities f ON f.id = m.facility_id
         LEFT JOIN dispatch_orders o ON o.id = m.dispatch_order_id
         LEFT JOIN dispatch_order_items i ON i.id = m.dispatch_order_item_id
        WHERE m.txn_id = $1
        ORDER BY m.id`, [txn.id]);

    // Batches touched by this transaction. Sent whole: a receipt creates one, and Cloud
    // cannot mirror a movement against a lot it has never heard of.
    const { rows: batches } = await exec(
      `SELECT DISTINCT b.uid, b.commodity_id, b.batch_number, b.expiry_date, b.unit_cost,
              b.quantity_received, b.quantity_remaining, b.received_date, b.created_by,
              b.vendor_id, b.origin, b.source_instance
         FROM commodity_batches b
         JOIN batch_movements m ON m.batch_id = b.id
        WHERE m.txn_id = $1`, [txn.id]);

    let order = null;
    if (txn.dispatch_order_id) {
      const { rows: o } = await exec(
        `SELECT o.uid, o.facility_id, o.total_amount, o.dispatched_by, o.authorized_by, o.dispatched_at,
                o.notes, o.scheme, o.edited_at, o.edited_by, o.edit_count,
                o.origin, o.source_instance,
                r.uid AS request_uid, r.envo_request_id
           FROM dispatch_orders o
           LEFT JOIN requests r ON r.dispatch_order_id = o.id
          WHERE o.id = $1`, [txn.dispatch_order_id]);
      if (o[0]) {
        const { rows: items } = await exec(
          `SELECT uid, commodity_id, quantity, unit_price, line_total
             FROM dispatch_order_items WHERE dispatch_order_id = $1 ORDER BY id`,
          [txn.dispatch_order_id]);
        order = { ...o[0], items };
        // A direct dispatch has no request behind it. That absence is the ONLY thing that
        // distinguishes it, and it must survive the trip: Cloud must never present a
        // warehouse-raised issue as though a facility had asked for it in EnVo.
        order.isDirect = !o[0].request_uid;
      }
    }

    let request = null;
    if (txn.request_id) {
      const { rows: r } = await exec(
        `SELECT uid, envo_request_id, status, dispatched_at, dispatched_by, authorized_by, picked_by,
                carrier_name, carrier_phone, total_amount
           FROM requests WHERE id = $1`, [txn.request_id]);
      if (r[0]) {
        const { rows: items } = await exec(
          `SELECT uid, commodity_id, quantity, qty_dispatched FROM request_items
            WHERE request_id = $1 ORDER BY id`, [txn.request_id]);
        request = { ...r[0], items };
      }
    }

    return {
      envelopeVersion: 1,
      clientTxnId: txn.client_txn_id,
      txn: {
        uid: txn.uid, operation: txn.operation, actor: txn.actor, actorUserId: txn.actor_user_id,
        origin: txn.origin, sourceInstance: txn.source_instance,
        createdAt: txn.created_at, result: txn.result,
      },
      batches, movements, order, request,
    };
  }

  /**
   * Queue a committed transaction for Cloud. Called inside the same transaction that did the
   * work, so a committed dispatch always has its sync record waiting and a rolled-back one
   * leaves nothing behind.
   *
   * `causeKey` is the batch or order, so the outbox's existing causality guard holds a
   * reversal behind the dispatch it reverses instead of letting it overtake.
   */
  static async enqueue(client, { clientTxnId, causeKey }) {
    if (!IS_CMS) return null;   // Cloud syncs nowhere
    const { rows } = await client.query(
      `INSERT INTO outbox (kind, payload) VALUES ('sync_transaction', $1::jsonb) RETURNING id`,
      [JSON.stringify({ clientTxnId, causeKey: causeKey ?? clientTxnId })]);
    return rows[0].id;
  }

  static async markSynced(clientTxnId) {
    await query(
      'UPDATE inventory_transactions SET synced_at = now() WHERE client_txn_id = $1 AND synced_at IS NULL',
      [clientTxnId]);
  }

  static async pendingCount() {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS pending,
              MIN(created_at) AS oldest
         FROM inventory_transactions WHERE synced_at IS NULL`);
    return rows[0];
  }

  // ── Cloud side: ingest ────────────────────────────────────────────────────
  /**
   * Apply one envelope to Cloud's mirror, idempotently and atomically.
   *
   * Everything Cloud is allowed to accept is checked before anything is written:
   *   - the envelope must be authored by CMS (`origin: 'cms'`), because Cloud accepting a
   *     'cloud'-authored inventory envelope would mean Cloud had written warehouse stock;
   *   - the referenced master data must already exist here, since Cloud owns it and an
   *     unknown commodity means the two instances disagree about something more fundamental
   *     than a dispatch.
   *
   * A replay is not an error. It returns the original result, which is what lets CMS retry a
   * sync whose acknowledgement was lost without any coordination.
   */
  static async ingest(envelope) {
    if (!IS_CLOUD) {
      const e = new Error('only the Cloud instance ingests sync envelopes'); e.status = 403; throw e;
    }
    if (!envelope?.clientTxnId || !envelope?.txn) {
      const e = new Error('malformed envelope'); e.status = 400; throw e;
    }
    if (envelope.txn.origin !== 'cms') {
      const e = new Error(
        `refusing an envelope with origin "${envelope.txn.origin}": Cloud only mirrors ` +
        'inventory authored by CMS, and must never be the writer of warehouse stock');
      e.status = 403; e.code = 'BAD_ORIGIN'; throw e;
    }

    return withTransaction(async (client) => {
      // Declare this transaction a mirror ingest, so the balance guard stands down for it —
      // and only for it. SET LOCAL dies at commit, and the origin check above has already
      // established that what follows is CMS's work being recorded, not Cloud's being
      // authored. See migrations/037 for why a mirror cannot satisfy the guard.
      await client.query("SET LOCAL envo.mirror_ingest = 'on'");

      // Idempotence, using the same header every write has used since Phase 1.
      const { rows: existing } = await client.query(
        'SELECT * FROM inventory_transactions WHERE client_txn_id = $1', [envelope.clientTxnId]);
      if (existing[0]) {
        return { applied: false, duplicate: true, clientTxnId: envelope.clientTxnId,
                 result: existing[0].result };
      }

      const { rows: txnRows } = await client.query(
        `INSERT INTO inventory_transactions
           (uid, client_txn_id, operation, actor, actor_user_id, origin, source_instance,
            result, created_at, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9, now())
         ON CONFLICT (client_txn_id) DO NOTHING
         RETURNING id`,
        [envelope.txn.uid, envelope.clientTxnId, envelope.txn.operation, envelope.txn.actor,
         envelope.txn.actorUserId, envelope.txn.origin, envelope.txn.sourceInstance,
         JSON.stringify(envelope.txn.result ?? null), envelope.txn.createdAt]);

      // Lost a race with a concurrent identical envelope — the other one is authoritative.
      if (!txnRows[0]) {
        return { applied: false, duplicate: true, clientTxnId: envelope.clientTxnId };
      }
      const txnId = txnRows[0].id;

      // Batches, addressed by uid. Quantities are taken as CMS reports them: this is a
      // mirror, and recomputing them here would be Cloud forming its own opinion of the
      // warehouse's stock.
      const batchIdByUid = new Map();
      for (const b of envelope.batches || []) {
        const { rows } = await client.query(
          `INSERT INTO commodity_batches
             (uid, commodity_id, vendor_id, batch_number, expiry_date, unit_cost,
              quantity_received, quantity_remaining, received_date, created_by,
              origin, source_instance)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (uid) DO UPDATE SET quantity_remaining = EXCLUDED.quantity_remaining,
             batch_number = EXCLUDED.batch_number, expiry_date = EXCLUDED.expiry_date
           RETURNING id`,
          [b.uid, b.commodity_id, b.vendor_id, b.batch_number, b.expiry_date, b.unit_cost,
           b.quantity_received, b.quantity_remaining, b.received_date, b.created_by,
           b.origin, b.source_instance]);
        batchIdByUid.set(b.uid, rows[0].id);
      }

      // The order, if this transaction produced one.
      let orderId = null;
      const itemIdByUid = new Map();
      if (envelope.order) {
        const o = envelope.order;
        const { rows } = await client.query(
          `INSERT INTO dispatch_orders
             (uid, facility_id, total_amount, dispatched_by, dispatched_at, notes, scheme,
              edited_at, edited_by, edit_count, origin, source_instance, authorized_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (uid) DO UPDATE SET total_amount = EXCLUDED.total_amount,
             notes = EXCLUDED.notes, edited_at = EXCLUDED.edited_at,
             edited_by = EXCLUDED.edited_by, edit_count = EXCLUDED.edit_count
           RETURNING id`,
          [o.uid, o.facility_id, o.total_amount, o.dispatched_by, o.dispatched_at, o.notes,
           o.scheme, o.edited_at, o.edited_by, o.edit_count ?? 0, o.origin, o.source_instance,
           o.authorized_by ?? null]);   // absent from an envelope sent by an older CMS
        orderId = rows[0].id;

        await client.query('DELETE FROM dispatch_order_items WHERE dispatch_order_id = $1', [orderId]);
        for (const it of o.items || []) {
          const { rows: ir } = await client.query(
            `INSERT INTO dispatch_order_items (uid, dispatch_order_id, commodity_id, quantity, unit_price, line_total)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [it.uid, orderId, it.commodity_id, it.quantity, it.unit_price, it.line_total]);
          itemIdByUid.set(it.uid, ir[0].id);
        }
      }

      // The request's fulfilment state, if this was a fulfilment. Cloud owns the request row
      // itself; what CMS reports is what the warehouse actually did with it.
      let requestId = null;
      if (envelope.request) {
        const r = envelope.request;
        const { rows: rr } = await client.query(
          `UPDATE requests SET status = $2, dispatched_at = $3, dispatched_by = $4,
                  picked_by = $5, carrier_name = $6, carrier_phone = $7,
                  dispatch_order_id = COALESCE($8, dispatch_order_id),
                  authorized_by = $9
            WHERE envo_request_id = $1 RETURNING id`,
          [r.envo_request_id, r.status, r.dispatched_at, r.dispatched_by, r.picked_by,
           r.carrier_name, r.carrier_phone, orderId, r.authorized_by ?? null]);
        requestId = rr[0]?.id ?? null;
        for (const it of r.items || []) {
          await client.query(
            `UPDATE request_items SET qty_dispatched = $2
              WHERE request_id = $1 AND commodity_id = $3`,
            [requestId, it.qty_dispatched, it.commodity_id]);
        }
      }

      // The movements themselves.
      for (const m of envelope.movements || []) {
        // A movement must name a batch the envelope actually carries. Without this the
        // lookup below yields undefined, Postgres rejects a null batch_id, and the operator
        // gets a not-null constraint error that says nothing about what was wrong with the
        // envelope. Refuse it by name instead — and refuse the whole envelope, because a
        // dispatch missing one of its movements is exactly the half-applied state this
        // ingest exists to make impossible.
        const batchId = batchIdByUid.get(m.batch_uid);
        if (!batchId) {
          const e = new Error(
            `envelope references batch ${m.batch_uid} in a movement but does not carry that ` +
            'batch — it cannot be applied without inventing a lot');
          e.status = 422; e.code = 'INCOMPLETE_ENVELOPE'; throw e;
        }
        await client.query(
          `INSERT INTO batch_movements
             (uid, batch_id, movement_type, quantity, facility_id, dispatch_order_id,
              dispatch_order_item_id, reason, note, created_by, created_at, txn_id,
              origin, source_instance)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (uid) DO NOTHING`,
          [m.uid, batchId, m.movement_type, m.quantity, m.facility_id,
           orderId, m.dispatch_order_item_uid ? itemIdByUid.get(m.dispatch_order_item_uid) : null,
           m.reason, m.note, m.created_by, m.created_at, txnId, m.origin, m.source_instance]);
      }

      await client.query(
        `UPDATE inventory_transactions
            SET dispatch_order_id = $2, request_id = $3,
                batch_id = (SELECT id FROM commodity_batches WHERE uid = $4)
          WHERE id = $1`,
        [txnId, orderId, requestId, envelope.batches?.[0]?.uid ?? null]);

      // Telling EnVo the request shipped is NOT done here.
      //
      // It used to be, and once Phase 5.5 gave status transitions their own events it became
      // a second mouth saying the same thing: the fulfilment arrived as an inventory envelope
      // AND as a 'dispatched' status event, and EnVo was told twice. The commissioning drill
      // caught it as `dispatched:2`.
      //
      // Status is now the status stream's job, end to end — one mechanism, idempotent on the
      // event uid. This ingest applies the STOCK; RequestStatusService.ingest applies the
      // STATUS and queues the callback.

      return { applied: true, duplicate: false, clientTxnId: envelope.clientTxnId,
               movements: (envelope.movements || []).length };
    });
  }

  /**
   * Cloud's mirror of a batch, for parity checking. Deliberately not a stock API: it exists
   * so an operator (or a test) can ask whether Cloud agrees with CMS yet.
   */
  static async mirrorBalances(batchUids = null) {
    const { rows } = await query(
      `SELECT b.uid, b.quantity_remaining,
              COALESCE(SUM(m.quantity), 0) AS ledger,
              MAX(t.synced_at) AS synced_as_of
         FROM commodity_batches b
         LEFT JOIN batch_movements m ON m.batch_id = b.id
         LEFT JOIN inventory_transactions t ON t.id = m.txn_id
        WHERE ($1::uuid[] IS NULL OR b.uid = ANY($1))
        GROUP BY b.id
        ORDER BY b.id`, [batchUids]);
    return rows;
  }
}
