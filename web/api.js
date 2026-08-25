/**
 * Talking to the club server.
 *
 * The base address is stored on the device so the same build works whether the
 * app is served by the club server itself (blank base, same origin) or from
 * static hosting pointed at a server elsewhere.
 */

const KEY_TOKEN = 'tagcheck.token';
const KEY_MEMBER = 'tagcheck.member';
const KEY_BASE = 'tagcheck.server';

export const session = {
  get token() { return localStorage.getItem(KEY_TOKEN) || ''; },
  get member() {
    try {
      return JSON.parse(localStorage.getItem(KEY_MEMBER) || 'null');
    } catch {
      return null;
    }
  },
  get base() { return (localStorage.getItem(KEY_BASE) || '').replace(/\/+$/, ''); },
  set base(value) {
    if (value) localStorage.setItem(KEY_BASE, value.replace(/\/+$/, ''));
    else localStorage.removeItem(KEY_BASE);
  },
  save({ token, member }) {
    localStorage.setItem(KEY_TOKEN, token);
    localStorage.setItem(KEY_MEMBER, JSON.stringify(member));
  },
  clear() {
    localStorage.removeItem(KEY_TOKEN);
    localStorage.removeItem(KEY_MEMBER);
  },
};

/** Thrown for anything the caller may want to branch on. */
export class ApiError extends Error {
  constructor(status, code, payload) {
    super(code || `http_${status}`);
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

/** Raised when the request never reached the server, so it is worth retrying. */
export class OfflineError extends Error {
  constructor() {
    super('offline');
  }
}

export function apiUrl(path) {
  return session.base + path;
}

async function request(path, { method = 'GET', body, timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(apiUrl(path), {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(session.token ? { authorization: `Bearer ${session.token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch {
    throw new OfflineError();
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  // A conflict is an expected answer here ("someone already tagged it"), so it
  // is handed back to the caller rather than thrown.
  if (response.status === 409) return { conflict: true, ...payload };
  if (!response.ok) throw new ApiError(response.status, payload && payload.error, payload);
  return payload;
}

export const api = {
  club: () => request('/api/club'),
  signIn: (code, name, deviceId) => request('/api/session', {
    method: 'POST',
    body: { code, name, deviceId },
  }),
  lookup: (plate) => request(`/api/plates/${encodeURIComponent(plate)}`),
  tag: (tag) => request('/api/tags', { method: 'POST', body: tag }),
  untag: (id) => request(`/api/tags/${id}`, { method: 'DELETE' }),
  feed: ({ mine, before } = {}) => {
    const params = new URLSearchParams();
    if (mine) params.set('mine', '1');
    if (before) params.set('before', before);
    const query = params.toString();
    return request(`/api/tags${query ? `?${query}` : ''}`);
  },
  stats: () => request('/api/stats'),
  sync: (since) => request(`/api/sync${since ? `?since=${encodeURIComponent(since)}` : ''}`),
};
