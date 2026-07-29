// Gate for writes that touch prices, batches, dispatch orders, stock thresholds and
// facility assignments. Runs after authMiddleware, so req.user is already populated.
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'admin role required' });
  }
  return next();
}
