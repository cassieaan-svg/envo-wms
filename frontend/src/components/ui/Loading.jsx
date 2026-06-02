export function Spinner({ size = 'md' }) {
  const sizes = { sm: 'w-4 h-4', md: 'w-5 h-5', lg: 'w-8 h-8' }
  return (
    <div className={`${sizes[size]} border-2 border-white/10 border-t-blue-400 rounded-full animate-spin`} />
  )
}

export function LoadingState({ message = 'Loading…' }) {
  return (
    <div className="flex items-center gap-3 p-8 text-gray-500 text-sm">
      <Spinner /> {message}
    </div>
  )
}

export function EmptyState({ message }) {
  return <div className="text-center py-12 text-gray-500 text-sm">{message}</div>
}
