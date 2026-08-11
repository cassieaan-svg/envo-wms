import { useState } from 'react';

export function ymd(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;
}

// The default window the backend also assumes: the last 30 days, inclusive of today.
export function defaultPeriod() {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 29);
  return { from: ymd(from), to: ymd(to) };
}

export function presetPeriod(days) {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - (days - 1));
  return { from: ymd(from), to: ymd(to) };
}

const PRESETS = [
  ['Last 7 days', 7],
  ['Last 30 days', 30],
  ['Last 90 days', 90],
  ['Last 12 months', 365],
];

// Which preset, if any, the current window matches — otherwise it's a custom range.
function matchPreset(period) {
  for (const [, days] of PRESETS) {
    const next = presetPeriod(days);
    if (period.from === next.from && period.to === next.to) return String(days);
  }
  return 'custom';
}

function pretty(iso) {
  const [y, m, d] = iso.split('-');
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${month[Number(m) - 1]} ${y}`;
}

export function periodLabel(period) {
  return `${pretty(period.from)} – ${pretty(period.to)}`;
}

// A preset dropdown that resolves to a date window. By default the From/To inputs stay
// out of the way behind "Custom range…" and the resolved dates are shown as text, so the
// common case is one control rather than three. `showDates` keeps the pickers on screen
// permanently, for pages where picking an exact window is routine rather than occasional.
export function PeriodSelect({ period, onChange, showDates = false }) {
  // A hand-picked window can coincide with a preset, so "custom" is sticky until a
  // preset is chosen again — otherwise the date inputs would vanish mid-edit. Moot when
  // the pickers are always on screen.
  const [custom, setCustom] = useState(false);
  const matched = matchPreset(period);
  const selected = custom && !showDates ? 'custom' : matched;
  const dates = showDates || selected === 'custom';

  return (
    <>
      <span className="filter-label">Period</span>
      <select
        value={selected}
        onChange={(e) => {
          if (e.target.value === 'custom') {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(presetPeriod(Number(e.target.value)));
        }}
      >
        {PRESETS.map(([label, days]) => (
          <option key={days} value={days}>
            {label}
          </option>
        ))}
        <option value="custom">Custom range…</option>
      </select>

      {dates ? (
        <>
          <input
            type="date"
            aria-label="From"
            value={period.from}
            max={period.to}
            onChange={(e) => onChange({ ...period, from: e.target.value })}
          />
          <span className="filter-label">to</span>
          <input
            type="date"
            aria-label="To"
            value={period.to}
            min={period.from}
            onChange={(e) => onChange({ ...period, to: e.target.value })}
          />
        </>
      ) : (
        <span className="range">{periodLabel(period)}</span>
      )}
    </>
  );
}

// The card-wrapped form, used by the Activity log. `extra` holds any page-specific
// filters that Clear should also reset.
export default function PeriodFilter({ period, onChange, onClear, showClear, extra, showDates }) {
  return (
    <div className="card">
      <div className="filter-bar">
        <PeriodSelect period={period} onChange={onChange} showDates={showDates} />
        {extra}
        {showClear && (
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={onClear}>
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}
