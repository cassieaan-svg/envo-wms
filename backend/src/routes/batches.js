import express from 'express';
import { BatchService } from '../services/batchService.js';
import { requireAdmin } from '../middleware/requireAdmin.js';

const router = express.Router();

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const { commodityId, batchNumber, expiryDate, quantity } = req.body || {};
    if (!commodityId) return res.status(400).json({ error: 'commodityId is required' });
    if (!batchNumber?.trim()) return res.status(400).json({ error: 'batchNumber is required' });
    if (!expiryDate) return res.status(400).json({ error: 'expiryDate is required' });
    if (!(Number(quantity) > 0)) return res.status(400).json({ error: 'quantity must be greater than zero' });

    const batch = await BatchService.receive({
      commodityId: Number(commodityId),
      vendorId: req.body.vendorId ? Number(req.body.vendorId) : null,
      batchNumber: batchNumber.trim(),
      expiryDate,
      quantity: Number(quantity),
      unitCost: req.body.unitCost != null ? Number(req.body.unitCost) : null,
      receivedDate: req.body.receivedDate || null,
      createdBy: req.user.username,
    });
    return res.status(201).json(batch);
  } catch (err) {
    // 23505 unique_violation — a repeat batch number for the same commodity usually means
    // someone is re-keying a receipt that already landed.
    if (err.code === '23505') {
      return res.status(409).json({ error: 'that batch number already exists for this commodity' });
    }
    // 23503 foreign_key_violation — commodityId or vendorId doesn't exist.
    if (err.code === '23503') {
      return res.status(400).json({ error: 'unknown commodityId or vendorId' });
    }
    return next(err);
  }
});

router.get('/:id/movements', async (req, res, next) => {
  try {
    return res.json(await BatchService.movements(Number(req.params.id)));
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/adjust', requireAdmin, async (req, res, next) => {
  try {
    const { delta, note } = req.body || {};
    if (delta == null || Number.isNaN(Number(delta)) || Number(delta) === 0) {
      return res.status(400).json({ error: 'delta must be a non-zero number' });
    }
    if (!note?.trim()) return res.status(400).json({ error: 'note is required for an adjustment' });

    const batch = await BatchService.adjust(Number(req.params.id), {
      delta: Number(delta),
      note: note.trim(),
      createdBy: req.user.username,
    });
    return res.json(batch);
  } catch (err) {
    return next(err);
  }
});

export default router;
