import { getServerBase } from './cmsServer.js';

const TOKEN_KEY = 'envo_wms_token';
const USER_KEY = 'envo_wms_user';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser() {
  const raw = localStorage.getItem(USER_KEY);
  return raw ? JSON.parse(raw) : null;
}

function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

async function request(path, { method = 'GET', body, signal } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';

  // Resolved per call, not once at module load: the operator can point the device at a
  // different warehouse server without reloading the app.
  const base = getServerBase();

  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers,
      signal,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (cause) {
    // fetch only rejects when the request never got an answer — the server is off, the
    // address is wrong, or the device is off the LAN. That is a different problem from a
    // 4xx, and the UI has to say so differently: one means "check the warehouse server",
    // the other means "you did something the server refused".
    const err = new Error('Warehouse server unavailable');
    err.offline = true;
    err.cause = cause;
    err.serverBase = base;
    throw err;
  }

  if (res.status === 401) {
    clearSession();
    window.dispatchEvent(new Event('envo-wms-unauthorized'));
    throw new Error('session expired — please sign in again');
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) throw new Error(data?.error || `request failed (${res.status})`);
  return data;
}

export const auth = {
  async login(username, password) {
    const result = await request('/api/auth/login', { method: 'POST', body: { username, password } });
    localStorage.setItem(TOKEN_KEY, result.token);
    // /login's own response carries only {id, username, fullName, role} — the legacy
    // display field. roles/permissions (what the Phase 1 authorization model actually
    // decides access by) come from /me, fetched immediately so the stored session — and
    // anything gating the UI on it, like the Users nav entry — reflects real permissions
    // from the first render rather than the stale legacy role column.
    const full = await request('/api/auth/me');
    localStorage.setItem(USER_KEY, JSON.stringify(full));
    return full;
  },
  logout: clearSession,
  me: () => request('/api/auth/me'),
  changePassword: (currentPassword, newPassword) =>
    request('/api/auth/password', { method: 'PUT', body: { currentPassword, newPassword } }),
};

const qs = (params) => {
  const search = new URLSearchParams(
    Object.entries(params || {}).filter(([, v]) => v !== null && v !== undefined && v !== '')
  ).toString();
  return search ? `?${search}` : '';
};

export const api = {
  schemes: {
    list: () => request('/api/schemes'),
  },

  // Facility indebtedness: per-order balances and the payments that clear them.
  accounts: {
    debtors:        ()             => request('/api/accounts/debtors'),
    facilityOrders: (id, params)   => request(`/api/accounts/facilities/${id}/orders${params?.onlyOutstanding ? '?onlyOutstanding=true' : ''}`),
    orderPayments:  (orderId)      => request(`/api/accounts/orders/${orderId}/payments`),
    settled:        (facilityId)   => request(`/api/accounts/settled${facilityId ? `?facilityId=${facilityId}` : ''}`),
    outstanding:    (facilityId)   => request(`/api/accounts/outstanding${facilityId ? `?facilityId=${facilityId}` : ''}`),
    recordPayment:  (orderId, body) => request(`/api/accounts/orders/${orderId}/payments`, { method: 'POST', body }),
  },

  vendors: {
    list: (params) => request(`/api/vendors${qs(params)}`),
    create: (body) => request('/api/vendors', { method: 'POST', body }),
    update: (id, body) => request(`/api/vendors/${id}`, { method: 'PUT', body }),
    deactivate: (id) => request(`/api/vendors/${id}`, { method: 'DELETE' }),
  },
  commodities: {
    list: (params) => request(`/api/commodities${qs(params)}`),
    categories: () => request('/api/commodities/categories'),
    get: (id) => request(`/api/commodities/${id}`),
    create: (body) => request('/api/commodities', { method: 'POST', body }),
    update: (id, body) => request(`/api/commodities/${id}`, { method: 'PUT', body }),
    setStockLevels: (id, body) => request(`/api/commodities/${id}/stock-levels`, { method: 'PUT', body }),
    priceHistory: (id) => request(`/api/commodities/${id}/prices`),
    setPrice: (id, body) => request(`/api/commodities/${id}/prices`, { method: 'PUT', body }),
    batches: (id, params) => request(`/api/commodities/${id}/batches${qs(params)}`),
  },
  batches: {
    receive: (body) => request('/api/batches', { method: 'POST', body }),
    movements: (id) => request(`/api/batches/${id}/movements`),
    adjust: (id, body) => request(`/api/batches/${id}/adjust`, { method: 'POST', body }),
    adjustmentReasons: () => request('/api/batches/adjustment-reasons'),
    setNumber: (id, body) => request(`/api/batches/${id}/number`, { method: 'PUT', body }),
  },
  facilities: {
    list: (params) => request(`/api/facilities${qs(params)}`),
    lgas: (params) => request(`/api/facilities/lgas${qs(params)}`),
    create: (body) => request('/api/facilities', { method: 'POST', body }),
    update: (id, body) => request(`/api/facilities/${id}`, { method: 'PUT', body }),
    commodities: (id) => request(`/api/facilities/${id}/commodities`),
    addCommodity: (id, body) => request(`/api/facilities/${id}/commodities`, { method: 'POST', body }),
    removeCommodity: (id, commodityId) =>
      request(`/api/facilities/${id}/commodities/${commodityId}`, { method: 'DELETE' }),
    stock: (id) => request(`/api/facilities/${id}/stock`),
    dispatchOrders: (id) => request(`/api/facilities/${id}/dispatch-orders`),
    createDispatchOrder: (id, body) =>
      request(`/api/facilities/${id}/dispatch-orders`, { method: 'POST', body }),
  },
  dispatchOrders: {
    list: (params) => request(`/api/dispatch-orders${qs(params)}`),
    get: (id) => request(`/api/dispatch-orders/${id}`),
    update: (id, body) => request(`/api/dispatch-orders/${id}`, { method: 'PUT', body }),
    // Records that a copy of the waybill was taken and returns the label it should carry
    // (ORIGINAL, REPRINT #1, …). Moves no stock — see DispatchService.recordPrint.
    print: (id, body) => request(`/api/dispatch-orders/${id}/print`, { method: 'POST', body }),
    prints: (id) => request(`/api/dispatch-orders/${id}/prints`),
  },
  requests: {
    list: (params) => request(`/api/requests${qs(params)}`),
    get: (id) => request(`/api/requests/${id}`),
    markPicking: (id, body) => request(`/api/requests/${id}/picking`, { method: 'PATCH', body }),
    fulfil: (id, body) => request(`/api/requests/${id}/fulfil`, { method: 'POST', body }),
    reject: (id, body) => request(`/api/requests/${id}/reject`, { method: 'POST', body }),
    recordReceipt: (id, body) => request(`/api/requests/${id}/receipt`, { method: 'POST', body }),
  },
  monitoring: {
    facility: (id, params) => request(`/api/monitoring/facilities/${id}${qs(params)}`),
    summary: (params) => request(`/api/monitoring/summary${qs(params)}`),
    daily: (params) => request(`/api/monitoring/daily${qs(params)}`),
    byCategory: (params) => request(`/api/monitoring/by-category${qs(params)}`),
    byFacility: (params) => request(`/api/monitoring/by-facility${qs(params)}`),
    byCommodity: (params) => request(`/api/monitoring/by-commodity${qs(params)}`),
    commodity: (id, params) => request(`/api/monitoring/commodities/${id}${qs(params)}`),
    commodityHistory: (id, params) =>
      request(`/api/monitoring/commodities/${id}/history${qs(params)}`),
    activity: (params) => request(`/api/monitoring/activity${qs(params)}`),
    adjustments: (params) => request(`/api/monitoring/adjustments${qs(params)}`),
    day: (params) => request(`/api/monitoring/day${qs(params)}`),
  },
  sync: {
    status: () => request('/api/sync/status'),
  },
  // Stock integrity: where the ledger and the shelf figure disagree. Findings only —
  // nothing here corrects anything.
  reconciliation: {
    open: () => request('/api/reconciliation'),
    run: () => request('/api/reconciliation/run', { method: 'POST', body: {} }),
    resolve: (id, body) => request(`/api/reconciliation/${id}/resolve`, { method: 'POST', body }),
  },

  alerts: {
    expiry: (params) => request(`/api/alerts/expiry${qs(params)}`),
    stock: () => request('/api/alerts/stock'),
  },

  // User/role administration — see docs/AUTHORIZATION.md. Held by System Administrator and
  // Warehouse Admin; which role a caller may grant/revoke is enforced server-side by tier.
  admin: {
    listUsers: () => request('/api/admin/users'),
    listRoles: () => request('/api/admin/roles'),
    createUser: (body) => request('/api/admin/users', { method: 'POST', body }),
    disableUser: (id) => request(`/api/admin/users/${id}/disable`, { method: 'PUT' }),
    enableUser: (id) => request(`/api/admin/users/${id}/enable`, { method: 'PUT' }),
    assignRole: (id, role) => request(`/api/admin/users/${id}/roles`, { method: 'POST', body: { role } }),
    removeRole: (id, role) => request(`/api/admin/users/${id}/roles/${role}`, { method: 'DELETE' }),
  },
};
