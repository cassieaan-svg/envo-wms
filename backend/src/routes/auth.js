import express from 'express'
import { verifyCredentials, makeToken, userPayload, getUserById, setPassword } from '../services/authService.js'
import { authMiddleware } from '../middleware/auth.js'

const router = express.Router()

// POST /auth/login  { email, password } -> { token, user }
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {}
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' })
  try {
    const u = await verifyCredentials(email, password)
    if (!u) return res.status(401).json({ error: 'Invalid login credentials' })
    res.json({ token: makeToken(u), user: userPayload(u) })
  } catch (err) {
    console.error('[auth] login error:', err.message)
    res.status(500).json({ error: 'Sign in failed.' })
  }
})

// GET /auth/me -> { user }  (restore session from the bearer token)
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const u = await getUserById(req.user.sub)
    if (!u) return res.status(404).json({ error: 'User not found' })
    res.json({ user: userPayload(u) })
  } catch (err) {
    console.error('[auth] me error:', err.message)
    res.status(500).json({ error: 'Could not load session.' })
  }
})

// POST /auth/password  { password } -> { ok: true }  (change own password)
router.post('/password', authMiddleware, async (req, res) => {
  const { password } = req.body || {}
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' })
  try {
    await setPassword(req.user.sub, password)
    res.json({ ok: true })
  } catch (err) {
    console.error('[auth] password change error:', err.message)
    res.status(500).json({ error: 'Could not change password.' })
  }
})

export default router
