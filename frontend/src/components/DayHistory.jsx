import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { Banner, Empty } from './ui.jsx';
import { ymd } from './PeriodFilter.jsx';
import { downloadCsv } from '../lib/download.js';

// The day's records for one kind of operation, shown the same way on every Operations
// page. History is not a separate view — it reveals the date input beside it, so an
// earlier day can be read without leaving the page you are working on.
//
// `columns` are the download.js column shape ({ header, value, align }) and are used for
// both the table and the CSV, so the export can never drift from what is on screen.
export default function DayHistory({ kind, noun, columns, cellOf, refreshKey }) {
  const today = useMemo(() => ymd(new Date()), []);
  const [day, setDay] = useState(today);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function load() {
    setLoading(true);
    try {
      const result = await api.monitoring.day({ kind, date: day });
      setRows(result.rows);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // `refreshKey` lets the page say "I just recorded something" without reaching in.
  useEffect(() => {
    load();
  }, [day, refreshKey]);

  return (
    <div className="card">
      <div className="card-head">
        <h2 style={{ margin: 0 }}>
          {noun} records for {day}
        </h2>
        <div className="row-actions" style={{ marginLeft: 'auto' }}>
          <button
            className={`btn small ${showDatePicker ? 'primary' : ''}`}
            onClick={() => setShowDatePicker(!showDatePicker)}
          >
            History
          </button>
          {showDatePicker && (
            <input
              type="date"
              value={day}
              max={today}
              onChange={(e) => setDay(e.target.value)}
              style={{ width: 'auto' }}
            />
          )}
          <button className="btn small" onClick={load} disabled={loading}>
            {loading ? 'refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      <Banner kind="error" onDismiss={() => setError(null)}>
        {error}
      </Banner>

      {loading ? (
        <Empty>loading…</Empty>
      ) : rows.length === 0 ? (
        <Empty>No {noun.toLowerCase()} records for this date.</Empty>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c.header} className={c.align === 'right' ? 'num' : c.wrap ? 'wrap' : ''}>
                      {c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={row.id ?? i}>
                    {columns.map((c) => (
                      <td
                        key={c.header}
                        className={`${c.align === 'right' ? 'num' : ''} ${c.wrap ? 'wrap' : ''} ${
                          c.muted ? 'muted' : ''
                        }`}
                      >
                        {/* `cellOf` renders what a CSV cannot — a badge, a colour, a dash
                            for an empty value. It falls back to the CSV value. */}
                        {cellOf?.(c, row) ?? (c.value(row) || <span className="muted">—</span>)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="total-bar">
            <span className="label">
              {rows.length} record{rows.length === 1 ? '' : 's'}
            </span>
            <button
              className="btn small"
              onClick={() => downloadCsv(`${kind}-records-${day}.csv`, columns, rows)}
            >
              ⭳ Export summary
            </button>
          </div>
        </>
      )}
    </div>
  );
}
