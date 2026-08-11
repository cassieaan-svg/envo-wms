import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Banner, Empty, Field, dateOnly, money } from './ui.jsx';

// The price trail for a commodity, and the form to adjust it. Rendered as a section of the
// commodity's edit modal rather than a modal of its own. Adjusting never edits an existing
// row — the old one is kept, marked not-current.
export default function PriceSection({ commodity, isAdmin, onSaved }) {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ unitPrice: '', effectiveDate: '' });
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
        unitPrice: Number(form.unitPrice),
        effectiveDate: form.effectiveDate || null,
      });
      setForm({ unitPrice: '', effectiveDate: '' });
      await load();
      onSaved?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Banner kind="error" onDismiss={() => setError(null)}>
        {error}
      </Banner>

      {isAdmin && (
        <form className="card" onSubmit={submit}>
          <h2>Adjust price</h2>
          <div className="form-grid">
            <Field label={`New unit price (₦) per ${commodity.unit || 'unit'} *`}>
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.unitPrice}
                onChange={(e) => setForm({ ...form, unitPrice: e.target.value })}
                required
                autoFocus
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
              {saving ? 'saving…' : 'Save new price'}
            </button>
          </div>
          <p className="muted" style={{ margin: '10px 0 0' }}>
            Current price:{' '}
            {commodity.current_price == null ? 'not set' : money(commodity.current_price)}. The old price
            is kept as history, not overwritten.
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
                  <th className="num">Unit price</th>
                  <th>Effective</th>
                  <th>Status</th>
                  <th>Set by</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.id}>
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
    </>
  );
}
