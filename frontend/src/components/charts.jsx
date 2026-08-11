import { useMemo, useRef, useState } from 'react';

// Two charts, hand-drawn as SVG. The app carries no charting library and this is the
// only place that needs one — two shapes of this size cost less than a dependency, and
// drawing them here means they inherit the theme's CSS variables directly.

// Categorical slots, in fixed order. Both columns are validated for contrast and for
// colour-vision deficiency against this app's two surfaces; a category keeps its slot
// however the filters change, so filtering never repaints the survivors.
export const SERIES = [
  { light: '#2a78d6', dark: '#3987e5' },
  { light: '#eb6834', dark: '#d95926' },
  { light: '#1baf7a', dark: '#199e70' },
  { light: '#eda100', dark: '#c98500' },
  { light: '#e87ba4', dark: '#d55181' },
  { light: '#008300', dark: '#008300' },
  { light: '#4a3aa7', dark: '#9085e9' },
];

export function seriesColor(index) {
  return `var(--series-${(index % SERIES.length) + 1})`;
}

const W = 720;
const H = 210;
const PAD = { top: 14, right: 10, bottom: 26, left: 10 };

// A single tall day flattens every other day into the baseline. Rather than drop the
// outlier or switch to a log scale — both of which mislead differently — the plot is
// clipped and says so, and hovering any point still reads its true value.
function ceilingFor(values) {
  const max = Math.max(...values, 0);
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (sorted.length < 5) return { ceiling: max, clipped: false, max };
  const median = sorted[Math.floor(sorted.length / 2)];
  const ceiling = median * 3;
  if (max <= ceiling) return { ceiling: max, clipped: false, max };
  return { ceiling, clipped: true, max };
}

export function AreaChart({ points, format = (v) => v, emptyLabel = 'Nothing in this period.' }) {
  const wrap = useRef(null);
  const [hover, setHover] = useState(null);

  const values = points.map((p) => Number(p.value) || 0);
  const { ceiling, clipped, max } = useMemo(() => ceilingFor(values), [points]);

  if (points.length === 0 || max === 0) return <div className="chart-empty">{emptyLabel}</div>;

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i) => PAD.left + (points.length === 1 ? innerW / 2 : (i * innerW) / (points.length - 1));
  const y = (v) => PAD.top + innerH - (Math.min(v, ceiling) / ceiling) * innerH;

  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(values.length - 1).toFixed(1)} ${PAD.top + innerH} L${x(0).toFixed(1)} ${
    PAD.top + innerH
  } Z`;

  // Six or so ticks, always including the first and last day.
  const step = Math.max(1, Math.ceil(points.length / 6));
  const ticks = points.map((p, i) => i).filter((i) => i % step === 0 || i === points.length - 1);

  function onMove(event) {
    const box = wrap.current.getBoundingClientRect();
    const ratio = ((event.clientX - box.left) / box.width) * W;
    const i = Math.round(((ratio - PAD.left) / innerW) * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  }

  const point = hover == null ? null : points[hover];

  return (
    <div className="chart" ref={wrap} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Daily quantity dispatched">
        <defs>
          <linearGradient id="area-fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>

        <path d={area} fill="url(#area-fade)" />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />

        {/* The clipped days get a marker at the ceiling so they are not silently levelled. */}
        {clipped &&
          values.map((v, i) =>
            v > ceiling ? (
              <circle key={i} cx={x(i)} cy={y(v)} r="3" fill="var(--warn)" />
            ) : null
          )}

        {ticks.map((i) => (
          <text
            key={i}
            x={Math.min(Math.max(x(i), 18), W - 18)}
            y={H - 8}
            textAnchor="middle"
            className="chart-tick"
          >
            {points[i].label}
          </text>
        ))}

        {hover != null && (
          <>
            <line
              x1={x(hover)}
              y1={PAD.top}
              x2={x(hover)}
              y2={PAD.top + innerH}
              stroke="var(--border)"
              strokeWidth="1"
            />
            <circle
              cx={x(hover)}
              cy={y(values[hover])}
              r="4.5"
              fill="var(--accent)"
              stroke="var(--surface)"
              strokeWidth="2"
            />
          </>
        )}
      </svg>

      {point && (
        <div
          className="chart-tip"
          style={{ left: `${(x(hover) / W) * 100}%`, transform: 'translate(-50%, -100%)' }}
        >
          <strong>{format(point.value)}</strong>
          <span>{point.full || point.label}</span>
        </div>
      )}

      {clipped && (
        <p className="chart-note">
          ▲ peak day clipped for readability — hover any point for its true value (max{' '}
          {format(max)})
        </p>
      )}
    </div>
  );
}

const R = 78;
const STROKE = 26;
const CIRC = 2 * Math.PI * R;

// Slices are `{ key, label, value }`, already sorted and already folded to at most as
// many entries as SERIES has slots — the donut does not invent a colour for an overflow
// category, the caller rolls the tail into "Other".
export function DonutChart({ slices, total, unit, onSelect, format = (v) => v }) {
  const [hover, setHover] = useState(null);

  if (!slices.length || !total) return <div className="chart-empty">Nothing in this period.</div>;

  // A 2px surface gap between segments keeps adjacent hues from touching.
  const gap = 2;
  let offset = 0;
  const arcs = slices.map((slice, i) => {
    const share = Number(slice.value) / total;
    const length = Math.max(share * CIRC - gap, 0.5);
    const arc = { ...slice, index: i, share, length, offset };
    offset += share * CIRC;
    return arc;
  });

  return (
    <div className="donut">
      <svg viewBox="0 0 200 200" role="img" aria-label="Quantity dispatched by category">
        <g transform="rotate(-90 100 100)">
          {arcs.map((arc) => (
            <circle
              key={arc.key}
              cx="100"
              cy="100"
              r={R}
              fill="none"
              stroke={seriesColor(arc.index)}
              strokeWidth={hover === arc.index ? STROKE + 4 : STROKE}
              strokeDasharray={`${arc.length} ${CIRC - arc.length}`}
              strokeDashoffset={-arc.offset}
              style={{ cursor: onSelect ? 'pointer' : 'default' }}
              onMouseEnter={() => setHover(arc.index)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onSelect?.(arc)}
            />
          ))}
        </g>
        <text x="100" y="98" textAnchor="middle" className="donut-total">
          {format(hover == null ? total : arcs[hover].value)}
        </text>
        <text x="100" y="116" textAnchor="middle" className="donut-unit">
          {hover == null ? unit : arcs[hover].label}
        </text>
      </svg>

      <ul className="donut-legend">
        {arcs.map((arc) => (
          <li key={arc.key}>
            <button
              type="button"
              onMouseEnter={() => setHover(arc.index)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onSelect?.(arc)}
              disabled={!onSelect}
            >
              <span className="dot" style={{ background: seriesColor(arc.index) }} />
              <span className="name">{arc.label}</span>
              <span className="share">{Math.round(arc.share * 100)}%</span>
              <span className="amount">{format(arc.value)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
