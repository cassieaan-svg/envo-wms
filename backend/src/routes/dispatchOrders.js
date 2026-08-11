import express from 'express';
import { DispatchService } from '../services/dispatchService.js';
import { requireAdmin } from '../middleware/requireAdmin.js';

const router = express.Router();

// The dispatch log across every facility, or one facility when ?facilityId= is given.
router.get('/', async (req, res, next) => {
  try {
    const facilityId = req.query.facilityId ? Number(req.query.facilityId) : null;
    return res.json(await DispatchService.list({ facilityId }));
  } catch (err) {
    return next(err);
  }
});

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

// Correct an already-dispatched order. Stock is returned to its original lots and drawn
// again — see DispatchService.updateOrder.
router.put('/:id', requireAdmin, async (req, res, next) => {
  try {
    const { items, notes } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items must be a non-empty array' });
    }
    for (const [index, item] of items.entries()) {
      if (!item?.commodityId) return res.status(400).json({ error: `items[${index}].commodityId is required` });
      if (!(Number(item.quantity) > 0)) return res.status(400).json({ error: `items[${index}].quantity must be greater than zero` });
      if (item.unitPrice == null || !(Number(item.unitPrice) >= 0)) {
        return res.status(400).json({ error: `items[${index}].unitPrice must be a non-negative number` });
      }
    }
    if (items.length !== new Set(items.map((i) => Number(i.commodityId))).size) {
      return res.status(400).json({ error: 'each commodity may only appear once per order' });
    }

    const order = await DispatchService.updateOrder(Number(req.params.id), {
      items,
      notes,
      editedBy: req.user.username,
    });
    return res.json(order);
  } catch (err) {
    return next(err);
  }
});

export default router;
