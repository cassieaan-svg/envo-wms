const KEY = 'envo_wms_theme';

export function getStoredTheme() {
  return localStorage.getItem(KEY) || 'system';
}

export function storeTheme(theme) {
  localStorage.setItem(KEY, theme);
}

export function systemPrefersDark() {
  // Defaults to dark when the browser can't tell us, matching EnVo.
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
}

export function resolveDark(theme, systemDark) {
  if (theme === 'system') return systemDark;
  return theme !== 'light';
}

// Called from main.jsx before React mounts so the first paint is already the right theme.
export function applyTheme(dark) {
  document.documentElement.classList.toggle('dark', dark);
}
