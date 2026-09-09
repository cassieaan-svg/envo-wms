import { AuthzService } from '../services/authzService.js';

// Replaces requireAdmin. Runs after authMiddleware, so req.user is already populated.
// Fail-closed: any resolution error is passed to the error handler, never treated as "allow".
export function requirePermission(key) {
  return async function requirePermissionMiddleware(req, res, next) {
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'missing bearer token' });
      const allowed = await AuthzService.hasPermission(req.user.id, key);
      if (!allowed) return res.status(403).json({ error: `permission required: ${key}` });
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
