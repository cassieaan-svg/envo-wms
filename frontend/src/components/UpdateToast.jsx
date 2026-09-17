import { useEffect, useState } from 'react'
import { applyPendingUpdate, onUpdateAvailable } from '../lib/pwa'

// A new cached build is waiting. Told, not forced — reloading mid-dispense or
// mid-intake would throw away whatever the user was part-way through typing.
export function UpdateToast() {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    onUpdateAvailable(() => setReady(true))
  }, [])

  if (!ready) return null

  return (
    <div className="fixed bottom-4 inset-x-4 sm:inset-x-auto sm:right-4 sm:max-w-sm z-50
                    bg-gray-900 border border-white/10 rounded-xl p-4 shadow-lg
                    flex items-center justify-between gap-3">
      <p className="text-sm text-gray-200">
        A new version is ready. It will be used next time the app opens, or update now.
      </p>
      <button
        type="button"
        onClick={applyPendingUpdate}
        className="shrink-0 px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-500 text-white text-xs font-medium transition-colors"
      >
        Update now
      </button>
    </div>
  )
}
