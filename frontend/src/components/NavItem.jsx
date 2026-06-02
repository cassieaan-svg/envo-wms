import { useAppStore } from '../store/appStore'

export function NavSection({ children }) {
  return (
    <div className="text-xs text-gray-600 uppercase tracking-widest px-3 pt-3 pb-1 mt-1">
      {children}
    </div>
  )
}

export function NavItem({ page, icon, children, disabled = false, badge = null }) {
  const store = useAppStore()
  const isActive = store.currentPage === page

  if (disabled) {
    return (
      <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-gray-600 cursor-not-allowed opacity-50 mb-0.5">
        <span className="w-4 h-4 flex-shrink-0">{icon}</span>
        {children}
      </div>
    )
  }

  return (
    <button
      onClick={() => {
        store.setCurrentPage(page)
        store.setSidebarOpen(false)
      }}
      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-all mb-0.5 text-left
        ${isActive
          ? 'bg-white/8 text-gray-100 font-medium'
          : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
        }`}
    >
      <span className="w-4 h-4 flex-shrink-0 flex items-center justify-center">{icon}</span>
      <span className="flex-1">{children}</span>
      {badge !== null && badge > 0 && (
        <span className="bg-amber-400 text-black text-xs font-bold rounded-full px-1.5 py-0.5 min-w-[18px] text-center">
          {badge}
        </span>
      )}
    </button>
  )
}
