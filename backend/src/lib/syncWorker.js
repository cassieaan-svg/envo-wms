import { MasterDataService } from '../services/masterDataService.js';
import { RequestSyncService } from '../services/requestSyncService.js';
import { OutboxService } from '../services/outboxService.js';
import { fetchMasterData, fetchOpenRequests } from './cloudClient.js';
import { IS_CMS } from './role.js';
import { query } from '../db.js';

// Keeps CMS in touch with Cloud: pull down what Cloud owns, push up what CMS owns.
//
// Runs only on CMS. Failure is the expected state, not an exception — the warehouse is
// designed to work without this — so a failed pass logs at warning level, records why in
// sync_state, and tries again on the next tick. Nothing here can interrupt warehouse work.
//
// ORDER MATTERS. Pull before push: a request that arrived while we were away should be on
// the local database before anything else happens, and master data should be current before
// transactions referencing it go up. The push then drains through the outbox, which already
// owns FIFO ordering, per-batch causality and exponential backoff.

const DEFAULT_INTERVAL_MS = 60_000;

let timer = null;
let inFlight = false;

export async function syncNow({ manual = false } = {}) {
  const result = { masterData: null, requests: null, outbox: null, errors: [] };

  // A manual sync is someone saying "the internet is back". Every failed attempt has pushed
  // its row into exponential backoff — up to an hour — and the causality guard holds later
  // rows for the same batch behind it, so without this the button appears to do nothing at
  // exactly the moment the operator most wants reassurance. Clearing the backoff does not
  // skip anything or weaken delivery: the rows are still drained in order, still
  // idempotently, and a genuine failure simply backs off again.
  if (manual) {
    await query(
      `UPDATE outbox SET next_attempt_at = now()
        WHERE delivered_at IS NULL AND next_attempt_at > now()`);
  }

  try {
    const snapshot = await fetchMasterData();
    const current = await MasterDataService.state('master_data');
    if (current?.cursor === snapshot.version) {
      // Unchanged since last time — record the successful contact without rewriting rows,
      // because "we reached Cloud" is what the staleness policy measures.
      await MasterDataService.apply({ ...snapshot, data: snapshot.data });
      result.masterData = { unchanged: true, version: snapshot.version };
    } else {
      result.masterData = { applied: await MasterDataService.apply(snapshot), version: snapshot.version };
    }
  } catch (err) {
    result.errors.push(`master data: ${err.message}`);
    await MasterDataService.recordFailure('master_data', err.message).catch(() => {});
  }

  try {
    result.requests = await RequestSyncService.apply(await fetchOpenRequests());
  } catch (err) {
    result.errors.push(`requests: ${err.message}`);
    await MasterDataService.recordFailure('requests', err.message).catch(() => {});
  }

  try {
    // Drain until the queue goes quiet, not once.
    //
    // The causality guard deliberately holds a row back while an earlier undelivered row for
    // the same batch or order is outstanding, so a single pass delivers at most one row per
    // cause key. An order raised and then corrected offline is two transactions on one cause
    // key: one pass sends the dispatch and leaves the correction behind, and at a 60-second
    // tick Cloud would sit two minutes behind a warehouse that is standing right there
    // watching. Looping keeps the ordering guarantee — each pass still respects the guard —
    // while actually emptying the queue.
    //
    // Bounded so a row that fails forever cannot spin: once a pass delivers nothing new,
    // there is nothing more this attempt can do.
    let delivered = 0; let failed = 0; let claimed = 0;
    for (let pass = 0; pass < 25; pass += 1) {
      const r = await OutboxService.drainOnce();
      claimed += r.claimed; delivered += r.delivered; failed += r.failed;
      if (r.claimed === 0 || r.delivered === 0) break;
    }
    result.outbox = { claimed, delivered, failed };
  } catch (err) {
    result.errors.push(`outbox: ${err.message}`);
  }

  return result;
}

async function tick() {
  if (inFlight) return;      // a slow pass must not stack up behind itself
  inFlight = true;
  try {
    const r = await syncNow();
    if (r.errors.length) {
      console.warn(`[sync] offline or partial: ${r.errors.join(' | ')}`);
    } else if (r.outbox?.delivered) {
      console.log(`[sync] ${r.outbox.delivered} transaction(s) delivered to Cloud`);
    }
  } finally {
    inFlight = false;
  }
}

export function startSyncWorker() {
  if (timer) return;
  if (!IS_CMS) return;                                  // Cloud syncs nowhere
  if (process.env.SYNC_WORKER === 'off') {
    console.log('[sync] worker disabled (SYNC_WORKER=off)');
    return;
  }
  const interval = Number(process.env.SYNC_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  timer = setInterval(tick, interval);
  timer.unref?.();
  // A short delay rather than firing on boot: if the machine has just started, the network
  // interface may not be up yet, and a first failure would only add noise.
  setTimeout(tick, 10_000).unref?.();
  console.log(`[sync] worker started (every ${Math.round(interval / 1000)}s)`);
}

export function stopSyncWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
