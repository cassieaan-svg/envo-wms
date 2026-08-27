// Where the warehouse server lives.
//
// An installed PWA is one build running on many devices, and the CMS server's address is a
// property of the SITE, not of the build. Baking it in at compile time would mean rebuilding
// the app to change an IP — so the address is resolved at RUNTIME, in this order:
//
//   1. what this device was configured with (localStorage), set on the sign-in screen
//   2. VITE_API_URL, if the build was made for a known deployment
//   3. same origin — correct when the CMS server also serves the app, which is the
//      simplest way to run it and the one that needs no configuration at all
//
// There is deliberately no localhost default. On a warehouse tablet `localhost` is the
// tablet, not the store server, and a default that is wrong on every device except the
// developer's is worse than no default: it fails in a way that looks like the server is
// down.

const KEY = 'wms_cms_server';

// Trailing slashes and a pasted-in "/api" are the two things people actually type. Strip
// both rather than making the operator's URL a trick question.
export function normaliseServerUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  const withScheme = /^https?:\/\//i.test(value) ? value : `http://${value}`;
  return withScheme.replace(/\/+$/, '').replace(/\/api$/i, '');
}

export function isValidServerUrl(raw) {
  const v = normaliseServerUrl(raw);
  if (!v) return false;
  try {
    const u = new URL(v);
    return !!u.hostname;
  } catch {
    return false;
  }
}

/** The address this device was configured with, if any. */
export function getConfiguredServer() {
  try {
    return localStorage.getItem(KEY) || '';
  } catch {
    return '';   // private mode / storage disabled
  }
}

export function setConfiguredServer(raw) {
  const v = normaliseServerUrl(raw);
  try {
    if (v) localStorage.setItem(KEY, v);
    else localStorage.removeItem(KEY);
  } catch { /* nothing we can do; the value still applies to this session via the caller */ }
  return v;
}

export function clearConfiguredServer() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/**
 * The base URL every API call is built on. '' means same origin, which is what the fetch
 * layer wants for a relative path.
 */
export function getServerBase() {
  const configured = getConfiguredServer();
  if (configured) return configured;

  const built = import.meta.env?.VITE_API_URL;
  // `??` not `||`: an explicitly empty VITE_API_URL means "same origin" and must not fall
  // through to the next option.
  if (built != null && built !== undefined) return built;

  return '';
}

/** For the UI: where are we pointed, and how was that decided? */
export function describeServer() {
  const configured = getConfiguredServer();
  if (configured) return { url: configured, source: 'device', label: configured };

  const built = import.meta.env?.VITE_API_URL;
  if (built) return { url: built, source: 'build', label: built };

  return {
    url: '',
    source: 'same-origin',
    label: typeof location !== 'undefined' ? location.origin : 'this server',
  };
}
