// Shared-secret auth for server-to-server calls from EnVo (catalogue sync now; the
// request round-trip later). This is NOT a user login — it's a single token in the
// env, sent as the `x-service-token` header. Rotate by changing SERVICE_TOKEN in both
// apps' env. Requests without a matching token are rejected before any handler runs.
export function serviceAuth(req, res, next) {
  const expected = process.env.SERVICE_TOKEN;
  const got = req.get('x-service-token');
  if (!expected) return res.status(503).json({ error: 'service token not configured' });
  if (!got || got !== expected) return res.status(401).json({ error: 'invalid service token' });
  next();
}
