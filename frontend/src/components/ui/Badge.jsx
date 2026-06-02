export function Badge({ type = 'info', children }) {
  const styles = {
    ok:      'bg-green-500/10 text-green-400 border border-green-500/20',
    low:     'bg-amber-500/10 text-amber-400 border border-amber-500/20',
    out:     'bg-red-500/10 text-red-400 border border-red-500/20',
    over:    'bg-blue-500/10 text-blue-400 border border-blue-500/20',
    info:    'bg-blue-500/10 text-blue-400 border border-blue-500/20',
    unknown: 'bg-gray-500/10 text-gray-400 border border-gray-500/20',
  }
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${styles[type] || styles.info}`}>
      {children}
    </span>
  )
}

export function CatBadge({ children }) {
  return (
    <span className="inline-block px-2 py-0.5 rounded text-xs bg-white/5 text-gray-400 border border-white/10">
      {children}
    </span>
  )
}
