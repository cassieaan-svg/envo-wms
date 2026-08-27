// The CMS instance's only upstream: Cloud.
//
// Deliberately narrow. CMS pulls master data and pushes inventory transactions, and does
// nothing else over the internet — in particular it never calls EnVo, which is Cloud's
// relationship to maintain. Keeping that boundary in one small file makes it obvious when
// something is about to cross it.
//
// Retry and backoff are NOT here. The outbox owns them for the push path, exactly as it does
// for the EnVo callbacks, so a warehouse that is offline overnight resumes rather than
// giving up. A single attempt here keeps a dead link from stalling the drain.

import { retry } from './envoClient.js';

function cloudUrl(path) {
  const base = process.env.CLOUD_API_URL;
  if (!base) throw new Error('CLOUD_API_URL is not configured on this CMS instance');
  return `${base.replace(/\/$/, '')}${path}`;
}

function headers() {
  const token = process.env.SYNC_TOKEN;
  if (!token) throw new Error('SYNC_TOKEN is not configured on this CMS instance');
  // A separate secret from the EnVo SERVICE_TOKEN on purpose: they authorise different
  // relationships, and a warehouse machine should not hold the credential that can talk to
  // EnVo on Cloud's behalf.
  return { 'Content-Type': 'application/json', 'x-sync-token': token };
}

/** Push one transaction envelope to Cloud. One attempt — the outbox retries. */
export async function pushTransaction(envelope) {
  const res = await fetch(cloudUrl('/sync/transactions'), {
    method: 'POST', headers: headers(), body: JSON.stringify(envelope),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Cloud ingest returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return res.json().catch(() => ({}));
}

/** Push one request-status event to Cloud. One attempt — the outbox retries. */
export async function pushRequestStatus(envelope) {
  const res = await fetch(cloudUrl('/sync/request-status'), {
    method: 'POST', headers: headers(), body: JSON.stringify(envelope),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Cloud status ingest returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return res.json().catch(() => ({}));
}

/** Pull the master-data snapshot. Retried here because it is a foreground operation. */
export function fetchMasterData() {
  return retry(async () => {
    const res = await fetch(cloudUrl('/sync/master-data'), { headers: headers() });
    if (!res.ok) throw new Error(`Cloud master-data returned ${res.status}`);
    return res.json();
  }, { attempts: 2, delayMs: 2000 });
}

/** Pull the requests the warehouse still has work to do on. */
export function fetchOpenRequests() {
  return retry(async () => {
    const res = await fetch(cloudUrl('/sync/requests'), { headers: headers() });
    if (!res.ok) throw new Error(`Cloud requests returned ${res.status}`);
    return res.json();
  }, { attempts: 2, delayMs: 2000 });
}
