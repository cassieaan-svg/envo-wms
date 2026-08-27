import express from 'express';
import { BatchService } from '../services/batchService.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { IdempotencyService } from '../services/idempotencyService.js';

const router = express.Router();

// Served rather than duplicated in the UI, so the dropdown and the CHECK constraint can
// never drift apart. Registered before /:id so 'adjustment-reasons' is not read as an id.
router.get('/adjustment-reasons', (req, res) => {
  return res.json(
    Object.entries(BatchService.ADJUSTMENT_REASONS).map(([code, { label, direction }]) => ({
      code,
      label,
      direction,
    }))
  );
});

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const { commodityId, expiryDate, quantity } = req.body || {};
    if (!commodityId) return res.status(400).json({ error: 'commodityId is required' });
    if (!expiryDate) return res.status(400).json({ error: 'expiryDate is required' });
    if (!(Number(quantity) > 0)) return res.status(400).json({ error: 'quantity must be greater than zero' });

    const batch = await BatchService.receive({
      commodityId: Number(commodityId),
      vendorId: req.body.vendorId ? Number(req.body.vendorId) : null,
      batchNumber: req.body?.batchNumber,
      expiryDate,
      quantity: Number(quantity),
      unitCost: req.body.unitCost != null ? Number(req.body.unitCost) : null,
      receivedDate: req.body.receivedDate || null,
      createdBy: req.user.username,
      // Optional: when supplied, a retry of this receipt returns the original batch
      // instead of creating a second lot. Validated here so a malformed id is a clear 400.
      clientTxnId: IdempotencyService.require(req.body?.clientTxnId),
      actorUserId: req.user.id,
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

// Label a lot after the fact — opening stock from a physical count has no number yet.
router.put('/:id/number', requireAdmin, async (req, res, next) => {
  try {
    const batch = await BatchService.setBatchNumber(Number(req.params.id), {
      batchNumber: req.body?.batchNumber,
    });
    if (!batch) return res.status(404).json({ error: 'batch not found' });
    return res.json(batch);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'that batch number already exists for this commodity' });
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
    const { delta, quantity, reason, note, adjustedBy } = req.body || {};
    const amount = quantity ?? delta;
    if (amount == null || Number.isNaN(Number(amount)) || Number(amount) === 0) {
      return res.status(400).json({ error: 'quantity must be a non-zero number' });
    }
    // The reason is the record; a free-text note is optional colour on top of it.
    if (!reason) return res.status(400).json({ error: 'reason is required for an adjustment' });

    const batch = await BatchService.adjust(Number(req.params.id), {
      quantity: Number(amount),
      reason,
      note: note?.trim() || null,
      // Whoever physically did the count signs for it. Falls back to the account in use,
      // which is the same person unless a store shares a login.
      createdBy: adjustedBy?.trim() || req.user.username,
      clientTxnId: IdempotencyService.require(req.body?.clientTxnId),
      actorUserId: req.user.id,
    });
    return res.json(batch);
  } catch (err) {
    return next(err);
  }
});

export default router;
