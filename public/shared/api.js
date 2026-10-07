/* ===== Bermuda Sort Station — fetch wrapper, session, OFFLINE detection ===== */
const TOKEN_KEY = 'bermuda_token';
const STATION_KEY = 'bermuda_station';
const ROLE_KEY = 'bermuda_role';
const TIMEOUT_MS = 3000;

export function getToken() { return sessionStorage.getItem(TOKEN_KEY); }
export function getStation() { return sessionStorage.getItem(STATION_KEY); }
export function getRole() { return sessionStorage.getItem(ROLE_KEY); }
export function setSession(token, station, role) {
  sessionStorage.setItem(TOKEN_KEY, token);
  sessionStorage.setItem(STATION_KEY, station);
  if (role) sessionStorage.setItem(ROLE_KEY, role);
}
export function clearSession() { sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(STATION_KEY); sessionStorage.removeItem(ROLE_KEY); }

const offlineListeners = [];
export function onOffline(fn) { offlineListeners.push(fn); }
// fired when a request carrying a stored token comes back 401 (session expired/removed) so a
// page can drop back to its login screen instead of silently rendering nothing
const unauthorizedListeners = [];
export function onUnauthorized(fn) { unauthorizedListeners.push(fn); }
function markOffline(isOffline) { for (const fn of offlineListeners) fn(isOffline); }

export async function apiFetch(path, options = {}) {
  // Content-Type: application/json on a bodyless request makes Fastify's JSON parser reject
  // it (FST_ERR_CTP_EMPTY_JSON_BODY) before the route handler ever runs — only send it when
  // there's actually a body to parse.
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || TIMEOUT_MS);
  try {
    const res = await fetch(path, { ...options, headers, signal: controller.signal });
    clearTimeout(timer);
    markOffline(false);
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 && token && path !== '/api/login') for (const fn of unauthorizedListeners) fn();
    if (!res.ok) return { ok: false, status: res.status, error: body.error || res.statusText };
    return body;
  } catch {
    clearTimeout(timer);
    markOffline(true);
    return { ok: false, offline: true, error: 'OFFLINE' };
  }
}

export async function login(station, name, pin) {
  const r = await apiFetch('/api/login', { method: 'POST', body: JSON.stringify({ station, name, pin }) });
  if (r.ok) setSession(r.token, station, r.user?.role);
  return r;
}

export const scanCode = raw => apiFetch('/api/scan', { method: 'POST', body: JSON.stringify({ raw }) });
export const undoLast = () => apiFetch('/api/undo', { method: 'POST' });
export const finishTote = () => apiFetch('/api/tote/finish', { method: 'POST' });
export const nextTotes = (n = 5) => apiFetch(`/api/next-totes?n=${n}`);
export const getStatus = () => apiFetch('/api/status');
export const getRouteProgress = () => apiFetch('/api/route-progress');
export const markToteMissing = (toteId, reason) => apiFetch(`/api/tote/${encodeURIComponent(toteId)}/missing`, { method: 'POST', body: JSON.stringify({ reason }) });
export const getCurrentTote = () => apiFetch('/api/tote/current');
export const releasePid = (location, pid) => apiFetch('/api/consolidation/release', { method: 'POST', body: JSON.stringify({ location, pid }) });
