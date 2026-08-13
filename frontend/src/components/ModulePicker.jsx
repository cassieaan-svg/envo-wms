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
      </div>
    </div>
  )
}
