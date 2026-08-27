// Shared-secret auth for the CMS <-> Cloud link.
//
// A DIFFERENT secret from the EnVo SERVICE_TOKEN, deliberately. They authorise different
// relationships, and a machine sitting in a warehouse should not be holding the credential
// that lets someone talk to EnVo as though they were Cloud.
export function syncAuth(req, res, next) {
  const expected = process.env.SYNC_TOKEN;
  const got = req.get('x-sync-token');
  if (!expected) return res.status(503).json({ error: 'sync token not configured' });
  if (!got || got !== expected) return res.status(401).json({ error: 'invalid sync token' });
  return next();
}
