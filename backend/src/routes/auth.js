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
