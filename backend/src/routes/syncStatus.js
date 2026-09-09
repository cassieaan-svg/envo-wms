import express from 'express';
import { OutboxService } from '../services/outboxService.js';
import { SyncService } from '../services/syncService.js';
import { MasterDataService } from '../services/masterDataService.js';
import { RequestStatusService } from '../services/requestStatusService.js';
import { syncNow } from '../lib/syncWorker.js';
import { IS_CLOUD, IS_CMS, describeRole } from '../lib/role.js';
import { requirePermission } from '../middleware/requirePermission.js';

// The user-facing half of sync: a WMS operator checking on or nudging their own instance's
// sync state. Mounted at /api/sync, behind a normal user JWT plus a permission check.
//
// This is deliberately a SEPARATE router from routes/sync.js, which is the Cloud<->CMS
// protocol (master-data snapshots, transaction/status-event ingest, the balance mirror) —
// server-to-server traffic authenticated by the sync token, never by a user permission, and
// never reachable from here. The two were previously the same router mounted twice — once
// correctly behind syncAuth at /sync, and again at /api/sync behind nothing but a valid
// login, with no permission check at all. That let any authenticated user, including one
// with zero roles, pull master-data.snapshot() (which carries every user's password hash)
// and trigger a manual sync run. See the Phase 1 verification audit, section 4.
const router = express.Router();

/**
 * GET /api/sync/status — whether anything is still queued for EnVo/Cloud.
 * Requires sync.view.
 */
router.get('/status', requirePermission('sync.view'), async (req, res, next) => {
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

/**
 * POST /api/sync/run — pull master data and requests, then drain the outbox, now.
 *
 * The worker does this on a timer; this is the button for someone who has just plugged the
 * internet back in and does not want to wait for the next tick. Requires sync.forceRun —
 * held by System Administrator only (Phase 1 matrix); the IS_CMS check stays alongside it
 * because the permission answers "may this person trigger a sync", not "does a sync from
 * here mean anything" — Cloud has no forward link to sync.
 */
router.post('/run', requirePermission('sync.forceRun'), async (req, res, next) => {
  try {
    if (!IS_CMS) return res.status(403).json({ error: 'only the CMS instance syncs to Cloud' });
    return res.json(await syncNow({ manual: true }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

export default router;
