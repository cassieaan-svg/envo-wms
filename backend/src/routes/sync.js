import express from 'express';
import { OutboxService } from '../services/outboxService.js';

const router = express.Router();

// Whether anything is still queued for EnVo. Staff need this on the Requests page: when
// the store is offline the queue is expected to grow, and the marker tells them the
// backlog is being held rather than lost.
router.get('/status', async (req, res, next) => {
  try {
    return res.json(await OutboxService.status());
  } catch (err) {
    return next(err);
  }
});

export default router;
