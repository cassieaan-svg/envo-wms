export function Card({ children, className = '' }) {
  return (
    <div className={`bg-gray-900 border border-white/8 rounded-xl overflow-hidden mb-4 ${className}`}>
      {children}
    </div>
  )
}

export function CardHeader({ children, className = '' }) {
  return (
    <div className={`px-5 py-3.5 border-b border-white/8 flex items-center justify-between gap-3 flex-wrap ${className}`}>
      {children}
    </div>
  )
}

export function CardTitle({ children }) {
  return <span className="text-sm font-medium text-gray-100">{children}</span>
}

export function CardBody({ children, className = '' }) {
  return <div className={`p-5 ${className}`}>{children}</div>
}
