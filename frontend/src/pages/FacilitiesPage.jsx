import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { Banner, Empty, Field, Modal, dateTime, money, qty, unitLabel } from '../components/ui.jsx';
import { downloadCsv, slug, stamp } from '../lib/download.js';

// Only Akwa Ibom is in scope for now, so there's no state filter — every facility in the
// register belongs to it.
const STATE = 'Akwa Ibom';

export default function FacilitiesPage({ isAdmin }) {
  const [facilities, setFacilities] = useState([]);
  const [lgas, setLgas] = useState([]);
  const [lgaFilter, setLgaFilter] = useState('');
  const [search, setSearch] = useState('');
  const [stockFor, setStockFor] = useState(null);
  const [historyFor, setHistoryFor] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const [list, lgaList] = await Promise.all([
        api.facilities.list({ lga: lgaFilter, search }),
        api.facilities.lgas(),
      ]);
      setFacilities(list);
      setLgas(lgaList);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [lgaFilter, search]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Facilities</h1>
          <p>Sites the central store supplies. Dispatch orders and stock views hang off these.</p>
        </div>
      </div>

      <Banner kind="error" onDismiss={() => setError(null)}>
        {error}
      </Banner>
      <Banner kind="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Banner>

      <div className="toolbar">
        <Field label="Search">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="facility name…"
          />
        </Field>
        <Field label="LGA">
          <select value={lgaFilter} onChange={(e) => setLgaFilter(e.target.value)}>
            <option value="">all LGAs</option>
            {lgas.map((l) => (
              <option key={l.lga} value={l.lga}>
                {l.lga} ({l.facility_count})
              </option>
            ))}
          </select>
        </Field>
        <button className="btn" onClick={load} disabled={loading}>
          {loading ? 'refreshing…' : 'Refresh'}
        </button>
        {(search || lgaFilter) && (
          <button
            className="btn"
            onClick={() => {
              setSearch('');
              setLgaFilter('');
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>
            {facilities.length} facilit{facilities.length === 1 ? 'y' : 'ies'}
          </h2>
          {facilities.length > 0 && (
            <button
              className="btn small"
              onClick={() =>
                downloadCsv(
                  `facilities-${stamp()}.csv`,
                  [
                    { header: 'Facility', value: (f) => f.name },
                    { header: 'State', value: (f) => f.state },
                    { header: 'LGA', value: (f) => f.lga || '' },
                  ],
                  facilities
                )
              }
            >
              ⭳ CSV
            </button>
          )}
        </div>
        {loading ? (
          <Empty>loading…</Empty>
        ) : facilities.length === 0 ? (
          <Empty>No facilities yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="wrap">Name</th>
                  <th>LGA</th>
                  <th className="num">Owed</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {facilities.map((facility) => (
                  <tr key={facility.id}>
                    <td className="wrap">{facility.name}</td>
                    <td>{facility.lga || '—'}</td>
                    {/* What this facility owes the store, so debtors can be spotted while
                        scanning the list instead of only from the Accounts page. */}
                    <td className="num">
                      {Number(facility.outstanding) > 0 ? (
                        <>
                          <strong>{money(facility.outstanding)}</strong>
                          <div className="muted">{facility.unpaid_orders} unpaid</div>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <div className="row-actions">
                        <button className="btn small" onClick={() => setStockFor(facility)}>
                          commodities
                        </button>
                        <button className="btn small" onClick={() => setHistoryFor(facility)}>
                          dispatch history
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {stockFor && <StockModal facility={stockFor} onClose={() => setStockFor(null)} />}

      {historyFor && (
        <FacilityHistoryModal facility={historyFor} onClose={() => setHistoryFor(null)} />
      )}
    </>
  );
}

// What a facility has taken from the store, and what it cost them. Covers both routes
// stock leaves by — ad-hoc dispatches and fulfilled requests — so the totals are what the
// facility actually received, not just one half of it.
function FacilityHistoryModal({ facility, onClose }) {
  const today = new Date().toISOString().slice(0, 10);
  const [period, setPeriod] = useState({ from: '2020-01-01', to: today });
  const [lines, setLines] = useState(null);
  const [payments, setPayments] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  // Selecting a dispatch or a commodity narrows everything below, the totals included.
  const [selected, setSelected] = useState(null); // { kind: 'order'|'commodity', key }

  async function load() {
    setLoading(true);
    try {
      const data = await api.monitoring.facility(facility.id, period);
      setLines(data.lines);
      setPayments(data.payments || []);
      setSelected(null);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [facility.id, period.from, period.to]);

  const all = lines || [];
  const refOf = (l) => l.source + '-' + l.order_ref;

  // Every view below is a grouping of the same lines, so a selection just narrows the set
  // they are grouped from — no refetch, and the totals stay consistent with the tables.
  const shown = useMemo(() => {
    if (!selected) return all;
    if (selected.kind === 'order') return all.filter((l) => refOf(l) === selected.key);
    return all.filter((l) => String(l.commodity_id) === String(selected.key));
  }, [all, selected]);

  const totals = useMemo(
    () => ({
      value: shown.reduce((sum, l) => sum + Number(l.line_value), 0),
      quantity: shown.reduce((sum, l) => sum + Number(l.quantity), 0),
      dispatches: new Set(shown.map(refOf)).size,
      commodities: new Set(shown.map((l) => l.commodity_id)).size,
    }),
    [shown]
  );

  // Money owed is per ORDER, so it is summed over distinct orders rather than over
  // lines — summing a line-level view would multiply the balance by the line count.
  const owed = useMemo(() => {
    const byOrder = new Map();
    for (const l of all) {
      if (l.balance_order_id == null || !l.is_debt) continue;
      byOrder.set(l.balance_order_id, {
        paid: Number(l.amount_paid || 0),
        outstanding: Number(l.outstanding || 0),
      });
    }
    let paid = 0, outstanding = 0, unpaid = 0;
    for (const b of byOrder.values()) {
      paid += b.paid;
      outstanding += b.outstanding;
      if (b.outstanding > 0) unpaid += 1;
    }
    return { paid, outstanding, unpaid };
  }, [all]);

  const history = useMemo(() => {
    const map = new Map();
    for (const l of all) {
      const key = refOf(l);
      if (!map.has(key)) {
        map.set(key, {
          key,
          source: l.source,
          ref: l.order_ref,
          at: l.dispatched_at,
          by: l.dispatched_by,
          // Order-level, so taken from the first line of the group rather than summed —
          // adding them per line would multiply the balance by the line count.
          scheme: l.scheme,
          isDebt: l.is_debt,
          balanceOrderId: l.balance_order_id,
          paid: Number(l.amount_paid || 0),
          outstanding: Number(l.outstanding || 0),
          lines: [],
          quantity: 0,
          value: 0,
        });
      }
      const order = map.get(key);
      order.lines.push(l);
      order.quantity += Number(l.quantity);
      order.value += Number(l.line_value);
    }
    return [...map.values()];
  }, [all]);

  const commodities = useMemo(() => {
    const map = new Map();
    for (const l of shown) {
      if (!map.has(l.commodity_id)) {
        map.set(l.commodity_id, {
          id: l.commodity_id,
          name: l.commodity_name,
          category: l.category,
          quantity: 0,
          value: 0,
          orders: new Set(),
        });
      }
      const c = map.get(l.commodity_id);
      c.quantity += Number(l.quantity);
      c.value += Number(l.line_value);
      c.orders.add(refOf(l));
    }
    return [...map.values()].sort((a, b) => b.value - a.value);
  }, [shown]);

  // Payments belong to the DISPATCH order. A request-sourced row's own ref is the
  // request id, so matching on that would find nothing — hence balanceOrderId.
  function paymentsFor(h) {
    if (h.balanceOrderId == null) return [];
    return payments.filter((p) => p.dispatch_order_id === h.balanceOrderId);
  }

  function toggle(kind, key) {
    setSelected((cur) =>
      cur && cur.kind === kind && String(cur.key) === String(key) ? null : { kind, key }
    );
  }

  const chosenOrder = selected?.kind === 'order' ? history.find((h) => h.key === selected.key) : null;
  const selectionLabel = !selected
    ? null
    : chosenOrder
      ? (chosenOrder.source === 'request' ? 'Request #' : 'Dispatch #') + chosenOrder.ref
      : commodities.find((c) => String(c.id) === String(selected.key))?.name;

  return (
    <Modal
      title={facility.name}
      subtitle={[facility.lga, facility.state].filter(Boolean).join(', ')}
      onClose={onClose}
    >
      <Banner kind="error" onDismiss={() => setError(null)}>
        {error}
      </Banner>

      <div className="toolbar">
        <Field label="From">
          <input
            type="date"
            value={period.from}
            onChange={(e) => setPeriod({ ...period, from: e.target.value })}
          />
        </Field>
        <Field label="To">
          <input
            type="date"
            value={period.to}
            onChange={(e) => setPeriod({ ...period, to: e.target.value })}
          />
        </Field>
        <button className="btn" onClick={load} disabled={loading}>
          {loading ? 'refreshing...' : 'Refresh'}
        </button>
        {(period.from !== '2020-01-01' || period.to !== today || selected) && (
          <button
            className="btn"
            onClick={() => {
              setPeriod({ from: '2020-01-01', to: today });
              setSelected(null);
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {loading || !lines ? (
        <Empty>loading...</Empty>
      ) : all.length === 0 ? (
        <Empty>Nothing dispatched to this facility in this period.</Empty>
      ) : (
        <>
          {selected && (
            <Banner kind="success" onDismiss={() => setSelected(null)}>
              Showing {selectionLabel} only — dismiss to see the whole period.
            </Banner>
          )}

          <div className="stat-row">
            <div className="stat">
              <div className="label">Value dispatched</div>
              <div className="value">{money(totals.value)}</div>
            </div>
            <div className="stat">
              <div className="label">Quantity</div>
              <div className="value">{qty(totals.quantity)}</div>
            </div>
            <div className="stat">
              <div className="label">Dispatches</div>
              <div className="value">{totals.dispatches}</div>
            </div>
            <div className="stat">
              <div className="label">Commodities</div>
              <div className="value">{totals.commodities}</div>
            </div>
            {/* Owed is not affected by the commodity/order selection above — a balance
                belongs to the order, and narrowing the view does not change the debt. */}
            <div className="stat">
              <div className="label">Paid</div>
              <div className="value">{money(owed.paid)}</div>
            </div>
            <div className="stat">
              <div className="label">Outstanding</div>
              <div className="value">{money(owed.outstanding)}</div>
              <div className="muted">
                {owed.unpaid} unpaid order{owed.unpaid === 1 ? '' : 's'}
              </div>
            </div>
          </div>

          <div className="card">
            <h2>Dispatch history</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Reference</th>
                    <th>When</th>
                    <th>By</th>
                    <th>Scheme</th>
                    <th className="num">Lines</th>
                    <th className="num">Quantity</th>
                    <th className="num">Value</th>
                    <th className="num">Paid</th>
                    <th className="num">Outstanding</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => {
                    const isOpen = selected?.kind === 'order' && selected.key === h.key;
                    return (
                      <Fragment key={h.key}>
                        <tr
                          onClick={() => toggle('order', h.key)}
                          className={isOpen ? 'row-selected' : ''}
                          style={{ cursor: 'pointer' }}
                        >
                          <td>
                            {h.source === 'request' ? 'Request' : 'Dispatch'} #{h.ref}
                          </td>
                          <td>{dateTime(h.at)}</td>
                          <td className="muted">{h.by || '—'}</td>
                          <td>{h.scheme || <span className="muted">—</span>}</td>
                          <td className="num">{h.lines.length}</td>
                          <td className="num">{qty(h.quantity)}</td>
                          <td className="num">{money(h.value)}</td>
                          <td className="num">{h.isDebt ? money(h.paid) : <span className="muted">—</span>}</td>
                          <td className="num">
                            {/* A BHCPF/insurance order is not the facility's to pay, so it
                                is neither outstanding nor "paid" — saying ₦0 outstanding
                                would read as settled. */}
                            {!h.isDebt
                              ? <span className="muted">not billed</span>
                              : h.outstanding > 0
                                ? <strong>{money(h.outstanding)}</strong>
                                : <span className="badge ok">paid</span>}
                          </td>
                          <td>
                            {/* The row is clickable, but a button says so — not everyone
                                will think to try. */}
                            <button
                              className="btn small"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggle('order', h.key);
                              }}
                            >
                              {isOpen ? 'hide' : 'view'}
                            </button>
                          </td>
                        </tr>
                        {/* Payments on this order, shown with its lines — the receipt
                            number is what a facility quotes when it queries a payment,
                            so the dispatch history is where it has to be findable. */}
                        {isOpen && paymentsFor(h).length > 0 && (
                          <tr className="row-child">
                            <td colSpan={10}>
                              <div className="muted" style={{ marginBottom: 4 }}>
                                Payments received on this order
                              </div>
                              <table>
                                <thead>
                                  <tr>
                                    <th>Receipt no.</th>
                                    <th>Paid on</th>
                                    <th className="num">Amount</th>
                                    <th>Recorded by</th>
                                    <th className="wrap">Note</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {paymentsFor(h).map((p) => (
                                    <tr key={p.id}>
                                      <td>
                                        {/* Blank on payments taken before receipts were
                                            captured — never backfilled. */}
                                        {p.receipt_no || <span className="muted">—</span>}
                                      </td>
                                      <td className="muted">{dateTime(p.paid_at)}</td>
                                      <td className="num">{money(p.amount)}</td>
                                      <td>{p.recorded_by || '—'}</td>
                                      <td className="wrap muted">{p.note || ''}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        )}
                        {isOpen &&
                          h.lines.map((l) => (
                            <tr key={h.key + '-' + l.commodity_id} className="row-child">
                              {/* Header is 10 columns: Reference, When, By, Scheme, Lines,
                                  Quantity, Value, Paid, Outstanding, actions. The name
                                  spans the first four; paid/outstanding are order-level
                                  and stay blank on a line. */}
                              <td colSpan={4} className="wrap">
                                {l.commodity_name}
                                <span className="muted"> · {l.category || 'uncategorised'}</span>
                              </td>
                              <td className="num muted">{money(l.unit_price)}</td>
                              <td className="num">{qty(l.quantity)}</td>
                              <td className="num">{money(l.line_value)}</td>
                              <td colSpan={3} />
                            </tr>
                          ))}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Commodities received</h2>
              <button
                className="btn small"
                onClick={() =>
                  downloadCsv(
                    'facility-commodities-' + slug(facility.name) + '-' + stamp() + '.csv',
                    [
                      { header: 'Commodity', value: (c) => c.name },
                      { header: 'Category', value: (c) => c.category || '' },
                      { header: 'Quantity', value: (c) => c.quantity, align: 'right' },
                      { header: 'Value (NGN)', value: (c) => c.value, align: 'right' },
                      { header: 'Dispatches', value: (c) => c.orders.size, align: 'right' },
                    ],
                    commodities
                  )
                }
              >
                &#11015; CSV
              </button>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="wrap">Commodity</th>
                    <th>Category</th>
                    <th className="num">Quantity</th>
                    <th className="num">Value</th>
                    <th className="num">Dispatches</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {commodities.map((c) => (
                    <tr
                      key={c.id}
                      onClick={() => toggle('commodity', c.id)}
                      className={
                        selected?.kind === 'commodity' && String(selected.key) === String(c.id)
                          ? 'row-selected'
                          : ''
                      }
                      style={{ cursor: 'pointer' }}
                    >
                      <td className="wrap">{c.name}</td>
                      <td className="muted">{c.category || '—'}</td>
                      <td className="num">{qty(c.quantity)}</td>
                      <td className="num">{money(c.value)}</td>
                      <td className="num">{c.orders.size}</td>
                      <td>
                        <button
                          className="btn small"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggle('commodity', c.id);
                          }}
                        >
                          {selected?.kind === 'commodity' && String(selected.key) === String(c.id)
                            ? 'clear'
                            : 'view'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}

// What a facility currently holds, read live from EnVo — this is EnVo's record, not the
// warehouse's, so there is nothing to add or remove here.
const STOCK_COLUMNS = [
  { header: 'Commodity', value: (r) => r.name },
  { header: 'Unit', value: (r) => r.unit || '' },
  { header: 'On hand', value: (r) => r.quantityOnHand, align: 'right' },
  { header: 'AMC', value: (r) => r.amc ?? '', align: 'right' },
  { header: 'MOS', value: (r) => r.mos ?? '', align: 'right' },
  { header: 'Status', value: (r) => r.status },
];

// The AMC window as the facility actually has it configured, e.g. "May – Jun 2026" for the
// default quarterly window, or "May, Jul 2026" when a facility has picked its own months.
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatAmcMonths(win) {
  const months = win.monthsUsed || [];
  if (months.length === 0) return `${win.months} month${win.months === 1 ? '' : 's'}`;

  const parts = months.map((ym) => {
    const [y, m] = ym.split('-').map(Number);
    return { label: MONTH_NAMES[m - 1], year: y };
  });
  const sameYear = parts.every((p) => p.year === parts[0].year);

  // Contiguous runs read better as a range than a list.
  const contiguous = months.every((ym, i) => {
    if (i === 0) return true;
    const [py, pm] = months[i - 1].split('-').map(Number);
    const [cy, cm] = ym.split('-').map(Number);
    return cy * 12 + cm === py * 12 + pm + 1;
  });

  if (parts.length === 1) return `${parts[0].label} ${parts[0].year}`;
  if (contiguous && sameYear) {
    return `${parts[0].label} – ${parts[parts.length - 1].label} ${parts[0].year}`;
  }
  if (sameYear) return `${parts.map((p) => p.label).join(', ')} ${parts[0].year}`;
  return parts.map((p) => `${p.label} ${p.year}`).join(', ');
}

const STATUS_BADGE = {
  out: 'expired',
  low: 'soon',
  ok: 'ok',
  over: 'manual',
  unknown: 'inactive',
};

function StockModal({ facility, onClose }) {
  const [stock, setStock] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.facilities
      .stock(facility.id)
      .then(setStock)
      .catch((err) => setError(err.message));
  }, [facility.id]);

  const win = stock?.amcWindow;

  return (
    <Modal
      title="Commodities at this facility"
      subtitle={`${facility.name} · ${stock?.stale ? 'last known figures' : 'live from EnVo'}`}
      onClose={onClose}
    >
      <Banner kind="error">{error}</Banner>

      {stock?.stale && (
        <Banner kind="warn">
          EnVo is unreachable, so these are the last figures we retrieved, from{' '}
          {dateTime(stock.asOf)}. Stock may have moved at the facility since.
        </Banner>
      )}

      {!stock && !error ? (
        <Empty>loading…</Empty>
      ) : (
        stock && (
          <>
            <div className="card-head">
              <p className="muted" style={{ margin: 0 }}>
                {win && (
                  <>
                    AMC over {formatAmcMonths(win)}
                    {win.custom ? ' · facility-set window' : ''}
                  </>
                )}
              </p>
              {stock.items.length > 0 && (
                <button
                  className="btn small"
                  onClick={() =>
                    downloadCsv(
                      `facility-stock-${slug(facility.name)}-${stamp()}.csv`,
                      STOCK_COLUMNS,
                      stock.items
                    )
                  }
                >
                  ⭳ CSV
                </button>
              )}
            </div>

            {stock.items.length === 0 ? (
              <Empty>
                EnVo has no Essential Commodities stock recorded for this facility yet.
              </Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th className="wrap">Commodity</th>
                      <th>Unit</th>
                      <th className="num">On hand</th>
                      <th className="num">AMC</th>
                      <th className="num">MOS</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stock.items.map((item) => (
                      <tr key={item.commodityId}>
                        <td className="wrap">{item.name}</td>
                        <td>{unitLabel(item.unit) || '—'}</td>
                        <td className="num">{qty(item.quantityOnHand)}</td>
                        <td className="num">{item.amc ? qty(item.amc) : <span className="muted">—</span>}</td>
                        <td className="num">
                          {item.mos == null ? <span className="muted">—</span> : item.mos}
                        </td>
                        <td>
                          <span className={`badge ${STATUS_BADGE[item.status] || 'inactive'}`}>
                            {item.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

          </>
        )
      )}
    </Modal>
  );
}
