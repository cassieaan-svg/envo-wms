import { ReconciliationService } from '../services/reconciliationService.js';

// Runs reconciliation on a timer so drift is found by the system rather than by someone
// eventually noticing.
//
// Phase 1 made reconciliation possible but left it entirely manual, which meant a batch
// could sit wrong for weeks. It is still explicit in the sense that matters — it records
// findings and corrects nothing, ever — but it no longer depends on a person remembering.
//
// Deliberately slow and dull. The check is one grouped scan; at warehouse scale that is
// milliseconds, but there is no reason to run it often, and running it during the working
// day competes with picking. Default is every 6 hours, offset by a short delay after
// startup so a restart loop cannot turn it into a hot loop.

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60 * 1000;

let timer = null;
let inFlight = false;

async function tick() {
  if (inFlight) return;
  inFlight = true;
  try {
    const { discrepancies, recorded } = await ReconciliationService.run({ source: 'scheduled' });
    if (discrepancies.length) {
      // Loud, because this is the warning the whole mechanism exists to produce. It names
      // the worst offender so the log line is actionable without opening the database.
      const worst = discrepancies[0];
      console.warn(
        `[reconcile] ${discrepancies.length} batch(es) out of balance, ${recorded} recorded — ` +
        `worst: batch ${worst.batchId} (${worst.commodityName}) expected ${worst.expected}, ` +
        `actual ${worst.actual}, variance ${worst.variance > 0 ? '+' : ''}${worst.variance}. ` +
        'Nothing was corrected; see GET /api/reconciliation.'
      );
    } else {
      console.log('[reconcile] every batch agrees with its ledger');
    }
  } catch (err) {
    console.warn(`[reconcile] check failed: ${err.message}`);
  } finally {
    inFlight = false;
  }
}

export function startReconciliationWorker() {
  if (timer) return;
  if (process.env.RECONCILE_WORKER === 'off') {
    console.log('[reconcile] worker disabled (RECONCILE_WORKER=off)');
    return;
  }
  const interval = Number(process.env.RECONCILE_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  timer = setInterval(tick, interval);
  timer.unref?.();
  setTimeout(tick, STARTUP_DELAY_MS).unref?.();
  console.log(`[reconcile] worker started (every ${Math.round(interval / 60000)} min)`);
}

export function stopReconciliationWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
