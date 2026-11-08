import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { startServer } from '../src/server.mjs';
import { ProjectStore } from '../src/store.mjs';
import { initProject } from '../src/schema.mjs';
import { generateKeyPairSync, sign } from 'node:crypto';

/** auth's key pair for tests: the server gets the public half (as AUTH_PUBLIC_KEY_FILE would), tests sign sessions */
export const AUTH_KEYS = generateKeyPairSync('ed25519');
/** A session as packages/auth issues it: base64url(JSON payload) + '.' + base64url(Ed25519 signature of that string). */
export function signSession(fields = {}, key = AUTH_KEYS.privateKey) {
  const now = Date.now(), p = Buffer.from(JSON.stringify({ typ: 'session', sub: 'ana@example.com', prd: 'cue-board', src: 'invite:Nacho', exp: now + 365 * 86400_000, chk: now, ...fields })).toString('base64url');
  return p + '.' + sign(null, Buffer.from(p), key).toString('base64url');
}

export const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cue-sync-test-'));

export async function server(dataDir, port, extra = {}) {
  return startServer({ port, dataDir, logLevel: process.env.LOG_LEVEL || 'silent', unloadAfterMs: 50, authPublicKey: AUTH_KEYS.publicKey, ...extra });
}

/** A fresh room seeded like a new project (one shot). */
export function makeRoom(dataDir, name = 'test') {
  const doc = new Y.Doc();
  initProject(doc, { title: name });
  return new ProjectStore(dataDir).createProject(name, doc);
}

export function client(srv, room, token) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(srv.url, room, doc, { WebSocketPolyfill: WebSocket, params: { token }, disableBc: true, maxBackoffTime: 200 });
  return { doc, provider };
}

export const synced = p => (p.synced ? Promise.resolve() : new Promise(ok => p.once('sync', s => s && ok())));

export async function until(fn, ms = 3000, label = 'condition') {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

/** Raw socket: resolves with 'joined' once the server greets it (the socket stays open; it's returned as `ws`), or with
    the close code if the server refuses it. */
export function join(url, headers = {}) {
  return new Promise(ok => {
    const ws = new WebSocket(url, { headers });
    ws.on('error', () => {});
    ws.once('message', () => ok({ result: 'joined', ws }));
    ws.on('close', code => ok({ result: code, ws }));
  });
}

/** Number of framed records in a room's updates.bin. */
export function records(file) {
  const buf = fs.readFileSync(file);
  let off = 0, n = 0;
  while (off + 4 <= buf.length) { off += 4 + buf.readUInt32LE(off); n++; }
  if (off !== buf.length) throw new Error(`${file}: framing doesn't end at EOF`);
  return n;
}

/** Raw socket: resolves with the close code the server sends. */
export function closeCode(url, onOpen = () => {}) {
  return new Promise(ok => {
    const ws = new WebSocket(url);
    ws.on('open', () => onOpen(ws));
    ws.on('error', () => {});
    ws.on('close', code => ok(code));
  });
}
