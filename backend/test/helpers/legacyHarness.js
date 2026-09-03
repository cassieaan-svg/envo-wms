import { attachScope } from '../../src/middleware/scope.js'

// Shared harness for exercising the REAL legacy guards in a test, without an
// HTTP server. Same pattern used throughout this project's scope.js tests:
// build req.scope exactly as attachScope does in production, fake a `res` that
// records its verdict instead of writing an HTTP response, and reduce a guard
// call to a plain boolean.

export function scopeFor(meta, queryParams = {}) {
  const req = { user: { user_metadata: meta }, get: () => null, query: queryParams }
  attachScope(req, {}, () => {})
  return req
}

export function fakeRes() {
  const rec = { status: null, body: null }
  return { rec, status(code) { rec.status = code; return { json(b) { rec.body = b; return b } } } }
}

// Runs a guard that takes (req, res, ...) and writes a 403 on denial. Reduces
// it to true/false, asserting the guard's own contract along the way (a denial
// must both return false and have written a 403).
export async function verdict(fn) {
  const res = fakeRes()
  const allowed = await fn(res)
  if (allowed === false) {
    if (res.rec.status !== 403) throw new Error(`guard denied without a 403 (got ${res.rec.status})`)
  }
  return allowed === true
}
