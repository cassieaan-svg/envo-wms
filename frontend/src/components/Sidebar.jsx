import { sb } from '../lib/supabase'
import { useAppStore } from '../store/appStore'
import { PharmacyNav } from '../pages/pharmacy/Nav'
import { LabNav }      from '../pages/lab/Nav'
import { AdminNav }    from '../pages/admin/Nav'
import { DsdNav }      from '../pages/dsd/Nav'
import { SdpNav }      from '../pages/sdp/Nav'

export function Sidebar() {
  const store      = useAppStore()
  const sectionIcon = store.commoditySection === 'lab' ? '🧪' : store.commoditySection === 'pharmacy' ? '💊' : '⬡'
  const sectionName = store.commoditySection === 'lab' ? 'Laboratory' : store.commoditySection === 'pharmacy' ? 'Pharmacy' : 'EnVo'

  const NavComponent = store.isAdmin()
    ? AdminNav
    : store.isSDP()
    ? SdpNav
    : store.isDSD()
    ? DsdNav
    : store.commoditySection === 'lab'
    ? LabNav
    : PharmacyNav

  return (
    <>
      {/* Overlay */}
      {store.sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => store.setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`
        fixed left-0 top-0 bottom-0 w-56 bg-gray-950 border-r border-white/8 z-50
        flex flex-col transition-transform duration-250
        ${store.sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        lg:translate-x-0
      `}>
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-4 py-4 border-b border-white/8">
          <div className="w-8 h-8 bg-green-500 rounded-lg flex items-center justify-center text-base flex-shrink-0">
            {sectionIcon}
          </div>
          <div>
            <div className="text-sm font-semibold text-gray-100">{sectionName}</div>
            <div className="text-xs text-gray-500">HIV Programme</div>
          </div>
        </div>

        {/* User info */}
        <div className="mx-3 my-2 px-3 py-2 bg-green-500/10 border border-green-500/20 rounded-lg">
          <div className="text-xs text-gray-500 uppercase tracking-widest mb-0.5">Logged in as</div>
          {store.isDSD() && store.dsdFacilities?.length > 1 ? (
            <select
              value={store.currentFacility?.id || ''}
              onChange={e => {
                const fac = store.dsdFacilities.find(f => f.id === e.target.value)
                if (fac) { store.setCurrentFacility(fac); store.setCurrentPage('dispense') }
              }}
              className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-gray-100 focus:outline-none focus:border-green-500 mt-0.5"
            >
              {store.dsdFacilities.map(f => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          ) : (
            <div className="text-sm font-medium text-gray-100 leading-snug">
              {store.isDSD() && store.dsdSiteName
                ? store.dsdSiteName
                : store.isSDP() && store.sdpName
                ? store.sdpName
                : store.currentFacility?.name || store.getSectionLabel() || '—'}
            </div>
          )}
          {(store.isDSD() || store.isSDP()) && store.currentFacility?.name && (
            <div className="text-xs text-gray-500 mt-0.5">{store.currentFacility.name}</div>
          )}
          <div className="text-xs text-green-400 mt-0.5">{store.getSectionLabel()}</div>

        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-2 overflow-y-auto">
          <NavComponent />
        </nav>

        {/* Footer */}
        <div className="px-3 pb-4 space-y-2">
          <button
            onClick={() => store.setTheme(store.theme === 'light' ? 'dark' : 'light')}
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-white/5 border border-white/8 text-xs text-gray-400 hover:bg-white/8 transition-colors"
          >
            <span>{store.theme === 'light' ? '🌙 Dark mode' : '☀ Light mode'}</span>
            <div className={`w-8 h-4 rounded-full relative transition-colors ${store.theme === 'light' ? 'bg-green-500' : 'bg-white/20'}`}>
              <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all ${store.theme === 'light' ? 'left-4' : 'left-0.5'}`} />
            </div>
          </button>
          <button
            onClick={async () => {
              const { sb } = await import('../lib/supabase')
              await sb.auth.signOut()
              store.reset()
            }}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/25 text-red-400 text-xs hover:bg-red-500/20 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M6 2H3a1 1 0 00-1 1v10a1 1 0 001 1h3M10 11l3-3-3-3M13 8H6"/>
            </svg>
            Sign out
          </button>
        </div>
      </aside>
    </>
  )
}
