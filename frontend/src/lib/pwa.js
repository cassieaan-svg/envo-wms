// Service-worker registration.
//
// The worker caches the application SHELL — the HTML, JavaScript, CSS, fonts and icons — so
// the app opens on a device that has no internet. It caches no warehouse data at all: stock
// levels, batches and request statuses always come from the CMS server over the LAN, or they
// do not come at all. See the workbox config in vite.config.js for why that line is drawn
// where it is.
//
// The import is dynamic and failure is swallowed. A browser with service workers disabled,
// or a page served over plain HTTP from an origin the browser will not register a worker
// for, must still run the application normally over the LAN — the worker is an improvement
// to how the app STARTS, never a requirement for it to WORK.

let onUpdateReady = null;

/** Called by the app to be told when a new version is waiting. */
export function onUpdateAvailable(fn) {
  onUpdateReady = fn;
}

let applyUpdate = null;

/** Activate the waiting worker and reload. Wired to the "Update" button. */
export function applyPendingUpdate() {
  if (applyUpdate) applyUpdate(true);
}

export async function registerServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

  try {
    const { registerSW } = await import('virtual:pwa-register');
    applyUpdate = registerSW({
      immediate: true,
      onNeedRefresh() {
        // A new build is cached and waiting. The user is told rather than interrupted:
        // reloading mid-dispatch would throw away what they were typing.
        onUpdateReady?.();
      },
      onRegisterError(err) {
        console.warn('[pwa] service worker did not register:', err?.message || err);
      },
    });
  } catch (err) {
    // Dev server (the worker is disabled there), an unsupported browser, or an insecure
    // origin. None of these should stop the warehouse working.
    console.info('[pwa] shell caching unavailable:', err?.message || err);
  }
}

/**
 * Is this running as an installed application rather than a browser tab?
 *
 * Used only to soften the UI — an installed window has no address bar, so it is worth not
 * telling the user to "bookmark this page".
 */
export function isInstalled() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)')?.matches
    || window.navigator?.standalone === true;
}
