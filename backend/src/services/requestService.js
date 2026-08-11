import { query, withTransaction } from '../db.js';
import { OutboxService } from './outboxService.js';

function round2(v) { return Math.round(Number(v) * 100) / 100; }

// Inbound facility requests from EnVo's Essential Commodities module (see
// migrations/017_requests.sql). Prices are resolved here from the current
// commodity_prices — the WMS is the price master.
export class RequestService {
  // EnVo POSTs { envoRequestId, envoFacilityId, facilityName, items:[{ wmsCommodityId, quantity }] }.
  // Resolve the facility, price each line, store the request 'pending'. Idempotent on
  // envo_request_id (a resubmit returns the existing row). Returns the created/existing request.
  static async receiveFromEnvo({ envoRequestId, envoFacilityId, facilityName, items, requestedBy, requesterPhone, notes }) {
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
            requested_by, requester_phone, notes)
         VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7) RETURNING *`,
        [envoRequestId, envoFacilityId ?? null, facility?.id ?? null, total,
         requestedBy ?? null, requesterPhone ?? null, notes ?? null]
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
              r.received_by, r.received_at,
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
    return { ...req, items };
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

      await OutboxService.enqueue(
        'request_status',
        { envoRequestId: req.envo_request_id, wmsRequestId: req.id, status: 'picking', pickedBy: req.picked_by },
        client
      );
      return req;
    });
  }

  // Same as recordReceipt, but keyed by EnVo's own request id — the only identifier EnVo
  // has when it calls back.
  static async recordReceiptByEnvoId(envoRequestId, opts = {}) {
    const { rows } = await query('SELECT id FROM requests WHERE envo_request_id = $1', [envoRequestId]);
    if (!rows[0]) return null;
    return this.recordReceipt(rows[0].id, opts);
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
  static async fulfil(id, { dispatchedBy, carrierName, carrierPhone, pickedBy } = {}) {
    // Stock is not released to an unnamed carrier — the pair is the handover record.
    if (!carrierName?.trim()) { const e = new Error("the carrier's name is required"); e.status = 400; throw e; }
    if (!carrierPhone?.trim()) { const e = new Error("the carrier's phone number is required"); e.status = 400; throw e; }

    await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM requests WHERE id = $1 FOR UPDATE', [id]);
      const req = rows[0];
      if (!req) { const e = new Error('request not found'); e.status = 404; throw e; }
      if (!['pending', 'picking'].includes(req.status)) { const e = new Error(`Cannot fulfil a ${req.status} request`); e.status = 409; throw e; }

      // A request dispatched straight from 'pending' never passed through markPicking, so
      // the picker is captured here instead; an existing picked_by is left alone.
      const picker = req.picked_by || pickedBy?.trim() || null;
      if (!picker) { const e = new Error('the name of the person who picked this order is required'); e.status = 400; throw e; }

      // Dispatch each line at its requested quantity.
      await client.query('UPDATE request_items SET qty_dispatched = quantity WHERE request_id = $1', [id]);
      const { rows: upd } = await client.query(
        `UPDATE requests
            SET status = 'dispatched', dispatched_at = now(), dispatched_by = $2,
                carrier_name = $3, carrier_phone = $4,
                picked_by = $5, picked_at = COALESCE(picked_at, now())
          WHERE id = $1 RETURNING *`,
        [id, dispatchedBy ?? null, carrierName.trim(), carrierPhone.trim(), picker]);
      const dispatched = upd[0];

      // Read the dispatched lines on the same connection so the payload matches exactly
      // what this transaction committed, and queue the callback alongside it. Stock has
      // left the building; EnVo must find out even if the link is down right now.
      const { rows: items } = await client.query(
        'SELECT commodity_id, qty_dispatched FROM request_items WHERE request_id = $1', [id]);

      await OutboxService.enqueue(
        'request_status',
        {
          envoRequestId: dispatched.envo_request_id,
          wmsRequestId: dispatched.id,
          status: 'dispatched',
          totalAmount: Number(dispatched.total_amount),
          pickedBy: dispatched.picked_by,
          carrierName: dispatched.carrier_name,
          carrierPhone: dispatched.carrier_phone,
          items: items.map(i => ({ wmsCommodityId: i.commodity_id, qtyDispatched: i.qty_dispatched })),
        },
        client
      );

      return dispatched;
    });

    return this.getById(id);
  }
}
