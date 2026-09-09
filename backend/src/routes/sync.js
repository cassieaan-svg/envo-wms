import express from 'express';
import { SyncService } from '../services/syncService.js';
import { MasterDataService } from '../services/masterDataService.js';
import { RequestSyncService } from '../services/requestSyncService.js';
import { RequestStatusService } from '../services/requestStatusService.js';
import { PriceService } from '../services/priceService.js';

const router = express.Router();

// The Cloud<->CMS sync PROTOCOL — server-to-server only. Mounted exactly once, at /sync,
// behind syncAuth (see server.js) — never behind a user JWT, and never mounted at /api/sync.
// A WMS user's own view of sync status, and their "sync now" button, live in
// routes/syncStatus.js instead: this file must stay server-to-server-only, because
// master-data snapshot() below carries every user's password hash by design (CMS needs it
// to authenticate offline), which is fine for a sync-token-authenticated machine and would
// not be fine behind a plain user login. See the Phase 1 verification audit, section 4.

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

/**
 * POST /sync/prices — ingest one price CMS has decided, from CMS.
 *
 * Idempotent on the price's own uid. CMS is the price authority; this is Cloud recording
 * what CMS decided and, in the same transaction, queuing the push on to EnVo.
 */
router.post('/prices', async (req, res, next) => {
  try {
    const result = await PriceService.ingest(req.body);
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

export default router;
