// `??` rather than `||` so an explicitly empty VITE_API_URL means "same origin" — the
// tunnel/demo case, where requests go through the dev proxy — instead of silently falling
// back to localhost, which would be the viewer's own machine.
const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:5100';
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

async function request(path, { method = 'GET', body } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

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
    localStorage.setItem(USER_KEY, JSON.stringify(result.user));
    return result.user;
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
  alerts: {
    expiry: (params) => request(`/api/alerts/expiry${qs(params)}`),
    stock: () => request('/api/alerts/stock'),
  },
};
