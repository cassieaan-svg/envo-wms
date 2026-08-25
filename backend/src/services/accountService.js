import { query, withTransaction } from '../db.js';

function round2(v) { return Math.round(Number(v) * 100) / 100; }

// What facilities owe the central store, and the payments that clear it.
//
// Debt is tracked PER DISPATCH ORDER: an order issued under a debt-bearing scheme (the
// DRF) is owed in full until payments against it add up to its total. A facility's
// balance is the sum across its orders. See migration 029 for why payments are rows
// rather than a single editable amount_paid.
export class AccountService {
  // Every order for a facility with its balance. Includes settled and non-debt orders
  // so the page can show the whole picture; callers filter with `onlyOutstanding`.
  static async ordersForFacility(facilityId, { onlyOutstanding = false } = {}) {
    const { rows } = await query(
      `SELECT b.dispatch_order_id AS id, b.scheme, b.is_debt, b.dispatched_at,
              b.total_amount, b.amount_paid, b.outstanding,
              o.notes, o.dispatched_by,
              (SELECT count(*)::int FROM dispatch_order_payments p
                WHERE p.dispatch_order_id = b.dispatch_order_id) AS payment_count
         FROM dispatch_order_balances b
         JOIN dispatch_orders o ON o.id = b.dispatch_order_id
        WHERE b.facility_id = $1
          ${onlyOutstanding ? 'AND b.outstanding > 0' : ''}
        ORDER BY b.dispatched_at DESC`, [facilityId]);
    return rows;
  }

  // One line per facility that owes anything, worst first — the store's debtors list.
  static async debtors() {
    const { rows } = await query(
      `SELECT f.id AS facility_id, f.name AS facility_name,
              count(*) FILTER (WHERE b.outstanding > 0)::int AS unpaid_orders,
              SUM(b.total_amount) FILTER (WHERE b.is_debt)::numeric(14,2) AS billed,
              SUM(b.amount_paid)  FILTER (WHERE b.is_debt)::numeric(14,2) AS paid,
              SUM(b.outstanding)::numeric(14,2) AS outstanding,
              MAX(b.dispatched_at) FILTER (WHERE b.outstanding > 0) AS oldest_unpaid_at
         FROM dispatch_order_balances b
         JOIN facilities f ON f.id = b.facility_id
        GROUP BY f.id, f.name
       HAVING SUM(b.outstanding) > 0
        ORDER BY SUM(b.outstanding) DESC`);
    return rows;
  }

  /**
   * Debt-bearing orders still owing money, oldest first — the ones to chase.
   *
   * Order-level rather than facility-level: payment is made against an order, so this is
   * the grain the work actually happens at. `debtors()` above rolls the same data up per
   * facility for the summary.
   */
  static async outstandingOrders({ facilityId = null } = {}) {
    const params = [];
    let where = 'b.is_debt AND b.outstanding > 0';
    if (facilityId) { params.push(facilityId); where += ` AND b.facility_id = $${params.length}`; }
    const { rows } = await query(
      `SELECT b.dispatch_order_id AS id, b.facility_id, f.name AS facility_name,
              b.scheme, b.dispatched_at, b.total_amount, b.amount_paid, b.outstanding,
              o.notes, o.dispatched_by,
              COALESCE(p.instalments, 0) AS instalments,
              p.last_paid_at
         FROM dispatch_order_balances b
         JOIN facilities f ON f.id = b.facility_id
         JOIN dispatch_orders o ON o.id = b.dispatch_order_id
         LEFT JOIN (
           SELECT dispatch_order_id,
                  count(*) FILTER (WHERE amount > 0)::int AS instalments,
                  MAX(paid_at) AS last_paid_at
             FROM dispatch_order_payments GROUP BY dispatch_order_id
         ) p ON p.dispatch_order_id = b.dispatch_order_id
        WHERE ${where}
        ORDER BY b.dispatched_at ASC`, params);
    return rows;
  }

  /**
   * Orders that have been paid off — the settlement history.
   *
   * A facility disappears from `debtors()` the moment it clears, which is right for a
   * debtors list and wrong as a record: there would be nothing to show that it ever
   * owed anything or how it paid. This is that record, with the instalment count and
   * the date the last payment landed.
   *
   * `amount_paid > 0` matters: a debt-bearing order worth ₦0 also has nothing
   * outstanding, but it was never paid off and does not belong in a payment history.
   */
  static async settled({ facilityId = null } = {}) {
    const params = [];
    let where = 'b.is_debt AND b.outstanding <= 0 AND b.amount_paid > 0';
    if (facilityId) { params.push(facilityId); where += ` AND b.facility_id = $${params.length}`; }
    const { rows } = await query(
      `SELECT b.dispatch_order_id AS id, b.facility_id, f.name AS facility_name,
              b.scheme, b.dispatched_at, b.total_amount, b.amount_paid,
              p.instalments, p.first_paid_at, p.cleared_at,
              o.notes, o.dispatched_by
         FROM dispatch_order_balances b
         JOIN facilities f ON f.id = b.facility_id
         JOIN dispatch_orders o ON o.id = b.dispatch_order_id
         JOIN (
           SELECT dispatch_order_id,
                  -- Only positive entries are instalments; a negative one is a
                  -- correction and would otherwise inflate the count.
                  count(*) FILTER (WHERE amount > 0)::int AS instalments,
                  MIN(paid_at) AS first_paid_at,
                  MAX(paid_at) AS cleared_at
             FROM dispatch_order_payments GROUP BY dispatch_order_id
         ) p ON p.dispatch_order_id = b.dispatch_order_id
        WHERE ${where}
        ORDER BY p.cleared_at DESC`, params);
    return rows;
  }

  /**
   * Balances keyed by EnVo's facility code, for EnVo to display.
   *
   * The WMS is the single source of truth for money: it owns prices, the dispatch and
   * the payments. EnVo reads this rather than computing its own figure — two systems
   * each deriving a balance is how a facility ends up seeing one number on its screen
   * and the store quoting another, with no way to say which is right.
   *
   * Keyed by envo_facility_id (the code EnVo sends on a request), because EnVo does not
   * know WMS facility ids. Facilities with nothing outstanding are returned too, with
   * zeroes, so EnVo can distinguish "owes nothing" from "unknown facility".
   */
  static async balancesByEnvoFacility(envoFacilityIds = null) {
    const params = [];
    let scope = 'f.envo_facility_id IS NOT NULL';
    if (Array.isArray(envoFacilityIds)) {
      if (envoFacilityIds.length === 0) return [];
      params.push(envoFacilityIds);
      scope += ` AND f.envo_facility_id = ANY($${params.length})`;
    }
    const { rows } = await query(
      `SELECT f.envo_facility_id,
              f.name AS facility_name,
              COALESCE(SUM(b.outstanding), 0)::numeric(14,2) AS outstanding,
              COALESCE(SUM(b.total_amount) FILTER (WHERE b.is_debt), 0)::numeric(14,2) AS billed,
              COALESCE(SUM(b.amount_paid)  FILTER (WHERE b.is_debt), 0)::numeric(14,2) AS paid,
              COUNT(*) FILTER (WHERE b.outstanding > 0)::int AS unpaid_orders,
              MIN(b.dispatched_at) FILTER (WHERE b.outstanding > 0) AS oldest_unpaid_at
         FROM facilities f
         LEFT JOIN dispatch_order_balances b ON b.facility_id = f.id
        WHERE ${scope}
        GROUP BY f.envo_facility_id, f.name
        ORDER BY 3 DESC`, params);
    return rows;
  }

  /**
   * The orders behind a facility's balance, keyed by EnVo's facility code.
   *
   * Includes DIRECT dispatches — orders raised in the warehouse with no EnVo request
   * behind them. They are a large part of what a facility owes, and EnVo has no other
   * way to see them: its own warehouse_requests table only knows about orders it raised.
   * Without this, a facility is shown a balance with nothing to explain it.
   *
   * Instalments come inline: the list is short, and a balance you cannot break down into
   * payments is the thing people dispute.
   */
  static async ordersByEnvoFacility(envoFacilityId) {
    const { rows } = await query(
      `SELECT b.dispatch_order_id AS id, b.scheme, b.is_debt, b.dispatched_at,
              b.total_amount, b.amount_paid, b.outstanding,
              o.notes, o.dispatched_by,
              r.envo_request_id,
              COALESCE(
                (SELECT json_agg(json_build_object(
                          'id', p.id, 'amount', p.amount, 'paid_at', p.paid_at,
                          'recorded_by', p.recorded_by, 'note', p.note)
                        ORDER BY p.paid_at, p.id)
                   FROM dispatch_order_payments p
                  WHERE p.dispatch_order_id = b.dispatch_order_id),
                '[]'::json) AS payments,
              -- What was actually issued. A facility being asked to pay ₦85,300 needs to
              -- see the commodities behind the figure, not just the total.
              COALESCE(
                (SELECT json_agg(json_build_object(
                          'commodity', c.name, 'category', c.category, 'unit', c.unit,
                          'quantity', i.quantity, 'unit_price', i.unit_price,
                          'line_total', i.line_total)
                        ORDER BY c.name)
                   FROM dispatch_order_items i
                   JOIN commodities c ON c.id = i.commodity_id
                  WHERE i.dispatch_order_id = b.dispatch_order_id),
                '[]'::json) AS items
         FROM dispatch_order_balances b
         JOIN facilities f ON f.id = b.facility_id
         JOIN dispatch_orders o ON o.id = b.dispatch_order_id
         LEFT JOIN requests r ON r.dispatch_order_id = b.dispatch_order_id
        WHERE f.envo_facility_id = $1
        ORDER BY b.dispatched_at DESC`, [envoFacilityId]);
    return rows;
  }

  // Dimensions the spend report can group by. An allowlist — the value is interpolated
  // into the SQL, so anything outside this map must be unreachable.
  static SPEND_GROUP_BY = {
    facility:  { sql: 'f.envo_facility_id', label: 'f.name' },
    lga:       { sql: 'f.lga',              label: 'f.lga' },
    state:     { sql: 'f.state',            label: 'f.state' },
    commodity: { sql: 'c.name',             label: 'c.name' },
    scheme:    { sql: 'o.scheme',           label: 'o.scheme' },
    month:     { sql: `to_char(o.dispatched_at, 'YYYY-MM')`, label: `to_char(o.dispatched_at, 'YYYY-MM')` },
  }

  /**
   * What the store has ISSUED to facilities, aggregated.
   *
   * Built on dispatch orders, not on EnVo's requests — so it covers both orders a
   * facility raised through EnVo AND direct dispatches raised at the warehouse. Reading
   * only EnVo's requests is what made its Spend page report ₦0 issued beside a
   * six-figure debt: every order behind that debt was a direct dispatch.
   *
   * `paid`/`outstanding` are only meaningful on debt-bearing schemes; the balances view
   * already encodes that rule, so this joins it rather than restating it.
   */
  static async spendByDimension({ groupBy = 'facility', from = null, to = null, envoFacilityIds = null, scheme = null } = {}) {
    const dim = this.SPEND_GROUP_BY[groupBy];
    if (!dim) { const e = new Error(`Unsupported group_by: ${groupBy}`); e.status = 400; throw e; }

    const conds = ['f.envo_facility_id IS NOT NULL'];
    const params = [];
    if (Array.isArray(envoFacilityIds)) {
      if (envoFacilityIds.length === 0) return [];
      params.push(envoFacilityIds); conds.push(`f.envo_facility_id = ANY($${params.length})`);
    }
    if (from)   { params.push(from);   conds.push(`o.dispatched_at >= $${params.length}::date`); }
    if (to)     { params.push(to);     conds.push(`o.dispatched_at < ($${params.length}::date + interval '1 day')`); }
    if (scheme) { params.push(scheme); conds.push(`o.scheme = $${params.length}`); }

    // Commodity grain needs the line items; every other grain would double-count if it
    // joined them, so the item join is only added where it is the grouping dimension.
    const needsItems = groupBy === 'commodity';
    const { rows } = await query(
      `SELECT ${dim.sql} AS key,
              MAX(${dim.label}) AS label,
              COUNT(DISTINCT o.id)::int AS orders,
              ${needsItems
                ? `COALESCE(SUM(i.quantity), 0)::numeric AS quantity,
                   COALESCE(SUM(i.line_total), 0)::numeric(14,2) AS issued,
                   0::numeric(14,2) AS paid,
                   0::numeric(14,2) AS outstanding`
                : `0::numeric AS quantity,
                   COALESCE(SUM(o.total_amount), 0)::numeric(14,2) AS issued,
                   COALESCE(SUM(b.amount_paid), 0)::numeric(14,2) AS paid,
                   COALESCE(SUM(b.outstanding), 0)::numeric(14,2) AS outstanding`}
         FROM dispatch_orders o
         JOIN facilities f ON f.id = o.facility_id
         JOIN dispatch_order_balances b ON b.dispatch_order_id = o.id
         ${needsItems ? `JOIN dispatch_order_items i ON i.dispatch_order_id = o.id
                         JOIN commodities c ON c.id = i.commodity_id` : ''}
        WHERE ${conds.join(' AND ')}
        GROUP BY ${dim.sql}
       HAVING ${dim.sql} IS NOT NULL
        ORDER BY issued DESC`, params);
    return rows;
  }

  static async payments(dispatchOrderId) {
    const { rows } = await query(
      `SELECT id, amount, paid_at, recorded_by, note
         FROM dispatch_order_payments
        WHERE dispatch_order_id = $1
        ORDER BY paid_at, id`, [dispatchOrderId]);
    return rows;
  }

  static async balance(dispatchOrderId, client = null) {
    const exec = client ? client.query.bind(client) : query;
    const { rows } = await exec(
      'SELECT * FROM dispatch_order_balances WHERE dispatch_order_id = $1', [dispatchOrderId]);
    return rows[0] || null;
  }

  /**
   * Record money received against one order.
   *
   * `amount` is signed: positive is a payment, negative reverses an entry made in error
   * (nothing is ever deleted, so a correction is as visible as the mistake).
   */
  static async recordPayment(dispatchOrderId, { amount, recordedBy, note, paidAt } = {}) {
    const value = round2(amount);
    if (!Number.isFinite(value) || value === 0) {
      const e = new Error('a non-zero amount is required'); e.status = 400; throw e;
    }

    return withTransaction(async (client) => {
      // Lock the order so two people recording payments at once cannot both read the
      // same outstanding figure and jointly overpay it.
      const { rows: ord } = await client.query(
        'SELECT id FROM dispatch_orders WHERE id = $1 FOR UPDATE', [dispatchOrderId]);
      if (!ord[0]) { const e = new Error('dispatch order not found'); e.status = 404; throw e; }

      const before = await this.balance(dispatchOrderId, client);
      if (!before.is_debt) {
        // A BHCPF/insurance issue is not the facility's to pay. Accepting money against
        // it would create a credit the balance sheet cannot explain.
        const e = new Error(`orders issued under ${before.scheme} are not billed to the facility`);
        e.status = 400; throw e;
      }

      const outstanding = Number(before.outstanding);
      if (value > 0 && value > outstanding) {
        // Refuse rather than bank an overpayment: the store has no credit concept, so a
        // negative outstanding would quietly offset a later order.
        const e = new Error(`payment exceeds the outstanding balance (₦${outstanding.toLocaleString()})`);
        e.status = 400; throw e;
      }
      if (value < 0 && Math.abs(value) > Number(before.amount_paid)) {
        const e = new Error(`cannot reverse more than has been paid (₦${Number(before.amount_paid).toLocaleString()})`);
        e.status = 400; throw e;
      }

      await client.query(
        `INSERT INTO dispatch_order_payments (dispatch_order_id, amount, recorded_by, note, paid_at)
         VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()))`,
        [dispatchOrderId, value, recordedBy ?? null, note ?? null, paidAt ?? null]);

      return this.balance(dispatchOrderId, client);
    });
  }
}
