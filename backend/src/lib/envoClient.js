// Outbound calls to EnVo's REST API. Network timeouts are common in the field, so
// everything here goes through retry().

const ATTEMPTS = 3;
const DELAY_MS = 3000;

export async function retry(fn, { attempts = ATTEMPTS, delayMs = DELAY_MS } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

// Push a warehouse-request status change back to EnVo (submitted / picking / dispatched).
// Service-token auth. Called through the outbox, which owns retrying and backoff — hence
// `{ attempts: 1 }` from there: sleeping 9s inside a single row would stall the drain.
export function postRequestStatus(payload, opts) {
  return retry(async () => {
    const res = await fetch(`${process.env.ENVO_API_URL}/hooks/warehouse-requests/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-token': process.env.SERVICE_TOKEN || '' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error(`EnVo callback returned ${res.status}`)
    return res.json().catch(() => ({}))
  }, opts)
}

// A facility's Essential Commodities stock-on-hand, read from EnVo's service-token hook.
// `facilityCode` is EnVo's facilities.code — what we store as envo_facility_id.
// Returns { facilityId, facilityName, asOf, items:[{ commodityId, name, quantityOnHand, unit }] },
// where commodityId is our own commodity id (EnVo maps it from wms_commodity_id).
export function fetchEnvoStock(facilityCode) {
  return retry(async () => {
    const res = await fetch(
      `${process.env.ENVO_API_URL}/hooks/facilities/${encodeURIComponent(facilityCode)}/stock`,
      { headers: { 'x-service-token': process.env.SERVICE_TOKEN || '' } }
    );
    if (!res.ok) throw new Error(`EnVo stock API returned ${res.status}`);
    return res.json();
  });
}
