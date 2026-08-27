import express from 'express';
import { DispatchService } from '../services/dispatchService.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { IdempotencyService } from '../services/idempotencyService.js';

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
      clientTxnId: IdempotencyService.require(req.body?.clientTxnId),
      actorUserId: req.user.id,
    });
    return res.json(order);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/dispatch-orders/:id/print — take a copy of the waybill.
 *
 * Returns the label the sheet should carry (ORIGINAL, then REPRINT #1, #2 …). Writes no
 * movement and no inventory transaction: printing is not a stock operation, and there is a
 * test that holds it to that.
 */
router.post('/:id/print', async (req, res, next) => {
  try {
    const record = await DispatchService.recordPrint(Number(req.params.id), {
      printedBy: (typeof req.body?.printedBy === 'string' && req.body.printedBy.trim())
        || req.user?.fullName || req.user?.username || null,
    });
    return res.status(201).json(record);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

/** GET /api/dispatch-orders/:id/prints — who has printed this, and when. */
router.get('/:id/prints', async (req, res, next) => {
  try {
    return res.json(await DispatchService.printHistory(Number(req.params.id)));
  } catch (err) {
    return next(err);
  }
});

export default router;
