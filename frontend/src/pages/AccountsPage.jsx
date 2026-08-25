import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Banner, Empty, Field, dateOnly, dateTime, money } from '../components/ui.jsx';
import { downloadCsv, stamp } from '../lib/download.js';

// What facilities owe the central store, as two lists of ORDERS: unpaid and paid.
//
// Order-level rather than facility-level because payment happens against an order —
// that is the grain the work is actually done at. The summary strip still shows the
// facility-wide totals.
//
// Only orders issued under a scheme that bills the facility (the DRF) appear. A BHCPF
// or insurance issue is settled by someone else, so it is neither owed nor "paid off";
// listing it either way would misstate what facilities owe.
//
// Every instalment is kept, so a cleared order can show HOW it was paid rather than
// just that it was.

const DEBTOR_COLUMNS = [
  { header: 'Facility', value: (r) => r.facility_name },
  { header: 'Unpaid orders', value: (r) => r.unpaid_orders, align: 'right' },
  { header: 'Billed', value: (r) => r.billed, align: 'right' },
  { header: 'Paid', value: (r) => r.paid, align: 'right' },
  { header: 'Outstanding', value: (r) => r.outstanding, align: 'right' },
];

const UNPAID_COLUMNS = [
  { header: 'Order', value: (r) => `#${r.id}` },
  { header: 'Facility', value: (r) => r.facility_name },
  { header: 'Dispatched', value: (r) => (r.dispatched_at || '').slice(0, 10) },
  { header: 'Total', value: (r) => r.total_amount, align: 'right' },
  { header: 'Paid', value: (r) => r.amount_paid, align: 'right' },
  { header: 'Outstanding', value: (r) => r.outstanding, align: 'right' },
  { header: 'Instalments', value: (r) => r.instalments, align: 'right' },
];

const PAID_COLUMNS = [
  { header: 'Order', value: (r) => `#${r.id}` },
  { header: 'Facility', value: (r) => r.facility_name },
  { header: 'Dispatched', value: (r) => (r.dispatched_at || '').slice(0, 10) },
  { header: 'Cleared', value: (r) => (r.cleared_at || '').slice(0, 10) },
  { header: 'Instalments', value: (r) => r.instalments, align: 'right' },
  { header: 'Amount', value: (r) => r.amount_paid, align: 'right' },
];

export default function AccountsPage() {
  // 'facility' rolls the same data up per facility — one row per facility with its
  // totals across every order. The other two views are per ORDER, which is the grain a
  // payment is actually made at.
  const [view, setView] = useState('unpaid');      // 'unpaid' | 'paid' | 'facility'
  const [unpaid, setUnpaid] = useState([]);
  const [paid, setPaid] = useState([]);
  const [debtors, setDebtors] = useState([]);
  // Set by clicking a facility in the debtors view; narrows the two order lists to it.
  const [facilityFilter, setFacilityFilter] = useState(null);   // { id, name }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  // orderId -> instalment rows, fetched on demand and cached.
  const [instalments, setInstalments] = useState({});
  const [openOrder, setOpenOrder] = useState(null);

  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [recordedBy, setRecordedBy] = useState(
    () => localStorage.getItem('wms_payment_recorded_by') || ''
  );
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const fid = facilityFilter?.id;
      const [u, p, d] = await Promise.all([
        api.accounts.outstanding(fid),
        api.accounts.settled(fid),
        api.accounts.debtors(),        // always unfiltered — it IS the facility overview
      ]);
      setUnpaid(u);
      setPaid(p);
      setDebtors(d);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [facilityFilter]);

  // One entry point for the panel: fetches the history the first time, and clears any
  // half-typed amount so it can't be carried onto a different order.
  async function togglePanel(orderId) {
    setAmount(''); setNote('');   // recordedBy is deliberately kept — same officer, next order
    await toggleInstalments(orderId);
  }

  async function toggleInstalments(orderId) {
    if (openOrder === orderId) { setOpenOrder(null); return; }
    try {
      if (!instalments[orderId]) {
        const rows = await api.accounts.orderPayments(orderId);
        setInstalments((m) => ({ ...m, [orderId]: rows }));
      }
      setOpenOrder(orderId);
    } catch (err) { setError(err.message); }
  }

  async function submitPayment(order) {
    const value = Number(amount);
    if (!Number.isFinite(value) || value === 0) return setError('enter an amount');
    setBusy(true);
    try {
      const b = await api.accounts.recordPayment(order.id, {
        amount: value, note: note || null, recordedBy: recordedBy.trim(),
      });
      // Remembered locally so the same officer isn't retyping their name on every
      // instalment; it is still a typed value, not the login account.
      localStorage.setItem('wms_payment_recorded_by', recordedBy.trim());
      setAmount(''); setNote('');
      const cleared = Number(b.outstanding) === 0;
      // The panel stays open on a part-payment, so REFETCH the history rather than just
      // dropping the cache — an emptied cache would leave the open panel reading "none
      // recorded" straight after a payment was accepted.
      const fresh = await api.accounts.orderPayments(order.id);
      setInstalments((m) => ({ ...m, [order.id]: fresh }));
      // A cleared order leaves the Unpaid list entirely, so its panel has nowhere to be.
      if (cleared) setOpenOrder(null);
      setNotice(
        cleared
          ? `Order #${order.id} is fully paid — moved to Paid orders.`
          : `Recorded ${money(value)} — ${money(b.outstanding)} still outstanding on order #${order.id}.`
      );
      load();
    } catch (err) {
      setError(err.message);
    } finally { setBusy(false); }
  }

  const totalOwed = unpaid.reduce((s, r) => s + Number(r.outstanding || 0), 0);
  const totalPaid = paid.reduce((s, r) => s + Number(r.amount_paid || 0), 0);
  const owingFacilities = new Set(unpaid.map((r) => r.facility_id)).size;

  const rows = view === 'unpaid' ? unpaid : view === 'paid' ? paid : debtors;

  function openFacility(d) {
    setFacilityFilter({ id: d.facility_id, name: d.facility_name });
    setView('unpaid');
    setOpenOrder(null);
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Accounts</h1>
          <p className="muted">
            Money owed to the store, per dispatch order. Only DRF issues are billed — BHCPF and
            insurance issues are settled elsewhere and never appear here.
          </p>
        </div>
      </div>

      {error && <Banner onDismiss={() => setError(null)}>{error}</Banner>}
      {notice && <Banner kind="success" onDismiss={() => setNotice(null)}>{notice}</Banner>}

      <div className="card">
        <div className="toolbar">
          <div>
            <div className="muted">Outstanding</div>
            <div className="amount" style={{ fontSize: 22 }}>{money(totalOwed)}</div>
            <div className="muted">
              {unpaid.length} order{unpaid.length === 1 ? '' : 's'} · {owingFacilities} facilit
              {owingFacilities === 1 ? 'y' : 'ies'}
            </div>
          </div>
          <div style={{ marginLeft: 24 }}>
            <div className="muted">Settled</div>
            <div className="amount" style={{ fontSize: 22 }}>{money(totalPaid)}</div>
            <div className="muted">{paid.length} order{paid.length === 1 ? '' : 's'} paid off</div>
          </div>
          <Field label="Show">
            <select
              value={view}
              onChange={(e) => { setView(e.target.value); setOpenOrder(null); }}
            >
              <option value="unpaid">Unpaid orders ({unpaid.length})</option>
              <option value="paid">Paid orders ({paid.length})</option>
              <option value="facility">By facility ({debtors.length} owing)</option>
            </select>
          </Field>
          <button className="btn small" style={{ marginLeft: 'auto' }} onClick={load} disabled={loading}>
            refresh
          </button>
          <button
            className="btn small"
            disabled={!rows.length}
            onClick={() =>
              downloadCsv(
                `${view === 'facility' ? 'debtors' : `${view}-orders`}-${stamp()}.csv`,
                view === 'unpaid' ? UNPAID_COLUMNS : view === 'paid' ? PAID_COLUMNS : DEBTOR_COLUMNS,
                rows
              )
            }
          >
            ⭳ CSV
          </button>
        </div>


        {facilityFilter && view !== 'facility' && (
          <div className="muted" style={{ marginBottom: 8 }}>
            Showing <strong>{facilityFilter.name}</strong> only.{' '}
            <button className="btn small" onClick={() => setFacilityFilter(null)}>
              show all facilities
            </button>
          </div>
        )}

        {loading ? (
          <Empty>loading…</Empty>
        ) : rows.length === 0 ? (
          <Empty>
            {view === 'facility'
              ? 'No facility owes anything.'
              : view === 'unpaid'
                ? 'Nothing outstanding — every billed order is settled.'
                : 'No orders have been paid off yet.'}
          </Empty>
        ) : view === 'facility' ? (
          // Per-facility rollup: one row per facility, totals across all its orders.
          // A separate table rather than columns toggled inside the orders table —
          // the two share no columns beyond the facility name.
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="wrap">Facility</th>
                  <th className="num">Unpaid orders</th>
                  <th className="num">Billed</th>
                  <th className="num">Paid</th>
                  <th className="num">Outstanding</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {debtors.map((d) => (
                  <tr key={d.facility_id}>
                    <td className="wrap">{d.facility_name}</td>
                    <td className="num">{d.unpaid_orders}</td>
                    <td className="num">{money(d.billed)}</td>
                    <td className="num">{money(d.paid)}</td>
                    <td className="num"><strong>{money(d.outstanding)}</strong></td>
                    <td>
                      <button className="btn small" onClick={() => openFacility(d)}>
                        view orders
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th className="wrap">Facility</th>
                  <th>Dispatched</th>
                  {view === 'paid' && <th>Cleared</th>}
                  <th className="num">Total</th>
                  <th className="num">Paid</th>
                  {view === 'unpaid' && <th className="num">Outstanding</th>}
                  <th className="num">Instalments</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => {
                  const open = openOrder === o.id;
                  const colSpan = view === 'paid' ? 8 : 8;
                  return [
                    <tr key={o.id}>
                      <td>#{o.id}</td>
                      <td className="wrap">{o.facility_name}</td>
                      <td className="muted">{dateOnly(o.dispatched_at)}</td>
                      {view === 'paid' && <td className="muted">{dateOnly(o.cleared_at)}</td>}
                      <td className="num">{money(o.total_amount)}</td>
                      <td className="num">{money(o.amount_paid)}</td>
                      {view === 'unpaid' && (
                        <td className="num"><strong>{money(o.outstanding)}</strong></td>
                      )}
                      <td className="num">
                        {o.instalments > 0 ? o.instalments : <span className="muted">0</span>}
                      </td>
                      <td>
                        {/* ONE action per order. It opens a panel holding both the
                            payment history and the form to add to it, so viewing and
                            recording are not two competing buttons. A settled order has
                            nothing left to record — the server refuses a payment against
                            a zero balance — so its label says view only. */}
                        <button className="btn small" onClick={() => togglePanel(o.id)}>
                          {open
                            ? 'close'
                            : view === 'paid'
                              ? 'View payments'
                              : 'View / Record payment'}
                        </button>
                      </td>
                    </tr>,
                    open && (
                      <tr key={`i-${o.id}`}>
                        <td colSpan={colSpan}>
                          {view === 'unpaid' && (
                            <div className="form-grid" style={{ marginBottom: 12 }}>
                              <Field label="Amount received">
                                <input
                                  type="number" step="0.01" autoFocus
                                  value={amount}
                                  onChange={(e) => setAmount(e.target.value)}
                                  placeholder={String(o.outstanding)}
                                />
                              </Field>
                              <Field label="Recorded by *">
                                <input
                                  value={recordedBy}
                                  onChange={(e) => setRecordedBy(e.target.value)}
                                  placeholder="who received the payment"
                                />
                              </Field>
                              <Field label="Note (optional)">
                                <input value={note} onChange={(e) => setNote(e.target.value)} />
                              </Field>
                              <button
                                className="btn primary"
                                disabled={busy || !recordedBy.trim()}
                                onClick={() => submitPayment(o)}
                              >
                                {busy ? 'saving…' : `Record payment`}
                              </button>
                              <div className="muted">
                                {money(o.outstanding)} outstanding on order #{o.id}
                              </div>
                            </div>
                          )}
                          <div className="muted" style={{ marginBottom: 4 }}>
                            Order #{o.id} · issued under {o.scheme} · dispatched{' '}
                            {dateOnly(o.dispatched_at)} by {o.dispatched_by || '—'}
                            {o.notes ? ` · ${o.notes}` : ''}
                          </div>
                          <div className="muted" style={{ marginBottom: 4 }}>
                            Instalments paid on order #{o.id}
                          </div>
                          {(instalments[o.id] || []).length === 0 ? (
                            <Empty>none recorded</Empty>
                          ) : (
                            <table>
                              <thead>
                                <tr>
                                  <th>When</th>
                                  <th className="num">Amount</th>
                                  <th className="num">Running total</th>
                                  <th>Recorded by</th>
                                  <th className="wrap">Note</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(() => {
                                  // Running total makes a part-payment history readable:
                                  // it shows how the balance was worked down, not just a
                                  // column of unrelated amounts.
                                  let running = 0;
                                  return instalments[o.id].map((p) => {
                                    running += Number(p.amount);
                                    return (
                                      <tr key={p.id}>
                                        <td className="muted">{dateTime(p.paid_at)}</td>
                                        <td className="num">{money(p.amount)}</td>
                                        <td className="num muted">{money(running)}</td>
                                        <td>{p.recorded_by || '—'}</td>
                                        <td className="wrap">{p.note || ''}</td>
                                      </tr>
                                    );
                                  });
                                })()}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="muted">
        A payment adds to what has already been received on the order until it clears, at which
        point the order moves to Paid orders. To undo an entry made in error, record the same
        amount as a negative — nothing is deleted, so the correction stays visible.
      </p>
    </section>
  );
}
