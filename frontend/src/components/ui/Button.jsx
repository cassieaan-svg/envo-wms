export function Button({ children, type = 'button', onClick, variant = 'default', size = 'md', disabled = false, className = '' }) {
  const base = 'inline-flex items-center justify-center font-medium rounded-lg transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed'
  const sizes = {
    sm: 'px-3 py-1.5 text-xs',
    md: 'px-4 py-2 text-sm min-h-[36px]',
    lg: 'px-5 py-2.5 text-sm min-h-[44px]',
  }
  const variants = {
    default: 'bg-transparent border border-white/15 text-gray-300 hover:bg-white/5',
    success: 'bg-green-500 border-green-500 text-white hover:opacity-90 font-semibold',
    danger:  'bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20',
    warning: 'bg-amber-500/10 border border-amber-500/30 text-amber-400 hover:bg-amber-500/20',
    ghost:   'bg-transparent text-gray-400 hover:text-gray-200',
  }
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  )
}
