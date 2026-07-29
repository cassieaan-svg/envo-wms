import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Banner, Empty, ExpiryBadge, Field, dateOnly, qty } from '../components/ui.jsx';

export default function AlertsPage() {
  const [withinDays, setWithinDays] = useState(90);
  const [expiry, setExpiry] = useState([]);
  const [stock, setStock] = useState({ understock: [], overstock: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function load() {
    setLoading(true);
    try {
      const [expiryRows, stockRows] = await Promise.all([
        api.alerts.expiry({ withinDays }),
        api.alerts.stock(),
      ]);
      setExpiry(expiryRows);
      setStock(stockRows);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [withinDays]);

  const expired = expiry.filter((row) => row.is_expired);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Alerts</h1>
          <p>Batches near or past expiry, and commodities outside their stock thresholds.</p>
        </div>
        <button className="btn" style={{ marginLeft: 'auto' }} onClick={load} disabled={loading}>
          {loading ? 'refreshing…' : 'Refresh'}
        </button>
      </div>

      <Banner kind="error" onDismiss={() => setError(null)}>
        {error}
      </Banner>

      <div className="stat-row">
        <div className={`stat ${expired.length ? 'alert' : ''}`}>
          <div className="label">Already expired</div>
          <div className="value">{expired.length}</div>
        </div>
        <div className={`stat ${expiry.length - expired.length ? 'warn' : ''}`}>
          <div className="label">Expiring soon</div>
          <div className="value">{expiry.length - expired.length}</div>
        </div>
        <div className={`stat ${stock.understock.length ? 'alert' : ''}`}>
          <div className="label">Understocked</div>
          <div className="value">{stock.understock.length}</div>
        </div>
        <div className={`stat ${stock.overstock.length ? 'warn' : ''}`}>
          <div className="label">Overstocked</div>
          <div className="value">{stock.overstock.length}</div>
        </div>
      </div>

      <div className="card">
        <div className="toolbar" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Expiry</h2>
          <Field label="Window">
            <select value={withinDays} onChange={(e) => setWithinDays(Number(e.target.value))}>
              <option value={30}>next 30 days</option>
              <option value={60}>next 60 days</option>
              <option value={90}>next 90 days</option>
              <option value={180}>next 6 months</option>
              <option value={365}>next 12 months</option>
            </select>
          </Field>
        </div>

        {loading ? (
          <Empty>loading…</Empty>
        ) : expiry.length === 0 ? (
          <Empty>No batches expire within that window.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="wrap">Commodity</th>
                  <th>Category</th>
                  <th>Batch no.</th>
                  <th>Expiry</th>
                  <th />
                  <th className="num">Remaining</th>
                  <th>Vendor</th>
                </tr>
              </thead>
              <tbody>
                {expiry.map((row) => (
                  <tr key={row.batch_id}>
                    <td className="wrap">{row.commodity_name}</td>
                    <td className="muted">{row.category || '—'}</td>
                    <td>{row.batch_number}</td>
                    <td>{dateOnly(row.expiry_date)}</td>
                    <td>
                      <ExpiryBadge daysToExpiry={row.days_to_expiry} isExpired={row.is_expired} />
                    </td>
                    <td className="num">
                      {qty(row.quantity_remaining)} {row.unit || ''}
                    </td>
                    <td>{row.vendor_name || <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Understocked — at or below reorder level</h2>
        <StockTable rows={stock.understock} loading={loading} kind="understock" />
      </div>

      <div className="card">
        <h2>Overstocked — above maximum level</h2>
        <StockTable rows={stock.overstock} loading={loading} kind="overstock" />
      </div>
    </>
  );
}

function StockTable({ rows, loading, kind }) {
  if (loading) return <Empty>loading…</Empty>;
  if (rows.length === 0) {
    return (
      <Empty>
        Nothing {kind === 'understock' ? 'below its reorder level' : 'above its maximum level'}.
        Commodities with no threshold set are not tracked here.
      </Empty>
    );
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th className="wrap">Commodity</th>
            <th>Category</th>
            <th className="num">On hand</th>
            <th className="num">{kind === 'understock' ? 'Reorder level' : 'Max level'}</th>
            <th className="num">{kind === 'understock' ? 'Shortfall' : 'Excess'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.commodity_id}>
              <td className="wrap">{row.commodity_name}</td>
              <td className="muted">{row.category || '—'}</td>
              <td className="num">
                {qty(row.on_hand)} {row.unit || ''}
              </td>
              <td className="num muted">
                {qty(kind === 'understock' ? row.reorder_level : row.max_level)}
              </td>
              <td className="num" style={{ color: kind === 'understock' ? 'var(--danger)' : 'var(--warn)' }}>
                {qty(kind === 'understock' ? row.shortfall : row.excess)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
