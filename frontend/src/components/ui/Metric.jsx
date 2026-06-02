export function MetricGrid({ children }) {
  return <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">{children}</div>
}

export function Metric({ label, value, color = '' }) {
  const colors = {
    green: 'text-green-400',
    red:   'text-red-400',
    amber: 'text-amber-400',
    blue:  'text-blue-400',
    '':    'text-gray-100',
  }
  return (
    <div className="bg-gray-900 border border-white/8 rounded-xl p-4">
      <div className="text-xs text-gray-500 uppercase tracking-widest mb-2">{label}</div>
      <div className={`text-2xl font-medium font-mono ${colors[color] || 'text-gray-100'}`}>{value}</div>
    </div>
  )
}
