// `cols` is the wide-screen column count (default 4). Pass 3, 5 or 6 for a different bar —
// the default is left alone so every existing four-card bar is unchanged rather
// than gaining a hole at the end.
export function MetricGrid({ children, cols = 4 }) {
  // Pinned to the top while the content below scrolls. The window is the scroll
  // container, so sticky tracks the viewport. Offset clears the fixed mobile
  // top bar (h-13 ≈ 52px); on desktop there's no top bar so it sits at top-0.
  // The -mx-6/px-6 lets the bar's background span the page gutter so scrolling
  // content doesn't bleed through the gaps between cards. bg-gray-950 matches
  // the dark page background and is remapped to white in light mode by index.css.
  return (
    <div className="sticky top-13 lg:top-0 z-20 -mx-6 px-6 pt-3 lg:pt-6 pb-3 mb-6 bg-gray-950">
      {/* Full class strings, not `sm:grid-cols-${cols}` — Tailwind scans source
          text, so an interpolated name is never emitted into the stylesheet. */}
      <div className={`grid grid-cols-2 gap-3 ${
        cols === 3 ? 'sm:grid-cols-3' :
        cols === 6 ? 'sm:grid-cols-3 xl:grid-cols-6' :
        cols === 5 ? 'sm:grid-cols-3 xl:grid-cols-5' :
                     'sm:grid-cols-4'}`}>{children}</div>
    </div>
  )
}

// `loading` shows a placeholder instead of `value`. Use it whenever the number
// would otherwise render before its data arrives — a premature 0 (or a count
// derived from empty data) reads as a real figure and misleads.
export function Metric({ label, value, color = '', onClick, active = false, loading = false }) {
  const colors = {
    green: 'text-green-400',
    red:   'text-red-400',
    amber: 'text-amber-400',
    blue:  'text-blue-400',
    '':    'text-gray-100',
  }
  const clickable = typeof onClick === 'function'
  return (
    <div
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }) : undefined}
      className={`bg-gray-900 rounded-xl p-4 border transition-colors ${
        active ? 'border-blue-500/60 ring-1 ring-blue-500/40' : 'border-white/8'
      } ${clickable ? 'cursor-pointer hover:border-white/20' : ''}`}
    >
      <div className="text-xs text-gray-500 uppercase tracking-widest mb-2">{label}</div>
      {loading
        ? <div className="h-8 w-12 rounded bg-white/10 animate-pulse" aria-label={`${label} loading`}/>
        : <div className={`text-2xl font-medium font-mono ${colors[color] || 'text-gray-100'}`}>{value}</div>}
    </div>
  )
}
