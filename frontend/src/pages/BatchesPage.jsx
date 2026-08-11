import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Banner, Empty, Field, Modal, dateOnly, dateTime, qty, qtyWithUnit } from '../components/ui.jsx';
import DayHistory from '../components/DayHistory.jsx';
import BatchTable from '../components/BatchTable.jsx';
import { CommodityPicker } from '../components/pickers.jsx';
import { reasonLabel } from '../lib/adjustments.js';
import { downloadCsv, slug, stamp } from '../lib/download.js';


// The day's receipts, shown the same way as every other Operations history.
const RECEIPT_COLUMNS = [
  { header: 'Time', value: (r) => dateTime(r.created_at), muted: true },
  { header: 'Commodity', value: (r) => r.commodity_name, wrap: true },
  { header: 'Intake batch no.', value: (r) => r.batch_number || '' },
  { header: 'Expiry', value: (r) => dateOnly(r.expiry_date), muted: true },
  { header: 'Quantity', value: (r) => qtyWithUnit(r.quantity, r.unit), align: 'right' },
  { header: 'Vendor', value: (r) => r.vendor_name || '', muted: true },
  { header: 'Note', value: (r) => r.note || '', wrap: true, muted: true },
  { header: 'Received by', value: (r) => r.created_by || '', muted: true },
];

const BLANK_RECEIPT = {
  batchNumber: '',
  expiryDate: '',
  quantity: '',
  unitCost: '',
  vendorId: '',
  receivedDate: '',
};

export default function BatchesPage({ isAdmin }) {
  const [commodities, setCommodities] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [commodityId, setCommodityId] = useState('');
  const [batches, setBatches] = useState([]);
  const [includeDepleted, setIncludeDepleted] = useState(false);
  const [receipt, setReceipt] = useState(BLANK_RECEIPT);
  const [adjustTarget, setAdjustTarget] = useState(null);
  const [movementsFor, setMovementsFor] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [list, vendorList] = await Promise.all([api.commodities.list(), api.vendors.list()]);
        setCommodities(list);
        setVendors(vendorList);
      } catch (err) {
        setError(err.message);
      }
    })();
  }, []);

  async function loadBatches() {
    if (!commodityId) {
      setBatches([]);
      return;
    }
    try {
      setBatches(await api.commodities.batches(commodityId, { includeDepleted }));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    loadBatches();
  }, [commodityId, includeDepleted]);

  const selected = commodities.find((c) => String(c.id) === String(commodityId));

  async function submitReceipt(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.batches.receive({
        commodityId: Number(commodityId),
        batchNumber: receipt.batchNumber,
        expiryDate: receipt.expiryDate,
        quantity: Number(receipt.quantity),
        unitCost: receipt.unitCost === '' ? null : Number(receipt.unitCost),
        vendorId: receipt.vendorId === '' ? null : Number(receipt.vendorId),
        receivedDate: receipt.receivedDate || null,
      });
      setNotice(`received batch ${receipt.batchNumber}`);
      setReceipt(BLANK_RECEIPT);
      await loadBatches();
      setCommodities(await api.commodities.list());
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Intake Batches</h1>
          <p>Intake batches: lot-level stock with expiry dates. Dispatch draws from these oldest-expiry-first.</p>
        </div>
      </div>

      <Banner kind="error" onDismiss={() => setError(null)}>
        {error}
      </Banner>
      <Banner kind="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Banner>

      <div className="card">
        <CommodityPicker commodities={commodities} value={commodityId} onChange={setCommodityId} />
        <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 10 }}>
          <input
            type="checkbox"
            checked={includeDepleted}
            onChange={(e) => setIncludeDepleted(e.target.checked)}
            style={{ width: 'auto' }}
          />
          show depleted batches
        </label>
        <button
          className="btn"
          style={{ marginTop: 10 }}
          onClick={async () => {
            setCommodities(await api.commodities.list());
            await loadBatches();
          }}
        >
          Refresh
        </button>
        {(commodityId || includeDepleted) && (
          <button
            className="btn"
            style={{ marginTop: 10 }}
            onClick={() => {
              setCommodityId('');
              setIncludeDepleted(false);
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {!commodityId ? (
        <div className="card">
          <Empty>Pick a commodity to see and receive its batches.</Empty>
        </div>
      ) : (
        <>
          <div className="stat-row">
            <div className="stat">
              <div className="label">On hand (usable)</div>
              <div className="value">{qty(selected?.on_hand)}</div>
            </div>
            <div className="stat">
              <div className="label">Active batches</div>
              <div className="value">{batches.filter((b) => Number(b.quantity_remaining) > 0).length}</div>
            </div>
            <div className="stat">
              <div className="label">Unit</div>
              <div className="value" style={{ fontSize: 16 }}>
                {selected?.unit || '—'}
              </div>
            </div>
          </div>

          {isAdmin && (
            <form className="card" onSubmit={submitReceipt}>
              <h2>Receive an intake batch</h2>
              <div className="form-grid">
                <Field label="Intake batch number *">
                  <input
                    value={receipt.batchNumber}
                    onChange={(e) => setReceipt({ ...receipt, batchNumber: e.target.value })}
                    required
                  />
                </Field>
                <Field label="Expiry date *">
                  <input
                    type="date"
                    value={receipt.expiryDate}
                    onChange={(e) => setReceipt({ ...receipt, expiryDate: e.target.value })}
                    required
                  />
                </Field>
                <Field label="Quantity *">
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={receipt.quantity}
                    onChange={(e) => setReceipt({ ...receipt, quantity: e.target.value })}
                    required
                  />
                </Field>
                <Field label="Unit cost (₦)">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={receipt.unitCost}
                    onChange={(e) => setReceipt({ ...receipt, unitCost: e.target.value })}
                  />
                </Field>
                <Field label="Vendor">
                  <select
                    value={receipt.vendorId}
                    onChange={(e) => setReceipt({ ...receipt, vendorId: e.target.value })}
                  >
                    <option value="">unknown</option>
                    {vendors.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Received date">
                  <input
                    type="date"
                    value={receipt.receivedDate}
                    onChange={(e) => setReceipt({ ...receipt, receivedDate: e.target.value })}
                  />
                </Field>
                <button className="btn primary" type="submit" disabled={busy}>
                  {busy ? 'saving…' : 'Receive batch'}
                </button>
              </div>
            </form>
          )}

          <div className="card">
            <div className="card-head">
              <h2>{selected?.name} — intake batches</h2>
              {batches.length > 0 && (
                <button
                  className="btn small"
                  onClick={() =>
                    downloadCsv(
                      `batches-${slug(selected?.name)}-${stamp()}.csv`,
                      [
                        { header: 'Intake batch no.', value: (b) => b.batch_number },
                        { header: 'Expiry', value: (b) => b.expiry_date },
                        { header: 'Days to expiry', value: (b) => b.days_to_expiry, align: 'right' },
                        { header: 'Received', value: (b) => b.received_date },
                        { header: 'Qty received', value: (b) => b.quantity_received, align: 'right' },
                        { header: 'Qty remaining', value: (b) => b.quantity_remaining, align: 'right' },
                        { header: 'Unit cost (NGN)', value: (b) => b.unit_cost ?? '', align: 'right' },
                        { header: 'Vendor', value: (b) => b.vendor_name || '' },
                      ],
                      batches
                    )
                  }
                >
                  ⭳ CSV
                </button>
              )}
            </div>
            <BatchTable batches={batches} onAdjust={isAdmin ? setAdjustTarget : null} />
            {batches.length > 0 && (
              <p className="muted" style={{ marginBottom: 0 }}>
                Adjustments are for corrections only — routine outbound stock leaves through a
                dispatch order.
              </p>
            )}
          </div>

          {batches.length > 0 && (
            <div className="card">
              <h2>Movement ledger</h2>
              <div className="toolbar">
                <Field label="Intake batch">
                  <select
                    value={movementsFor?.batchId || ''}
                    onChange={async (e) => {
                      const id = e.target.value;
                      if (!id) return setMovementsFor(null);
                      try {
                        setMovementsFor({ batchId: id, rows: await api.batches.movements(id) });
                      } catch (err) {
                        setError(err.message);
                      }
                    }}
                    style={{ minWidth: 220 }}
                  >
                    <option value="">select a batch…</option>
                    {batches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.batch_number}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              {movementsFor?.rows?.length ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Type</th>
                        <th className="num">Qty</th>
                        <th>Facility</th>
                        <th>Order line</th>
                        <th>Reason</th>
                        <th className="wrap">Note</th>
                        <th>By</th>
                      </tr>
                    </thead>
                    <tbody>
                      {movementsFor.rows.map((m) => (
                        <tr key={m.id}>
                          <td>{dateTime(m.created_at)}</td>
                          <td>{m.movement_type}</td>
                          <td className="num">{qty(m.quantity)}</td>
                          <td>{m.facility_name || '—'}</td>
                          <td className="muted">{m.dispatch_order_item_id ?? '—'}</td>
                          <td>{reasonLabel(m.reason) || <span className="muted">—</span>}</td>
                          <td className="wrap">{m.note || '—'}</td>
                          <td className="muted">{m.created_by || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty>Pick a batch to see every receipt, dispatch and adjustment against it.</Empty>
              )}
            </div>
          )}
        </>
      )}

      {adjustTarget && (
        <AdjustModal
          batch={adjustTarget}
          onClose={() => setAdjustTarget(null)}
          onError={setError}
          onSaved={async (message) => {
            setNotice(message);
            setAdjustTarget(null);
            await loadBatches();
            setCommodities(await api.commodities.list());
          }}
        />
      )}

      <DayHistory kind="receipt" noun="Receipt" columns={RECEIPT_COLUMNS} />
    </>
  );
}

// The reason carries the direction, so the quantity box takes a plain positive number for
// everything except a recount — nobody has to reason about whether a loss is "-5" or "5",
// which is where the old free-text version went wrong.
function AdjustModal({ batch, onClose, onSaved, onError }) {
  const [reasons, setReasons] = useState([]);
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.batches.adjustmentReasons().then(setReasons).catch((err) => onError(err.message));
  }, []);

  const rule = reasons.find((r) => r.code === reason);
  const signed = !rule || !amount ? null : rule.direction === 0 ? Number(amount) : Math.abs(Number(amount)) * rule.direction;
  const after = signed == null ? null : Number(batch.quantity_remaining) + signed;

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      await api.batches.adjust(batch.id, { quantity: Number(amount), reason, note });
      onSaved(`${rule.label.toLowerCase()}: ${qty(Math.abs(signed))} on ${batch.batch_number || 'unlabelled batch'}`);
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Adjust intake batch" subtitle={batch.batch_number || 'no batch number'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Reason *">
            <select value={reason} onChange={(e) => setReason(e.target.value)} required autoFocus>
              <option value="">choose a reason…</option>
              {reasons.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label={rule?.direction === 0 ? 'Change in quantity *' : 'Quantity *'}>
            <input
              type="number"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={rule?.direction === 0 ? '-5 or 12' : 'how many'}
              required
              disabled={!reason}
            />
          </Field>
          <Field label="Note">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="optional detail"
            />
          </Field>
          <button className="btn primary" type="submit" disabled={busy || !reason || !amount}>
            {busy ? 'saving…' : 'Apply adjustment'}
          </button>
        </div>

        <p className="muted" style={{ marginBottom: 0 }}>
          {rule?.direction === 0
            ? 'A recount can go either way — enter a negative number to reduce stock.'
            : rule
              ? `${rule.label} ${rule.direction < 0 ? 'takes stock off' : 'puts stock back on'} this batch.`
              : 'Pick what happened to the stock.'}{' '}
          Currently {qty(batch.quantity_remaining)} remaining
          {after != null && Number.isFinite(after) && (
            <>
              {' → '}
              <strong style={{ color: after < 0 ? 'var(--danger)' : 'inherit' }}>{qty(after)}</strong>
              {after < 0 && ' — the balance cannot go below zero'}
            </>
          )}
          .
        </p>
      </form>
    </Modal>
  );
}
