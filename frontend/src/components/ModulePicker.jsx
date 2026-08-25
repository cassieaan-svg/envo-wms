import { useAppStore } from '../store/appStore'

// Per-module accent colour. Anything returned by GET /api/modules but not listed here
// still renders with the neutral accent.
const ACCENT_BY_KEY = { hiv: 'green', essential: 'blue' }

const ACCENT = {
  green: { ring: 'hover:border-green-500/70 focus:border-green-500', glow: 'group-hover:text-green-400' },
  blue:  { ring: 'hover:border-blue-500/70 focus:border-blue-500',   glow: 'group-hover:text-blue-400' },
  slate: { ring: 'hover:border-white/25 focus:border-white/40',      glow: 'group-hover:text-gray-200' },
}

export function ModulePicker() {
  const modules   = useAppStore(s => s.availableModules)
  const setModule = useAppStore(s => s.setModule)
  const store     = useAppStore()

  // This screen sits between sign-in and the app, and it is a dead end for anyone whose
  // account can't open any module shown — without this they'd have to clear the tab to
  // get back to the login form. Mirrors the sidebar's sign-out exactly (close realtime,
  // drop the token, reset the store) so the two can't drift.
  async function signOut() {
    const { auth } = await import('../lib/api')
    const { closeRealtime } = await import('../lib/realtime')
    closeRealtime()
    auth.signOut()
    store.reset()
  }

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-2xl">
        <div className="text-center mb-8">
          <div className="w-12 h-12 bg-green-500 rounded-2xl inline-flex items-center justify-center text-xl mb-3">⬡</div>
          <h1 className="text-2xl font-semibold text-gray-100">Choose a module</h1>
          <p className="text-sm text-gray-500 mt-1">Pick the programme you want to work in.</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {modules.map(m => {
            const accent = ACCENT[ACCENT_BY_KEY[m.key]] || ACCENT.slate
            const disabled = !m.enrolled
            return (
              <button
                key={m.key}
                type="button"
                disabled={disabled}
                onClick={() => !disabled && setModule(m.key)}
                className={[
                  'group text-left rounded-2xl border p-5 transition-colors min-h-[120px] flex flex-col justify-between',
                  disabled
                    ? 'bg-gray-900/40 border-white/5 opacity-45 cursor-not-allowed'
                    : `bg-gray-900 border-white/10 ${accent.ring} focus:outline-none cursor-pointer`,
                ].join(' ')}
              >
                <div className={`text-base font-semibold text-gray-100 ${!disabled ? accent.glow : ''}`}>{m.label}</div>
                {disabled
                  ? <span className="mt-3 text-xs text-gray-600">Not enabled for your account</span>
                  : <span className="mt-3 text-xs font-medium text-gray-400 group-hover:text-gray-200">Enter →</span>}
              </button>
            )
          })}
        </div>

        <div className="mt-8 text-center">
          <button
            type="button"
            onClick={signOut}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-gray-400 text-xs hover:bg-white/8 hover:text-gray-200 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M6 2H3a1 1 0 00-1 1v10a1 1 0 001 1h3M10 11l3-3-3-3M13 8H6"/>
            </svg>
            Sign out
          </button>
        </div>
      </div>
    </div>
  )
}
