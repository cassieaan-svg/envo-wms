import { OutboxService } from '../services/outboxService.js';

// Drains the outbox on a timer. Deliberately dull: one pass at a time, never overlapping,
// and a failed pass is just logged — the rows keep their backoff and are retried later.
const INTERVAL_MS = 15_000;

const HOUSEKEEPING_MS = 60 * 60 * 1000;

let timer = null;
let inFlight = false;
let lastHousekeepingAt = 0;

async function tick() {
  if (inFlight) return; // a slow pass must not stack up behind itself
  inFlight = true;
  try {
    const { claimed, delivered, failed } = await OutboxService.drainOnce();
    if (claimed > 0) {
      console.log(`[outbox] ${delivered} delivered, ${failed} deferred`);
    }

    // Housekeeping, once an hour rather than every 15 seconds.
    if (Date.now() - lastHousekeepingAt > HOUSEKEEPING_MS) {
      lastHousekeepingAt = Date.now();
      const stuck = await OutboxService.stuck();
      if (stuck.length) {
        // EnVo is out of step with the warehouse for as long as this is true, so it is a
        // warning rather than a quiet metric.
        console.warn(
          `[outbox] ${stuck.length} callback(s) undelivered for hours — oldest #${stuck[0].id} ` +
          `(${stuck[0].kind}, ${stuck[0].attempts} attempts): ${stuck[0].last_error || 'no error recorded'}`
        );
      }
      const pruned = await OutboxService.prune();
      if (pruned) console.log(`[outbox] pruned ${pruned} delivered row(s)`);
    }
  } catch (err) {
    // Postgres itself being unavailable, say. Nothing to do but try again next tick.
    console.warn(`[outbox] drain failed: ${err.message}`);
  } finally {
    inFlight = false;
  }
}

export function startOutboxWorker() {
  if (timer) return;
  if (process.env.OUTBOX_WORKER === 'off') {
    console.log('[outbox] worker disabled (OUTBOX_WORKER=off)');
    return;
  }
  timer = setInterval(tick, INTERVAL_MS);
  timer.unref?.(); // never hold the process open on its own
  tick(); // deliver anything left over from a previous run straight away
  console.log(`[outbox] worker started (every ${INTERVAL_MS / 1000}s)`);
}

export function stopOutboxWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
