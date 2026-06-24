import jwt from 'jsonwebtoken'

// Verify our own JWT (issued by /auth/login). Replaces the Supabase token
// verification. On success req.user = { sub, email, user_metadata }.
export function authMiddleware(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' })
  }
  try {
    req.user = jwt.verify(header.slice(7), process.env.JWT_SECRET)
    next()
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}
