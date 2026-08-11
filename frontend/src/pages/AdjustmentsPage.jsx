import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Banner, dateOnly, dateTime, qty, qtyWithUnit } from '../components/ui.jsx';
import DayHistory from '../components/DayHistory.jsx';
import { CommodityPicker } from '../components/pickers.jsx';
import { reasonLabel } from '../lib/adjustments.js';

const COLUMNS = [
  { header: 'Date', value: (r) => dateTime(r.created_at), muted: true },
  { header: 'Commodity', value: (r) => r.commodity_name, wrap: true },
  { header: 'Type', value: (r) => (Number(r.quantity) < 0 ? 'Decrease' : 'Increase') },
  { header: 'Qty', value: (r) => qtyWithUnit(r.quantity, r.unit), align: 'right' },
  { header: 'Reason', value: (r) => reasonLabel(r.reason) || '', muted: true },
  { header: 'Expiry', value: (r) => dateOnly(r.expiry_date), muted: true },
  { header: 'Note', value: (r) => r.note || '', wrap: true, muted: true },
  { header: 'Adjusted by', value: (r) => r.created_by || '', muted: true },
];

// The sign is the whole story on this table, so Type and Qty carry it in colour.
function adjustmentCell(column, row) {
  if (column.header !== 'Type' && column.header !== 'Qty') return undefined;
  const out = Number(row.quantity) < 0;
  return (
    <span style={{ color: out ? 'var(--danger)' : 'var(--accent-text)' }}>{column.value(row)}</span>
  );
}

// Stock leaves the store by dispatch and arrives by receipt. Everything else — expiry,
// loss, damage, a recount, a facility sending stock back — is an adjustment, and this is
// the one place it happens and the one place it is read back.
export default function AdjustmentsPage({ isAdmin }) {
  const [saved, setSaved] = useState(0);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Stock Adjustment</h1>
          <p>Record expired, damaged, lost stock or physical count corrections</p>
        </div>
      </div>

      <Banner kind="error" onDismiss={() => setError(null)}>
        {error}
      </Banner>
      <Banner kind="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Banner>

      {isAdmin && (
        <AdjustmentForm
          onSaved={(message) => {
            setNotice(message);
            setSaved((n) => n + 1);
          }}
          onError={setError}
        />
      )}

      <DayHistory
        kind="adjustment"
        noun="Adjustment"
        columns={COLUMNS}
        cellOf={adjustmentCell}
        refreshKey={saved}
      />
    </>
  );
}

function AdjustmentForm({ onSaved, onError }) {
  const [commodities, setCommodities] = useState([]);
  const [reasons, setReasons] = useState([]);
  const [commodityId, setCommodityId] = useState('');
  const [batches, setBatches] = useState([]);
  const [batchId, setBatchId] = useState('');
  const [reason, setReason] = useState('');
  // Held separately from the reason so a count correction can be pointed either way.
  // Every other reason locks it, which is what makes the sign trustworthy.
  const [adjType, setAdjType] = useState('');
  const [amount, setAmount] = useState('1');
  // Not prefilled: whoever counted the shelf signs for it, and a name that arrives
  // already filled in is one nobody reads.
  const [adjustedBy, setAdjustedBy] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [list, reasonList] = await Promise.all([
          api.commodities.list(),
          api.batches.adjustmentReasons(),
        ]);
        setCommodities(list);
        setReasons(reasonList);
      } catch (err) {
        onError(err.message);
      }
    })();
  }, []);

  useEffect(() => {
    setBatchId('');
    if (!commodityId) {
      setBatches([]);
      return;
    }
    api.commodities
      .batches(commodityId, { includeDepleted: true })
      .then(setBatches)
      .catch((err) => onError(err.message));
  }, [commodityId]);

  const rule = reasons.find((r) => r.code === reason);
  const commodity = commodities.find((c) => String(c.id) === String(commodityId));
  const batch = batches.find((b) => String(b.id) === String(batchId));

  function onReasonChange(code) {
    setReason(code);
    const next = reasons.find((r) => r.code === code);
    setAdjType(!next ? '' : next.direction < 0 ? 'Decrease' : next.direction > 0 ? 'Increase' : '');
  }

  const magnitude = Math.abs(Number(amount) || 0);
  const signed = !adjType || !magnitude ? null : adjType === 'Decrease' ? -magnitude : magnitude;
  const after = batch && signed != null ? Number(batch.quantity_remaining) + signed : null;
  const wouldGoNegative = after != null && after < 0;

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      // The reason fixes the sign server-side for everything but a recount, where the
      // chosen type is what decides it — so a recount sends a signed number.
      const payload = rule.direction === 0 ? signed : magnitude;
      await api.batches.adjust(Number(batchId), {
        quantity: payload,
        reason,
        note,
        adjustedBy,
      });
      onSaved(`${rule.label.toLowerCase()}: ${qty(magnitude)} on ${commodity?.name}`);
      setAmount('1');
      setNote('');
      setAdjustedBy('');
      setBatchId('');
      setReason('');
      setAdjType('');
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const ready =
    commodityId && batchId && reason && adjType && magnitude && adjustedBy.trim() && !wouldGoNegative;

  return (
    <form className="card adjust-form" onSubmit={submit}>
      <h2>Adjustment details</h2>

      <CommodityPicker commodities={commodities} value={commodityId} onChange={setCommodityId} />

      <div className="form-grid pairs">
        <div className="field">
          <label>Reason *</label>
          <select value={reason} onChange={(e) => onReasonChange(e.target.value)} required>
            <option value="">Select reason…</option>
            {reasons.map((r) => (
              <option key={r.code} value={r.code}>
                {r.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>Adjustment type *</label>
          <select
            value={adjType}
            onChange={(e) => setAdjType(e.target.value)}
            disabled={!rule || rule.direction !== 0}
            required
          >
            <option value="">{reason ? '— auto-set by reason —' : '— select reason first —'}</option>
            <option value="Increase">+ Positive adjustment (stock added)</option>
            <option value="Decrease">− Negative adjustment (stock removed)</option>
          </select>
          {rule && (
            <p
              className="muted"
              style={{
                fontSize: 12,
                margin: '4px 0 0',
                color:
                  rule.direction > 0
                    ? 'var(--accent-text)'
                    : rule.direction < 0
                      ? 'var(--danger)'
                      : 'var(--muted)',
              }}
            >
              {rule.direction > 0
                ? 'Positive — stock is being put back'
                : rule.direction < 0
                  ? `Negative — cannot increase ${rule.label.toLowerCase()} stock`
                  : 'Can be positive or negative'}
            </p>
          )}
        </div>

        <div className="field">
          <label>Select batch *</label>
          <select
            value={batchId}
            onChange={(e) => setBatchId(e.target.value)}
            disabled={!commodityId}
            required
          >
            <option value="">
              {commodityId ? 'Choose the batch being adjusted…' : 'Select a commodity first'}
            </option>
            {batches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.batch_number || 'no batch number'} · exp {dateOnly(b.expiry_date)} ·{' '}
                {qty(b.quantity_remaining)} on hand
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>Quantity *</label>
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
          />
        </div>

        <div className="field">
          <label>Adjusted by *</label>
          <input
            value={adjustedBy}
            onChange={(e) => setAdjustedBy(e.target.value)}
            placeholder="Staff name or ID"
            required
          />
        </div>

        <div className="field">
          <label>Notes</label>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Additional details"
          />
        </div>
      </div>

      {batch && signed != null && (
        <div className={`banner ${wouldGoNegative ? 'error' : 'info'}`}>
          {wouldGoNegative
            ? `That would leave ${qty(after)} — only ${qty(batch.quantity_remaining)} on hand.`
            : `This batch holds ${qty(batch.quantity_remaining)} → ${qty(after)} after the adjustment.`}
        </div>
      )}

      <div className="toolbar" style={{ marginBottom: 0 }}>
        <button className="btn primary" type="submit" disabled={busy || !ready}>
          {busy ? 'Saving…' : 'Save adjustment'}
        </button>
      </div>
    </form>
  );
}
