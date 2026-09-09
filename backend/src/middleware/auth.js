import jwt from 'jsonwebtoken';
import { query } from '../db.js';

// Verifies the Bearer token issued by /api/auth/login and sets req.user.
// WMS has its own users table — these are not EnVo @envo.ng accounts.
export async function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'missing bearer token' });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'invalid or expired token' });
  }

  try {
    // The local emergency lockout (migration 040) is checked on every request, ahead of any
    // permission resolution — it must take effect immediately, including when this instance
    // cannot reach Cloud to disable the account the ordinary way. Never synced in either
    // direction, so it can't be cleared by an incoming roster pull and can't contend with
    // Cloud's authoritative role/permission grants.
    const { rows } = await query('SELECT is_locally_disabled FROM users WHERE id = $1', [payload.sub]);
    if (rows[0]?.is_locally_disabled) {
      return res.status(403).json({ error: 'account disabled on this instance' });
    }
    req.user = { id: payload.sub, username: payload.username, role: payload.role };
    return next();
  } catch (err) {
    return next(err);
  }
}
