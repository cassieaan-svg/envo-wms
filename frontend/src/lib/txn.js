// Transaction identity for inventory-changing requests.
//
// The id names the LOGICAL transaction — this dispatch, this receipt — not the HTTP request
// that carries it. It is generated before the request is sent and reused unchanged on every
// retry of the same transaction, which is what lets the server tell "the reply got lost, ask
// again" apart from "issue that stock a second time".
//
// It lives in localStorage rather than component state because the retry may not come from
// the same page load: the officer's browser is closed, the tab is reloaded, the laptop
// sleeps mid-request. A new id after a reload would look to the server like a second
// dispatch, which is exactly the failure this prevents.
//
// This is transaction identity only. There is no queue here, nothing is replayed
// automatically, and nothing works offline — a failed request is still a failed request the
// user must retry themselves. Offline operation is a later phase.

const PREFIX = 'envo_wms_txn:';
// A pending id older than this is treated as abandoned. Without it, an id left behind by a
// transaction the user gave up on would be reused weeks later for an unrelated one.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ULID-ish: time-ordered prefix so ids sort by when they were created, plus enough
// randomness that two devices cannot collide. crypto.randomUUID is available in every
// browser this runs on; the fallback is there for older webviews.
function newId() {
  const time = Date.now().toString(36).toUpperCase();
  const rand =
    globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 16).toUpperCase() ??
    Math.random().toString(36).slice(2, 18).toUpperCase();
  return `${time}-${rand}`;
}

/**
 * The id for the transaction identified by `key`, creating and persisting one if this is a
 * first attempt. Calling it again for the same key returns the SAME id — that is the point.
 */
export function beginTxn(key) {
  const storageKey = PREFIX + key;
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved?.id && Date.now() - (saved.startedAt || 0) < MAX_AGE_MS) return saved.id;
    }
  } catch {
    // Corrupt or unavailable storage: fall through and mint a fresh id. A transaction
    // without retry protection is worse than one with it, but far better than a crash.
  }

  const id = newId();
  try {
    localStorage.setItem(storageKey, JSON.stringify({ id, startedAt: Date.now() }));
  } catch { /* private mode / quota — the id still works for this attempt */ }
  return id;
}

/** Forget the id, once the transaction has completed and can never need retrying. */
export function clearTxn(key) {
  try { localStorage.removeItem(PREFIX + key); } catch { /* nothing to clean up */ }
}

/**
 * Run one inventory-changing call under a stable transaction id.
 *
 * On success the id is retired. On failure it is deliberately KEPT, so whatever the user
 * does next — press Save again, reload and try once more — carries the same id and cannot
 * double-issue stock. A server transaction that rolled back released the id anyway, so a
 * corrected resubmit under the same id is safe and does the new thing.
 */
export async function withTxn(key, run) {
  const id = beginTxn(key);
  const result = await run(id);
  clearTxn(key);
  return result;
}
