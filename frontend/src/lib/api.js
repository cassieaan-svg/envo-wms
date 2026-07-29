const BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000';
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

async function request(path, { method = 'GET', body, isUpload = false } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body && !isUpload) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: isUpload ? body : body ? JSON.stringify(body) : undefined,
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
};

const qs = (params) => {
  const search = new URLSearchParams(
    Object.entries(params || {}).filter(([, v]) => v !== null && v !== undefined && v !== '')
  ).toString();
  return search ? `?${search}` : '';
};

export const api = {
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
  },
  facilities: {
    list: (params) => request(`/api/facilities${qs(params)}`),
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
    get: (id) => request(`/api/dispatch-orders/${id}`),
  },
  alerts: {
    expiry: (params) => request(`/api/alerts/expiry${qs(params)}`),
    stock: () => request('/api/alerts/stock'),
  },
  priceListImports: {
    list: () => request('/api/price-list-imports'),
    get: (id) => request(`/api/price-list-imports/${id}`),
    upload: (file, notes) => {
      const form = new FormData();
      form.append('file', file);
      if (notes) form.append('notes', notes);
      return request('/api/price-list-imports', { method: 'POST', body: form, isUpload: true });
    },
    updateRow: (importId, rowId, body) =>
      request(`/api/price-list-imports/${importId}/rows/${rowId}`, { method: 'PUT', body }),
    assignVendor: (importId, body) =>
      request(`/api/price-list-imports/${importId}/vendor`, { method: 'PUT', body }),
    commit: (importId) => request(`/api/price-list-imports/${importId}/commit`, { method: 'POST' }),
  },
};
