// @ts-check
/* The sync server's HTTP API, from the browser (packages/sync-server/src/api.mjs). Rooms created from the app,
   owner actions. Tokens go in the Authorization header, never in a URL. Every call resolves (it
   never throws): { ok: true, ...fields } or { ok: false, error, message, status }, where `message` is a sentence the app
   can show as it is and `error` a stable code ('no_session', 'create_limit', 'not_owner', ...; 'network'
   when the server didn't answer at all, 'malformed' when its answer wasn't the JSON expected). */

/** wss://sync.example.dev → https://sync.example.dev (the API lives on the same host as the WebSocket). */
export function httpBase(/** @type {string} */ syncUrl) {
  return String(syncUrl || '').trim().replace(/\/+$/, '').replace(/^ws(s?):\/\//i, 'http$1://');
}

/** @typedef {{ ok: false, error: string, message: string, status: number, retryAfter?: number }} ApiError */

/** @param {string} syncUrl @param {{ fetch?: typeof fetch, timeoutMs?: number }} [opts] */
export function createApi(syncUrl, opts = {}) {
  const base = httpBase(syncUrl), f = opts.fetch || ((...a) => globalThis.fetch(...a)), timeoutMs = opts.timeoutMs ?? 15000;

  /** @param {string} method @param {string} path @param {{ token?: string, body?: any }} [o] @returns {Promise<any>} */
  async function call(method, path, { token, body } = {}) {
    /** @type {Record<string, string>} */ const headers = {};
    if (token) headers.authorization = 'Bearer ' + token;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const ctl = typeof AbortController === 'function' ? new AbortController() : null, t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : 0;
    try {
      const r = await f(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl ? ctl.signal : undefined, cache: 'no-store', credentials: 'omit' });
      let j = null; try { j = await r.json(); } catch { j = null; }
      if (!r.ok) {
        const e = /** @type {ApiError} */ ({ ok: false, status: r.status, error: j && typeof j.error === 'string' ? j.error : 'http_' + r.status, message: j && typeof j.message === 'string' ? j.message : "The sync server didn't accept that." });
        if (j && Number.isFinite(j.retryAfter)) e.retryAfter = j.retryAfter;
        return e;
      }
      if (!j || typeof j !== 'object') return { ok: false, status: r.status, error: 'malformed', message: "The sync server's answer couldn't be read." };
      return { ok: true, ...j };
    } catch {
      return { ok: false, status: 0, error: 'network', message: "The sync server didn't answer. Check your connection and try again." };
    } finally { clearTimeout(t); }
  }

  return {
    /** a new, empty room named after the project, with a session from auth → { ok, roomId, token, ownerToken } */
    createRoom: (/** @type {string} */ session, /** @type {string} */ name) => call('POST', '/rooms', { token: session, body: { name: String(name || '').slice(0, 120) } }),
    /** owner: a new invite link; every old one stops working and everyone connected is closed → { ok, token } */
    regenerateInvite: (/** @type {string} */ roomId, /** @type {string} */ ownerToken) => call('POST', `/rooms/${encodeURIComponent(roomId)}/invite`, { token: ownerToken }),
    /** owner: wipe the room on the server; members see "room deleted" → { ok } */
    deleteRoom: (/** @type {string} */ roomId, /** @type {string} */ ownerToken) => call('DELETE', `/rooms/${encodeURIComponent(roomId)}`, { token: ownerToken }),
  };
}
