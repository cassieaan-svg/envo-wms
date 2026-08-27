import { query, withTransaction } from '../db.js';
import { OutboxService } from './outboxService.js';
import { DispatchService } from './dispatchService.js';
import { normalizeNgPhone } from '../lib/phone.js';
import { IdempotencyService } from './idempotencyService.js';
import { ORIGIN, INSTANCE_ID } from '../lib/instance.js';
import { assertCanWriteWarehouseStock, IS_CLOUD } from '../lib/role.js';
import { RequestStatusService } from './requestStatusService.js';

function round2(v) { return Math.round(Number(v) * 100) / 100; }

// Inbound facility requests from EnVo's Essential Commodities module (see
// migrations/017_requests.sql). Prices are resolved here from the current
// commodity_prices — the WMS is the price master.
export class RequestService {
  // EnVo POSTs { envoRequestId, envoFacilityId, facilityName, items:[{ wmsCommodityId, quantity }] }.
  // Resolve the facility, price each line, store the request 'pending'. Idempotent on
  // envo_request_id (a resubmit returns the existing row). Returns the created/existing request.
  static async receiveFromEnvo({ envoRequestId, envoFacilityId, facilityName, items, requestedBy, requesterPhone, notes, scheme }) {
    if (!envoRequestId) { const e = new Error('envoRequestId is required'); e.status = 400; throw e; }
    if (!Array.isArray(items) || !items.length) { const e = new Error('items are required'); e.status = 400; throw e; }

    // Idempotency: if we've already seen this EnVo request, return it unchanged.
    const existing = await query('SELECT * FROM requests WHERE envo_request_id = $1', [envoRequestId]);
    if (existing.rows[0]) return this.getById(existing.rows[0].id);

    // Resolve the facility by the code EnVo sent (falls back to name).
    let facility = (await query('SELECT id FROM facilities WHERE envo_facility_id = $1', [envoFacilityId])).rows[0];
    if (!facility && facilityName) {
      facility = (await query('SELECT id FROM facilities WHERE lower(name) = lower($1)', [facilityName])).rows[0];
    }

    // Price each line from the current price list.
    const wmsIds = items.map(i => i.wmsCommodityId);
    const priced = (await query(
      `SELECT c.id, c.name, p.unit_price
         FROM commodities c
         LEFT JOIN commodity_prices p ON p.commodity_id = c.id AND p.is_current
        WHERE c.id = ANY($1)`, [wmsIds]
    )).rows;
    const byId = new Map(priced.map(r => [r.id, r]));

    // We are the price authority. A line whose commodity has no current price can't be
    // costed, and a request half-priced at ₦0 is worse than one refused — EnVo already
    // hides unpriced commodities from the request form, so this only fires on a stale or
    // hand-made request. Reject it, naming the offenders, rather than banking a ₦0 line.
    const unpriced = items
      .filter(i => byId.get(i.wmsCommodityId)?.unit_price == null)
      .map(i => byId.get(i.wmsCommodityId)?.name || i.wmsCommodityId);
    if (unpriced.length) {
      const e = new Error(`cannot accept request — no current price for: ${unpriced.join(', ')}`);
      e.status = 422;
      throw e;
    }

    const lines = items.map(i => {
      const row = byId.get(i.wmsCommodityId);
      const unitPrice = row?.unit_price != null ? Number(row.unit_price) : 0;
      const qty = Number(i.quantity);
      return { commodityId: i.wmsCommodityId, quantity: qty, unitPrice, lineTotal: round2(qty * unitPrice) };
    });
    const total = round2(lines.reduce((s, l) => s + l.lineTotal, 0));

    const request = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO requests
           (envo_request_id, envo_facility_id, facility_id, status, total_amount,
            requested_by, requester_phone, notes, scheme)
         VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, coalesce($8, 'drf')) RETURNING *`,
        [envoRequestId, envoFacilityId ?? null, facility?.id ?? null, total,
         requestedBy ?? null, requesterPhone ?? null, notes ?? null,
         // The fund the FACILITY raised this against. Binding — the warehouse fills from
         // it or rejects the request. 'drf' only for a request from an EnVo old enough
         // not to send one.
         scheme ?? null]
      );
      const req = rows[0];
      for (const l of lines) {
        await client.query(
          `INSERT INTO request_items (request_id, commodity_id, quantity, unit_price, line_total)
           VALUES ($1, $2, $3, $4, $5)`,
          [req.id, l.commodityId, l.quantity, l.unitPrice, l.lineTotal]
        );
      }
      // Acknowledge back to EnVo: it lands as 'submitted' with our id + authoritative
      // total. Queued in the same transaction, so a committed request always has its
      // callback pending rather than lost.
      await OutboxService.enqueue(
        'request_status',
        { envoRequestId, wmsRequestId: req.id, status: 'submitted', totalAmount: total },
        client
      );
      return req;
    });

    return this.getById(request.id);
  }

  static async listQueue({ status = null } = {}) {
    const params = [], conds = [];
    if (status) { params.push(status); conds.push(`r.status = $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT r.id, r.envo_request_id, r.status, r.total_amount, r.created_at, r.dispatched_at,
              r.requested_by, r.requester_phone, r.picked_by, r.carrier_name, r.carrier_phone,
              r.received_by, r.received_at, r.scheme,
              f.name AS facility_name, f.state, f.lga,
              COUNT(i.id)::int AS line_count, COALESCE(SUM(i.quantity),0)::int AS total_quantity
         FROM requests r
         LEFT JOIN facilities f ON f.id = r.facility_id
         LEFT JOIN request_items i ON i.request_id = r.id
         ${where}
         GROUP BY r.id, f.name, f.state, f.lga
         ORDER BY r.created_at DESC`, params);
    return rows;
  }

  static async getById(id, client = null) {
    const run = client ? (t, p) => client.query(t, p) : query;
    const { rows } = await run(
      `SELECT r.*, f.name AS facility_name, f.state, f.lga
         FROM requests r LEFT JOIN facilities f ON f.id = r.facility_id
        WHERE r.id = $1`, [id]);
    const req = rows[0];
    if (!req) return null;
    const { rows: items } = await run(
      `SELECT i.*, c.name AS commodity_name, c.category, c.unit
         FROM request_items i JOIN commodities c ON c.id = i.commodity_id
        WHERE i.request_id = $1 ORDER BY c.category, c.name`, [id]);

    // The transitions this request has been through, oldest first. `synced_at` is what tells
    // a warehouse user whether Cloud (and so EnVo, and so the facility) has been told yet —
    // during an outage the answer is no, and that is worth being able to see rather than
    // guess at.
    const { rows: statusEvents } = await run(
      `SELECT uid, status, actor, note, occurred_at, synced_at, origin
         FROM request_status_events WHERE request_id = $1 ORDER BY occurred_at, id`, [id]);

    return { ...req, items, statusEvents };
  }

  // The store officer who starts picking is named, so the order is never in an
  // unattributed half-picked state.
  static async markPicking(id, { pickedBy } = {}) {
    if (!pickedBy?.trim()) { const e = new Error('the name of the person picking is required'); e.status = 400; throw e; }

    return withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE requests SET status = 'picking', picked_by = $2, picked_at = now()
          WHERE id = $1 AND status = 'pending' RETURNING *`, [id, pickedBy.trim()]);
      const req = rows[0];
      if (!req) return null;

      // Recorded as an event so it can travel. On CMS this queues it for Cloud; on Cloud it
      // is history beside the callback below.
      await RequestStatusService.record(client, {
        requestId: req.id, envoRequestId: req.envo_request_id,
        status: 'picking', actor: req.picked_by,
      });

      // Cloud's callback to make, not the warehouse's — CMS cannot reach EnVo. When CMS
      // raises this, the event above carries it to Cloud, which then tells EnVo.
      if (IS_CLOUD) await OutboxService.enqueue(
        'request_status',
        { envoRequestId: req.envo_request_id, wmsRequestId: req.id, status: 'picking', pickedBy: req.picked_by },
        client
      );
      return req;
    });
  }

  // Reject a request the warehouse can't fill (nothing in stock). Marks it 'rejected' and
  // tells EnVo — which cancels it, so the facility simply re-requests once CMS has stock.
  // Only a request still in the queue (pending/picking) can be rejected. No stock has moved.
  static async reject(id, { rejectedBy, reason } = {}) {
    if (!reason?.trim()) { const e = new Error('a reason for rejecting is required'); e.status = 400; throw e; }
    return withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM requests WHERE id = $1 FOR UPDATE', [id]);
      const req = rows[0];
      if (!req) { const e = new Error('request not found'); e.status = 404; throw e; }
      if (!['pending', 'picking'].includes(req.status)) {
        const e = new Error(`Cannot reject a ${req.status} request`); e.status = 409; throw e;
      }

      const { rows: upd } = await client.query(
        `UPDATE requests SET status = 'rejected', notes = COALESCE(notes, '') || $2 WHERE id = $1 RETURNING *`,
        [id, ` [Rejected by ${rejectedBy || 'warehouse'}: ${reason.trim()}]`]);
      const request = upd[0];

      await RequestStatusService.record(client, {
        requestId: request.id, envoRequestId: request.envo_request_id,
        status: 'rejected', actor: rejectedBy ?? null, note: reason.trim(),
      });

      // As above: Cloud owns the EnVo conversation; from CMS the event carries it there.
      if (IS_CLOUD) await OutboxService.enqueue(
        'request_status',
        { envoRequestId: request.envo_request_id, wmsRequestId: request.id, status: 'cancelled', reason: reason.trim() },
        client
      );
      return request;
    });
  }

  // Same as recordReceipt, but keyed by EnVo's own request id — the only identifier EnVo
  // has when it calls back.
  static async recordReceiptByEnvoId(envoRequestId, opts = {}) {
    const { rows } = await query('SELECT id FROM requests WHERE envo_request_id = $1', [envoRequestId]);
    if (!rows[0]) return null;
    return this.recordReceipt(rows[0].id, opts);
  }

  // The facility cancelled the request on the EnVo side. Drop it from the queue if it
  // hasn't shipped; if it's already dispatched/received/rejected, leave it (stock moved).
  // Idempotent and safe if the request never arrived (returns null).
  static async cancelByEnvoId(envoRequestId, { reason } = {}) {
    const { rows } = await query('SELECT * FROM requests WHERE envo_request_id = $1', [envoRequestId]);
    const req = rows[0];
    if (!req) return null;
    if (!['pending', 'picking'].includes(req.status)) return req;
    const { rows: upd } = await query(
      `UPDATE requests SET status = 'cancelled', notes = COALESCE(notes, '') || $2 WHERE id = $1 RETURNING *`,
      [req.id, ` [Cancelled by facility${reason ? ': ' + reason : ''}]`]);
    return upd[0];
  }

  // Delivery confirmation, pushed back from EnVo once the facility signs for the stock.
  static async recordReceipt(id, { receivedBy, receivedAt } = {}) {
    const { rows } = await query(
      `UPDATE requests
          SET received_by = $2, received_at = COALESCE($3::timestamptz, now())
        WHERE id = $1 RETURNING *`,
      [id, receivedBy ?? null, receivedAt ?? null]);
    return rows[0] || null;
  }

  // Fulfil: record the dispatched quantities + price the order, mark dispatched, and tell
  // EnVo. (Batch-level FEFO depletion via DispatchService is deferred until the warehouse
  // holds batch stock — it currently holds none.)
  // NOTE: fulfil takes no `scheme`. A request is filled from the fund the FACILITY
  // raised it against, or it is rejected so the facility re-raises. Letting the store
  // move an order onto another fund would change who pays for it — a free BHCPF issue
  // becoming a DRF debt — without the facility ever agreeing. The warehouse does choose
  // a fund for a direct dispatch it raises itself (DispatchService.createOrder).
  static async fulfil(id, { dispatchedBy, carrierName, carrierPhone, pickedBy, items, clientTxnId = null, actorUserId = null } = {}) {
    // Stock is not released to an unnamed carrier — the pair is the handover record.
    if (!carrierName?.trim()) { const e = new Error("the carrier's name is required"); e.status = 400; throw e; }
    if (!carrierPhone?.trim()) { const e = new Error("the carrier's phone number is required"); e.status = 400; throw e; }
    // Stored in the same 0-leading shape EnVo uses, so a +234… or spaced entry doesn't
    // leave two stores holding the same number in two forms.
    assertCanWriteWarehouseStock();

    const carrierPhoneNorm = normalizeNgPhone(carrierPhone);
    if (!carrierPhoneNorm) {
      const e = new Error("the carrier phone must be a complete Nigerian number, e.g. 08012345678 or +2348012345678");
      e.status = 400;
      throw e;
    }

    await withTransaction(async (client) => {
      // Claimed before the request row is locked. Fulfilment draws FEFO stock and writes a
      // dispatch order, so a retried fulfil would issue the stock twice; the status guard
      // below ('Cannot fulfil a dispatched request') would usually catch it, but it answers
      // with an error rather than the original result, which is not what a retry needs.
      let txnId = null;
      if (clientTxnId) {
        const { txn, replay } = await IdempotencyService.claim(client, {
          clientTxnId, operation: 'request_fulfil', actorUserId, actor: dispatchedBy ?? null,
        });
        if (replay) return;   // already fulfilled by this transaction — change nothing
        txnId = txn.id;
      }

      const { rows } = await client.query('SELECT * FROM requests WHERE id = $1 FOR UPDATE', [id]);
      const req = rows[0];
      if (!req) { const e = new Error('request not found'); e.status = 404; throw e; }
      if (!['pending', 'picking'].includes(req.status)) { const e = new Error(`Cannot fulfil a ${req.status} request`); e.status = 409; throw e; }

      // A request dispatched straight from 'pending' never passed through markPicking, so
      // the picker is captured here instead; an existing picked_by is left alone.
      const picker = req.picked_by || pickedBy?.trim() || null;
      if (!picker) { const e = new Error('the name of the person who picked this order is required'); e.status = 400; throw e; }


      // Short-dispatch: allocate each line FEFO up to what's physically on hand and record
      // the actual amount shipped. A line the warehouse can't cover yet ships 0 and stays
      // visible as requested-minus-dispatched, rather than blocking the whole delivery.
      // allocateFefo decrements `commodity_batches.quantity_remaining` and writes
      // `batch_movements` in this same transaction, so WMS stock reflects the handover.
      const { rows: reqItems } = await client.query(
        'SELECT id, commodity_id, quantity, unit_price FROM request_items WHERE request_id = $1', [id]);

      // Per-line issue quantities the store officer set while picking. Absent → issue the
      // full requested amount. Clamped to [0, requested] — you can short an order but never
      // issue more than was asked. allocateFefo still caps each line at what's on hand.
      const issueQty = new Map((items || []).map((i) => [Number(i.itemId), Number(i.qty)]));

      let anyDispatched = false;
      const dispatchedLines = [];   // the lines that actually shipped, for the dispatch order
      for (const it of reqItems) {
        const requested = Number(it.quantity || 0);
        let want = issueQty.has(it.id) ? issueQty.get(it.id) : requested;
        if (!(want >= 0)) want = 0;
        if (want > requested) want = requested;
        // The dispatch order does not exist yet — it is written below, once we know which
        // lines actually shipped — so the movements are linked to it afterwards, by id,
        // inside this same transaction. Previously they were never linked at all, and a
        // fulfilment's stock could not be traced to any document.
        const { allocated, movementIds } = want > 0
          ? await DispatchService.allocateFefo(client, {
              commodityId: it.commodity_id,
              quantity: want,
              facilityId: req.facility_id,
              itemId: null,
              actor: dispatchedBy ?? null,
              allowShort: true,
              txnId,
            })
          : { allocated: 0, movementIds: [] };
        await client.query('UPDATE request_items SET qty_dispatched = $2 WHERE id = $1', [it.id, allocated]);
        if (allocated > 0) {
          anyDispatched = true;
          const unitPrice = Number(it.unit_price);
          dispatchedLines.push({
            commodityId: it.commodity_id, quantity: allocated, unitPrice,
            lineTotal: round2(allocated * unitPrice), movementIds,
          });
        }
      }
      if (!anyDispatched) {
        const e = new Error('None of the requested commodities are in stock yet — nothing to dispatch.');
        e.status = 409; throw e;
      }

      const { rows: upd } = await client.query(
        `UPDATE requests
            SET status = 'dispatched', dispatched_at = now(), dispatched_by = $2,
                carrier_name = $3, carrier_phone = $4,
                picked_by = $5, picked_at = COALESCE(picked_at, now())
          WHERE id = $1 RETURNING *`,
        [id, dispatchedBy ?? null, carrierName.trim(), carrierPhoneNorm, picker]);
      const dispatched = upd[0];

      // Record the fulfilment as a dispatch order so it shows in dispatch history, and
      // link it back to the request. Only the lines that actually shipped are included
      // (dispatch_order_items.quantity must be > 0). The batch draw above already wrote
      // batch_movements; this is the order-level document over the same handover.
      const orderTotal = round2(dispatchedLines.reduce((s, l) => s + l.lineTotal, 0));
      const { rows: ord } = await client.query(
        `INSERT INTO dispatch_orders
           (facility_id, total_amount, dispatched_by, notes, scheme, origin, source_instance)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [req.facility_id, orderTotal, dispatchedBy ?? null,
         `Essential request #${dispatched.id}${dispatched.envo_request_id ? ` (${dispatched.envo_request_id})` : ''}`,
         // The dispatch order inherits the request's fund; it is not a separate choice.
         req.scheme, ORIGIN, INSTANCE_ID]);
      const dispatchOrderId = ord[0].id;
      for (const l of dispatchedLines) {
        const { rows: line } = await client.query(
          `INSERT INTO dispatch_order_items (dispatch_order_id, commodity_id, quantity, unit_price, line_total)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [dispatchOrderId, l.commodityId, l.quantity, l.unitPrice, l.lineTotal]);
        // Close the loop: the movements drawn for this line now name the order and the line
        // they belong to, so a fulfilment is traceable exactly like a direct dispatch.
        if (l.movementIds.length) {
          await client.query(
            `UPDATE batch_movements
                SET dispatch_order_id = $2, dispatch_order_item_id = $3
              WHERE id = ANY($1)`,
            [l.movementIds, dispatchOrderId, line[0].id]);
        }
      }
      await client.query('UPDATE requests SET dispatch_order_id = $2 WHERE id = $1', [id, dispatchOrderId]);

      // Read the actually-dispatched lines on the same connection so the callback payload
      // matches exactly what this transaction committed. EnVo credits qty_dispatched.
      const { rows: shippedItems } = await client.query(
        'SELECT commodity_id, qty_dispatched FROM request_items WHERE request_id = $1', [id]);

      await RequestStatusService.record(client, {
        requestId: dispatched.id, envoRequestId: dispatched.envo_request_id,
        status: 'dispatched', actor: dispatched.dispatched_by,
      });

      // Telling EnVo is Cloud's relationship, not the warehouse's.
      //
      // On CMS this queued a callback the instance can never deliver: it has no ENVO_API_URL
      // by design, so the row failed on every attempt and would have retried forever. The
      // fulfilment reaches EnVo the proper way — CMS syncs the transaction to Cloud, and
      // Cloud queues the callback as it ingests. Found by the two-instance commissioning
      // drill; a single-database test cannot see it, because there the two roles are one
      // process with EnVo configured.
      if (IS_CLOUD) await OutboxService.enqueue(
        'request_status',
        {
          envoRequestId: dispatched.envo_request_id,
          wmsRequestId: dispatched.id,
          status: 'dispatched',
          totalAmount: Number(dispatched.total_amount),
          pickedBy: dispatched.picked_by,
          carrierName: dispatched.carrier_name,
          carrierPhone: dispatched.carrier_phone,
          items: shippedItems.map(i => ({ wmsCommodityId: i.commodity_id, qtyDispatched: i.qty_dispatched })),
        },
        client
      );

      if (txnId) {
        await IdempotencyService.complete(client, txnId, dispatched,
          { requestId: id, dispatchOrderId });
      }

      return dispatched;
    });

    // A replay answers with the request as it stands, exactly as the first attempt did.
    return this.getById(id);
  }
}
