import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { Banner, Empty, ExpiryBadge, Field, dateOnly, qty } from '../components/ui.jsx';
import { downloadCsv, stamp } from '../lib/download.js';

const EXPIRY_COLUMNS = [
  { header: 'Commodity', value: (r) => r.commodity_name },
  { header: 'Category', value: (r) => r.category || '' },
  { header: 'Intake batch no.', value: (r) => r.batch_number },
  { header: 'Expiry', value: (r) => r.expiry_date },
  { header: 'Days to expiry', value: (r) => r.days_to_expiry, align: 'right' },
  { header: 'Expired', value: (r) => (r.is_expired ? 'yes' : 'no') },
  { header: 'Remaining', value: (r) => r.quantity_remaining, align: 'right' },
  { header: 'Unit', value: (r) => r.unit || '' },
  { header: 'Vendor', value: (r) => r.vendor_name || '' },
];

const STOCK_COLUMNS = [
  { header: 'Commodity', value: (r) => r.commodity_name },
  { header: 'Category', value: (r) => r.category || '' },
  { header: 'On hand', value: (r) => r.on_hand, align: 'right' },
  { header: 'Unit', value: (r) => r.unit || '' },
  { header: 'Reorder level', value: (r) => r.reorder_level ?? '', align: 'right' },
  { header: 'Max level', value: (r) => r.max_level ?? '', align: 'right' },
  { header: 'Shortfall', value: (r) => r.shortfall ?? '', align: 'right' },
  { header: 'Excess', value: (r) => r.excess ?? '', align: 'right' },
];

export default function AlertsPage() {
  const [withinDays, setWithinDays] = useState(90);
  const [expiry, setExpiry] = useState([]);
  const [stock, setStock] = useState({ understock: [], overstock: [] });
  // '' | 'expired' | 'soon' — set by the two expiry tiles, which split the same table.
  const [expiryFilter, setExpiryFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const expiryCard = useRef(null);
  const understockCard = useRef(null);
  const overstockCard = useRef(null);

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
  const soon = expiry.filter((row) => !row.is_expired);

  // The tiles count the whole window; only the table narrows. Counting the filtered rows
  // instead would zero the other tiles the moment you clicked one.
  const visibleExpiry =
    expiryFilter === 'expired' ? expired : expiryFilter === 'soon' ? soon : expiry;

  function reveal(ref) {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Both expiry tiles drive the one table, so each toggles its own half of it.
  function pickExpiry(kind) {
    setExpiryFilter(expiryFilter === kind ? '' : kind);
    reveal(expiryCard);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Alerts</h1>
          <p>Intake batches near or past expiry, and commodities outside their stock thresholds.</p>
        </div>
        <button className="btn" style={{ marginLeft: 'auto' }} onClick={load} disabled={loading}>
          {loading ? 'refreshing…' : 'Refresh'}
        </button>
      </div>

      <Banner kind="error" onDismiss={() => setError(null)}>
        {error}
      </Banner>

      {/* Every tile stands for a table further down, so each one opens it: the expiry
          pair narrows the expiry table to its half, the stock pair jumps to its card. */}
      <div className="stat-row">
        <button
          className={`stat clickable ${expired.length ? 'alert' : ''} ${
            expiryFilter === 'expired' ? 'selected' : ''
          }`}
          aria-pressed={expiryFilter === 'expired'}
          onClick={() => pickExpiry('expired')}
        >
          <div className="label">Already expired</div>
          <div className="value">{expired.length}</div>
        </button>
        <button
          className={`stat clickable ${soon.length ? 'warn' : ''} ${
            expiryFilter === 'soon' ? 'selected' : ''
          }`}
          aria-pressed={expiryFilter === 'soon'}
          onClick={() => pickExpiry('soon')}
        >
          <div className="label">Expiring soon</div>
          <div className="value">{soon.length}</div>
        </button>
        <button
          className={`stat clickable ${stock.understock.length ? 'alert' : ''}`}
          onClick={() => reveal(understockCard)}
        >
          <div className="label">Understocked</div>
          <div className="value">{stock.understock.length}</div>
        </button>
        <button
          className={`stat clickable ${stock.overstock.length ? 'warn' : ''}`}
          onClick={() => reveal(overstockCard)}
        >
          <div className="label">Overstocked</div>
          <div className="value">{stock.overstock.length}</div>
        </button>
      </div>

      <div className="card" ref={expiryCard}>
        <div className="toolbar" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>
            Expiry
            {expiryFilter === 'expired' && ' — already expired'}
            {expiryFilter === 'soon' && ' — expiring soon'}
          </h2>
          <Field label="Window">
            <select value={withinDays} onChange={(e) => setWithinDays(Number(e.target.value))}>
              <option value={30}>next 30 days</option>
              <option value={60}>next 60 days</option>
              <option value={90}>next 90 days</option>
              <option value={180}>next 6 months</option>
              <option value={365}>next 12 months</option>
            </select>
          </Field>
          {(withinDays !== 90 || expiryFilter) && (
            <button
              className="btn"
              onClick={() => {
                setWithinDays(90);
                setExpiryFilter('');
              }}
            >
              Clear filters
            </button>
          )}
          {visibleExpiry.length > 0 && (
            <button
              className="btn small"
              style={{ marginLeft: 'auto' }}
              onClick={() =>
                downloadCsv(
                  `expiry-alerts-${withinDays}d-${stamp()}.csv`,
                  EXPIRY_COLUMNS,
                  visibleExpiry
                )
              }
            >
              ⭳ CSV
            </button>
          )}
        </div>

        {loading ? (
          <Empty>loading…</Empty>
        ) : visibleExpiry.length === 0 ? (
          <Empty>
            {expiryFilter === 'expired'
              ? 'Nothing has expired within that window.'
              : expiryFilter === 'soon'
                ? 'Nothing is due to expire within that window.'
                : 'No intake batches expire within that window.'}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="wrap">Commodity</th>
                  <th>Category</th>
                  <th>Intake batch no.</th>
                  <th>Expiry</th>
                  <th />
                  <th className="num">Remaining</th>
                  <th>Vendor</th>
                </tr>
              </thead>
              <tbody>
                {visibleExpiry.map((row) => (
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

      <div className="card" ref={understockCard}>
        <div className="card-head">
          <h2>Understocked — at or below reorder level</h2>
          {stock.understock.length > 0 && (
            <button
              className="btn small"
              onClick={() =>
                downloadCsv(`understocked-${stamp()}.csv`, STOCK_COLUMNS, stock.understock)
              }
            >
              ⭳ CSV
            </button>
          )}
        </div>
        <StockTable rows={stock.understock} loading={loading} kind="understock" />
      </div>

      <div className="card" ref={overstockCard}>
        <div className="card-head">
          <h2>Overstocked — above maximum level</h2>
          {stock.overstock.length > 0 && (
            <button
              className="btn small"
              onClick={() =>
                downloadCsv(`overstocked-${stamp()}.csv`, STOCK_COLUMNS, stock.overstock)
              }
            >
              ⭳ CSV
            </button>
          )}
        </div>
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
