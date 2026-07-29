import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Banner, Empty, Field, Modal, dateTime, qty } from '../components/ui.jsx';
import BatchTable from '../components/BatchTable.jsx';

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
          <h1>Batches</h1>
          <p>Lot-level stock with expiry dates. Dispatch draws from these oldest-expiry-first.</p>
        </div>
      </div>

      <Banner kind="error" onDismiss={() => setError(null)}>
        {error}
      </Banner>
      <Banner kind="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Banner>

      <div className="toolbar">
        <Field label="Commodity">
          <select value={commodityId} onChange={(e) => setCommodityId(e.target.value)} style={{ minWidth: 280 }}>
            <option value="">select a commodity…</option>
            {commodities.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.category ? ` · ${c.category}` : ''}
              </option>
            ))}
          </select>
        </Field>
        <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={includeDepleted}
            onChange={(e) => setIncludeDepleted(e.target.checked)}
            style={{ width: 'auto' }}
          />
          show depleted batches
        </label>
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
              <h2>Receive a batch</h2>
              <div className="form-grid">
                <Field label="Batch / lot number *">
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
            <h2>{selected?.name} — batches</h2>
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
                <Field label="Batch">
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
    </>
  );
}

function AdjustModal({ batch, onClose, onSaved, onError }) {
  const [delta, setDelta] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      await api.batches.adjust(batch.id, { delta: Number(delta), note });
      onSaved(`adjusted batch ${batch.batch_number} by ${delta}`);
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Adjust batch" subtitle={batch.batch_number} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Change in quantity *">
            <input
              type="number"
              step="0.01"
              value={delta}
              onChange={(e) => setDelta(e.target.value)}
              placeholder="-5 or 12"
              required
              autoFocus
            />
          </Field>
          <Field label="Reason *">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="damaged in store, recount…"
              required
            />
          </Field>
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'saving…' : 'Apply adjustment'}
          </button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Currently {qty(batch.quantity_remaining)} remaining. Negative values reduce stock; the
          balance cannot go below zero.
        </p>
      </form>
    </Modal>
  );
}
