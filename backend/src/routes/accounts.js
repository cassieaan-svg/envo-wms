import express from 'express';
import { AccountService } from '../services/accountService.js';
import { requireAdmin } from '../middleware/requireAdmin.js';

const router = express.Router();

// Facility indebtedness to the central store. Debt is per dispatch order, and only for
// orders issued under a scheme that bills the facility (the DRF).

/** GET /api/accounts/debtors — facilities owing money, worst first. */
router.get('/debtors', async (_req, res, next) => {
  try {
    return res.json(await AccountService.debtors());
  } catch (err) { return next(err); }
});

/** GET /api/accounts/outstanding?facilityId= — unpaid orders, oldest first. */
router.get('/outstanding', async (req, res, next) => {
  try {
    return res.json(await AccountService.outstandingOrders({
      facilityId: req.query.facilityId ? Number(req.query.facilityId) : null,
    }));
  } catch (err) { return next(err); }
});

/** GET /api/accounts/settled?facilityId= — orders paid off, most recently cleared first. */
router.get('/settled', async (req, res, next) => {
  try {
    return res.json(await AccountService.settled({
      facilityId: req.query.facilityId ? Number(req.query.facilityId) : null,
    }));
  } catch (err) { return next(err); }
});

/** GET /api/accounts/facilities/:id/orders?onlyOutstanding=true */
router.get('/facilities/:id/orders', async (req, res, next) => {
  try {
    return res.json(await AccountService.ordersForFacility(Number(req.params.id), {
      onlyOutstanding: req.query.onlyOutstanding === 'true',
    }));
  } catch (err) { return next(err); }
});

/** GET /api/accounts/orders/:id/payments */
router.get('/orders/:id/payments', async (req, res, next) => {
  try {
    return res.json(await AccountService.payments(Number(req.params.id)));
  } catch (err) { return next(err); }
});

/**
 * POST /api/accounts/orders/:id/payments — record money received. Body: { amount, note?, paidAt? }
 *
 * Admin-only: this moves a facility's balance, and the store's own staff record it from
 * the teller the facility brings in.
 */
router.post('/orders/:id/payments', requireAdmin, async (req, res, next) => {
  try {
    const balance = await AccountService.recordPayment(Number(req.params.id), {
      amount: req.body?.amount,
      note: req.body?.note,
      paidAt: req.body?.paidAt,
      receiptNo: req.body?.receiptNo,
      // The person who actually took the payment, as typed on the form. The login
      // account is only a fallback: several people share a store login, so stamping
      // 'cms.admin' on every entry says nothing about who received the money.
      recordedBy: (typeof req.body?.recordedBy === 'string' && req.body.recordedBy.trim())
        || req.user?.username || null,
    });
    return res.status(201).json(balance);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

export default router;
