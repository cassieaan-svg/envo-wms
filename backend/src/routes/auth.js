import express from 'express';
import { UserService } from '../services/userService.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }

    const result = await UserService.login(username, password);
    if (!result) {
      return res.status(401).json({ error: 'invalid credentials' });
    }
    return res.json(result);
  } catch (err) {
    // A stale local roster is a 503, not a 500: the credentials may well be right, the
    // warehouse simply cannot vouch for them any more. The message tells the operator that.
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    return next(err);
  }
});

router.put('/password', authMiddleware, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'new password must be at least 8 characters' });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({ error: 'new password must differ from the current one' });
    }

    await UserService.changePassword(req.user.id, { currentPassword, newPassword });
    return res.json({ changed: true });
  } catch (err) {
    return next(err);
  }
});

router.get('/me', authMiddleware, async (req, res, next) => {
  try {
    const user = await UserService.getById(req.user.id);
    if (!user) return res.status(404).json({ error: 'user not found' });
    return res.json({ id: user.id, username: user.username, fullName: user.full_name, role: user.role });
  } catch (err) {
    return next(err);
  }
});

export default router;
