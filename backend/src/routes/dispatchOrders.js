import express from 'express';
import { DispatchService } from '../services/dispatchService.js';

const router = express.Router();

// Receipt-style detail for one order, including which batches each line drew from.
router.get('/:id', async (req, res, next) => {
  try {
    const order = await DispatchService.getOrder(Number(req.params.id));
    if (!order) return res.status(404).json({ error: 'dispatch order not found' });
    return res.json(order);
  } catch (err) {
    return next(err);
  }
});

export default router;
