import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { Banner, Empty, Field, Modal, blockEnterSubmit, dateOnly, dateTime, money, qty, qtyWithUnit } from '../components/ui.jsx';
import DispatchLineEditor from '../components/DispatchLineEditor.jsx';
import { CommodityPicker, FacilityPicker } from '../components/pickers.jsx';
import { ymd } from '../components/PeriodFilter.jsx';
import { downloadCsv, slug, stamp } from '../lib/download.js';
import { printDrfVoucher } from '../lib/drfVoucher.js';

// A dispatch order shaped for the DRF voucher: what was dispatched is what was issued,
// and the "to be completed by" sections stay open (no request/receipt to pre-fill).
function orderAsVoucher(order) {
  return {
    id: order.id,
    facility_name: order.facility_name,
    lga: order.lga,
    state: order.state,
    total_amount: order.total_amount,
    received_by: '',
    received_at: null,
    items: (order.items || []).map((i) => ({
      commodity_name: i.commodity_name,
      unit: i.unit,
      quantity: i.quantity,
      qty_dispatched: i.quantity,
      unit_price: i.unit_price,
      line_total: i.line_total,
    })),
  };
}


// One order as flat rows, shared by the CSV and PDF writers so both stay in step.
const ORDER_COLUMNS = [
  { header: 'Commodity', value: (r) => r.commodity_name },
  { header: 'Unit', value: (r) => r.unit || '' },
  { header: 'Quantity', value: (r) => r.quantity, align: 'right' },
  { header: 'Unit price (NGN)', value: (r) => r.unit_price, align: 'right' },
  { header: 'Line total (NGN)', value: (r) => r.line_total, align: 'right' },
  {
    header: 'Intake batches used',
    value: (r) => r.batches.map((b) => `${b.batchNumber} x${b.quantity} exp ${b.expiryDate}`).join('; '),
  },
];

let lineKey = 0;

export default function DispatchPage({ isAdmin }) {
  const [facilities, setFacilities] = useState([]);
  const [commodities, setCommodities] = useState([]);
  const [facilityId, setFacilityId] = useState('');
  const [lines, setLines] = useState([]);
  const [notes, setNotes] = useState('');
  const [history, setHistory] = useState([]);
  // Empty means the whole log. A date narrows it to that day, which is the same
  // History affordance every other Operations page has.
  const [historyDay, setHistoryDay] = useState('');
  const todayIso = useMemo(() => ymd(new Date()), []);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [viewOrder, setViewOrder] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  // Whether the commodity picker is showing. Open for the first line, then folded away
  // behind "+ Add commodity" after each pick.
  const [picking, setPicking] = useState(true);

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

  // No facility selected means the whole log, not an empty one.
  async function loadHistory() {
    try {
      // A day comes from the shared day endpoint, which is not capped at the most recent
      // 200 orders — otherwise an older date would silently show nothing.
      const rows = historyDay
        ? (await api.monitoring.day({ kind: 'dispatch', date: historyDay })).rows
        : await api.dispatchOrders.list(facilityId ? { facilityId } : undefined);
      setHistory(
        historyDay && facilityId
          ? rows.filter((o) => String(o.facility_id) === String(facilityId))
          : rows
      );
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    loadHistory();
  }, [facilityId, historyDay]);

  const grandTotal = useMemo(
    () =>
      lines.reduce(
        (sum, line) => sum + (Number(line.quantity) || 0) * (Number(line.unitPrice) || 0),
        0
      ),
    [lines]
  );

  const chosenIds = useMemo(
    () => new Set(lines.map((l) => String(l.commodityId)).filter(Boolean)),
    [lines]
  );

  // Clicking a commodity in the picker appends a line, prefilled with its catalogue price.
  // Clicking one that's already on the order is a no-op rather than a duplicate.
  function addLine(commodityId) {
    if (!commodityId || chosenIds.has(String(commodityId))) return;
    const commodity = commodities.find((c) => String(c.id) === String(commodityId));
    setPicking(false);
    setLines((current) => [
      ...current,
      {
        key: (lineKey += 1),
        commodityId: String(commodityId),
        quantity: '',
        unitPrice: commodity?.current_price != null ? String(commodity.current_price) : '',
      },
    ]);
  }

  const filled = lines.filter((l) => l.commodityId && Number(l.quantity) > 0 && l.unitPrice !== '');

  async function submit(event) {
    event.preventDefault();
    if (filled.length === 0) return setError('add at least one complete commodity line');

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
      setLines([]);
      setNotes('');
      setPicking(true);
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
            Send several commodities to a facility in one order. Stock is drawn from the intake batches
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

      <div className="card">
        <FacilityPicker facilities={facilities} value={facilityId} onChange={setFacilityId} />
        <button
          className="btn"
          style={{ marginTop: 10 }}
          onClick={() => Promise.all([loadHistory(), loadReference()])}
        >
          Refresh
        </button>
        {facilityId && (
          <button
            className="btn"
            style={{ marginTop: 10, marginLeft: 8 }}
            onClick={() => setFacilityId('')}
          >
            Clear filters
          </button>
        )}
      </div>

      {!facilityId ? (
        <div className="card">
          <Empty>Pick a facility to build a dispatch order.</Empty>
        </div>
      ) : (
        <>
          {isAdmin ? (
            <form className="card" onSubmit={submit} onKeyDown={blockEnterSubmit}>
              <h2>New dispatch to {facility?.name}</h2>

              {/* The picker shows for the first commodity, then folds away behind
                  "+ Add commodity" so the order itself stays the focus. Already-added
                  commodities are marked so the same one can't go on twice. */}
              {picking && (
                <CommodityPicker
                  commodities={commodities}
                  value=""
                  onChange={addLine}
                  metaOf={(c) =>
                    chosenIds.has(String(c.id))
                      ? 'added'
                      : c.current_price == null
                        ? null
                        : money(c.current_price)
                  }
                />
              )}

              {lines.length === 0 ? (
                !picking && (
                  <Empty>
                    <button className="btn" type="button" onClick={() => setPicking(true)}>
                      + Add commodity
                    </button>
                  </Empty>
                )
              ) : (
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
                          commodity={commodities.find((c) => String(c.id) === String(line.commodityId))}
                          disabled={busy}
                          onChange={(next) =>
                            setLines(lines.map((l, i) => (i === index ? next : l)))
                          }
                          onRemove={() => setLines(lines.filter((_, i) => i !== index))}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {lines.length > 0 && !picking && (
                <button
                  className="btn"
                  type="button"
                  style={{ marginTop: 10 }}
                  onClick={() => setPicking(true)}
                  disabled={busy}
                >
                  + Add commodity
                </button>
              )}

              <div className="total-bar">
                <span className="label">Order total</span>
                <span className="amount">{money(grandTotal)}</span>
              </div>

              <div className="toolbar" style={{ marginTop: 14, marginBottom: 0 }}>
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
                  disabled={busy || filled.length === 0}
                  style={{ marginLeft: 'auto' }}
                >
                  {busy ? 'dispatching…' : `Dispatch ${filled.length} line(s)`}
                </button>
              </div>
            </form>
          ) : (
            <Banner kind="warn">Only admins can create dispatch orders.</Banner>
          )}

        </>
      )}

      {/* Outside the facility gate: the usual question is "what went out", not "what went
          out to this one site". Picking a facility narrows it. */}
      <div className="card">
        <div className="card-head">
          <h2>
            {historyDay ? `Dispatch records for ${historyDay}` : 'Dispatch history'}
            {facility ? ` — ${facility.name}` : ''}
          </h2>
          {/* Kept together on the right, as on every other history card. */}
          <div className="row-actions" style={{ marginLeft: 'auto' }}>
            <button
              className={`btn small ${showDatePicker ? 'primary' : ''}`}
              onClick={() => {
                const next = !showDatePicker;
                setShowDatePicker(next);
                if (!next) setHistoryDay('');
              }}
            >
              History
            </button>
            {showDatePicker && (
              <input
                type="date"
                value={historyDay}
                max={todayIso}
                onChange={(e) => setHistoryDay(e.target.value)}
                style={{ width: 'auto' }}
              />
            )}
            {history.length > 0 && (
              <button
                className="btn small"
                onClick={() =>
                  downloadCsv(
                    `dispatch-history-${slug(facility?.name || 'all-facilities')}-${stamp()}.csv`,
                    [
                      { header: 'Order', value: (o) => `#${o.id}` },
                      { header: 'Facility', value: (o) => o.facility_name || '' },
                      { header: 'LGA', value: (o) => o.lga || '' },
                      { header: 'Dispatched at', value: (o) => o.dispatched_at },
                      { header: 'Dispatched by', value: (o) => o.dispatched_by || '' },
                      { header: 'Lines', value: (o) => o.line_count },
                      { header: 'Total quantity', value: (o) => o.total_quantity },
                      { header: 'Value (NGN)', value: (o) => o.total_amount },
                      { header: 'Notes', value: (o) => o.notes || '' },
                    ],
                    history
                  )
                }
              >
                ⭳ CSV
              </button>
            )}
          </div>
        </div>
        {history.length === 0 ? (
          <Empty>
            {historyDay
              ? 'No dispatch records for this date.'
              : facility
                ? 'Nothing dispatched to this facility yet.'
                : 'Nothing dispatched yet.'}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  {!facility && <th className="wrap">Facility</th>}
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
                    {!facility && (
                      <td className="wrap">
                        {order.facility_name}
                        {order.lga && <div className="muted">{order.lga}</div>}
                      </td>
                    )}
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

      {viewOrder && (
        <OrderDetailModal
          order={viewOrder}
          isAdmin={isAdmin}
          commodities={commodities}
          onClose={() => setViewOrder(null)}
          onSaved={async (updated) => {
            setViewOrder(updated);
            setNotice(`order #${updated.id} corrected — total now ${money(updated.total_amount)}`);
            await Promise.all([loadHistory(), loadReference()]);
          }}
        />
      )}
    </>
  );
}

function OrderDetailModal({ order, onClose, isAdmin, commodities, onSaved }) {
  const base = `dispatch-order-${order.id}-${slug(order.facility_name)}`;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState([]);
  const [draftNotes, setDraftNotes] = useState(order.notes || '');
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState(null);
  const [picking, setPicking] = useState(false);

  function startEdit() {
    setDraft(order.items.map((i) => ({
      key: (lineKey += 1),
      commodityId: String(i.commodity_id),
      quantity: String(Number(i.quantity)),
      unitPrice: String(Number(i.unit_price)),
    })));
    setDraftNotes(order.notes || '');
    setEditError(null);
    setPicking(false);
    setEditing(true);
  }

  const draftIds = new Set(draft.map((l) => String(l.commodityId)));
  const draftTotal = draft.reduce(
    (sum, l) => sum + (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0), 0);

  async function saveEdit(event) {
    event.preventDefault();
    const filled = draft.filter((l) => l.commodityId && Number(l.quantity) > 0 && l.unitPrice !== '');
    if (filled.length === 0) return setEditError('an order needs at least one line');

    setSaving(true);
    setEditError(null);
    try {
      const updated = await api.dispatchOrders.update(order.id, {
        items: filled.map((l) => ({
          commodityId: Number(l.commodityId),
          quantity: Number(l.quantity),
          unitPrice: Number(l.unitPrice),
        })),
        notes: draftNotes || null,
      });
      setEditing(false);
      onSaved?.(updated);
    } catch (err) {
      setEditError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function csv() {
    downloadCsv(`${base}.csv`, ORDER_COLUMNS, order.items);
  }

  return (
    <Modal
      title={`Dispatch order #${order.id}`}
      subtitle={`${order.facility_name} · ${dateTime(order.dispatched_at)}`}
      onClose={onClose}
    >
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <button className="btn small" onClick={csv} disabled={editing}>
          ⭳ CSV
        </button>
        <button className="btn small" onClick={() => printDrfVoucher(orderAsVoucher(order))} disabled={editing}>
          ⎙ DRF Voucher
        </button>
        {isAdmin && !editing && !/^Essential request #/.test(order.notes || '') && (
          <button className="btn small" onClick={startEdit} style={{ marginLeft: 'auto' }}>
            edit
          </button>
        )}
        {/^Essential request #/.test(order.notes || '') && (
          <span className="muted" style={{ marginLeft: 'auto' }}>
            From a facility request — correct via the request or an adjustment
          </span>
        )}
      </div>

      <Banner kind="error" onDismiss={() => setEditError(null)}>
        {editError}
      </Banner>

      {editing ? (
        <form onSubmit={saveEdit} onKeyDown={blockEnterSubmit}>
          <p className="muted">
            Correcting this order returns the original quantities to the lots they came from,
            then draws the new quantities again — stock levels follow the change.
          </p>

          {picking && (
            <CommodityPicker
              commodities={commodities}
              value=""
              onChange={(id) => {
                if (!id || draftIds.has(String(id))) return;
                const c = commodities.find((x) => String(x.id) === String(id));
                setPicking(false);
                setDraft((cur) => [...cur, {
                  key: (lineKey += 1),
                  commodityId: String(id),
                  quantity: '',
                  unitPrice: c?.current_price != null ? String(c.current_price) : '',
                }]);
              }}
              metaOf={(c) => (draftIds.has(String(c.id)) ? 'on order' : c.current_price == null ? null : money(c.current_price))}
            />
          )}

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
                {draft.map((line, index) => (
                  <DispatchLineEditor
                    key={line.key}
                    line={line}
                    commodity={commodities.find((c) => String(c.id) === String(line.commodityId))}
                    disabled={saving}
                    onChange={(next) => setDraft(draft.map((l, i) => (i === index ? next : l)))}
                    onRemove={() => setDraft(draft.filter((_, i) => i !== index))}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {!picking && (
            <button className="btn" type="button" style={{ marginTop: 10 }} onClick={() => setPicking(true)} disabled={saving}>
              + Add commodity
            </button>
          )}

          <div className="total-bar">
            <span className="label">Revised total</span>
            <span className="amount">{money(draftTotal)}</span>
          </div>

          <div className="toolbar" style={{ marginBottom: 0 }}>
            <Field label="Notes">
              <input value={draftNotes} onChange={(e) => setDraftNotes(e.target.value)} placeholder="reason for the correction…" />
            </Field>
            <button className="btn" type="button" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </button>
            <button className="btn primary" type="submit" disabled={saving}>
              {saving ? 'saving…' : 'Save correction'}
            </button>
          </div>
        </form>
      ) : (
        <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="wrap">Commodity</th>
              <th className="num">Qty</th>
              <th className="num">Unit price</th>
              <th className="num">Line total</th>
              <th className="wrap">Intake batches used</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((item) => (
              <tr key={item.id}>
                <td className="wrap">{item.commodity_name}</td>
                <td className="num">
                  {qtyWithUnit(item.quantity, item.unit)}
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

        </>
      )}

      {order.notes && (
        <p className="muted" style={{ marginBottom: 0 }}>
          Notes: {order.notes}
        </p>
      )}
    </Modal>
  );
}
