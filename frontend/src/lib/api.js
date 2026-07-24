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

async function request(path, { method = 'GET', body, auth = false } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (auth) {
    const t = getToken()
    if (t) headers.Authorization = `Bearer ${t}`
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
const post  = (path, body)   => request(`/api${path}`, { method: 'POST',   auth: true, body }).then(r => r?.data)
const put   = (path, body)   => request(`/api${path}`, { method: 'PUT',    auth: true, body }).then(r => r?.data)
const patch = (path, body)   => request(`/api${path}`, { method: 'PATCH',  auth: true, body }).then(r => r?.data)
const del   = (path)         => request(`/api${path}`, { method: 'DELETE', auth: true }).then(r => r?.data)

export const api = {
  stock: {
    // facility_id optional: omit it to get the caller's whole scoped set (admin
    // / aggregate views). Other params: commodity_id, commodity_ids, location_type,
    // limit, offset.
    list:   (params)        => get('/stock', params),
    // On-hand lots of one bin (batch/expiry balances) for the dispense picker.
    // params: facility_id, commodity_id, location_type, site_name (dsd/sdp).
    lots:   (params)        => get('/stock/lots', params),
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
    get:    (id)     => get(`/transfers/${id}`),
    create: (lines)  => post('/transfers', lines),          // array | {lines:[]} | single row
    update: (id, body) => patch(`/transfers/${id}`, body),  // metadata-only
    remove: (id)     => del(`/transfers/${id}`),
    // lifecycle transitions
    dispatch:        (id, body) => patch(`/transfers/${id}/dispatch`, body),
    assignSource:    (id, body) => patch(`/transfers/${id}/assign`, body),
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
  intake:      { record: (body) => post('/intake', body),      history: (params) => get('/intake', params),      update: (id, body) => patch(`/intake/${id}`, body) },
  adjustments: { record: (body) => post('/adjustments', body), history: (params) => get('/adjustments', params), update: (id, body) => patch(`/adjustments/${id}`, body) },

  reports: {
    daily:        (params) => get('/reports/daily', params),
    weekly:       (params) => get('/reports/weekly', params),
    monthly:      (params) => get('/reports/monthly', params),
    stockBalance: (params) => get('/reports/stock-balance', params),
  },

  facilities:  { list: (params) => get('/facilities', params), get: (id) => get(`/facilities/${id}`), dsdSites: (id) => get(`/facilities/${id}/dsd-sites`) },
  commodities: {
    list: () => get('/commodities'),
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
}
