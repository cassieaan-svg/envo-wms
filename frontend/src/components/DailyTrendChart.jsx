// Daily consumption/utilization trend as a filled area + line sparkline.
// Scales to the ~95th percentile of non-zero days so a single spike doesn't
// flatten the rest (clipped peaks are marked and the true value shows on hover).
// `daily` is an ordered { 'YYYY-MM-DD': number } map (oldest → newest).
export function DailyTrendChart({ daily, color = '#3fb950', unit = '' }) {
  const entries = Object.entries(daily || {})
  const n = entries.length
  if (!n) return <div className="text-sm text-gray-500 py-8 text-center">No activity in this period.</div>

  const vals = entries.map(([, v]) => v)
  const nz = vals.filter(v => v > 0).sort((a, b) => a - b)
  const cap = Math.max(nz.length ? nz[Math.floor((nz.length - 1) * 0.95)] : 0, 1)
  const trueMax = Math.max(...vals, 1)
  const anyClipped = vals.some(v => v > cap)

  const W = 100, H = 36
  const xOf = i => (n === 1 ? W / 2 : (i / (n - 1)) * W)
  const yOf = v => H - (Math.min(v, cap) / cap) * (H - 3) - 1.5
  const pts = entries.map(([d, v], i) => ({ d, v, xi: xOf(i), yi: yOf(v), clipped: v > cap }))
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.xi.toFixed(2)},${p.yi.toFixed(2)}`).join(' ')
  const area = `${line} L${xOf(n - 1).toFixed(2)},${H} L${xOf(0).toFixed(2)},${H} Z`

  const fmt = ds => new Date(ds).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
  const step = Math.max(1, Math.round(n / 6))
  const gid = 'trend-' + color.replace('#', '')

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
        style={{ width: '100%', height: 120, display: 'block', overflow: 'visible' }}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1="0" y1={H} x2={W} y2={H} stroke="rgba(255,255,255,0.08)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <path d={area} fill={`url(#${gid})`} />
        <path d={line} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
        {pts.filter(p => p.clipped).map((p, i) => (
          <line key={i} x1={p.xi} y1="0" x2={p.xi} y2="3.5" stroke="#f0883e" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        ))}
        {/* full-height invisible hover targets carry the per-day tooltip */}
        {pts.map((p, i) => (
          <rect key={i} x={p.xi - W / n / 2} y="0" width={W / n} height={H} fill="transparent">
            <title>{`${fmt(p.d)}: ${p.v.toLocaleString()}${unit ? ' ' + unit : ''}${p.clipped ? ' (peak — clipped)' : ''}`}</title>
          </rect>
        ))}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
        {pts.map((p, i) => (i % step === 0 || i === n - 1)
          ? <span key={i} style={{ fontSize: 10, color: '#8b949e' }}>{fmt(p.d)}</span> : null)}
      </div>
      {anyClipped && (
        <div style={{ fontSize: 10, color: '#8b949e', marginTop: 6 }}>
          <span style={{ color: '#f0883e' }}>▲</span> peak day clipped for readability — hover any point for its true value (max {trueMax.toLocaleString()})
        </div>
      )}
    </div>
  )
}
