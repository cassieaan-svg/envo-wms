export function MetricGrid({ children }) {
  // Pinned to the top while the content below scrolls. The window is the scroll
  // container, so sticky tracks the viewport. Offset clears the fixed mobile
  // top bar (h-13 ≈ 52px); on desktop there's no top bar so it sits at top-0.
  // The -mx-6/px-6 lets the bar's background span the page gutter so scrolling
  // content doesn't bleed through the gaps between cards. bg-gray-950 matches
  // the dark page background and is remapped to white in light mode by index.css.
  return (
    <div className="sticky top-13 lg:top-0 z-20 -mx-6 px-6 pt-3 lg:pt-6 pb-3 mb-6 bg-gray-950">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">{children}</div>
    </div>
  )
}

// `loading` shows a placeholder instead of `value`. Use it whenever the number
// would otherwise render before its data arrives — a premature 0 (or a count
// derived from empty data) reads as a real figure and misleads.
// `hint` is a small caption under the value, for a figure that needs a caveat to
// be read correctly (e.g. a running total that is not part of the period above).
export function Metric({ label, value, color = '', onClick, active = false, loading = false, hint = null }) {
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
      {hint && !loading && <div className="mt-1 text-[11px] text-gray-500 leading-snug">{hint}</div>}
    </div>
  )
}
