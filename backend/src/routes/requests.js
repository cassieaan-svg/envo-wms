import express from 'express';
import { RequestService } from '../services/requestService.js';
import { IdempotencyService } from '../services/idempotencyService.js';
import { requirePermission } from '../middleware/requirePermission.js';

const router = express.Router();

// Warehouse-facing request queue (user JWT, applied globally under /api in server.js).
// The pick list is just the request detail rendered in a print view on the frontend.

const who = (req) => req.user?.fullName || req.user?.username || req.user?.sub || null;

/** GET /api/requests?status=pending — the warehouse queue. */
router.get('/', async (req, res) => {
  try {
    res.json(await RequestService.listQueue({ status: req.query.status || null }));
  } catch (err) {
    console.error('list requests error:', err);
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/requests/:id — request detail / pick list. */
router.get('/:id', async (req, res) => {
  try {
    const request = await RequestService.getById(Number(req.params.id));
    if (!request) return res.status(404).json({ error: 'not found' });
    res.json(request);
  } catch (err) {
    console.error('get request error:', err);
    res.status(500).json({ error: err.message });
  }
});

/** PATCH /api/requests/:id/picking — mark as being picked. Body: { pickedBy }. */
router.patch('/:id/picking', requirePermission('requests.fulfil'), async (req, res) => {
  try {
    const request = await RequestService.markPicking(Number(req.params.id), {
      pickedBy: req.body?.pickedBy,

    });
    if (!request) return res.status(409).json({ error: 'request is not pending' });
    res.json(request);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('mark picking error:', err);
    res.status(status).json({ error: err.message });
  }
});

/**
 * POST /api/requests/:id/fulfil — dispatch. Body: { carrierName, carrierPhone, pickedBy?, dispatchedBy? }.
 * Previously reachable by any logged-in user with no role check — a gap the Phase 1 audit
 * flagged explicitly. Now requires requests.fulfil.
 */
router.post('/:id/fulfil', requirePermission('requests.fulfil'), async (req, res) => {
  try {
    const request = await RequestService.fulfil(Number(req.params.id), {
      // Typed name wins; who(req) (the login) is only the fallback. Store logins are
      // shared, so the account name says nothing about who released the stock.
      dispatchedBy: (typeof req.body?.dispatchedBy === 'string' && req.body.dispatchedBy.trim())
        || who(req),
      carrierName: req.body?.carrierName,
      carrierPhone: req.body?.carrierPhone,
      pickedBy: req.body?.pickedBy,
      items: req.body?.items,   // optional [{ itemId, qty }] — issue quantities set while picking
      clientTxnId: IdempotencyService.require(req.body?.clientTxnId),
      actorUserId: req.user?.id ?? null,
    });
    res.json(request);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('fulfil request error:', err);
    res.status(status).json({ error: err.message });
  }
});

/**
 * POST /api/requests/:id/reject — reject a request the warehouse can't fill. Body: { reason }.
 * Shares requests.fulfil rather than a separate permission: rejecting is the negative branch
 * of the same fulfilment decision, not a distinct capability — see the Phase 1 design.
 */
router.post('/:id/reject', requirePermission('requests.fulfil'), async (req, res) => {
  try {
    const request = await RequestService.reject(Number(req.params.id), {
      rejectedBy: (typeof req.body?.rejectedBy === 'string' && req.body.rejectedBy.trim())
        || who(req),
      reason: req.body?.reason,
    });
    res.json(request);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('reject request error:', err);
    res.status(status).json({ error: err.message });
  }
});

/**
 * POST /api/requests/:id/receipt — record who received it at the facility.
 * Previously reachable by any logged-in user with no role check — a gap the Phase 1 audit
 * flagged explicitly. Now requires requests.receipt.
 */
router.post('/:id/receipt', requirePermission('requests.receipt'), async (req, res) => {
  try {
    const { receivedBy } = req.body || {};
    if (!receivedBy?.trim()) return res.status(400).json({ error: 'receivedBy is required' });

    const request = await RequestService.recordReceipt(Number(req.params.id), {
      receivedBy: receivedBy.trim(),
    });
    if (!request) return res.status(404).json({ error: 'request not found' });
    res.json(await RequestService.getById(request.id));
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('record receipt error:', err);
    res.status(status).json({ error: err.message });
  }
});

export default router;
