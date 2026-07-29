import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { Banner, Empty, Field, Modal, dateOnly, dateTime, money, qty } from '../components/ui.jsx';
import DispatchLineEditor from '../components/DispatchLineEditor.jsx';

let lineKey = 0;
const newLine = () => ({ key: (lineKey += 1), commodityId: '', quantity: '', unitPrice: '' });

export default function DispatchPage({ isAdmin }) {
  const [facilities, setFacilities] = useState([]);
  const [commodities, setCommodities] = useState([]);
  const [facilityId, setFacilityId] = useState('');
  const [lines, setLines] = useState([newLine()]);
  const [notes, setNotes] = useState('');
  const [history, setHistory] = useState([]);
  const [viewOrder, setViewOrder] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  async function loadReference() {
    try {
      const [facilityList, commodityList] = await Promise.all([
        api.facilities.list(),
        api.commodities.list(),
      ]);
      setFacilities(facilityList);
      setCommodities(commodityList);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    loadReference();
  }, []);

  async function loadHistory() {
    if (!facilityId) {
      setHistory([]);
      return;
    }
    try {
      setHistory(await api.facilities.dispatchOrders(facilityId));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    loadHistory();
  }, [facilityId]);

  const grandTotal = useMemo(
    () =>
      lines.reduce(
        (sum, line) => sum + (Number(line.quantity) || 0) * (Number(line.unitPrice) || 0),
        0
      ),
    [lines]
  );

  const filled = lines.filter((l) => l.commodityId && Number(l.quantity) > 0 && l.unitPrice !== '');
  const duplicate = new Set(filled.map((l) => l.commodityId)).size !== filled.length;

  async function submit(event) {
    event.preventDefault();
    if (filled.length === 0) return setError('add at least one complete commodity line');
    if (duplicate) return setError('each commodity may only appear once per order');

    setBusy(true);
    setError(null);
    try {
      const order = await api.facilities.createDispatchOrder(facilityId, {
        items: filled.map((l) => ({
          commodityId: Number(l.commodityId),
          quantity: Number(l.quantity),
          unitPrice: Number(l.unitPrice),
        })),
        notes: notes || null,
      });
      setNotice(
        `dispatched ${order.items.length} line(s) totalling ${money(order.total_amount)} — order #${order.id}`
      );
      setLines([newLine()]);
      setNotes('');
      setViewOrder(order);
      await Promise.all([loadHistory(), loadReference()]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const facility = facilities.find((f) => String(f.id) === String(facilityId));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dispatch</h1>
          <p>
            Send several commodities to a facility in one order. Stock is drawn from the batches
            closest to expiry first.
          </p>
        </div>
      </div>

      <Banner kind="error" onDismiss={() => setError(null)}>
        {error}
      </Banner>
      <Banner kind="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Banner>

      <div className="toolbar">
        <Field label="Facility">
          <select value={facilityId} onChange={(e) => setFacilityId(e.target.value)} style={{ minWidth: 300 }}>
            <option value="">select a facility…</option>
            {facilities.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} · {f.state}
                {f.lga ? ` / ${f.lga}` : ''}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {!facilityId ? (
        <div className="card">
          <Empty>Pick a facility to build a dispatch order.</Empty>
        </div>
      ) : (
        <>
          {isAdmin ? (
            <form className="card" onSubmit={submit}>
              <h2>New dispatch to {facility?.name}</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th className="wrap">Commodity</th>
                      <th className="num">On hand</th>
                      <th>Quantity</th>
                      <th>Unit price (₦)</th>
                      <th className="num">Line total</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, index) => (
                      <DispatchLineEditor
                        key={line.key}
                        line={line}
                        commodities={commodities}
                        disabled={busy}
                        onChange={(next) =>
                          setLines(lines.map((l, i) => (i === index ? next : l)))
                        }
                        onRemove={() =>
                          setLines(lines.length === 1 ? [newLine()] : lines.filter((_, i) => i !== index))
                        }
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="total-bar">
                <span className="label">Order total</span>
                <span className="amount">{money(grandTotal)}</span>
              </div>

              <div className="toolbar" style={{ marginTop: 14, marginBottom: 0 }}>
                <button className="btn" type="button" onClick={() => setLines([...lines, newLine()])} disabled={busy}>
                  + Add line
                </button>
                <Field label="Notes (optional)">
                  <input
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="waybill reference, driver…"
                  />
                </Field>
                <button
                  className="btn primary"
                  type="submit"
                  disabled={busy || filled.length === 0 || duplicate}
                  style={{ marginLeft: 'auto' }}
                >
                  {busy ? 'dispatching…' : `Dispatch ${filled.length} line(s)`}
                </button>
              </div>
              {duplicate && (
                <p style={{ color: 'var(--danger)', marginBottom: 0 }}>
                  The same commodity appears on more than one line.
                </p>
              )}
            </form>
          ) : (
            <Banner kind="warn">Only admins can create dispatch orders.</Banner>
          )}

          <div className="card">
            <h2>Dispatch history — {facility?.name}</h2>
            {history.length === 0 ? (
              <Empty>Nothing dispatched to this facility yet.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>When</th>
                      <th>By</th>
                      <th className="num">Lines</th>
                      <th className="num">Total qty</th>
                      <th className="num">Value</th>
                      <th className="wrap">Notes</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((order) => (
                      <tr key={order.id}>
                        <td>#{order.id}</td>
                        <td>{dateTime(order.dispatched_at)}</td>
                        <td className="muted">{order.dispatched_by || '—'}</td>
                        <td className="num">{order.line_count}</td>
                        <td className="num">{qty(order.total_quantity)}</td>
                        <td className="num">{money(order.total_amount)}</td>
                        <td className="wrap">{order.notes || '—'}</td>
                        <td>
                          <button
                            className="btn small"
                            onClick={async () => {
                              try {
                                setViewOrder(await api.dispatchOrders.get(order.id));
                              } catch (err) {
                                setError(err.message);
                              }
                            }}
                          >
                            view
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {viewOrder && <OrderDetailModal order={viewOrder} onClose={() => setViewOrder(null)} />}
    </>
  );
}

function OrderDetailModal({ order, onClose }) {
  return (
    <Modal
      title={`Dispatch order #${order.id}`}
      subtitle={`${order.facility_name} · ${dateTime(order.dispatched_at)}`}
      onClose={onClose}
    >
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="wrap">Commodity</th>
              <th className="num">Qty</th>
              <th className="num">Unit price</th>
              <th className="num">Line total</th>
              <th className="wrap">Batches used</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((item) => (
              <tr key={item.id}>
                <td className="wrap">{item.commodity_name}</td>
                <td className="num">
                  {qty(item.quantity)} {item.unit || ''}
                </td>
                <td className="num">{money(item.unit_price)}</td>
                <td className="num">{money(item.line_total)}</td>
                <td className="wrap">
                  {item.batches.length === 0 ? (
                    <span className="muted">—</span>
                  ) : (
                    item.batches.map((b) => (
                      <div key={b.batchId}>
                        {b.batchNumber} — {qty(b.quantity)}{' '}
                        <span className="muted">exp {dateOnly(b.expiryDate)}</span>
                      </div>
                    ))
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="total-bar">
        <span className="label">Order total</span>
        <span className="amount">{money(order.total_amount)}</span>
      </div>

      {order.notes && (
        <p className="muted" style={{ marginBottom: 0 }}>
          Notes: {order.notes}
        </p>
      )}
    </Modal>
  );
}
