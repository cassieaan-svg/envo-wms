// Shared-secret auth for server-to-server calls from the WMS (the warehouse request
// status callback). NOT a user login — a single token (SERVICE_TOKEN) sent as the
// `x-service-token` header, matching the same-named middleware in the envo-wms repo.
// Mounted on the /hooks path, outside the user-JWT (/api) layer.
export function serviceAuth(req, res, next) {
  const expected = process.env.SERVICE_TOKEN
  const got = req.get('x-service-token')
  if (!expected) return res.status(503).json({ success: false, error: 'service token not configured', code: 'NO_SERVICE_TOKEN' })
  if (!got || got !== expected) return res.status(401).json({ success: false, error: 'invalid service token', code: 'BAD_SERVICE_TOKEN' })
  next()
}
