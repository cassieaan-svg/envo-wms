// Backend API client. Auth AND data now run against our own Express API (backed
// by the migrated local Postgres) instead of Supabase. The `api` export below is
// the data surface that replaces the old `sb.from(...)` calls; realtime
// (sb.channel) is migrated separately (#5).
const BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000'

// JWT issued by POST /auth/login, persisted so sessions survive a refresh.
const TOKEN_KEY = 'envo_token'
export const getToken   = () => localStorage.getItem(TOKEN_KEY)
export const setToken   = (t) => localStorage.setItem(TOKEN_KEY, t)
export const clearToken = () => localStorage.removeItem(TOKEN_KEY)

// Active module — which commodity programme (HIV / Essential Commodities) the caller
// is working in. Sent as the `x-envo-module` header on every authenticated request so
// the backend scopes the catalogue / facility list. Held in sessionStorage so it's
// per-tab (two tabs can sit in different modules) and survives a refresh.
const MODULE_KEY = 'ct_module'
export const getModule   = () => sessionStorage.getItem(MODULE_KEY)
export const setModule   = (m) => { if (m) sessionStorage.setItem(MODULE_KEY, m); else sessionStorage.removeItem(MODULE_KEY) }
export const clearModule = () => sessionStorage.removeItem(MODULE_KEY)

async function request(path, { method = 'GET', body, auth = false } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (auth) {
    const t = getToken()
    if (t) headers.Authorization = `Bearer ${t}`
    const m = getModule()
    if (m) headers['x-envo-module'] = m
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  let data = null
  try { data = await res.json() } catch { /* non-JSON / empty body */ }

  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`)
    err.status = res.status
    throw err
  }
  return data
}

export const auth = {
  // Returns the user payload ({ id, email, user_metadata }) and stores the token.
  async login(email, password) {
    const { token, user } = await request('/auth/login', {
      method: 'POST',
      body: { email, password },
    })
    setToken(token)
    return user
  },

  // Restore the session from the stored token. Throws on a missing/expired token.
  async me() {
    const { user } = await request('/auth/me', { auth: true })
    return user
  },

  // Change the logged-in user's password.
  async changePassword(password) {
    return request('/auth/password', { method: 'POST', auth: true, body: { password } })
  },

  signOut() { clearToken() },
}

// ─── Data surface (replaces sb.from(...)) ────────────────────────────────────
// Every method hits an authenticated /api/* endpoint, returns the `data` payload
// (rows or a single row) and throws on a non-2xx (err.status is set). Query
// objects skip null/undefined/'' values.

function qs(params = {}) {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    sp.append(k, Array.isArray(v) ? v.join(',') : v)
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

const get   = (path, params) => request(`/api${path}${qs(params)}`, { auth: true }).then(r => r?.data)
// Same call, whole envelope. Paged endpoints return `total` alongside `data`, and
// unwrapping to `data` would throw the page count away.
const getRaw = (path, params) => request(`/api${path}${qs(params)}`, { auth: true })
const post  = (path, body)   => request(`/api${path}`, { method: 'POST',   auth: true, body }).then(r => r?.data)
const put   = (path, body)   => request(`/api${path}`, { method: 'PUT',    auth: true, body }).then(r => r?.data)
const patch = (path, body)   => request(`/api${path}`, { method: 'PATCH',  auth: true, body }).then(r => r?.data)
const del   = (path)         => request(`/api${path}`, { method: 'DELETE', auth: true }).then(r => r?.data)

export const api = {
  // The offline device's one-pull cache: catalogue, this facility's stock, the
  // facility record. Facility-tier + Essential-module only — see
  // routes/facilitySnapshot.js. Whole envelope (getRaw), not just `.data` — the
  // caller wants `version`/`generatedAt`/`counts` alongside `data`.
  facilitySnapshot: {
    get: () => getRaw('/facility-snapshot'),
  },

  stock: {
    // facility_id optional: omit it to get the caller's whole scoped set (admin
    // / aggregate views). Other params: commodity_id, commodity_ids, location_type,
    // limit, offset.
    list:   (params)        => get('/stock', params),
    // PER-COMMODITY rollup across the caller's scope — one row per commodity
    // ({ commodity_id, store_qty, dispensary_qty, dsd_qty, sdp_qty, baseline_amc,
    // has_stock }) instead of every raw stock/DSD/SDP row for the browser to
    // reduce. Use this for anything that only needs totals (dashboards, stock
    // tables, alert counts): the payload tracks the commodity catalogue, not the
    // number of stock rows, so it stays flat as the database grows.
    // params: facility_id | facility_ids | state/lga, commodity_ids.
    summary: (params)       => get('/stock/summary', params),
    // On-hand lots of one bin (batch/expiry balances) for the dispense picker.
    // params: facility_id, commodity_id, location_type, site_name (dsd/sdp).
    lots:   (params)        => get('/stock/lots', params),
    // On-hand per-batch balances across scope from the lot ledger (authoritative),
    // for expiry views + stock-by-batch. params: facility_id | facility_ids,
    // commodity_ids, expiry_to (ISO), include_unknown. Already-expired lots included.
    lotsExpiry: (params)    => get('/stock/lots/expiry', params),
    // Record a lot's batch/expiry (metadata only — quantity untouched).
    relabelLot: (id, body)  => patch(`/stock/lots/${id}`, body),
    get:    (id)            => get(`/stock/${id}`),
    create: (body)         => post('/stock', body),
    update: (id, quantity) => patch(`/stock/${id}`, { quantity }),
    upsert: (body)         => put('/stock/upsert', body),
    dsd: {
      list:        (params)        => get('/stock/dsd', params),
      upsert:      (body)         => put('/stock/dsd/upsert', body),
      setQuantity: (id, quantity) => patch(`/stock/dsd/${id}`, { quantity }),
    },
    sdp: {
      list:        (params)        => get('/stock/sdp', params),
      upsert:      (body)         => put('/stock/sdp/upsert', body),
      setQuantity: (id, quantity) => patch(`/stock/sdp/${id}`, { quantity }),
    },
  },

  transfers: {
    // params: facility_id, direction, status (csv), section, date_field, from, to,
    // notes_includes, limit, offset.
    list:   (params) => get('/transfers', params),
    // Accepted transfers in/out, aggregated (Monitoring's transfer figures).
    summary: (params) => get('/transfers/summary', params),
    get:    (id)     => get(`/transfers/${id}`),
    create: (lines)  => post('/transfers', lines),          // array | {lines:[]} | single row
    update: (id, body) => patch(`/transfers/${id}`, body),  // metadata-only
    remove: (id)     => del(`/transfers/${id}`),
    // lifecycle transitions
    dispatch:        (id, body) => patch(`/transfers/${id}/dispatch`, body),
    assignSource:    (id, body) => patch(`/transfers/${id}/assign`, body),
    // Assign ONE source to several pending requests at once, all-or-nothing.
    // body: { sending_facility_id, sending_facility_name, reviewed_by, items:[{id, quantity}] }
    assignBatch:     (body)     => patch('/transfers/assign-batch', body),
    // Dispatch several pending transfers in one transaction (source facility side).
    // body: { approved_by, carrier, items:[{ id, quantity, lots?, carrier? }] }
    dispatchBatch:   (body)     => patch('/transfers/dispatch-batch', body),
    accept:          (id, body) => patch(`/transfers/${id}/accept`, body),
    dispute:         (id, body) => patch(`/transfers/${id}/dispute`, body),
    cancel:          (id, body) => patch(`/transfers/${id}/cancel`, body),
    approveInternal: (id, body) => patch(`/transfers/${id}/approve-internal`, body),
    approveDsd:      (id, body) => patch(`/transfers/${id}/approve-dsd`, body),
    receive:         (id, body) => patch(`/transfers/${id}/receive`, body),
  },

  // Log writes bundle the stock mutation server-side (transactional) — one call
  // replaces the old insert-log + update-stock sequence.
  // `update` edits an existing log row's metadata (EditModal); stock is reconciled
  // separately by the caller via the stock methods.
  dispense:    { record: (body) => post('/dispense', body),    history: (params) => get('/dispense', params),    summary: (params) => get('/dispense/summary', params),    update: (id, body) => patch(`/dispense/${id}`, body) },
  intake:      { record: (body) => post('/intake', body),      history: (params) => get('/intake', params), summary: (params) => get('/intake/summary', params),      update: (id, body) => patch(`/intake/${id}`, body) },
  adjustments: { record: (body) => post('/adjustments', body), history: (params) => get('/adjustments', params), summary: (params) => get('/adjustments/summary', params), update: (id, body) => patch(`/adjustments/${id}`, body) },

  // One time-ordered feed across all four logs, paged server-side. Returns the raw
  // envelope ({ data, total, ... }) because the caller needs `total` to page.
  activity: (params) => getRaw('/activity', params),

  reports: {
    daily:        (params) => get('/reports/daily', params),
    weekly:       (params) => get('/reports/weekly', params),
    monthly:      (params) => get('/reports/monthly', params),
    stockBalance: (params) => get('/reports/stock-balance', params),
  },

  // Modules the caller may work in ([{ key, label, enrolled }]). Not module-scoped
  // itself — it's what the module picker renders.
  modules:     { list: () => get('/modules') },

  // Essential-commodity priced requests to the central warehouse.
  schemes: { list: () => get('/schemes') },

  warehouseRequests: {
    list:    (params)     => get('/warehouse-requests', params),
    // params: { group_by: facility|lga|state|commodity|status|month, from, to, status }
    spend:   (params)     => get('/warehouse-requests/spend', params),
    // What facilities owe the central store. Read from the WMS, which owns the money.
    balances: (params)    => get('/warehouse-requests/balances', params),
    // The orders behind a facility's balance — includes direct dispatches EnVo never saw.
    balanceOrders: (facilityId) => get(`/warehouse-requests/balances/${facilityId}/orders`),
    get:     (id)         => get(`/warehouse-requests/${id}`),
    create:  (body)       => post('/warehouse-requests', body),   // { items:[{commodity_id, quantity}], requestedBy, requesterPhone, notes }
    cancel:  (id)         => patch(`/warehouse-requests/${id}/cancel`),
    resubmit:(id)         => patch(`/warehouse-requests/${id}/resubmit`),
    receive: (id)         => patch(`/warehouse-requests/${id}/receive`),
  },

  facilities:  { list: (params) => get('/facilities', params), listAll: () => get('/facilities', { all: true }), get: (id) => get(`/facilities/${id}`), dsdSites: (id) => get(`/facilities/${id}/dsd-sites`) },
  commodities: {
    list: (params) => get('/commodities', params),
    modules: () => get('/commodities/modules'),
    categories: (params) => get('/commodities/categories', params),
    create: (body) => post('/commodities', body),
    createCategory: (body) => post('/commodities/categories', body),
    // Ids ever transacted (any intake/dispense, however old) in the given scope.
    // params: { facility_id } | { state, lga } | { facility_ids }
    transacted: (params) => get('/commodities/transacted', params),
  },
  binCard:     (params) => get('/bincard', params),
  binCardBins: (params) => get('/bincard/bins', params),
  binCardRedistBatches: (params) => get('/bincard/redist-batches', params),

  amcSettings: {
    list:   (params) => get('/amc-settings', params),
    upsert: (body)   => put('/amc-settings', body),
    remove: (facilityId) => del(`/amc-settings/${facilityId}`),
  },

  editHistory: {
    byRecord: (record_id) => get('/edit-history', { record_id }),
    create:   (body)      => post('/edit-history', body),
  },

  // ACL configuration screens. Every one of these is gated server-side on
  // req.scope (system_admin, or state_admin within its own state) — the UI's
  // hidden controls are convenience, never protection.
  admin: {
    meta:        ()            => get('/admin/meta'),
    // getRaw, not get: the envelope carries `total` alongside `data`, and the
    // list needs it to say how many matched.
    users:       (params)      => getRaw('/admin/users', params),
    user:        (id)          => get(`/admin/users/${id}`),
    createUser:  (body)        => post('/admin/users', body),
    deleteUser:  (id)          => del(`/admin/users/${id}`),
    createFacility: (body)     => post('/admin/facilities', body),
    setRole:     (id, body)    => put(`/admin/users/${id}/role`, body),
    setOverride: (id, body)    => put(`/admin/users/${id}/permission`, body),
    featureConfig:    ()       => get('/admin/feature-config'),
    setFeatureConfig: (body)   => put('/admin/feature-config', body),
  },
}
