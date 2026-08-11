import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { Banner, Empty, Modal, dateOnly, money, qty, qtyWithUnit } from '../components/ui.jsx';
import { PeriodSelect, defaultPeriod, periodLabel } from '../components/PeriodFilter.jsx';
import { AreaChart, DonutChart, SERIES } from '../components/charts.jsx';
import { downloadCsv, slug, stamp } from '../lib/download.js';

const VIEWS = [
  ['facility', 'By facility'],
  ['commodity', 'By commodity'],
];

export default function MonitoringPage() {
  const initial = useMemo(defaultPeriod, []);
  const [period, setPeriod] = useState(initial);
  const [lga, setLga] = useState('');
  const [category, setCategory] = useState('');
  const [view, setView] = useState('facility');

  const [summary, setSummary] = useState(null);
  const [daily, setDaily] = useState([]);
  const [categories, setCategories] = useState([]);
  const [facilities, setFacilities] = useState([]);
  const [commodities, setCommodities] = useState([]);

  const [lgaOptions, setLgaOptions] = useState([]);
  const [categoryOptions, setCategoryOptions] = useState([]);
  const [drill, setDrill] = useState(null);
  const tables = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Everything on the page answers the same question over the same window, so one filter
  // change reloads the lot rather than leaving half the page describing a stale period.
  const filters = { ...period, lga: lga || undefined, category: category || undefined };

  async function load() {
    setLoading(true);
    try {
      const [sum, series, byCategory, byFacility, byCommodity] = await Promise.all([
        api.monitoring.summary(filters),
        api.monitoring.daily(filters),
        api.monitoring.byCategory(filters),
        api.monitoring.byFacility(filters),
        api.monitoring.byCommodity(filters),
      ]);
      setSummary(sum);
      setDaily(series.rows);
      setCategories(byCategory.rows);
      setFacilities(byFacility.rows);
      setCommodities(byCommodity.rows);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [period.from, period.to, lga, category]);

  // The filter dropdowns are reference data — loaded once, not per window.
  useEffect(() => {
    (async () => {
      try {
        const [lgas, cats] = await Promise.all([
          api.facilities.lgas(),
          api.commodities.categories(),
        ]);
        // Both endpoints answer with a bare array of rows carrying counts alongside the
        // name; the dashboard only needs the names.
        setLgaOptions(lgas.map((r) => r.lga));
        setCategoryOptions(cats.map((r) => r.category));
      } catch {
        // A missing filter list is not worth an error banner over the whole page — the
        // dashboard still works, just without those two dropdowns.
      }
    })();
  }, []);

  const points = daily.map((row) => ({
    label: shortDay(row.day),
    full: dateOnly(row.day),
    value: Number(row.quantity),
  }));

  // The donut has a fixed number of colour slots; anything past them is one "Other"
  // slice rather than a generated hue.
  const slices = useMemo(() => {
    const sorted = [...categories].sort((a, b) => Number(b.quantity) - Number(a.quantity));
    if (sorted.length <= SERIES.length) {
      return sorted.map((r) => ({ key: r.category, label: r.category, value: Number(r.quantity) }));
    }
    const head = sorted.slice(0, SERIES.length - 1);
    const tail = sorted.slice(SERIES.length - 1);
    return [
      ...head.map((r) => ({ key: r.category, label: r.category, value: Number(r.quantity) })),
      {
        key: '__other',
        label: `Other (${tail.length})`,
        value: tail.reduce((sum, r) => sum + Number(r.quantity), 0),
      },
    ];
  }, [categories]);

  const totalQuantity = Number(summary?.quantity) || 0;

  // The tables are below the fold on most screens, so selecting one from a tile has to
  // bring it into view or the click looks like it did nothing.
  function showTable(next) {
    setView(next);
    tables.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Monitoring</h1>
          <p>Everything that has left the store, by facility and by commodity.</p>
        </div>
      </div>

      <Banner kind="error" onDismiss={() => setError(null)}>
        {error}
      </Banner>

      <div className="card">
        <div className="filter-bar">
          <PeriodSelect period={period} onChange={setPeriod} />
          <span className="filter-label">LGA</span>
          <select value={lga} onChange={(e) => setLga(e.target.value)}>
            <option value="">All LGAs</option>
            {lgaOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <span className="filter-label">Category</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All categories</option>
            {categoryOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          {(lga || category) && (
            <button className="btn small" onClick={() => { setLga(''); setCategory(''); }}>
              Clear
            </button>
          )}
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={load} disabled={loading}>
            {loading ? 'refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="stat-row">
        <div className="stat accent">
          <div className="label">Units dispatched</div>
          <div className="value">{qty(summary?.quantity)}</div>
        </div>
        <div className="stat">
          <div className="label">Value dispatched</div>
          <div className="value">{money(summary?.value_dispatched)}</div>
        </div>
        {/* The two counts are the totals of the tables further down, so clicking one
            opens the table it counts rather than being a dead figure. */}
        <button
          className={`stat clickable ${view === 'commodity' ? 'selected' : ''}`}
          onClick={() => showTable('commodity')}
        >
          <div className="label">Commodities dispatched</div>
          <div className="value">{summary?.commodities ?? '—'}</div>
        </button>
        <button
          className={`stat clickable ${view === 'facility' ? 'selected' : ''}`}
          onClick={() => showTable('facility')}
        >
          <div className="label">Facilities served</div>
          <div className="value">{summary?.facilities ?? '—'}</div>
        </button>
        <div className="stat">
          <div className="label">Dispatched today</div>
          <div className="value">{qty(summary?.quantity_today)}</div>
        </div>
      </div>

      <div className="chart-grid">
        <div className="card">
          <div className="card-head">
            <h2>Daily dispatched</h2>
            <span className="range" style={{ marginLeft: 'auto' }}>
              {periodLabel(period)}
            </span>
          </div>
          {loading ? <Empty>loading…</Empty> : <AreaChart points={points} format={qty} />}
        </div>

        <div className="card">
          <div className="card-head">
            <h2>By category</h2>
            <span className="range" style={{ marginLeft: 'auto' }}>
              {category ? 'showing one category' : 'click to drill down'}
            </span>
          </div>
          {loading ? (
            <Empty>loading…</Empty>
          ) : (
            <DonutChart
              slices={slices}
              total={totalQuantity}
              unit="units"
              format={qty}
              onSelect={(arc) => arc.key !== '__other' && setCategory(arc.key)}
            />
          )}
        </div>
      </div>

      <div className="card" ref={tables}>
        <div className="toolbar" style={{ marginBottom: 12 }}>
          {VIEWS.map(([key, label]) => (
            <button
              key={key}
              className={`btn small ${view === key ? 'primary' : ''}`}
              onClick={() => setView(key)}
            >
              {label}
            </button>
          ))}
          <span style={{ marginLeft: 'auto' }}>
            {view === 'facility' && facilities.length > 0 && (
              <button
                className="btn small"
                onClick={() =>
                  downloadCsv(`dispatched-by-facility-${stamp()}.csv`, FACILITY_COLUMNS, facilities)
                }
              >
                ⭳ CSV
              </button>
            )}
            {view === 'commodity' && commodities.length > 0 && (
              <button
                className="btn small"
                onClick={() =>
                  downloadCsv(`dispatched-by-commodity-${stamp()}.csv`, COMMODITY_COLUMNS, commodities)
                }
              >
                ⭳ CSV
              </button>
            )}
          </span>
        </div>

        {loading ? (
          <Empty>loading…</Empty>
        ) : view === 'facility' ? (
          <FacilityTable rows={facilities} onDrill={(row) => setDrill({ kind: 'facility', row })} />
        ) : (
          <CommodityTable rows={commodities} onDrill={(row) => setDrill({ kind: 'commodity', row })} />
        )}
      </div>

      {drill && (
        <DrillModal detail={drill} period={period} onClose={() => setDrill(null)} onError={setError} />
      )}
    </>
  );
}

// '2026-08-09' → '09 Aug', without going through Date and risking a timezone shift.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDay(value) {
  const iso = dateOnly(value);
  const [, m, d] = iso.split('-');
  return `${d} ${MONTHS[Number(m) - 1]}`;
}

const FACILITY_COLUMNS = [
  { header: 'Facility', value: (r) => r.facility_name },
  { header: 'LGA', value: (r) => r.lga || '' },
  { header: 'Dispatches', value: (r) => r.orders, align: 'right' },
  { header: 'Commodities', value: (r) => r.commodities, align: 'right' },
  { header: 'Quantity', value: (r) => r.quantity, align: 'right' },
  { header: 'Value (NGN)', value: (r) => r.value_dispatched, align: 'right' },
  { header: 'Last dispatch', value: (r) => r.last_dispatch },
];

const COMMODITY_COLUMNS = [
  { header: 'Commodity', value: (r) => r.commodity_name },
  { header: 'Category', value: (r) => r.category || '' },
  { header: 'Facilities', value: (r) => r.facilities, align: 'right' },
  { header: 'Dispatches', value: (r) => r.orders, align: 'right' },
  { header: 'Quantity', value: (r) => r.quantity, align: 'right' },
  { header: 'Unit', value: (r) => r.unit || '' },
  { header: 'Value (NGN)', value: (r) => r.value_dispatched, align: 'right' },
  { header: 'Last dispatch', value: (r) => r.last_dispatch },
];

function FacilityTable({ rows, onDrill }) {
  if (rows.length === 0) return <Empty>Nothing was dispatched to any facility in this period.</Empty>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th className="wrap">Facility</th>
            <th>LGA</th>
            <th className="num">Dispatches</th>
            <th className="num">Commodities</th>
            <th className="num">Quantity</th>
            <th className="num">Value</th>
            <th>Last dispatch</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.facility_id} className="clickable" onClick={() => onDrill(row)}>
              <td className="wrap">{row.facility_name}</td>
              <td className="muted">{row.lga || '—'}</td>
              <td className="num">{row.orders}</td>
              <td className="num">{row.commodities}</td>
              <td className="num">{qty(row.quantity)}</td>
              <td className="num">{money(row.value_dispatched)}</td>
              <td className="muted">{dateOnly(row.last_dispatch)}</td>
              <td>
                <button className="btn small" onClick={() => onDrill(row)}>
                  view
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CommodityTable({ rows, onDrill }) {
  if (rows.length === 0) return <Empty>No commodity left the store in this period.</Empty>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th className="wrap">Commodity</th>
            <th>Category</th>
            <th className="num">Facilities</th>
            <th className="num">Dispatches</th>
            <th className="num">Quantity</th>
            <th className="num">Value</th>
            <th>Last dispatch</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.commodity_id} className="clickable" onClick={() => onDrill(row)}>
              <td className="wrap">{row.commodity_name}</td>
              <td className="muted">{row.category || '—'}</td>
              <td className="num">{row.facilities}</td>
              <td className="num">{row.orders}</td>
              <td className="num">{qtyWithUnit(row.quantity, row.unit)}</td>
              <td className="num">{money(row.value_dispatched)}</td>
              <td className="muted">{dateOnly(row.last_dispatch)}</td>
              <td>
                <button className="btn small" onClick={() => onDrill(row)}>
                  view
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Both drill-downs are the same shape of answer from opposite directions: the raw
// dispatched lines, rolled up by the other dimension, with the individual dispatches
// underneath.
function DrillModal({ detail, period, onClose, onError }) {
  const { kind, row } = detail;
  const [lines, setLines] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const result =
          kind === 'facility'
            ? await api.monitoring.facility(row.facility_id, period)
            : await api.monitoring.commodity(row.commodity_id, period);
        setLines(result.lines);
      } catch (err) {
        onError(err.message);
        onClose();
      }
    })();
  }, []);

  const groups = useMemo(() => {
    if (!lines) return [];
    const map = new Map();
    for (const line of lines) {
      const key = kind === 'facility' ? line.commodity_id : line.facility_id;
      const name = kind === 'facility' ? line.commodity_name : line.facility_name || 'unresolved facility';
      const entry = map.get(key) || { key, name, unit: line.unit, quantity: 0, value: 0, count: 0 };
      entry.quantity += Number(line.quantity);
      entry.value += Number(line.line_value);
      entry.count += 1;
      map.set(key, entry);
    }
    return [...map.values()].sort((a, b) => b.value - a.value);
  }, [lines, kind]);

  const title = kind === 'facility' ? row.facility_name : row.commodity_name;
  const subtitle = periodLabel(period);

  return (
    <Modal title={title} subtitle={subtitle} onClose={onClose}>
      {!lines ? (
        <Empty>loading…</Empty>
      ) : lines.length === 0 ? (
        <Empty>Nothing in this period.</Empty>
      ) : (
        <>
          <div className="stat-row">
            <div className="stat">
              <div className="label">Value</div>
              <div className="value">{money(row.value_dispatched)}</div>
            </div>
            <div className="stat">
              <div className="label">Quantity</div>
              <div className="value">{qty(row.quantity)}</div>
            </div>
            <div className="stat">
              <div className="label">Dispatches</div>
              <div className="value">{row.orders}</div>
            </div>
          </div>

          <h2>{kind === 'facility' ? 'Commodities received' : 'Facilities served'}</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="wrap">{kind === 'facility' ? 'Commodity' : 'Facility'}</th>
                  <th className="num">Lines</th>
                  <th className="num">Quantity</th>
                  <th className="num">Value</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.key}>
                    <td className="wrap">{g.name}</td>
                    <td className="num">{g.count}</td>
                    <td className="num">{qtyWithUnit(g.quantity, g.unit)}</td>
                    <td className="num">{money(g.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2>Dispatch history</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Source</th>
                  <th className="wrap">{kind === 'facility' ? 'Commodity' : 'Facility'}</th>
                  <th className="num">Quantity</th>
                  <th className="num">Unit price</th>
                  <th className="num">Value</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => (
                  <tr key={`${line.source}-${line.order_ref}-${index}`}>
                    <td className="muted">{dateOnly(line.dispatched_at)}</td>
                    <td className="muted">
                      {line.source === 'request' ? 'request' : 'dispatch'} #{line.order_ref}
                    </td>
                    <td className="wrap">
                      {kind === 'facility' ? line.commodity_name : line.facility_name || '—'}
                    </td>
                    <td className="num">{qtyWithUnit(line.quantity, line.unit)}</td>
                    <td className="num">{money(line.unit_price)}</td>
                    <td className="num">{money(line.line_value)}</td>
                    <td className="muted">{line.dispatched_by || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            className="btn small"
            onClick={() =>
              downloadCsv(
                `${slug(title)}-${period.from}-to-${period.to}.csv`,
                [
                  { header: 'When', value: (l) => l.dispatched_at },
                  { header: 'Source', value: (l) => l.source },
                  { header: 'Ref', value: (l) => l.order_ref },
                  {
                    header: kind === 'facility' ? 'Commodity' : 'Facility',
                    value: (l) => (kind === 'facility' ? l.commodity_name : l.facility_name || ''),
                  },
                  { header: 'Quantity', value: (l) => l.quantity, align: 'right' },
                  { header: 'Unit price (NGN)', value: (l) => l.unit_price, align: 'right' },
                  { header: 'Value (NGN)', value: (l) => l.line_value, align: 'right' },
                  { header: 'By', value: (l) => l.dispatched_by || '' },
                ],
                lines
              )
            }
          >
            ⭳ CSV
          </button>
        </>
      )}
    </Modal>
  );
}
