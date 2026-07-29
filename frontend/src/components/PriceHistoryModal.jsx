import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Banner, Empty, Field, Modal, dateOnly, money } from './ui.jsx';

// Shows the full price trail for a commodity and lets an admin set a new current price.
// Setting a price never edits an existing row — the old one is marked not-current.
export default function PriceHistoryModal({ commodity, vendors, isAdmin, onClose, onSaved }) {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ vendorId: '', brandName: '', unitPrice: '', effectiveDate: '' });
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setHistory(await api.commodities.priceHistory(commodity.id));
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [commodity.id]);

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.commodities.setPrice(commodity.id, {
        vendorId: Number(form.vendorId),
        brandName: form.brandName || null,
        unitPrice: Number(form.unitPrice),
        effectiveDate: form.effectiveDate || null,
      });
      setForm({ vendorId: '', brandName: '', unitPrice: '', effectiveDate: '' });
      await load();
      onSaved?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={commodity.name} subtitle={commodity.category || 'uncategorised'} onClose={onClose}>
      <Banner kind="error" onDismiss={() => setError(null)}>
        {error}
      </Banner>

      {isAdmin && (
        <form className="card" onSubmit={submit}>
          <h2>Set new current price</h2>
          <div className="form-grid">
            <Field label="Vendor *">
              <select
                value={form.vendorId}
                onChange={(e) => setForm({ ...form, vendorId: e.target.value })}
                required
              >
                <option value="">select vendor…</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Brand (optional)">
              <input
                value={form.brandName}
                onChange={(e) => setForm({ ...form, brandName: e.target.value })}
                placeholder="generic"
              />
            </Field>
            <Field label="Unit price (₦) *">
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.unitPrice}
                onChange={(e) => setForm({ ...form, unitPrice: e.target.value })}
                required
              />
            </Field>
            <Field label="Effective date">
              <input
                type="date"
                value={form.effectiveDate}
                onChange={(e) => setForm({ ...form, effectiveDate: e.target.value })}
              />
            </Field>
            <button className="btn primary" type="submit" disabled={saving}>
              {saving ? 'saving…' : 'Add price'}
            </button>
          </div>
          <p className="muted" style={{ margin: '10px 0 0' }}>
            The existing current price for this vendor and brand is kept as history, not overwritten.
          </p>
        </form>
      )}

      <div className="card">
        <h2>Price history</h2>
        {loading ? (
          <Empty>loading…</Empty>
        ) : history.length === 0 ? (
          <Empty>No prices recorded yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th>Brand</th>
                  <th className="num">Unit price</th>
                  <th>Effective</th>
                  <th>Status</th>
                  <th>Set by</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.id}>
                    <td>{row.vendor_name}</td>
                    <td>{row.brand_name || <span className="muted">generic</span>}</td>
                    <td className="num">{money(row.unit_price)}</td>
                    <td>{dateOnly(row.effective_date)}</td>
                    <td>
                      {row.is_current ? (
                        <span className="badge ok">current</span>
                      ) : (
                        <span className="badge inactive">superseded</span>
                      )}
                    </td>
                    <td className="muted">{row.created_by || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}
