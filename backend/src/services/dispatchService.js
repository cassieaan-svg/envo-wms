import { query, withTransaction } from '../db.js';
import { IdempotencyService } from './idempotencyService.js';
import { ORIGIN, INSTANCE_ID } from '../lib/instance.js';
import { assertCanWriteWarehouseStock } from '../lib/role.js';

function round2(value) {
  return Math.round(value * 100) / 100;
}

export class DispatchService {
  // Creates one dispatch order covering every line. Each line is fulfilled FEFO
  // (soonest expiry first) across that commodity's batches. If any line cannot be
  // filled the whole transaction rolls back — no partially dispatched orders.
  // A DIRECT dispatch — raised in the warehouse with no EnVo request behind it. This is
  // the one place the store chooses the fund, because there is no facility request whose
  // choice it would be overriding. (Fulfilling a request inherits that request's scheme;
  // see RequestService.fulfil.)
  static async createOrder({ facilityId, items, notes, dispatchedBy, authorizedBy = null, scheme, clientTxnId = null, actorUserId = null }) {
    // Only the instance that owns the stock may move it.
    assertCanWriteWarehouseStock();
    return withTransaction(async (client) => {
      // Claimed first, before the facility is even read: a retried dispatch must not draw
      // stock a second time. Everything below this point happens exactly once per
      // clientTxnId.
      let txnId = null;
      if (clientTxnId) {
        const { txn, replay } = await IdempotencyService.claim(client, {
          clientTxnId, operation: 'dispatch', actorUserId, actor: dispatchedBy ?? null,
        });
        if (replay) return txn.result;
        txnId = txn.id;
      }

      const facility = await client.query('SELECT id FROM facilities WHERE id = $1 AND is_active', [facilityId]);
      if (!facility.rows[0]) {
        const err = new Error('facility not found');
        err.status = 404;
        throw err;
      }

      const lines = items.map((item) => {
        const quantity = Number(item.quantity);
        const unitPrice = Number(item.unitPrice);
        return {
          commodityId: Number(item.commodityId),
          quantity,
          unitPrice,
          lineTotal: round2(quantity * unitPrice),
        };
      });

      const totalAmount = round2(lines.reduce((sum, line) => sum + line.lineTotal, 0));

      // Which fund this issue is made against decides who pays for it, so it is required
      // rather than defaulted, and validated against the table rather than a hardcoded list.
      const issueScheme = String(scheme ?? '').trim();
      if (!issueScheme) { const e = new Error('scheme is required'); e.status = 400; throw e; }
      const okScheme = await client.query('SELECT 1 FROM schemes WHERE key = $1 AND active', [issueScheme]);
      if (!okScheme.rows.length) { const e = new Error(`Unknown scheme: ${issueScheme}`); e.status = 400; throw e; }

      const orderResult = await client.query(
        `INSERT INTO dispatch_orders
           (facility_id, total_amount, dispatched_by, authorized_by, notes, scheme, origin, source_instance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, uid, facility_id, total_amount, dispatched_by, authorized_by, dispatched_at, notes, scheme`,
        [facilityId, totalAmount, dispatchedBy ?? null, authorizedBy ?? null, notes ?? null,
         issueScheme, ORIGIN, INSTANCE_ID]
      );
      const order = orderResult.rows[0];

      for (const line of lines) {
        const itemResult = await client.query(
          `INSERT INTO dispatch_order_items (dispatch_order_id, commodity_id, quantity, unit_price, line_total)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [order.id, line.commodityId, line.quantity, line.unitPrice, line.lineTotal]
        );
        const itemId = itemResult.rows[0].id;

        await this.allocateFefo(client, {
          commodityId: line.commodityId,
          quantity: line.quantity,
          facilityId,
          itemId,
          actor: dispatchedBy,
          txnId,
          orderId: order.id,
        });
      }

      const created = await this.getOrder(order.id, client);
      if (txnId) await IdempotencyService.complete(client, txnId, created, { dispatchOrderId: order.id });
      return created;
    });
  }

  // Correct an already-dispatched order.
  //
  // The stock has physically moved, so this is not a document edit: the original
  // quantities go back into the exact lots they came from, the order's lines are rewritten,
  // and the new quantities are drawn again FEFO. All in one transaction — a half-applied
  // correction would leave the ledger disagreeing with the shelves.
  static async updateOrder(orderId, { items, notes, editedBy, clientTxnId = null, actorUserId = null }) {
    assertCanWriteWarehouseStock();
    return withTransaction(async (client) => {
      // An edit reverses and re-draws real stock, so a repeated edit is as damaging as a
      // repeated dispatch. Same gate, before the order row is locked.
      let txnId = null;
      if (clientTxnId) {
        const { txn, replay } = await IdempotencyService.claim(client, {
          clientTxnId, operation: 'dispatch_edit', actorUserId, actor: editedBy ?? null,
        });
        if (replay) return txn.result;
        txnId = txn.id;
      }

      const { rows: existing } = await client.query(
        'SELECT * FROM dispatch_orders WHERE id = $1 FOR UPDATE', [orderId]);
      const order = existing[0];
      if (!order) { const e = new Error('dispatch order not found'); e.status = 404; throw e; }

      // Orders generated by fulfilling a facility request are owned by the request
      // lifecycle, not hand-editable here. Their movements ARE linked to the order now
      // (see 034), so reverseOrder would find and return the stock correctly — but the
      // request's own qty_dispatched, its EnVo callback and the facility's expectation
      // would all still say the original figures. Correct such a dispatch through the
      // request or a stock adjustment instead.
      const { rows: fromRequest } = await client.query(
        'SELECT 1 FROM requests WHERE dispatch_order_id = $1 LIMIT 1', [orderId]);
      if (fromRequest[0]) {
        const e = new Error('This dispatch was generated from a facility request and cannot be edited here — correct it through the request or a stock adjustment.');
        e.status = 409; throw e;
      }

      const lines = items.map((item) => {
        const quantity = Number(item.quantity);
        const unitPrice = Number(item.unitPrice);
        return {
          commodityId: Number(item.commodityId),
          quantity,
          unitPrice,
          lineTotal: round2(quantity * unitPrice),
        };
      });

      // Return everything first, so the re-allocation below sees true availability —
      // otherwise reducing a line could fail for lack of stock the order itself is holding.
      await this.reverseOrder(client, orderId, editedBy, txnId);

      // The old lines go, along with the ledger's link to them; the reversal rows above
      // already recorded what came back, so history isn't lost.
      await client.query(
        'UPDATE batch_movements SET dispatch_order_item_id = NULL WHERE dispatch_order_item_id IN (SELECT id FROM dispatch_order_items WHERE dispatch_order_id = $1)',
        [orderId]
      );
      await client.query('DELETE FROM dispatch_order_items WHERE dispatch_order_id = $1', [orderId]);

      for (const line of lines) {
        const { rows: item } = await client.query(
          `INSERT INTO dispatch_order_items (dispatch_order_id, commodity_id, quantity, unit_price, line_total)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [orderId, line.commodityId, line.quantity, line.unitPrice, line.lineTotal]
        );
        await this.allocateFefo(client, {
          commodityId: line.commodityId,
          quantity: line.quantity,
          facilityId: order.facility_id,
          itemId: item[0].id,
          actor: editedBy,
          txnId,
          orderId,
        });
      }

      const totalAmount = round2(lines.reduce((sum, l) => sum + l.lineTotal, 0));
      await client.query(
        `UPDATE dispatch_orders
            SET total_amount = $2,
                notes = $3,
                edited_at = now(),
                edited_by = $4,
                edit_count = edit_count + 1
          WHERE id = $1`,
        [orderId, totalAmount, notes ?? order.notes, editedBy ?? null]
      );

      const edited = await this.getOrder(orderId, client);
      if (txnId) await IdempotencyService.complete(client, txnId, edited, { dispatchOrderId: orderId });
      return edited;
    });
  }

  // Take `quantity` of a commodity out of stock, oldest-expiry-first, writing one ledger
  // row per lot touched. Shared by dispatching and by re-applying an edited order so the
  // two can never drift apart.
  // Draws `quantity` FEFO across a commodity's lots and returns the amount actually
  // allocated. By default it's all-or-nothing (throws if stock is short). With
  // `allowShort`, it takes whatever is on hand (0..quantity) and returns that, so a
  // request can ship the lines the warehouse has without being blocked by the ones it
  // doesn't — the shortfall stays visible as requested-minus-dispatched.
  static async allocateFefo(client, { commodityId, quantity, facilityId, itemId, actor, allowShort = false, txnId = null, orderId = null }) {
    // Locking the usable lots for the transaction stops two concurrent dispatches both
    // claiming the same stock.
    const batches = await client.query(
      `SELECT b.id, b.batch_number, b.quantity_remaining, c.name AS commodity_name
         FROM commodity_batches b
         JOIN commodities c ON c.id = b.commodity_id
        WHERE b.commodity_id = $1
          AND b.quantity_remaining > 0
          AND b.expiry_date >= CURRENT_DATE
        ORDER BY b.expiry_date, b.id
          FOR UPDATE OF b`,
      [commodityId]
    );

    const available = batches.rows.reduce((sum, b) => sum + Number(b.quantity_remaining), 0);
    if (!allowShort && available < quantity) {
      const name = batches.rows[0]?.commodity_name || `commodity #${commodityId}`;
      const err = new Error(
        `insufficient stock for ${name}: requested ${quantity}, available ${available}`
      );
      err.status = 400;
      throw err;
    }

    let outstanding = allowShort ? Math.min(quantity, available) : quantity;
    let allocated = 0;
    // Returned so a caller that could not know the order line up front (a request
    // fulfilment allocates before its dispatch order exists) can link these rows to it
    // afterwards, inside the same transaction.
    const movementIds = [];
    for (const batch of batches.rows) {
      if (outstanding <= 0) break;
      const take = Math.min(outstanding, Number(batch.quantity_remaining));

      await client.query(
        'UPDATE commodity_batches SET quantity_remaining = quantity_remaining - $2 WHERE id = $1',
        [batch.id, take]
      );
      const movement = await client.query(
        `INSERT INTO batch_movements
           (batch_id, movement_type, quantity, facility_id, dispatch_order_item_id,
            dispatch_order_id, created_by, txn_id, origin, source_instance)
         VALUES ($1, 'dispatch', $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [batch.id, -take, facilityId, itemId, orderId, actor ?? null, txnId, ORIGIN, INSTANCE_ID]
      );
      movementIds.push(movement.rows[0].id);
      outstanding = round2(outstanding - take);
      allocated = round2(allocated + take);
    }
    return { allocated, movementIds };
  }

  // Put an order's dispatched quantities back into the exact lots they came from. Read
  // from the ledger rather than re-deriving, so stock returns where it actually left —
  // FEFO at edit time could pick different lots entirely.
  static async reverseOrder(client, orderId, actor, txnId = null) {
    const { rows: moves } = await client.query(
      `SELECT m.id, m.batch_id, m.quantity, m.facility_id, m.dispatch_order_item_id
         FROM batch_movements m
        WHERE m.dispatch_order_id = $1
          AND m.movement_type = 'dispatch'
          AND NOT EXISTS (
            SELECT 1 FROM batch_movements r
             WHERE r.movement_type = 'reversal'
               AND r.dispatch_order_id = m.dispatch_order_id
               AND r.batch_id = m.batch_id
               AND r.id > m.id
          )
        ORDER BY m.id`,
      [orderId]
    );

    for (const move of moves) {
      const back = Math.abs(Number(move.quantity));
      await client.query(
        'UPDATE commodity_batches SET quantity_remaining = quantity_remaining + $2 WHERE id = $1',
        [move.batch_id, back]
      );
      await client.query(
        `INSERT INTO batch_movements
           (batch_id, movement_type, quantity, facility_id, dispatch_order_item_id,
            dispatch_order_id, note, created_by, txn_id, origin, source_instance)
         VALUES ($1, 'reversal', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [move.batch_id, back, move.facility_id, move.dispatch_order_item_id, orderId,
         `reversed by edit of order #${orderId}`, actor ?? null, txnId, ORIGIN, INSTANCE_ID]
      );
    }
    return moves.length;
  }

  /**
   * Record that this dispatch document was printed, and say which copy it is.
   *
   * A reprint MOVES NO STOCK. It writes no movement, no inventory transaction and no order —
   * it is a record that a piece of paper was produced, nothing more. That separation is the
   * whole point of tracking it: two copies of one waybill in circulation are dangerous only
   * if nobody can tell which is which, and a reprint that quietly re-dispatched would be a
   * far worse bug than the one it solves.
   *
   * Numbering is taken under a row lock so two people pressing Print at once cannot both be
   * handed "REPRINT #1".
   */
  static async recordPrint(orderId, { printedBy } = {}) {
    return withTransaction(async (client) => {
      const { rows: ord } = await client.query(
        'SELECT id, print_count FROM dispatch_orders WHERE id = $1 FOR UPDATE', [orderId]);
      if (!ord[0]) { const e = new Error('dispatch order not found'); e.status = 404; throw e; }

      const printNumber = Number(ord[0].print_count);           // 0 for the first copy
      const label = printNumber === 0 ? 'ORIGINAL' : `REPRINT #${printNumber}`;

      const { rows } = await client.query(
        `INSERT INTO dispatch_order_prints
           (dispatch_order_id, print_number, label, printed_by, origin, source_instance)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING uid, print_number, label, printed_by, printed_at`,
        [orderId, printNumber, label, printedBy ?? null, ORIGIN, INSTANCE_ID]);

      await client.query(
        'UPDATE dispatch_orders SET print_count = print_count + 1 WHERE id = $1', [orderId]);

      return { ...rows[0], isReprint: printNumber > 0 };
    });
  }

  /** Who has printed this document, and when. */
  static async printHistory(orderId) {
    const { rows } = await query(
      `SELECT uid, print_number, label, printed_by, printed_at
         FROM dispatch_order_prints WHERE dispatch_order_id = $1 ORDER BY print_number`,
      [orderId]);
    return rows;
  }

  static async getOrder(orderId, client = null) {
    const run = client ? (text, params) => client.query(text, params) : query;

    const orderResult = await run(
      `SELECT o.id, o.uid, o.facility_id, f.name AS facility_name, f.state, f.lga,
              o.total_amount, o.dispatched_by, o.authorized_by, o.dispatched_at, o.notes,
              o.edited_at, o.edited_by, o.edit_count, o.print_count, o.scheme
         FROM dispatch_orders o
         JOIN facilities f ON f.id = o.facility_id
        WHERE o.id = $1`,
      [orderId]
    );
    const order = orderResult.rows[0];
    if (!order) return null;

    // Each line reports the batches it actually drew from, so a dispatched lot stays
    // traceable to the facility that received it.
    const itemsResult = await run(
      `SELECT i.id,
              i.commodity_id,
              c.name AS commodity_name,
              c.unit,
              i.quantity,
              i.unit_price,
              i.line_total,
              COALESCE(json_agg(
                json_build_object(
                  'batchId', b.id,
                  'batchNumber', b.batch_number,
                  'expiryDate', b.expiry_date,
                  'quantity', -m.quantity
                ) ORDER BY b.expiry_date
              ) FILTER (WHERE m.id IS NOT NULL), '[]'::json) AS batches
         FROM dispatch_order_items i
         JOIN commodities c ON c.id = i.commodity_id
         LEFT JOIN batch_movements m ON m.dispatch_order_item_id = i.id
         LEFT JOIN commodity_batches b ON b.id = m.batch_id
        WHERE i.dispatch_order_id = $1
        GROUP BY i.id, c.name, c.unit
        ORDER BY c.name`,
      [orderId]
    );

    return { ...order, items: itemsResult.rows };
  }

  // The dispatch log. Unfiltered by default — "what went out" is the usual question, not
  // "what went out to this one site" — with an optional facility filter to narrow it.
  static async list({ facilityId = null, limit = 200 } = {}) {
    const { rows } = await query(
      `SELECT o.id,
              o.facility_id,
              f.name AS facility_name,
              f.lga,
              o.total_amount,
              o.dispatched_by,
              o.authorized_by,
              o.dispatched_at,
              o.notes,
              o.edited_at,
              o.edit_count,
              o.scheme,
              b.is_debt,
              b.amount_paid,
              b.outstanding,
              COUNT(i.id)::int AS line_count,
              COALESCE(SUM(i.quantity), 0) AS total_quantity
         FROM dispatch_orders o
         JOIN facilities f ON f.id = o.facility_id
         JOIN dispatch_order_balances b ON b.dispatch_order_id = o.id
         LEFT JOIN dispatch_order_items i ON i.dispatch_order_id = o.id
        WHERE ($1::int IS NULL OR o.facility_id = $1)
        GROUP BY o.id, f.name, f.lga, b.is_debt, b.amount_paid, b.outstanding
        ORDER BY o.dispatched_at DESC
        LIMIT $2`,
      [facilityId, limit]
    );
    return rows;
  }

  static listForFacility(facilityId) {
    return this.list({ facilityId });
  }
}
