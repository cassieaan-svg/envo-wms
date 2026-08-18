import express from 'express';
import { RequestService } from '../services/requestService.js';

const router = express.Router();

// Server-to-server intake of a facility request from EnVo. Service-token auth (mounted
// before the user-JWT layer). Body:
//   { envoRequestId, envoFacilityId, facilityName, requestedBy, requesterPhone, notes,
//     items:[{ wmsCommodityId, quantity }] }
router.post('/', async (req, res) => {
  try {
    const request = await RequestService.receiveFromEnvo(req.body || {});
    res.status(201).json({ requestId: request.id, status: request.status, total: request.total_amount });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('inbound request error:', err);
    res.status(status).json({ error: err.message });
  }
});

// EnVo tells us the facility cancelled the request; drop it from the queue if unshipped.
// Body: { envoRequestId, reason? }. Always 2xx (idempotent) so the EnVo outbox settles.
router.post('/cancel', async (req, res) => {
  try {
    const { envoRequestId, reason } = req.body || {};
    if (!envoRequestId) return res.status(400).json({ error: 'envoRequestId is required' });
    const request = await RequestService.cancelByEnvoId(envoRequestId, { reason });
    res.json({ ok: true, requestId: request?.id ?? null, status: request?.status ?? null });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('inbound cancel error:', err);
    res.status(status).json({ error: err.message });
  }
});

// EnVo tells us who signed for the delivery once the facility confirms receipt.
// Body: { envoRequestId, receivedBy, receivedAt? }
router.post('/receipt', async (req, res) => {
  try {
    const { envoRequestId, receivedBy, receivedAt } = req.body || {};
    if (!envoRequestId) return res.status(400).json({ error: 'envoRequestId is required' });

    const request = await RequestService.recordReceiptByEnvoId(envoRequestId, { receivedBy, receivedAt });
    if (!request) return res.status(404).json({ error: 'request not found' });
    res.json({ requestId: request.id, receivedBy: request.received_by, receivedAt: request.received_at });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('inbound receipt error:', err);
    res.status(status).json({ error: err.message });
  }
});

export default router;
