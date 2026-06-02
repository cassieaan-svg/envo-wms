export function Input({ className = '', ...props }) {
  return (
    <input
      className={`w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2 text-sm text-gray-100
        placeholder:text-gray-500 focus:outline-none focus:border-blue-500 transition-colors ${className}`}
      {...props}
    />
  )
}

export function Select({ children, className = '', ...props }) {
  return (
    <select
      className={`bg-white/5 border border-white/15 rounded-lg px-3 py-2 text-sm text-gray-100
        focus:outline-none focus:border-blue-500 transition-colors appearance-none ${className}`}
      {...props}
    >
      {children}
    </select>
  )
}
