// The commodity programmes the app hosts. Mirrors the `modules` reference table
// (db/migrations/20260801_modules.sql). Kept as a constant so scope.js can validate
// an incoming module without a DB round-trip on every request.
//
// A caller's active module arrives per-request via the `x-envo-module` header (or a
// `?module=` query param). When neither is present we default to 'hiv' so the
// existing HIV frontend — which sends no module yet — behaves exactly as before.
export const MODULES = ['hiv', 'essential']
export const DEFAULT_MODULE = 'hiv'

export function isModule(value) {
  return MODULES.includes(value)
}
