import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { Banner, Empty, dateTime, qtyWithUnit } from '../components/ui.jsx';
import PeriodFilter, { defaultPeriod } from '../components/PeriodFilter.jsx';
import { ADJUSTMENT_REASON_LABELS, reasonLabel } from '../lib/adjustments.js';
import { downloadCsv, stamp } from '../lib/download.js';

// Stock movements only — every quantity change written to the batch ledger. Catalogue
// edits (prices, units, names) are not here: they move no stock.
export const MOVEMENT_LABELS = {
  receipt: 'Received',
  dispatch: 'Dispatched',
  adjustment: 'Adjusted',
  reversal: 'Reversed',
};

const COLUMNS = [
  { header: 'When', value: (r) => r.created_at },
  { header: 'Movement', value: (r) => MOVEMENT_LABELS[r.movement_type] || r.movement_type },
  { header: 'Commodity', value: (r) => r.commodity_name },
  { header: 'Category', value: (r) => r.category || '' },
  { header: 'Intake batch no.', value: (r) => r.batch_number || '' },
  { header: 'Reason', value: (r) => reasonLabel(r.reason) || '' },
  { header: 'Expiry', value: (r) => r.expiry_date || '' },
  { header: 'Quantity', value: (r) => r.quantity, align: 'right' },
  { header: 'Unit', value: (r) => r.unit || '' },
  { header: 'Facility', value: (r) => r.facility_name || '' },
  { header: 'Note', value: (r) => r.note || '' },
  { header: 'By', value: (r) => r.created_by || '' },
];

export default function ActivityLogPage() {
  const initial = useMemo(defaultPeriod, []);
  const [period, setPeriod] = useState(initial);
  const [movementType, setMovementType] = useState('');
  const [reason, setReason] = useState('');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function load() {
    setLoading(true);
    try {
      const result = await api.monitoring.activity({
        ...period,
        type: movementType || undefined,
      });
      setRows(result.rows);
      setCounts(result.counts);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [period.from, period.to, movementType]);

  const term = search.trim().toLowerCase();
  const byReason = reason ? rows.filter((r) => r.reason === reason) : rows;
  const visible = term
    ? byReason.filter((r) =>
        [r.commodity_name, r.batch_number, r.facility_name, r.note, r.created_by]
          .filter(Boolean)
          .some((field) => String(field).toLowerCase().includes(term))
      )
    : byReason;

  const filtered =
    period.from !== initial.from ||
    period.to !== initial.to ||
    movementType !== '' ||
    reason !== '' ||
    term !== '';


  return (
    <>
      <div className="page-head">
        <div>
          <h1>Activity log</h1>
          <p>Every movement of stock through the store — receipts, dispatches, adjustments and corrections.</p>
        </div>
        <button className="btn" style={{ marginLeft: 'auto' }} onClick={load} disabled={loading}>
          {loading ? 'refreshing…' : 'Refresh'}
        </button>
      </div>

      <Banner kind="error" onDismiss={() => setError(null)}>
        {error}
      </Banner>

      <PeriodFilter
        period={period}
        onChange={setPeriod}
        showDates
        showClear={filtered}
        onClear={() => {
          setPeriod(initial);
          setMovementType('');
          setReason('');
          setSearch('');
        }}
        extra={
          <>
            <span className="filter-label">Movement</span>
            <select value={movementType} onChange={(e) => setMovementType(e.target.value)}>
              <option value="">All movements</option>
              {Object.entries(MOVEMENT_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
            <span className="filter-label">Reason</span>
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">All reasons</option>
              {Object.entries(ADJUSTMENT_REASON_LABELS).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
            <span className="filter-label">Search</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="commodity, batch, facility, who…"
            />
          </>
        }
      />

      {/* Each tile is the count of one movement type, so clicking it filters the log to
          that type — and clicking the selected one clears the filter again. */}
      <div className="stat-row">
        {Object.entries(MOVEMENT_LABELS).map(([key, label]) => (
          <button
            key={key}
            className={`stat clickable ${movementType === key ? 'selected' : ''}`}
            aria-pressed={movementType === key}
            onClick={() => setMovementType(movementType === key ? '' : key)}
          >
            <div className="label">{label}</div>
            <div className="value">{counts[key] || 0}</div>
          </button>
        ))}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>
            {visible.length} movement{visible.length === 1 ? '' : 's'}
          </h2>
          {visible.length > 0 && (
            <button
              className="btn small"
              onClick={() => downloadCsv(`stock-movements-${stamp()}.csv`, COLUMNS, visible)}
            >
              ⭳ CSV
            </button>
          )}
        </div>

        {loading ? (
          <Empty>loading…</Empty>
        ) : visible.length === 0 ? (
          <Empty>{rows.length === 0 ? 'No stock moved in this period.' : 'Nothing matches that search.'}</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Movement</th>
                  <th className="wrap">Commodity</th>
                  <th>Intake batch no.</th>
                  <th>Reason</th>
                  <th className="num">Quantity</th>
                  <th>Facility</th>
                  <th className="wrap">Note</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => {
                  const out = Number(row.quantity) < 0;
                  return (
                    <tr key={row.id}>
                      <td className="muted">{dateTime(row.created_at)}</td>
                      <td>{MOVEMENT_LABELS[row.movement_type] || row.movement_type}</td>
                      <td className="wrap">{row.commodity_name}</td>
                      <td>{row.batch_number || <span className="muted">—</span>}</td>
                      <td>{reasonLabel(row.reason) || <span className="muted">—</span>}</td>
                      <td className="num" style={{ color: out ? 'var(--danger)' : 'inherit' }}>
                        {qtyWithUnit(row.quantity, row.unit)}
                      </td>
                      <td>{row.facility_name || <span className="muted">—</span>}</td>
                      <td className="wrap muted">{row.note || '—'}</td>
                      <td className="muted">{row.created_by || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
