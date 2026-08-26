import { query } from '../db.js';

// Everything that has actually left the store, from both routes it can leave by:
// an ad-hoc dispatch order raised on the Dispatch page, and a facility request fulfilled
// from the Requests queue. Reporting on one alone would understate what a facility took.
//
// Requests need care: only 'dispatched' ones count, the shipped figure is `qty_dispatched`
// (not the requested `quantity`), and the value is recomputed from it — `line_total` is
// priced at what was asked for, which need not be what went out. `facility_id` is nullable
// there too, when EnVo names a facility we can't resolve.
const DISPATCHED_LINES = `
  WITH dispatched_lines AS (
    SELECT 'dispatch'::text AS source,
           o.id AS order_ref,
           o.facility_id,
           i.commodity_id,
           i.quantity::numeric AS quantity,
           i.unit_price,
           (i.quantity * i.unit_price)::numeric AS line_value,
           o.dispatched_at,
           o.dispatched_by
      FROM dispatch_orders o
      JOIN dispatch_order_items i ON i.dispatch_order_id = o.id
     WHERE o.dispatched_at >= $1::date
       AND o.dispatched_at < ($2::date + 1)
    UNION ALL
    SELECT 'request',
           r.id,
           r.facility_id,
           ri.commodity_id,
           ri.qty_dispatched::numeric,
           ri.unit_price,
           (ri.qty_dispatched * ri.unit_price)::numeric,
           r.dispatched_at,
           r.dispatched_by
      FROM requests r
      JOIN request_items ri ON ri.request_id = r.id
     WHERE r.status = 'dispatched'
       AND r.dispatched_at >= $1::date
       AND r.dispatched_at < ($2::date + 1)
       AND COALESCE(ri.qty_dispatched, 0) > 0
  )
`;

// The dashboard slices the same lines by LGA and by category, so both dimensions are
// joined on once here and the filters applied in one place. $3 is the LGA, $4 the
// category; either NULL means "all". Aggregates read `filtered`; the drill-downs below
// still read `dispatched_lines` directly, since they filter by a single id instead.
const FILTERED_LINES = `${DISPATCHED_LINES},
  filtered AS (
    SELECT d.*,
           f.name AS facility_name,
           f.lga,
           c.name AS commodity_name,
           c.category,
           c.unit
      FROM dispatched_lines d
      LEFT JOIN facilities f ON f.id = d.facility_id
      JOIN commodities c ON c.id = d.commodity_id
     WHERE ($3::text IS NULL OR f.lga = $3)
       AND ($4::text IS NULL OR c.category = $4)
  )
`;

// Default window: the last 30 days, inclusive of today.
function resolvePeriod({ from, to, lga, category } = {}) {
  const end = to || new Date().toISOString().slice(0, 10);
  const filters = { lga: lga || null, category: category || null };
  if (from) return { from, to: end, ...filters };
  const start = new Date(end);
  start.setDate(start.getDate() - 29);
  return { from: start.toISOString().slice(0, 10), to: end, ...filters };
}

export class MonitoringService {
  // Headline figures for the period. Order ids collide across the two sources — a
  // dispatch order 7 and a request 7 are different things — so orders are counted on the
  // (source, ref) pair. Facilities served ignores the unresolved-facility rows.
  static async summary(period) {
    const { from, to, lga, category } = resolvePeriod(period);
    const { rows } = await query(
      `${FILTERED_LINES}
       SELECT COALESCE(ROUND(SUM(line_value)::numeric, 2), 0) AS value_dispatched,
              COALESCE(SUM(quantity), 0) AS quantity,
              COALESCE(SUM(quantity) FILTER (WHERE dispatched_at::date = CURRENT_DATE), 0) AS quantity_today,
              COUNT(*) AS lines,
              COUNT(DISTINCT (source, order_ref)) AS orders,
              COUNT(DISTINCT facility_id) FILTER (WHERE facility_id IS NOT NULL) AS facilities,
              COUNT(DISTINCT commodity_id) AS commodities
         FROM filtered`,
      [from, to, lga, category]
    );
    return { period: { from, to }, ...rows[0] };
  }

  // One row per day in the window, including the days nothing moved — a gap-free series
  // is what the chart needs, and generate_series is cheaper than filling holes in JS.
  static async daily(period) {
    const { from, to, lga, category } = resolvePeriod(period);
    const { rows } = await query(
      `${FILTERED_LINES}
       SELECT day::date AS day,
              COALESCE(SUM(f.quantity), 0) AS quantity,
              COALESCE(ROUND(SUM(f.line_value)::numeric, 2), 0) AS value_dispatched
         FROM generate_series($1::date, $2::date, interval '1 day') AS day
         LEFT JOIN filtered f ON f.dispatched_at::date = day::date
        GROUP BY day
        ORDER BY day`,
      [from, to, lga, category]
    );
    return { period: { from, to }, rows };
  }

  // Uncategorised commodities are their own slice rather than dropped — a donut that
  // silently omits stock would not add up to the headline total.
  static async byCategory(period) {
    const { from, to, lga, category } = resolvePeriod(period);
    const { rows } = await query(
      `${FILTERED_LINES}
       SELECT COALESCE(category, 'Uncategorised') AS category,
              COUNT(DISTINCT commodity_id) AS commodities,
              SUM(quantity) AS quantity,
              ROUND(SUM(line_value)::numeric, 2) AS value_dispatched
         FROM filtered
        GROUP BY COALESCE(category, 'Uncategorised')
        ORDER BY SUM(quantity) DESC`,
      [from, to, lga, category]
    );
    return { period: { from, to }, rows };
  }

  static async byFacility(period) {
    const { from, to, lga, category } = resolvePeriod(period);
    const { rows } = await query(
      `${FILTERED_LINES}
       SELECT facility_id,
              facility_name,
              lga,
              COUNT(DISTINCT (source, order_ref)) AS orders,
              COUNT(DISTINCT commodity_id) AS commodities,
              SUM(quantity) AS quantity,
              ROUND(SUM(line_value)::numeric, 2) AS value_dispatched,
              MAX(dispatched_at) AS last_dispatch
         FROM filtered
        WHERE facility_id IS NOT NULL
        GROUP BY facility_id, facility_name, lga
        ORDER BY SUM(line_value) DESC`,
      [from, to, lga, category]
    );
    return { period: { from, to }, rows };
  }

  static async byCommodity(period) {
    const { from, to, lga, category } = resolvePeriod(period);
    const { rows } = await query(
      `${FILTERED_LINES}
       SELECT commodity_id,
              commodity_name,
              category,
              unit,
              COUNT(DISTINCT (source, order_ref)) AS orders,
              COUNT(DISTINCT facility_id) FILTER (WHERE facility_id IS NOT NULL) AS facilities,
              SUM(quantity) AS quantity,
              ROUND(SUM(line_value)::numeric, 2) AS value_dispatched,
              MAX(dispatched_at) AS last_dispatch
         FROM filtered
        GROUP BY commodity_id, commodity_name, category, unit
        ORDER BY SUM(line_value) DESC`,
      [from, to, lga, category]
    );
    return { period: { from, to }, rows };
  }

  // Where one commodity has gone, newest first, over all time rather than a reporting
  // window — the catalogue asks "who takes this?", not "who took it in July", and a
  // commodity that moves twice a year would look dead through a 30-day lens.
  static async commodityHistory(commodityId, { limit } = {}) {
    const { rows } = await query(
      `${DISPATCHED_LINES}
       SELECT d.source,
              d.order_ref,
              d.dispatched_at,
              d.dispatched_by,
              d.facility_id,
              f.name AS facility_name,
              f.lga,
              d.quantity,
              d.unit_price,
              ROUND(d.line_value, 2) AS line_value
         FROM dispatched_lines d
         LEFT JOIN facilities f ON f.id = d.facility_id
        WHERE d.commodity_id = $3
        ORDER BY d.dispatched_at DESC
        LIMIT $4`,
      ['1900-01-01', new Date().toISOString().slice(0, 10), commodityId, Math.min(Number(limit) || 25, 200)]
    );
    return { rows };
  }

  // The facilities that received one commodity, and every line behind them. Same shape of
  // answer as facilityDetail, from the other direction.
  static async commodityDetail(commodityId, period) {
    const { from, to } = resolvePeriod(period);
    const { rows: lines } = await query(
      `${DISPATCHED_LINES}
       SELECT d.source,
              d.order_ref,
              d.dispatched_at,
              d.dispatched_by,
              d.facility_id,
              f.name AS facility_name,
              f.lga,
              d.quantity,
              d.unit_price,
              ROUND(d.line_value, 2) AS line_value
         FROM dispatched_lines d
         LEFT JOIN facilities f ON f.id = d.facility_id
        WHERE d.commodity_id = $3
        ORDER BY d.dispatched_at DESC, f.name`,
      [from, to, commodityId]
    );
    return { period: { from, to }, lines };
  }

  // Activity log — stock movements only. `batch_movements` is already the append-only
  // ledger every quantity change writes to, so this needs no separate audit table and
  // cannot drift from the stock it describes. Catalogue edits (prices, units, names) are
  // deliberately out of scope: they move no stock.
  static async activity({ from, to, type, limit } = {}) {
    const period = resolvePeriod({ from, to });
    const { rows } = await query(
      `SELECT m.id,
              m.movement_type,
              m.quantity,
              m.reason,
              m.note,
              m.created_by,
              m.created_at,
              m.dispatch_order_item_id,
              b.batch_number,
              b.expiry_date,
              c.id AS commodity_id,
              c.name AS commodity_name,
              c.category,
              c.unit,
              f.name AS facility_name
         FROM batch_movements m
         JOIN commodity_batches b ON b.id = m.batch_id
         JOIN commodities c ON c.id = b.commodity_id
         LEFT JOIN facilities f ON f.id = m.facility_id
        WHERE m.created_at >= $1::date
          AND m.created_at < ($2::date + 1)
          AND ($3::text IS NULL OR m.movement_type = $3)
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $4`,
      [period.from, period.to, type || null, Math.min(Number(limit) || 500, 2000)]
    );

    // Counted over the whole window and across every type, deliberately ignoring both
    // `type` and the row limit: these are the figures the tiles show, and a tile that
    // dropped to zero the moment you filtered by it could never be clicked twice.
    const { rows: counts } = await query(
      `SELECT m.movement_type, COUNT(*)::int AS count
         FROM batch_movements m
        WHERE m.created_at >= $1::date
          AND m.created_at < ($2::date + 1)
        GROUP BY m.movement_type`,
      [period.from, period.to]
    );

    return {
      period,
      rows,
      counts: Object.fromEntries(counts.map((r) => [r.movement_type, r.count])),
    };
  }

  // Adjustments only — the corrections that are not receipts and not dispatches. Kept
  // apart from the general activity log because the question here is different: not "what
  // happened" but "what did we lose, to what, and how much of it".
  // `direction` splits the log the way the store thinks about it: stock taken off (expiry,
  // loss, damage, a recount that found less) versus stock put back on (returns, a recount
  // that found more). It is derived from the sign rather than stored, so it stays true
  // even for a recount, which can go either way under one reason code.
  static async adjustments({ from, to, reason, direction, createdBy } = {}) {
    const period = resolvePeriod({ from, to });

    const { rows } = await query(
      `SELECT m.id,
              m.quantity,
              m.reason,
              m.note,
              m.created_by,
              m.created_at,
              b.batch_number,
              b.expiry_date,
              c.id AS commodity_id,
              c.name AS commodity_name,
              c.category,
              c.unit
         FROM batch_movements m
         JOIN commodity_batches b ON b.id = m.batch_id
         JOIN commodities c ON c.id = b.commodity_id
        WHERE m.movement_type = 'adjustment'
          AND m.created_at >= $1::date
          AND m.created_at < ($2::date + 1)
          AND ($3::text IS NULL OR m.reason = $3)
          AND ($4::text IS NULL
               OR ($4 = 'positive' AND m.quantity > 0)
               OR ($4 = 'negative' AND m.quantity < 0))
          AND ($5::text IS NULL OR m.created_by = $5)
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1000`,
      [period.from, period.to, reason || null, direction || null, createdBy || null]
    );

    // Who has adjusted anything in this window, whatever the other filters say — the
    // dropdown must still offer the person you are trying to filter to.
    const { rows: actors } = await query(
      `SELECT DISTINCT m.created_by
         FROM batch_movements m
        WHERE m.movement_type = 'adjustment'
          AND m.created_by IS NOT NULL
          AND m.created_at >= $1::date
          AND m.created_at < ($2::date + 1)
        ORDER BY m.created_by`,
      [period.from, period.to]
    );

    return { period, rows, actors: actors.map((a) => a.created_by) };
  }

  // What happened on one day, for one kind of operation. Every Operations page shows the
  // same "records for <date>" card, so they read from one query rather than four pages
  // each growing their own date filter.
  static async dayRecords({ date, kind } = {}) {
    const day = date || new Date().toISOString().slice(0, 10);

    if (kind === 'adjustment') {
      const { rows } = await MonitoringService.adjustments({ from: day, to: day });
      return { date: day, kind, rows };
    }

    if (kind === 'receipt') {
      const { rows } = await query(
        `SELECT m.id,
                m.quantity,
                m.note,
                m.created_by,
                m.created_at,
                b.batch_number,
                b.expiry_date,
                b.unit_cost,
                v.name AS vendor_name,
                c.name AS commodity_name,
                c.category,
                c.unit
           FROM batch_movements m
           JOIN commodity_batches b ON b.id = m.batch_id
           JOIN commodities c ON c.id = b.commodity_id
           LEFT JOIN vendors v ON v.id = b.vendor_id
          WHERE m.movement_type = 'receipt'
            AND m.created_at >= $1::date
            AND m.created_at < ($1::date + 1)
          ORDER BY m.created_at DESC, m.id DESC`,
        [day]
      );
      return { date: day, kind, rows };
    }

    if (kind === 'dispatch') {
      const { rows } = await query(
        `SELECT o.id,
                o.facility_id,
                o.dispatched_at,
                o.dispatched_by,
                o.total_amount,
                o.notes,
                f.name AS facility_name,
                f.lga,
                COUNT(i.id)::int AS line_count,
                COALESCE(SUM(i.quantity), 0) AS total_quantity
           FROM dispatch_orders o
           JOIN facilities f ON f.id = o.facility_id
           LEFT JOIN dispatch_order_items i ON i.dispatch_order_id = o.id
          WHERE o.dispatched_at >= $1::date
            AND o.dispatched_at < ($1::date + 1)
          GROUP BY o.id, f.name, f.lga
          ORDER BY o.dispatched_at DESC`,
        [day]
      );
      return { date: day, kind, rows };
    }

    if (kind === 'request') {
      // A request touches the day it arrived and the day it shipped, and both are worth
      // seeing on that day's card — so it matches on either.
      const { rows } = await query(
        `SELECT r.id,
                r.envo_request_id,
                r.status,
                r.created_at,
                r.dispatched_at,
                r.requested_by,
                r.total_amount,
                f.name AS facility_name,
                f.lga,
                COUNT(i.id)::int AS line_count,
                COALESCE(SUM(i.quantity), 0)::int AS total_quantity
           FROM requests r
           LEFT JOIN facilities f ON f.id = r.facility_id
           LEFT JOIN request_items i ON i.request_id = r.id
          WHERE (r.created_at >= $1::date AND r.created_at < ($1::date + 1))
             OR (r.dispatched_at >= $1::date AND r.dispatched_at < ($1::date + 1))
          GROUP BY r.id, f.name, f.lga
          ORDER BY COALESCE(r.dispatched_at, r.created_at) DESC`,
        [day]
      );
      return { date: day, kind, rows };
    }

    const err = new Error(`unknown kind "${kind}" — expected receipt, dispatch, request or adjustment`);
    err.status = 400;
    throw err;
  }

  // Every dispatched line for one facility over the period, unaggregated. The totals,
  // the per-commodity roll-up and the dispatch history are all just groupings of this, so
  // returning the lines lets the UI re-derive them instantly when a dispatch or a
  // commodity is selected — no round trip to filter.
  static async facilityDetail(facilityId, period) {
    const { from, to } = resolvePeriod(period);

    const { rows: lines } = await query(
      `${DISPATCHED_LINES}
       SELECT d.source,
              d.order_ref,
              d.dispatched_at,
              d.dispatched_by,
              d.commodity_id,
              c.name AS commodity_name,
              c.category,
              c.unit,
              d.quantity,
              d.unit_price,
              ROUND(d.line_value, 2) AS line_value,
              -- Order-level money, repeated on each of its lines. Joined here rather
              -- than in the shared DISPATCHED_LINES CTE, which several other queries
              -- use and none of them need this.
              b.scheme,
              b.is_debt,
              b.amount_paid,
              b.outstanding,
              -- The dispatch order the money hangs off. A 'request' line's order_ref is
              -- the REQUEST id, so it cannot be used to match payments; this can.
              b.dispatch_order_id AS balance_order_id
         FROM dispatched_lines d
         JOIN commodities c ON c.id = d.commodity_id
         -- A 'request' line is priced against the dispatch order the request produced,
         -- so it has to hop through requests to find the same balance.
         LEFT JOIN requests rq ON d.source = 'request' AND rq.id = d.order_ref
         LEFT JOIN dispatch_order_balances b
                ON b.dispatch_order_id = CASE WHEN d.source = 'dispatch'
                                              THEN d.order_ref
                                              ELSE rq.dispatch_order_id END
        WHERE d.facility_id = $3
        ORDER BY d.dispatched_at DESC, c.name`,
      [from, to, facilityId]
    );

    // The instalments behind those balances, so the dispatch history can show HOW an
    // order was paid — receipt number included, which is what a facility quotes when it
    // queries a payment. Fetched alongside the lines rather than per-order on expand:
    // the volume is small, and it keeps the panel from loading one order at a time.
    const { rows: payments } = await query(
      `SELECT p.id, p.dispatch_order_id, p.amount, p.paid_at, p.recorded_by, p.note, p.receipt_no
         FROM dispatch_order_payments p
         JOIN dispatch_orders o ON o.id = p.dispatch_order_id
        WHERE o.facility_id = $1
        ORDER BY p.paid_at, p.id`,
      [facilityId]
    );

    return { period: { from, to }, lines, payments };
  }
}
