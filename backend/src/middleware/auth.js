import jwt from 'jsonwebtoken';

// Verifies the Bearer token issued by /api/auth/login and sets req.user.
// WMS has its own users table — these are not EnVo @envo.ng accounts.
export function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'missing bearer token' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.sub, username: payload.username, role: payload.role };
    return next();
  } catch {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
}
