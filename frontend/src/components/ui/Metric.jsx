export function MetricGrid({ children }) {
  return <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">{children}</div>
}

export function Metric({ label, value, color = '', onClick, active = false }) {
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
      <div className={`text-2xl font-medium font-mono ${colors[color] || 'text-gray-100'}`}>{value}</div>
    </div>
  )
}
