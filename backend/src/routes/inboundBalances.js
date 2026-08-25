import express from 'express';
import { AccountService } from '../services/accountService.js';

const router = express.Router();

// Service-to-service: EnVo reads facility balances so a facility can see what it owes
// the store, and its LGA/state admins can see it across their area. Mounted behind
// serviceAuth (see server.js) — this is not a user-facing route.
//
// Mounted once at /inbound (see server.js), so paths are declared in full below.
// GET /inbound/balances?envoFacilityIds=code1,code2   (omit to get every mapped facility)
router.get('/balances', async (req, res, next) => {
  try {
    const csv = req.query.envoFacilityIds;
    const ids = csv ? String(csv).split(',').map((s) => s.trim()).filter(Boolean) : null;
    return res.json(await AccountService.balancesByEnvoFacility(ids));
  } catch (err) { return next(err); }
});

/**
 * GET /inbound/balances/orders?envoFacilityId=CODE — the orders behind one facility's
 * balance, including direct dispatches EnVo never saw, each with its instalments.
 */
router.get('/balances/orders', async (req, res, next) => {
  try {
    const code = String(req.query.envoFacilityId || '').trim();
    if (!code) return res.status(400).json({ error: 'envoFacilityId is required' });
    return res.json(await AccountService.ordersByEnvoFacility(code));
  } catch (err) { return next(err); }
});

/** GET /inbound/spend — what the store issued, aggregated. Covers direct dispatches. */
router.get('/spend', async (req, res, next) => {
  try {
    const csv = req.query.envoFacilityIds;
    return res.json(await AccountService.spendByDimension({
      groupBy: req.query.group_by || 'facility',
      from: req.query.from || null,
      to: req.query.to || null,
      scheme: req.query.scheme || null,
      envoFacilityIds: csv ? String(csv).split(',').map((x) => x.trim()).filter(Boolean) : null,
    }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

export default router;
