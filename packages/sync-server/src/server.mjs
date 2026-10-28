// @ts-check
/* WebSocket server speaking the standard Yjs protocol (y-protocols sync + awareness, the same wire format as y-websocket),
   one Y.Doc per project room, persisted by ProjectStore.

   Join:   ws://<host>/r/<roomId>?token=<invite token>
   Close codes: 4400 malformed message · 4401 bad token · 4404 unknown room · 4429 too many connections from this IP
                1009 message too big (sent by ws) · 1001 server shutting down */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { ProjectStore } from './store.mjs';
import { createLogger } from './log.mjs';

const MSG_SYNC = 0, MSG_AWARENESS = 1, MSG_QUERY_AWARENESS = 3;
const DEMO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../demo');
const DEMO_FILES = { '/demo/': ['index.html', 'text/html'], '/demo/dist/client.js': ['dist/client.js', 'text/javascript'] };

/**
 * @param {{ port?: number, host?: string, dataDir?: string, maxMessageBytes?: number, maxConnsPerIp?: number,
 *   compactEvery?: number, compactIntervalMs?: number, unloadAfterMs?: number, pingMs?: number,
 *   trustProxy?: boolean, serveDemo?: boolean, logLevel?: string }} [opts]
 */
export async function startServer(opts = {}) {
  const o = {
    port: 3300, host: '127.0.0.1', dataDir: './data', maxMessageBytes: 2 * 1024 * 1024, maxConnsPerIp: 16,
    compactEvery: 500, compactIntervalMs: 60_000, unloadAfterMs: 30_000, pingMs: 30_000,
    trustProxy: false, serveDemo: false, logLevel: 'info', ...opts,
  };
  const log = createLogger(o.logLevel), store = new ProjectStore(o.dataDir);
  /** @type {Map<string, Room>} */ const rooms = new Map();
  /** @type {Map<string, number>} */ const perIp = new Map();
  let closing = false;

  /** @typedef {{ id: string, doc: Y.Doc, awareness: awarenessProtocol.Awareness, conns: Map<import('ws').WebSocket, Set<number>>, records: number, unloadTimer: NodeJS.Timeout | null }} Room */

  /** @param {string} id */
  function getRoom(id) {
    let room = rooms.get(id);
    if (room) { if (room.unloadTimer) { clearTimeout(room.unloadTimer); room.unloadTimer = null; } return room; }
    const t0 = performance.now(), { doc, records, bytes, torn } = store.loadDoc(id);
    if (torn) log.warn('dropped torn tail of update log', { room: id, bytes: torn });
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null);
    const r = /** @type {Room} */ ({ id, doc, awareness, conns: new Map(), records, unloadTimer: null });
    rooms.set(id, r);
    doc.on('update', (/** @type {Uint8Array} */ update, /** @type {any} */ origin) => {
      store.append(id, update);              // on disk before anyone hears about it
      if (++r.records >= o.compactEvery) compact(r);
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

  /** @param {Room} r */
  function compact(r) {
    if (r.records <= 1) return;
    const bytes = store.compact(r.id, r.doc);
    log.debug('compacted', { room: r.id, records: r.records, bytes });
    r.records = 1;
  }

  /** @param {Room} r */
  function unload(r) {
    compact(r); r.awareness.destroy(); r.doc.destroy(); rooms.delete(r.id);
    log.debug('room unloaded', { room: r.id });
  }

  /** @param {import('ws').WebSocket} ws @param {Uint8Array} msg */
  function send(ws, msg) {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(msg, err => { if (err) ws.terminate(); });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, rooms: rooms.size })); return; }
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

  const wss = new WebSocketServer({ noServer: true, maxPayload: o.maxMessageBytes });
  server.on('upgrade', (req, socket, head) => {
    if (closing) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => onConnection(ws, req));
  });

  /** @param {import('ws').WebSocket} ws @param {http.IncomingMessage} req */
  function onConnection(ws, req) {
    const fwd = o.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = fwd || req.socket.remoteAddress || '?';
    ws.on('error', err => log.debug('socket error', { ip, err: err.message }));
    const n = (perIp.get(ip) || 0) + 1;
    if (n > o.maxConnsPerIp) { log.warn('rejected: too many connections', { ip }); ws.close(4429, 'too many connections'); return; }
    const url = new URL(req.url || '/', 'http://x'), m = /^\/r\/([^/]+)$/.exec(url.pathname), id = m ? m[1] : '';
    if (!store.exists(id)) { log.warn('rejected: unknown room', { ip }); ws.close(4404, 'unknown room'); return; }
    if (!store.checkToken(id, url.searchParams.get('token') || '')) { log.warn('rejected: bad token', { ip, room: id }); ws.close(4401, 'bad token'); return; }

    perIp.set(ip, n);
    const room = getRoom(id);
    room.conns.set(ws, new Set());
    /** @type {any} */ (ws).alive = true;
    ws.on('pong', () => { /** @type {any} */ (ws).alive = true; });
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
    setInterval(() => { for (const r of rooms.values()) compact(r); }, o.compactIntervalMs),
    setInterval(() => {
      for (const ws of wss.clients) { const w = /** @type {any} */ (ws); if (!w.alive) { ws.terminate(); continue; } w.alive = false; ws.ping(); }
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
    for (const r of [...rooms.values()]) { if (r.unloadTimer) clearTimeout(r.unloadTimer); unload(r); }
    await new Promise(ok => { server.close(() => ok(undefined)); server.closeAllConnections(); });
    log.info('stopped');
  }

  return { port: addr.port, url: `ws://${o.host}:${addr.port}/r`, rooms, store, close };
}
