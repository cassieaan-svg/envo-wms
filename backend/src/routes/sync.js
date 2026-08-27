import express from 'express';
import { OutboxService } from '../services/outboxService.js';
import { SyncService } from '../services/syncService.js';
import { MasterDataService } from '../services/masterDataService.js';
import { RequestSyncService } from '../services/requestSyncService.js';
import { RequestStatusService } from '../services/requestStatusService.js';
import { syncNow } from '../lib/syncWorker.js';
import { IS_CLOUD, IS_CMS, describeRole } from '../lib/role.js';

const router = express.Router();

// Whether anything is still queued for EnVo. Staff need this on the Requests page: when
// the store is offline the queue is expected to grow, and the marker tells them the
// backlog is being held rather than lost.
router.get('/status', async (req, res, next) => {
  try {
    const outbox = await OutboxService.status();
    if (IS_CLOUD) return res.json({ ...outbox, role: describeRole() });

    // On CMS the question people actually ask is "is my work safe, and does Cloud know?"
    const [pending, pendingStatus, master, requests, staleness] = await Promise.all([
      SyncService.pendingCount(),
      RequestStatusService.pendingCount(),
      MasterDataService.state('master_data'),
      MasterDataService.state('requests'),
      MasterDataService.staleness(),
    ]);
    return res.json({
      ...outbox,
      role: describeRole(),
      pendingTransactions: pending.pending,
      oldestPendingAt: pending.oldest,
      pendingStatusEvents: pendingStatus.pending,
      masterData: {
        lastSuccessAt: master?.last_success_at ?? null,
        version: master?.cursor ?? null,
        lastError: master?.last_error ?? null,
        staleness,
      },
      requests: {
        lastSuccessAt: requests?.last_success_at ?? null,
        lastError: requests?.last_error ?? null,
      },
    });
  } catch (err) {
    return next(err);
  }
});

// ── Cloud-side surfaces, consumed by CMS over the sync token ────────────────
// These are mounted behind syncAuth in server.js and only in the cloud role.

/** GET /sync/master-data — the snapshot CMS mirrors. */
router.get('/master-data', async (req, res, next) => {
  try {
    return res.json(await MasterDataService.snapshot());
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

/** GET /sync/requests — the requests CMS still has work to do on. */
router.get('/requests', async (req, res, next) => {
  try {
    return res.json(await RequestSyncService.openRequests());
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

/**
 * POST /sync/transactions — ingest one envelope from CMS.
 *
 * Idempotent: a replay returns the original outcome with `duplicate: true` and 200, which is
 * what lets CMS retry a push whose acknowledgement was lost. An envelope not authored by CMS
 * is refused with 403 — Cloud mirrors warehouse stock, it never writes it.
 */
router.post('/transactions', async (req, res, next) => {
  try {
    const result = await SyncService.ingest(req.body);
    return res.status(result.duplicate ? 200 : 201).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    return next(err);
  }
});

/**
 * POST /sync/request-status — ingest one status event from CMS.
 *
 * Idempotent on the event uid, so a re-delivered event produces no second EnVo callback.
 */
router.post('/request-status', async (req, res, next) => {
  try {
    const result = await RequestStatusService.ingest(req.body);
    return res.status(result.duplicate ? 200 : 201).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    return next(err);
  }
});

/** GET /sync/mirror — Cloud's view of warehouse balances, for parity checking. */
router.get('/mirror', async (req, res, next) => {
  try {
    const uids = req.query.uids ? String(req.query.uids).split(',').filter(Boolean) : null;
    return res.json({ asOf: new Date().toISOString(), balances: await SyncService.mirrorBalances(uids) });
  } catch (err) {
    return next(err);
  }
});

// ── CMS-side control ────────────────────────────────────────────────────────
/**
 * POST /api/sync/run — pull master data and requests, then drain the outbox, now.
 *
 * The worker does this on a timer; this is the button for someone who has just plugged the
 * internet back in and does not want to wait for the next tick.
 */
router.post('/run', async (req, res, next) => {
  try {
    if (!IS_CMS) return res.status(403).json({ error: 'only the CMS instance syncs to Cloud' });
    return res.json(await syncNow({ manual: true }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

export default router;
