// Service-worker registration.
//
// Ported from envo-wms's own lib/pwa.js (the warehouse app's PWA is the working
// template — see docs/ESSENTIAL_COMMODITIES_OFFLINE_DESIGN.md in that sibling
// project). Same contract: the worker caches the application SHELL only — HTML, JS,
// CSS, fonts, icons — so the app OPENS with no connection. It caches no facility
// data of its own; that's the IndexedDB layer (not built yet), a separate concern
// from "does the app load at all". Catalogue, stock and every write still go through
// the network only, or the not-yet-built local queue — never the service worker
// cache. See the workbox config in vite.config.js for where that line is drawn.
//
// The import is dynamic and failure is swallowed. A browser with service workers
// disabled, or an insecure origin the browser won't register a worker for, must
// still run the app normally over the network — the worker improves how the app
// STARTS, it is never a requirement for it to WORK.

let onUpdateReady = null

/** Called by the app to be told when a new version is waiting. */
export function onUpdateAvailable(fn) {
  onUpdateReady = fn
}

let applyUpdate = null

/** Activate the waiting worker and reload. Wired to the "Update now" button. */
export function applyPendingUpdate() {
  if (applyUpdate) applyUpdate(true)
}

export async function registerServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return

  try {
    const { registerSW } = await import('virtual:pwa-register')
    applyUpdate = registerSW({
      immediate: true,
      onNeedRefresh() {
        // A new build is cached and waiting. The user is told rather than
        // interrupted: reloading mid-dispense would throw away what they were typing.
        onUpdateReady?.()
      },
      onRegisterError(err) {
        console.warn('[pwa] service worker did not register:', err?.message || err)
      },
    })
  } catch (err) {
    // Dev server (the worker is disabled there), an unsupported browser, or an
    // insecure origin. None of these should stop the app working.
    console.info('[pwa] shell caching unavailable:', err?.message || err)
  }
}

/**
 * Is this running as an installed application rather than a browser tab?
 * Used only to soften the UI — an installed window has no address bar.
 */
export function isInstalled() {
  if (typeof window === 'undefined') return false
  return window.matchMedia?.('(display-mode: standalone)')?.matches
    || window.navigator?.standalone === true
}
