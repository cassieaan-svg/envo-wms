import express from 'express';
import { ReconciliationService } from '../services/reconciliationService.js';
import { requireAdmin } from '../middleware/requireAdmin.js';

const router = express.Router();

// Reconciliation is an administrative act, not something that happens on its own. It reads
// every batch against its ledger, so it is invoked deliberately — never from a write path,
// and never on a schedule this process decides for itself.

/** GET /api/reconciliation — open findings, worst variance first. Cheap; reads recorded rows. */
router.get('/', requireAdmin, async (req, res, next) => {
  try {
    return res.json(await ReconciliationService.listOpen());
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/reconciliation/check — run the comparison and report, recording nothing.
 * The read-only view, for looking before deciding to record.
 */
router.get('/check', requireAdmin, async (req, res, next) => {
  try {
    const commodityId = req.query.commodityId ? Number(req.query.commodityId) : null;
    const discrepancies = await ReconciliationService.check({ commodityId });
    return res.json({ checkedAt: new Date().toISOString(), count: discrepancies.length, discrepancies });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/reconciliation/run — run it and record what it finds.
 * Records only. Nothing here alters stock: a variance is evidence, and correcting it is a
 * physical count raised as a `count_correction` adjustment by someone who has looked.
 */
router.post('/run', requireAdmin, async (req, res, next) => {
  try {
    const commodityId = req.body?.commodityId ? Number(req.body.commodityId) : null;
    const result = await ReconciliationService.run({
      commodityId,
      source: `api:${req.user?.username || 'unknown'}`,
    });
    return res.json({ ...result, count: result.discrepancies.length });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/reconciliation/anomalies — ledger-internal integrity, not just cache variance.
 * Reporting only. Several counts are expected to be non-zero on an existing database
 * (rows that predate Phase 1/2); what matters is that they do not grow.
 */
router.get('/anomalies', requireAdmin, async (req, res, next) => {
  try {
    const anomalies = await ReconciliationService.anomalies();
    return res.json({
      checkedAt: new Date().toISOString(),
      clean: anomalies.every((a) => a.count === 0),
      anomalies,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/reconciliation/:id/resolve-by-count — close a finding with a physical count.
 * Body: { countedQuantity, resolvedBy, note }.
 *
 * The only route that changes a batch's balance outside the normal inventory operations,
 * and it does so by writing an attributed count_correction movement for the difference —
 * so the ledger, not this endpoint, remains the explanation for the new figure.
 */
router.post('/:id/resolve-by-count', requireAdmin, async (req, res, next) => {
  try {
    const row = await ReconciliationService.resolveByCount(Number(req.params.id), {
      countedQuantity: req.body?.countedQuantity,
      resolvedBy: req.body?.resolvedBy || req.user?.username,
      note: req.body?.note,
    });
    if (!row) return res.status(404).json({ error: 'no open discrepancy with that id' });
    return res.json(row);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

/**
 * POST /api/reconciliation/:id/resolve — close a finding that has been investigated.
 * Body: { resolvedBy, note }. Records that a person dealt with it; touches no stock.
 */
router.post('/:id/resolve', requireAdmin, async (req, res, next) => {
  try {
    const row = await ReconciliationService.resolve(Number(req.params.id), {
      resolvedBy: req.body?.resolvedBy || req.user?.username,
      note: req.body?.note,
    });
    if (!row) return res.status(404).json({ error: 'no open discrepancy with that id' });
    return res.json(row);
  } catch (err) {
    return next(err);
  }
});

export default router;
