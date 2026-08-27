// What the warehouse actually needs to know: can I work, and does anyone outside know yet?
//
// There are two independent questions and warehouse staff should never have to untangle them:
//
//   Is the CMS server reachable?   → decides whether the app WORKS AT ALL
//   Has Cloud heard from it?       → decides only whether EnVo is up to date
//
// The second one failing is normal and harmless. The first one failing stops everything. A
// single "offline" indicator would blur them together and teach people to ignore it, so this
// keeps them separate and describes each in plain terms.

import { getServerBase, describeServer } from './cmsServer.js';

export const STATE = {
  CONNECTED: 'connected',       // CMS reachable; Cloud up to date
  HOLDING: 'holding',           // CMS reachable; work waiting for Cloud — normal offline mode
  UNAVAILABLE: 'unavailable',   // CMS not reachable — nothing works
  CHECKING: 'checking',
};

/**
 * Classify a health probe and sync status into one operational state.
 *
 * Pure, so the wording and the thresholds can be tested without a browser or a server.
 */
export function classifyConnection({ serverUp, sync, error } = {}) {
  if (serverUp === false) {
    return {
      state: STATE.UNAVAILABLE,
      tone: 'alert',
      short: 'Warehouse server unavailable',
      detail:
        'Check that the CMS server is running and that this device is on the warehouse ' +
        'network. Nothing can be recorded until it is reachable — no stock has been lost.',
      canWork: false,
      error: error || null,
    };
  }

  if (serverUp !== true) {
    return { state: STATE.CHECKING, tone: 'muted', short: 'Checking warehouse server…',
             detail: null, canWork: false };
  }

  const pendingTxns = Number(sync?.pendingTransactions) || 0;
  const pendingStatus = Number(sync?.pendingStatusEvents) || 0;
  const held = pendingTxns + pendingStatus;

  if (held > 0) {
    const parts = [
      pendingTxns > 0 && `${pendingTxns} transaction${pendingTxns === 1 ? '' : 's'}`,
      pendingStatus > 0 && `${pendingStatus} status update${pendingStatus === 1 ? '' : 's'}`,
    ].filter(Boolean);
    return {
      state: STATE.HOLDING,
      tone: 'soon',
      short: 'Working — waiting to reach Cloud',
      // Deliberately reassuring, because this state is NORMAL. The work is done and safe;
      // the only thing outstanding is telling the outside world.
      detail: `${parts.join(' and ')} recorded here and waiting to reach Cloud. They will ` +
              'send themselves when the internet is back. Carry on as usual.',
      canWork: true,
      held,
    };
  }

  return {
    state: STATE.CONNECTED, tone: 'ok', short: 'Connected',
    detail: 'The warehouse server is reachable and Cloud is up to date.',
    canWork: true, held: 0,
  };
}

/**
 * Probe the CMS server. Uses /health, which needs no session — so this answers "is the
 * server there" even when nobody is signed in, which is exactly when the sign-in screen
 * needs to know.
 */
export async function probeServer({ timeoutMs = 4000 } = {}) {
  const base = getServerBase();
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { serverUp: false, error: `server answered ${res.status}` };

    // A 200 is not enough. Anything serving a single-page app answers unknown paths with
    // index.html and a 200, so pointing the device at a web server that is NOT the CMS
    // backend would look like a healthy warehouse server. The health payload has to be
    // real JSON that identifies itself, or this is not our server.
    const health = await res.json().catch(() => null);
    if (!health || health.ok !== true) {
      return {
        serverUp: false,
        error: 'that address answered, but it is not the warehouse server',
        server: describeServer(),
      };
    }
    return { serverUp: true, health, server: describeServer() };
  } catch (err) {
    return {
      serverUp: false,
      error: err?.name === 'TimeoutError' ? 'no answer from the server' : err.message,
      server: describeServer(),
    };
  }
}
