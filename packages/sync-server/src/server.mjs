// @ts-check
/* WebSocket server speaking the standard Yjs protocol (y-protocols sync + awareness, the same wire format as y-websocket),
   one Y.Doc per project room, persisted by ProjectStore.

   Join:   ws://<host>/r/<roomId>?token=<invite token>
   Close codes: 4400 malformed message · 4401 bad token · 4404 unknown room · 4429 too many connections from this IP
                4500 room unavailable (unreadable project.json or updates.bin, or the room is degraded: an append to its log
                failed and it refuses joins until a compaction gets its state on disk; see the error log)
                1009 message too big (sent by ws) · 1001 server shutting down · 1006 terminated (no pong, or a slow reader) */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { ProjectStore, CorruptLogError } from './store.mjs';
import { createLogger } from './log.mjs';

const MSG_SYNC = 0, MSG_AWARENESS = 1, MSG_QUERY_AWARENESS = 3;
const DEMO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../demo');
const DEMO_FILES = { '/demo/': ['index.html', 'text/html'], '/demo/dist/client.js': ['dist/client.js', 'text/javascript'] };

/**
 * @param {{ port?: number, host?: string, dataDir?: string, maxMessageBytes?: number, maxConnsPerIp?: number,
 *   compactEvery?: number, compactIntervalMs?: number, unloadAfterMs?: number, pingMs?: number,
 *   maxBufferedBytes?: number, trustProxy?: boolean, trustedProxyHops?: number, serveDemo?: boolean, logLevel?: string,
 *   log?: ReturnType<typeof createLogger> }} [opts]
 */
export async function startServer(opts = {}) {
  const o = {
    port: 3300, host: '127.0.0.1', dataDir: './data', maxMessageBytes: 2 * 1024 * 1024, maxConnsPerIp: 16,
    compactEvery: 500, compactIntervalMs: 60_000, unloadAfterMs: 30_000, pingMs: 30_000, maxBufferedBytes: 8 * 1024 * 1024,
    trustProxy: false, trustedProxyHops: 1, serveDemo: false, logLevel: 'info', ...opts,
  };
  const log = o.log || createLogger(o.logLevel), store = new ProjectStore(o.dataDir, log);
  /** @type {Map<string, Room>} */ const rooms = new Map();
  /** @type {Map<string, number>} */ const perIp = new Map();
  let closing = false, warnedShortXff = false;

  /** failing: compaction is failing (logged once per burst). degraded: an append failed, so the log on disk is behind the
      doc (maybe with a torn tail); nothing more is appended until a compaction rewrites it, and new joins get 4500.
      @typedef {{ id: string, doc: Y.Doc, awareness: awarenessProtocol.Awareness, conns: Map<import('ws').WebSocket, Set<number>>, records: number, unloadTimer: NodeJS.Timeout | null,
        failing: boolean, degraded: boolean }} Room */

  /** @param {string} id */
  function getRoom(id) {
    let room = rooms.get(id);
    if (room) { if (room.unloadTimer) { clearTimeout(room.unloadTimer); room.unloadTimer = null; } return room; }
    const t0 = performance.now(), { doc, records, bytes, torn } = store.loadDoc(id);
    if (torn) log.warn('dropped torn tail of update log (original kept as updates.bin.torn-*)', { room: id, bytes: torn });
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null);
    const r = /** @type {Room} */ ({ id, doc, awareness, conns: new Map(), records, unloadTimer: null, failing: false, degraded: false });
    rooms.set(id, r);
    doc.on('update', (/** @type {Uint8Array} */ update, /** @type {any} */ origin) => {
      // on disk before anyone hears about it. Nothing may throw from here: it would escape the Yjs transaction mid-cleanup.
      if (!r.degraded) {
        try { store.append(id, update); } catch (err) {
          r.degraded = true;
          log.error('append failed: room degraded, refusing joins until a compaction succeeds', { room: id, ...fsErr(err) });
          if (r.conns.has(origin)) origin.close(4500, 'room unavailable');
        }
      }
      if (++r.records >= o.compactEvery && !r.failing && !r.degraded) compact(r);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC); syncProtocol.writeUpdate(enc, update);
      const msg = encoding.toUint8Array(enc);
      for (const c of r.conns.keys()) if (c !== origin) send(c, msg);
    });
    awareness.on('update', (/** @type {any} */ { added, updated, removed }, /** @type {any} */ origin) => {
      const ids = r.conns.get(origin);
      if (ids) { added.forEach((/** @type {number} */ c) => ids.add(c)); removed.forEach((/** @type {number} */ c) => ids.delete(c)); }
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]));
      const msg = encoding.toUint8Array(enc);
      for (const c of r.conns.keys()) send(c, msg);
    });
    log.info('room loaded', { room: id, records, bytes, ms: +(performance.now() - t0).toFixed(1) });
    return r;
  }

  /** @param {unknown} err */
  function fsErr(err) { const e = /** @type {NodeJS.ErrnoException} */ (err); return { code: e.code, err: e.message }; }

  /** Rewrite the room's log as one record. Never throws: on a disk error (ENOSPC, EACCES, DATA_DIR gone) it logs once per
      failure burst, leaves the room as it is and returns false; the compaction tick retries. @param {Room} r */
  function compact(r) {
    if (r.records <= 1 && !r.degraded) return true;
    try {
      const bytes = store.compact(r.id, r.doc);
      log.debug('compacted', { room: r.id, records: r.records, bytes });
    } catch (err) {
      if (!r.failing) log.error('compaction failed, retrying every tick', { room: r.id, degraded: r.degraded, ...fsErr(err) });
      r.failing = true;
      return false;
    }
    if (r.failing || r.degraded) log.info('compaction recovered, room state is on disk', { room: r.id, wasDegraded: r.degraded });
    r.records = 1; r.failing = false; r.degraded = false;
    return true;
  }

  /** If the final compaction fails, the room stays loaded and the compaction tick retries the unload. `force` (shutdown)
      unloads anyway. @param {Room} r */
  function unload(r, force = false) {
    r.unloadTimer = null;
    if (!compact(r)) {
      if (!force) return;
      if (r.degraded) log.error('shutting down with changes not on disk', { room: r.id });
    }
    r.awareness.destroy(); r.doc.destroy(); rooms.delete(r.id);
    log.debug('room unloaded', { room: r.id });
  }

  /** A client that stops reading would make every broadcast pile up in our memory: drop it once its queue would pass
      maxBufferedBytes. A message onto an empty queue always goes, so a big initial sync is never refused.
      @param {import('ws').WebSocket} ws @param {Uint8Array} msg */
  function send(ws, msg) {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount && ws.bufferedAmount + msg.length > o.maxBufferedBytes) {
      log.warn('terminating: slow reader', { ip: /** @type {any} */ (ws).ip, buffered: ws.bufferedAmount });
      ws.terminate();
      return;
    }
    ws.send(msg, err => { if (err) ws.terminate(); });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, rooms: rooms.size, degraded: [...rooms.values()].filter(r => r.degraded).length })); return; }
    const f = o.serveDemo && /** @type {any} */ (DEMO_FILES)[url.pathname];
    if (f) {
      fs.readFile(path.join(DEMO_DIR, f[0]), (err, body) => {
        if (err) { res.writeHead(404); res.end('demo not built: npm run build:demo'); return; }
        res.writeHead(200, { 'content-type': f[1], 'cache-control': 'no-store' }); res.end(body);
      });
      return;
    }
    res.writeHead(404); res.end();
  });

  // A browser can't set headers on a WebSocket, so the app sends the token as the second subprotocol
  // (`cueboard, <token>`) instead of in the URL, where it would land in proxy access logs and in the browser console
  // whenever a connect fails. Only `cueboard` is echoed back, never the token.
  const wss = new WebSocketServer({ noServer: true, maxPayload: o.maxMessageBytes, handleProtocols: protocols => (protocols.has('cueboard') ? 'cueboard' : false) });
  server.on('upgrade', (req, socket, head) => {
    if (closing) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => onConnection(ws, req));
  });

  /** Client IP. Behind our own proxies, the Nth X-Forwarded-For entry from the right (N = trustedProxyHops) is the
      address the outermost one of them saw; anything left of it is whatever the client sent. With fewer than N entries the header
      can't have come through all our proxies, so none of it is trusted: the socket address is used (warned once).
      @param {http.IncomingMessage} req */
  function clientIp(req) {
    if (o.trustProxy) {
      const n = Math.max(1, o.trustedProxyHops);
      const hops = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
      if (hops.length >= n) return hops[hops.length - n];
      if (!warnedShortXff) {
        warnedShortXff = true;
        log.warn('X-Forwarded-For has fewer entries than TRUSTED_PROXY_HOPS, using the socket address (warned once)', { entries: hops.length, hops: n });
      }
    }
    return req.socket.remoteAddress || '?';
  }

  /** Token from `Sec-WebSocket-Protocol: cueboard, <token>`, or ''. @param {http.IncomingMessage} req */
  function protocolToken(req) {
    const p = String(req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim());
    return p[0] === 'cueboard' && p[1] ? p[1] : '';
  }

  /** @param {import('ws').WebSocket} ws @param {http.IncomingMessage} req */
  function onConnection(ws, req) {
    const ip = clientIp(req);
    ws.on('error', err => log.debug('socket error', { ip, err: err.message }));
    const n = (perIp.get(ip) || 0) + 1;
    if (n > o.maxConnsPerIp) { log.warn('rejected: too many connections', { ip }); ws.close(4429, 'too many connections'); return; }
    const url = new URL(req.url || '/', 'http://x'), m = /^\/r\/([^/]+)$/.exec(url.pathname), id = m ? m[1] : '';
    /** @type {Room} */ let room;
    try {
      if (!store.exists(id)) { log.warn('rejected: unknown room', { ip }); ws.close(4404, 'unknown room'); return; }
      if (!store.checkToken(id, url.searchParams.get('token') || protocolToken(req))) { log.warn('rejected: bad token', { ip, room: id }); ws.close(4401, 'bad token'); return; }
      if (rooms.get(id)?.degraded) { log.warn('rejected: room degraded', { ip, room: id }); ws.close(4500, 'room unavailable'); return; }
      room = getRoom(id);
    } catch (err) {
      // a broken project.json or updates.bin: refuse this room, keep serving the rest. Only our own messages are logged,
      // since a JSON.parse message can quote project.json (token hashes).
      const e = /** @type {Error} */ (err);
      log.error('rejected: room unavailable', { room: id, ip, err: e instanceof CorruptLogError ? e.message : e.name });
      ws.close(4500, 'room unavailable');
      return;
    }

    perIp.set(ip, n);
    room.conns.set(ws, new Set());
    // liveness: only a pong echoing the nonce of our outstanding ping counts; unsolicited pongs are ignored
    const w = /** @type {any} */ (ws);
    w.ip = ip; w.pingNonce = null;
    ws.on('pong', data => { if (w.pingNonce && w.pingNonce.equals(data)) w.pingNonce = null; });
    log.debug('joined', { room: id, ip, conns: room.conns.size });

    ws.on('message', (data, isBinary) => {
      try {
        if (!isBinary) throw new Error('text frame');
        const dec = decoding.createDecoder(new Uint8Array(/** @type {Buffer} */ (data)));
        const type = decoding.readVarUint(dec);
        if (type === MSG_SYNC) {
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, MSG_SYNC);
          syncProtocol.readSyncMessage(dec, enc, room.doc, ws);
          if (encoding.length(enc) > 1) send(ws, encoding.toUint8Array(enc));
        } else if (type === MSG_AWARENESS) {
          awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(dec), ws);
        } else if (type === MSG_QUERY_AWARENESS) {
          sendAwareness(ws, room);
        } else throw new Error('unknown message type ' + type);
      } catch (err) {
        log.warn('closing: malformed message', { room: id, ip, err: /** @type {Error} */ (err).message });
        ws.close(4400, 'malformed message');
      }
    });

    ws.on('close', code => {
      const ids = room.conns.get(ws);
      room.conns.delete(ws);
      const left = (perIp.get(ip) || 1) - 1;
      if (left) perIp.set(ip, left); else perIp.delete(ip);
      if (ids && ids.size) awarenessProtocol.removeAwarenessStates(room.awareness, [...ids], null);
      if (code === 1009) log.warn('closed: message too big', { room: id, ip });
      log.debug('left', { room: id, ip, code, conns: room.conns.size });
      if (!room.conns.size && !closing && rooms.get(id) === room) room.unloadTimer = setTimeout(() => unload(room), o.unloadAfterMs);
    });

    // greet: our state vector (client answers with what we miss) + who else is here
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC); syncProtocol.writeSyncStep1(enc, room.doc);
    send(ws, encoding.toUint8Array(enc));
    sendAwareness(ws, room);
  }

  /** @param {import('ws').WebSocket} ws @param {Room} room */
  function sendAwareness(ws, room) {
    const states = room.awareness.getStates();
    if (!states.size) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()]));
    send(ws, encoding.toUint8Array(enc));
  }

  const timers = [
    // an empty room without an unload timer is one whose unload failed: retry it
    setInterval(() => { for (const r of [...rooms.values()]) { if (!r.conns.size && !r.unloadTimer) unload(r); else compact(r); } }, o.compactIntervalMs),
    setInterval(() => {
      for (const ws of wss.clients) {
        const w = /** @type {any} */ (ws);
        if (w.pingNonce) { ws.terminate(); continue; }   // our last ping went unanswered
        w.pingNonce = randomBytes(8); ws.ping(w.pingNonce);
      }
    }, o.pingMs),
  ];
  timers.forEach(t => t.unref());

  await new Promise((ok, fail) => { server.once('error', fail); server.listen(o.port, o.host, () => ok(undefined)); });
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  log.info('listening', { host: o.host, port: addr.port, dataDir: store.dir });

  async function close() {
    if (closing) return;
    closing = true;
    timers.forEach(clearInterval);
    for (const ws of wss.clients) ws.close(1001, 'server shutting down');
    for (const r of [...rooms.values()]) { if (r.unloadTimer) clearTimeout(r.unloadTimer); unload(r, true); }
    await new Promise(ok => { server.close(() => ok(undefined)); server.closeAllConnections(); });
    log.info('stopped');
  }

  return { port: addr.port, url: `ws://${o.host}:${addr.port}/r`, rooms, store, close };
}
