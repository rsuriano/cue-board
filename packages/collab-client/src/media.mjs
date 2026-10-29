// @ts-check
/* Peer-to-peer media for one open room session (docs/media-p2p.md). Every collaborator replicates every file the doc
   references, in the background, from whichever online peer has it: over a WebRTC data channel when one comes up,
   else through the sync server's relay. Every frame is sealed with the room's media key (media-core.mjs), so the relay
   and the signaling path only ever carry ciphertext. Everything a peer sends is untrusted: sizes, indexes and counts are
   checked, each chunk is authenticated, the whole file's sha256 is verified before the app sees it, and a peer that
   sends bad data is dropped for the session. */
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import {
  CHUNK, WINDOW, MAX_QUEUE, MAX_HAVE, MAX_FILE, HEX, roomKeys, sealCtl, openCtl, checkCtl, SeqGuard, sealChunk, openChunk,
  chunkFrame, parseChunk, chunkLen, chunkCount, Download, drain, sha256Blob, F_CTL, F_CHUNK,
} from './media-core.mjs';
import { relayable } from '@cue-board/sync-server/media-limits';

const MSG_MEDIA = 10, K = { WELCOME: 1, SIGNAL: 2, RELAY: 3, JOINED: 4, LEFT: 5, DROPPED: 6 }, DROP = { RATE: 1, TRANSFER: 2, BUSY: 3 };
const OLD_RELAY_MAX = 500 * 1024 * 1024;  // a server that doesn't say its cap (before RELAY_MAX_FILE): 600 MiB counted with re-sends
const REANNOUNCE_MS = 20000;       // `have` again to every peer this often: a relayed control frame can be dropped
const CANCEL_GRACE_MS = 30000;     // chunks of a cancelled file arriving this long after are expected, not hostile
const HIGH = 1024 * 1024;          // a transport's queue we keep under (backpressure)
const MAX_ACTIVE = 3;              // files downloading at once
const STALE_MS = 8000;             // a request unanswered this long is asked again (elsewhere if possible)
const MAX_STRIKES = 48;            // unasked or duplicate chunks before a peer is dropped
const MAX_PENDING = 96;            // frames from one peer waiting to be processed
const RELAY_RATE = 3 * 1024 * 1024; // our own pace through the relay, under the server's per-IP cap
const RTC_TIMEOUT = 10000;
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

/**
 * @typedef {{ bytes: number, mime: string, label: string, song?: boolean, local: boolean }} Want
 * @typedef {{
 *   provider: any, roomId: string, token: string, pid: string, ice: RTCIceServer[],
 *   store: { open(hex: string, meta: any): Promise<number[]>, put(hex: string, i: number, b: Uint8Array): Promise<boolean>,
 *            read(hex: string, count: number): Promise<Blob[] | null>, drop(hex: string): Promise<void> },
 *   wanted(): Map<string, Want>, localBlob(hex: string): Promise<Blob | null>,
 *   landed(hex: string, blob: Blob, w: Want): Promise<void>, clientName(c: number): string,
 *   limits(): { file: number, project: number }, onChange(): void,
 *   storage?(): 'ok' | 'blocked' | 'replaced',   whether the store can be used (another tab may hold the database)
 * }} Ctx
 * store.list?(pid): the files this project has parts of (dropped once the doc no longer references them)
 */

/** @param {Ctx} ctx */
export function createMedia(ctx) {
  const T = /** @type {any} */ (globalThis).__CUE_MEDIA_TEST || {};   // test hooks (design/media-check.mjs)
  const prov = ctx.provider;
  /** @type {CryptoKey | null} */ let key = null;
  const keyP = roomKeys(ctx.token, ctx.roomId).then(k => { key = k.key; });
  let myId = 0, sseq = 0, stopped = false, paused = false, override = false, storageFull = false, relayMax = OLD_RELAY_MAX;
  const reMs = () => T.reannounceMs || REANNOUNCE_MS;
  const storeState = () => (ctx.storage ? ctx.storage() : 'ok');
  /** @type {Map<string, { until: number, sent: number, late: number[][] }>} */ const cancelled = new Map();   // hex -> late chunks are expected
  /** @type {Map<number, any>} */ const peers = new Map();
  /** @type {Map<string, any>} */ const dls = new Map();          // hex -> { d: Download, src, fails, state, finishing }
  /** @type {Set<string>} */ const failed = new Set();
  /** @type {Set<string>} */ const asked = new Set();    // asked for one by one ("Download" on a skipped file): past the size limits
  /** @type {{ persisted: boolean | null, free: number | null }} */ const storage = { persisted: null, free: null };
  let swept = false, tickTimer = /** @type {any} */ (0), relayTokens = RELAY_RATE, relayT = Date.now();
  const stats = { recv: 0, sent: 0, banned: 0, rejected: 0 };

  /* ---------- server link ---------- */
  function toServer(/** @type {number} */ kind, /** @type {number} */ to, /** @type {Uint8Array} */ payload) {
    const ws = prov.ws;
    if (!ws || !prov.wsconnected || ws.readyState !== 1) return false;
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_MEDIA); encoding.writeVarUint(e, kind); encoding.writeVarUint(e, to); encoding.writeVarUint8Array(e, payload);
    ws.send(encoding.toUint8Array(e));
    return true;
  }
  prov.messageHandlers[MSG_MEDIA] = (/** @type {any} */ _enc, /** @type {decoding.Decoder} */ dec) => {
    if (stopped) return;
    try {
      const kind = decoding.readVarUint(dec), from = decoding.readVarUint(dec), payload = decoding.readVarUint8Array(dec);
      if (kind === K.WELCOME) {
        reset();
        myId = from;
        const pd = decoding.createDecoder(payload), n = decoding.readVarUint(pd), ids = [];
        for (let i = 0; i < n && i < 4096; i++) ids.push(decoding.readVarUint(pd));
        // the relay's per-file cap follows the ids; a server too old to send it gets the old, smaller one
        relayMax = n <= 4096 && decoding.hasContent(pd) ? decoding.readVarUint(pd) : OLD_RELAY_MAX;
        for (const id of ids.slice(0, 64)) { const p = addPeer(id); keyP.then(() => hello(p, false)); }
      } else if (kind === K.JOINED) addPeer(from);
      else if (kind === K.LEFT) removePeer(from);
      else if (kind === K.SIGNAL || kind === K.RELAY) { const p = peers.get(from); if (p) frameIn(p, payload.slice(), kind === K.SIGNAL); }
      else if (kind === K.DROPPED) {
        const p = peers.get(from); if (!p) return;
        const now = Date.now();
        p.backoff = now + 300;
        if (payload[0] === DROP.TRANSFER && payload.length >= 9) {
          // too big for the relay: stop sending that file to them (they don't ask for it over the relay themselves)
          const tag = [...payload.subarray(1, 9)].map(x => x.toString(16).padStart(2, '0')).join('');
          p.queue = p.queue.filter((/** @type {any} */ q) => !q.h.startsWith(tag));
        } else p.reannounceAt = Math.min(p.reannounceAt, Math.max(now + 1000, p.announced + 3000));   // maybe a control frame
      }
    } catch { /* a malformed frame from the server: ignored */ }
  };

  /* ---------- peers ---------- */
  function addPeer(/** @type {number} */ id) {
    if (!id || id === myId) return peers.get(id);
    let p = peers.get(id);
    if (!p && peers.size < 32) {                 // a room is a handful of people; past 32 the rest are ignored
      p = { id, client: -1, guard: new SeqGuard(), have: new Set(), pc: null, dc: null, direct: 'none', saidHi: false, heard: false,
        foreign: false, banned: false, gone: false, queue: [], pumping: false, strikes: 0, pending: 0, chain: Promise.resolve(),
        blobs: new Map(), backoff: 0, hiAt: Date.now(), heardAt: 0, announced: 0, reannounceAt: Infinity };
      peers.set(id, p);
    }
    return p;
  }
  function removePeer(/** @type {number} */ id) {
    const p = peers.get(id); if (!p) return;
    p.gone = true; closeRtc(p); peers.delete(id);
    for (const x of dls.values()) { if (x.d) x.d.release(id); if (x.src === p) x.src = null; }
    changed(); schedule();
  }
  function reset() {
    for (const p of peers.values()) { p.gone = true; closeRtc(p); }
    peers.clear();
    for (const x of dls.values()) { if (x.d) x.d.inflight.clear(); x.src = null; }
  }
  function ban(/** @type {any} */ p, /** @type {string} */ why) {
    if (p.banned) return;
    p.banned = true; p.queue.length = 0; p.have.clear(); stats.banned++;
    closeRtc(p);
    for (const x of dls.values()) { if (x.d) x.d.release(p.id); if (x.src === p) x.src = null; }
    if (T.log) T.log.push('dropped peer: ' + why);
    changed(); schedule();
  }
  const strike = (/** @type {any} */ p, /** @type {string} */ why) => { stats.rejected++; if (++p.strikes > MAX_STRIKES) ban(p, why); };

  /* ---------- sending ---------- */
  async function ctl(/** @type {any} */ p, /** @type {any} */ msg, viaSignal = false) {
    await keyP;
    if (!key || p.gone || stopped) return;
    msg.s = ++sseq;
    const f = await sealCtl(key, myId, p.id, msg);
    if (viaSignal) toServer(K.SIGNAL, p.id, f); else sendData(p, f);
  }
  const dcOpen = (/** @type {any} */ p) => p.dc && p.dc.readyState === 'open';
  function sendData(/** @type {any} */ p, /** @type {Uint8Array} */ f) {
    if (dcOpen(p)) { try { p.dc.send(f); return true; } catch { /* closing: fall back to the relay */ } }
    return toServer(K.RELAY, p.id, f);
  }
  /** the transport `p` is on right now, for backpressure */
  const transport = (/** @type {any} */ p) => ({
    buffered: () => (dcOpen(p) ? p.dc.bufferedAmount : prov.ws ? prov.ws.bufferedAmount : 0),
    waitLow: () => sleep(10),
  });
  async function relayPace(/** @type {number} */ n) {
    for (;;) {
      const now = Date.now(); relayTokens = Math.min(RELAY_RATE, relayTokens + ((now - relayT) / 1000) * RELAY_RATE); relayT = now;
      if (relayTokens >= n) { relayTokens -= n; return; }
      await sleep(20);
    }
  }
  function hello(/** @type {any} */ p, /** @type {boolean} */ re) {
    if (!p || p.gone) return;
    p.saidHi = true; p.hiAt = Date.now();
    ctl(p, { t: 'hi', c: prov.awareness ? prov.awareness.clientID : 0, re }, true);
  }
  /** everything we have, to `p`. Idempotent on their side, so it's also sent again now and then (upkeep()) */
  function announce(/** @type {any} */ p) {
    const w = ctx.wanted(), mine = [...w].filter(([, v]) => v.local).map(([h]) => h);
    p.told = new Set(mine); p.announced = Date.now(); p.reannounceAt = p.announced + reMs();
    for (let i = 0; i < mine.length; i += 200) ctl(p, { t: 'have', h: mine.slice(i, i + 200) });
  }
  /* A relayed control frame can be dropped by the server (rate caps, the receiver's queue) or lost in a reconnect, and
     nothing answers `have`, `hi` or `cancel`. So, once a second: `have` again to each peer every REANNOUNCE_MS (sooner
     after the server said it dropped one of our frames to them), `hi` again to a peer we never heard from. Bounded:
     a handful of small frames per peer per period. `nf` and `lost` answer a `get`, which is itself asked again. */
  function upkeep() {
    const now = Date.now();
    for (const p of peers.values()) {
      if (p.gone || p.banned || p.foreign) continue;
      if (p.heard) { if (now >= p.reannounceAt) announce(p); }
      else if (now - p.hiAt >= reMs()) hello(p, false);
    }
    for (const [h, c] of cancelled) if (now > c.until) cancelled.delete(h);
  }

  /* ---------- WebRTC: optional, the relay carries everything until a data channel opens ---------- */
  function startRtc(/** @type {any} */ p, /** @type {boolean} */ initiator) {
    if (p.pc || p.direct === 'failed' || typeof RTCPeerConnection !== 'function' || stopped) return;
    let pc;
    try { pc = new RTCPeerConnection({ iceServers: ctx.ice }); } catch { p.direct = 'failed'; return; }
    p.pc = pc; p.direct = 'trying';
    pc.onicecandidate = e => { if (e.candidate && e.candidate.candidate && !T.noDirect) ctl(p, { t: 'ice', c: e.candidate.toJSON() }, true); };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') rtcDown(p, pc); };
    const setup = (/** @type {RTCDataChannel} */ dc) => {
      dc.binaryType = 'arraybuffer'; dc.bufferedAmountLowThreshold = HIGH / 2;
      dc.onopen = () => { if (p.pc !== pc) return; p.dc = dc; p.direct = 'open'; clearTimeout(p.rtcTimer); changed(); pump(p); };
      dc.onclose = () => rtcDown(p, pc);
      dc.onmessage = e => { if (e.data instanceof ArrayBuffer) frameIn(p, new Uint8Array(e.data), false); };
    };
    if (initiator) {
      setup(pc.createDataChannel('cue-media', { ordered: true }));
      pc.createOffer().then(o => pc.setLocalDescription(o)).then(() => ctl(p, { t: 'offer', sdp: sdpOut(pc) }, true)).catch(() => rtcDown(p, pc));
    } else pc.ondatachannel = e => { if (e.channel.label === 'cue-media' && !p.dc) setup(e.channel); };
    p.rtcTimer = setTimeout(() => { if (p.pc === pc && p.direct !== 'open') rtcDown(p, pc); }, RTC_TIMEOUT);
  }
  const sdpOut = (/** @type {RTCPeerConnection} */ pc) => {
    const s = pc.localDescription ? pc.localDescription.sdp : '';
    return T.noDirect ? s.split('\r\n').filter(l => !l.startsWith('a=candidate')).join('\r\n') : s;
  };
  function rtcDown(/** @type {any} */ p, /** @type {RTCPeerConnection} */ pc) {
    if (p.pc !== pc) return;
    p.direct = 'failed'; closeRtc(p); changed(); pump(p);     // the relay takes over
  }
  function closeRtc(/** @type {any} */ p) {
    clearTimeout(p.rtcTimer);
    const pc = p.pc; p.pc = null; p.dc = null;
    if (pc) try { pc.close(); } catch { /* already closed */ }
    if (p.direct === 'open' || p.direct === 'trying') p.direct = 'failed';
  }
  async function onRtcSignal(/** @type {any} */ p, /** @type {any} */ m) {
    if (T.noDirect && m.t === 'ice') return;
    try {
      if (m.t === 'offer') {
        if (myId < p.id || p.direct === 'failed') return;      // the lower id offers; one attempt per peer
        startRtc(p, false);
        const pc = p.pc; if (!pc) return;
        await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        ctl(p, { t: 'answer', sdp: sdpOut(pc) }, true);
      } else if (m.t === 'answer') { if (p.pc && p.pc.signalingState === 'have-local-offer') await p.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }); }
      else if (m.t === 'ice') { if (p.pc && p.pc.remoteDescription) await p.pc.addIceCandidate(m.c); }
    } catch { if (p.pc) rtcDown(p, p.pc); }
  }

  /* ---------- receiving ---------- */
  /** Frames from one peer are handled one at a time, in order; a peer that floods us is dropped. */
  function frameIn(/** @type {any} */ p, /** @type {Uint8Array} */ f, /** @type {boolean} */ viaSignal) {
    if (p.banned || p.gone || stopped) return;
    if (++p.pending > MAX_PENDING) { ban(p, 'flood'); return; }
    const run = () => handle(p, f, viaSignal).catch(() => {}).finally(() => { p.pending--; });
    // control messages in order; chunks (self-contained, each checked against what was asked) are decrypted and
    // written side by side, so one IndexedDB write doesn't hold up the next chunk. MAX_PENDING still bounds memory.
    if (f[0] === F_CHUNK) run(); else p.chain = p.chain.then(run);
  }
  async function handle(/** @type {any} */ p, /** @type {Uint8Array} */ f, /** @type {boolean} */ viaSignal) {
    await keyP;
    if (!key || p.banned || p.gone || stopped) return;
    if (f[0] === F_CTL) {
      const m = checkCtl(await openCtl(key, p.id, myId, f));
      if (!m) {
        // the first message we can't open is someone who joined with another invite link (another key): not an attack,
        // but nothing can be exchanged with them. Later bad frames from a peer we could read are.
        if (!p.heard) { p.foreign = true; changed(); return; }
        ban(p, 'bad control frame'); return;
      }
      if (!p.guard.ok(m.s)) { strike(p, 'replay'); return; }
      p.heard = true; p.foreign = false;
      if (viaSignal !== ['hi', 'offer', 'answer', 'ice'].includes(m.t)) { strike(p, 'wrong path'); return; }
      return onCtl(p, m);
    }
    if (f[0] === F_CHUNK) return onChunk(p, f);
    strike(p, 'unknown frame');
  }
  function onCtl(/** @type {any} */ p, /** @type {any} */ m) {
    switch (m.t) {
      case 'hi':
        p.client = m.c; p.heardAt = p.heardAt || Date.now();
        if (!m.re || !p.saidHi) hello(p, true);
        if (myId < p.id && !T.noRtc) startRtc(p, true);
        announce(p); changed();
        return;
      case 'offer': case 'answer': case 'ice': return onRtcSignal(p, m);
      case 'have': for (const h of m.h) if (p.have.size < MAX_HAVE) p.have.add(h); changed(); schedule(); return;
      case 'lost': case 'nf':
        for (const h of m.t === 'nf' ? [m.h] : m.h) { p.have.delete(h); const x = dls.get(h); if (x) { if (x.d) x.d.release(p.id); if (x.src === p) x.src = null; } }
        changed(); schedule(); return;
      case 'cancel': p.queue = p.queue.filter((/** @type {any} */ q) => q.h !== m.h); return;
      case 'get': return onGet(p, m);
    }
  }
  function onGet(/** @type {any} */ p, /** @type {any} */ m) {
    // only hashes this room's doc references, only files we have, only indexes inside the file
    const w = ctx.wanted().get(m.h);
    if (!w || !w.local) { ctl(p, { t: 'nf', h: m.h }); return; }
    const count = chunkCount(w.bytes);
    if (m.i.some((/** @type {number} */ i) => i >= count)) { ban(p, 'index out of range'); return; }
    const queued = new Set(p.queue.filter((/** @type {any} */ q) => q.h === m.h).map((/** @type {any} */ q) => q.i));
    const add = m.i.filter((/** @type {number} */ i) => !queued.has(i));
    if (p.queue.length + add.length > MAX_QUEUE) { ban(p, 'request flood'); return; }
    for (const i of add) p.queue.push({ h: m.h, i });
    pump(p);
  }
  async function onChunk(/** @type {any} */ p, /** @type {Uint8Array} */ f) {
    const c = parseChunk(f);
    if (!c) { strike(p, 'bad chunk frame'); return; }
    const x = [...dls.values()].find(v => v.d && v.d.hex.startsWith(c.tag));
    if (!x) {
      // a file we cancelled: what was asked before still arrives. Not hostile; tell them again (once a second at most)
      const k = [...cancelled.keys()].find(h => h.startsWith(c.tag)), cc = k && cancelled.get(k);
      if (!k || !cc) { strike(p, 'chunk for nothing'); return; }
      if (Date.now() - cc.sent > 1000) { cc.sent = Date.now(); ctl(p, { t: 'cancel', h: k }); }
      return;
    }
    const d = x.d, why = d.accept(p.id, c.i);
    if (why === 'late') { d.late.delete(c.i); return; }       // asked of them, given up on (timeout), arriving now
    if (why !== 'ok') { strike(p, 'chunk ' + why); return; }
    const plain = await openChunk(/** @type {CryptoKey} */ (key), d.hex, d.size, c.i, c.base, c.ct);
    if (!plain || plain.length !== chunkLen(d.size, c.i)) { ban(p, 'chunk failed authentication'); return; }
    if (dls.get(d.hex) !== x || x.d !== d || d.accept(p.id, c.i) !== 'ok') return;   // cancelled or reset meanwhile
    const ok = await ctx.store.put(d.hex, c.i, plain);
    if (dls.get(d.hex) !== x || x.d !== d) return;
    if (!ok) { d.release(p.id); if (storeState() === 'ok') storageFull = true; changed(); return; }   // busy: not "full"
    d.stored(p.id, c.i); stats.recv += plain.length;
    if (d.done) finish(x); else schedule();
    changedSoon();
  }

  /* ---------- serving ---------- */
  async function pump(/** @type {any} */ p) {
    if (p.pumping) return;
    p.pumping = true;
    try {
      while (p.queue.length && !p.gone && !p.banned && !stopped) {
        if (Date.now() < p.backoff) await sleep(p.backoff - Date.now());
        await drain(transport(p), HIGH);
        const q = p.queue.shift(); if (!q) break;
        const src = await sourceFor(p, q.h);
        if (!src) { p.queue = p.queue.filter((/** @type {any} */ r) => r.h !== q.h); ctl(p, { t: 'nf', h: q.h }); continue; }
        const n = chunkLen(src.size, q.i);
        const plain = new Uint8Array(await src.blob.slice(q.i * CHUNK, q.i * CHUNK + n).arrayBuffer());
        if (plain.length !== n) { p.blobs.delete(q.h); p.queue = p.queue.filter((/** @type {any} */ r) => r.h !== q.h); ctl(p, { t: 'nf', h: q.h }); continue; }
        const ct = await sealChunk(/** @type {CryptoKey} */ (key), q.h, src.size, q.i, src.base, plain);
        if (T.corrupt && T.corrupt.has && T.corrupt.has(q.i) && !T.corrupted) { T.corrupted = true; ct[5] ^= 0xff; }
        if (T.chunkDelay) await sleep(T.chunkDelay);
        if (p.gone || p.banned || stopped) break;
        const fr = chunkFrame(q.h, q.i, src.base, ct);
        if (!dcOpen(p)) await relayPace(fr.length);
        if (sendData(p, fr)) stats.sent += n;
      }
    } catch { /* the file went away mid-read: the peer asks again or elsewhere */ } finally { p.pumping = false; }
  }
  async function sourceFor(/** @type {any} */ p, /** @type {string} */ h) {
    const w = ctx.wanted().get(h);
    if (!w || !w.local) return null;
    let s = p.blobs.get(h);
    if (!s) {
      const blob = await ctx.localBlob(h);
      if (!blob || blob.size !== w.bytes) { if (!blob) lost([h]); return null; }   // missing (storage cleared) or not the doc's size
      if (p.blobs.size >= 8) p.blobs.delete(p.blobs.keys().next().value);
      s = { blob, size: blob.size, base: crypto.getRandomValues(new Uint8Array(12)) };
      p.blobs.set(h, s);
    }
    return s;
  }
  /** a file we thought we had is gone (the browser cleared storage): tell everyone, fetch it again */
  function lost(/** @type {string[]} */ hs) { for (const p of peers.values()) if (p.heard && !p.banned) ctl(p, { t: 'lost', h: hs }); }

  /* ---------- scheduling ---------- */
  /* run the scheduler now. The 1 s fallback timer it leaves behind (stale requests, new holders) must not stand in the
     way: refilling the window only once a second capped every transfer at 16 chunks/s. */
  let tickSoon = false, ticking = false, again = false, sweptParts = false;
  function schedule() {
    if (stopped) return;
    if (ticking) { again = true; return; }       // one tick at a time: the running one goes again when it ends
    if (tickSoon) return;
    clearTimeout(tickTimer); tickSoon = true; tickTimer = setTimeout(tick, 0);
  }
  let changeTimer = /** @type {any} */ (0);
  const changed = () => { clearTimeout(changeTimer); changeTimer = 0; if (!stopped) ctx.onChange(); };
  const changedSoon = () => { if (!changeTimer) changeTimer = setTimeout(changed, 250); };
  /** what to fetch, in order (smallest first), and what the limits skip */
  function plan() {
    const w = ctx.wanted(), lim = ctx.limits();
    let used = 0; for (const v of w.values()) if (v.local) used += v.bytes;
    const missing = [...w].filter(([h, v]) => !v.local && !failed.has(h)).sort((a, b) => a[1].bytes - b[1].bytes);
    /** @type {string[]} */ const fetch = []; /** @type {Map<string, string>} */ const skipped = new Map();
    for (const [h, v] of missing) {
      if (!Number.isSafeInteger(v.bytes) || v.bytes <= 0 || v.bytes > MAX_FILE) { skipped.set(h, 'unknown'); continue; }
      const any = override || asked.has(h);
      if (!any && v.bytes > lim.file) { skipped.set(h, 'file'); continue; }
      if (!any && used + v.bytes > lim.project) { skipped.set(h, 'project'); continue; }
      used += v.bytes; fetch.push(h);
    }
    return { w, fetch, skipped };
  }
  const holders = (/** @type {string} */ h) => [...peers.values()].filter(p => p.heard && !p.banned && !p.gone && p.have.has(h));
  /* A file bigger than the relay's cap (only "Download all now" asks for those) comes only over a data channel. */
  const viaRelay = (/** @type {number} */ bytes) => relayable(bytes, relayMax);
  const canServe = (/** @type {any} */ p, /** @type {number} */ bytes) => viaRelay(bytes) || dcOpen(p);
  const usable = (/** @type {string} */ h, /** @type {number} */ bytes) => holders(h).filter(p => canServe(p, bytes));
  /** a data channel to `p` may still open: the attempt is running, or about to start */
  const mayDirect = (/** @type {any} */ p) => !T.noRtc && typeof RTCPeerConnection === 'function' &&
    (p.direct === 'trying' || (p.direct === 'none' && Date.now() - p.heardAt < RTC_TIMEOUT + 2000));
  /** stop fetching `h`. keep: only the limits skip it now (paused, lowered, the budget went to another file): its
      chunks stay stored and it resumes from them when it's allowed again. Else (deleted, here already): dropped. */
  function stopFetch(/** @type {string} */ h, /** @type {any} */ x, /** @type {boolean} */ keep) {
    dls.delete(h);
    const to = new Set(x.d ? [...x.d.inflight.values()].map(v => v.peer) : []); if (x.src) to.add(x.src.id);
    for (const id of to) { const p = peers.get(id); if (p) ctl(p, { t: 'cancel', h }); }
    // what was asked is still on its way: if the file starts again soon, those chunks are late, not unasked
    const late = x.d ? [...x.d.inflight].map(([i, v]) => [i, v.peer]) : [];
    const now = Date.now(); cancelled.set(h, { until: now + CANCEL_GRACE_MS, sent: now, late });
    if (keep) kept.add(h); else { kept.delete(h); ctx.store.drop(h); }
  }
  /** @type {Set<string>} */ const kept = new Set();   // stopped with their chunks kept: dropped if the doc lets go of them
  async function tick() {
    clearTimeout(tickTimer); tickTimer = 0; tickSoon = false;
    if (stopped) return;
    if (ticking) { again = true; return; }
    ticking = true; again = false;
    let more = true;
    try { more = await step(); } catch { /* storage threw: the next tick tries again */ } finally { ticking = false; }
    if (stopped) return;
    clearTimeout(tickTimer); tickTimer = 0;
    if (again) schedule(); else if (more) tickTimer = setTimeout(tick, 1000);
  }
  /** one pass of the scheduler; true while there's something to come back for */
  async function step() {
    const { w, fetch, skipped } = plan(), busy = storeState() !== 'ok';
    // a crash after a file landed and before its parts were dropped leaves them behind: drop them for files that are here
    if (!swept && !busy) { swept = true; for (const [h, v] of w) if (v.local) ctx.store.drop(h); }
    // parts of files the doc no longer references (deleted while this browser was away), once the doc is in
    if (!sweptParts && !busy && prov.synced && ctx.store.list) {
      sweptParts = true;
      for (const h of await ctx.store.list(ctx.pid)) if (!ctx.wanted().has(h) && !dls.has(h)) ctx.store.drop(h);
    }
    for (const h of kept) {
      const v = w.get(h);
      if (dls.has(h)) kept.delete(h); else if (!busy && (!v || v.local)) { kept.delete(h); ctx.store.drop(h); }
    }
    for (const [h, x] of dls) if (!fetch.includes(h) && !x.finishing) {
      const v = w.get(h), why = skipped.get(h);
      stopFetch(h, x, !!v && !v.local && !failed.has(h) && (why === 'file' || why === 'project'));
    }
    for (const h of fetch) {
      if (dls.size >= MAX_ACTIVE) break;
      const v = /** @type {Want} */ (w.get(h));
      if (dls.has(h) || paused || storageFull || busy || !usable(h, v.bytes).length) continue;
      const x = { d: /** @type {Download | null} */ (null), src: null, fails: 0, finishing: false, opening: true };
      const was = cancelled.get(h);
      dls.set(h, /** @type {any} */ (x)); cancelled.delete(h);
      const have = await ctx.store.open(h, { size: v.bytes, mime: v.mime, pid: ctx.pid, t: Date.now() });
      if (dls.get(h) !== x || stopped) continue;
      x.d = new Download(h, v.bytes, have); x.opening = false;
      if (was) for (const [i, peer] of was.late) x.d.late.set(i, peer);
      if (x.d.done) finish(x);
    }
    for (const x of dls.values()) {
      if (!x.d || x.finishing) continue;
      if (x.d.done) { if (!storageFull) finish(x); continue; } // all stored, landing interrupted: again (not while full)
      for (const pid of x.d.stale(STALE_MS)) { x.d.release(pid); if (x.src && x.src.id === pid) x.src = null; }
      if (x.src && (x.src.gone || x.src.banned || !x.src.have.has(x.d.hex) || !canServe(x.src, x.d.size))) x.src = null;
      if (paused || storageFull || busy) continue;
      if (!x.src) {
        const hs = usable(x.d.hex, x.d.size).sort((a, b) => load(a) - load(b));
        x.src = hs[0] || null;
      }
      if (!x.src) {
        // too big for the relay and its data channel closed: free the slot for another file, keep what's stored
        if (!viaRelay(x.d.size) && !x.d.inflight.size) stopFetch(x.d.hex, x, true);
        continue;
      }
      const want = WINDOW - x.d.inflightFrom(x.src.id);
      if (want >= 4 || (want > 0 && x.d.count - x.d.n <= WINDOW)) {
        const idx = x.d.take(x.src.id, Math.min(want, 32));
        if (idx.length) ctl(x.src, { t: 'get', h: x.d.hex, i: idx });
      }
    }
    changedSoon();
    return [...dls.values()].some(x => x.d && !x.finishing) || fetch.some(h => !dls.has(h));
  }
  const load = (/** @type {any} */ p) => [...dls.values()].filter(x => x.src === p).length;
  async function finish(/** @type {any} */ x) {
    if (x.finishing) return;
    x.finishing = true;
    const d = /** @type {Download} */ (x.d), w = ctx.wanted().get(d.hex);
    try {
      const parts = await ctx.store.read(d.hex, d.count);
      if (!parts && storeState() !== 'ok') { x.finishing = false; return; }   // storage closed under us: not the file's fault
      const blob = parts && parts.length === d.count ? new Blob(parts, { type: (w && w.mime) || '' }) : null;
      const ok = !!blob && blob.size === d.size && (await sha256Blob(blob)) === d.hex;
      if (stopped || dls.get(d.hex) !== x) return;            // left, deleted, or cancelled while verifying
      if (!ok) {
        // the whole file doesn't hash to its id: start over. A single source sent it all: that peer is dropped.
        await ctx.store.drop(d.hex);
        if (d.sources.size === 1) { const p = peers.get([...d.sources][0]); if (p) ban(p, 'file failed its hash'); }
        d.reset(); x.src = null; x.finishing = false;
        if (++x.fails >= 3) { failed.add(d.hex); dls.delete(d.hex); }
        changed(); schedule(); return;
      }
      const cur = ctx.wanted().get(d.hex);
      if (!cur || cur.local) { dls.delete(d.hex); await ctx.store.drop(d.hex); return; }   // deleted meanwhile, or here already
      await ctx.landed(d.hex, /** @type {Blob} */ (blob), cur);
      dls.delete(d.hex);
      await ctx.store.drop(d.hex);
      for (const p of peers.values()) if (p.heard && !p.banned) ctl(p, { t: 'have', h: [d.hex] });
    } catch {
      // the app couldn't store it (quota): pause instead of re-reading and re-hashing the whole file every second
      x.finishing = false; storageFull = true;
    } finally { changed(); schedule(); }
  }

  /* ---------- storage ---------- */
  async function checkStorage() {
    const st = /** @type {any} */ (navigator).storage;
    if (!st) return;
    try { storage.persisted = (await st.persisted()) || (await st.persist()); } catch { storage.persisted = false; }
    try { const e = await st.estimate(); storage.free = Math.max(0, (e.quota || 0) - (e.usage || 0)); } catch { storage.free = null; }
    changed();
  }

  /* ---------- the app's view ---------- */
  function files() {
    const { w, skipped } = plan(), out = [];
    for (const [h, v] of w) {
      const x = dls.get(h), who = holders(h).map(p => ctx.clientName(p.client)).filter(Boolean);
      // relay: only a direct connection can bring it (bigger than the relay's cap), and none is open or coming
      const relay = !viaRelay(v.bytes) && !usable(h, v.bytes).length && !holders(h).some(mayDirect);
      const state = v.local ? 'here' : failed.has(h) ? 'failed' : skipped.has(h) ? 'skipped' : x && x.d && x.d.n ? 'downloading'
        : who.length ? (paused || storageFull || storeState() !== 'ok' ? 'paused' : relay ? 'relay' : 'queued') : 'unavailable';
      out.push({ hex: h, label: v.label, bytes: v.bytes, song: !!v.song, state, skip: skipped.get(h) || '', got: v.local ? v.bytes : x && x.d ? x.d.bytes : 0, who });
    }
    return out;
  }
  function summary() {
    const l = files(), n = (/** @type {string} */ s) => l.filter(f => f.state === s).length;
    return { total: l.length, here: n('here'), active: n('downloading') + n('queued'), unavailable: n('unavailable'), skipped: n('skipped'),
      failed: n('failed'), relay: n('relay'), paused, storageFull, storageBusy: storeState() === 'ok' ? '' : storeState(), storage: { ...storage }, foreign: [...peers.values()].filter(p => p.foreign).length,
      direct: [...peers.values()].filter(p => p.direct === 'open').length, relayed: [...peers.values()].filter(p => p.heard && p.direct !== 'open').length };
  }

  checkStorage();
  let beats = 0;
  const idle = setInterval(() => { if (stopped) return; upkeep(); if (++beats % 5 === 0) schedule(); }, 1000);
  return {
    files, summary, stats,
    /** progress of a missing file, 0..1, or null if nothing is coming */
    progress(/** @type {string} */ hex) { const x = dls.get(hex); return x && x.d ? x.d.bytes / Math.max(1, x.d.size) : null; },
    /** the doc changed (a file added or deleted, or one landed here): announce what's new, fetch what's missing */
    refresh() {
      const w = ctx.wanted();
      for (const p of peers.values()) {
        if (!p.heard || p.banned) continue;
        const mine = [...w].filter(([, v]) => v.local).map(([h]) => h), told = p.told || (p.told = new Set());
        const add = mine.filter(h => !told.has(h)); add.forEach(h => told.add(h));
        for (let i = 0; i < add.length; i += 200) ctl(p, { t: 'have', h: add.slice(i, i + 200) });
      }
      schedule(); changedSoon();
    },
    /** no new requests; chunks already asked for still land (dropping them would count against an honest peer).
        "Download all now" stays on: resuming continues the files it started, from their stored chunks */
    pause(/** @type {boolean} */ on) { paused = on; changed(); schedule(); },
    /** fetch everything now, the size limits too, for the rest of the session; also retries after "storage full" */
    downloadAll() { override = true; paused = false; storageFull = false; failed.clear(); changed(); schedule(); },
    /** fetch this one file now, past the size limits, for the rest of the session */
    download(/** @type {string} */ hex) { asked.add(hex); changed(); schedule(); },
    /** a file that failed its hash: three more tries */
    retry(/** @type {string} */ hex) { failed.delete(hex); changed(); schedule(); },
    retryStorage() { storageFull = false; schedule(); },
    stop() {
      if (stopped) return;
      stopped = true; clearTimeout(tickTimer); clearInterval(idle); clearTimeout(changeTimer);
      prov.messageHandlers[MSG_MEDIA] = () => {};
      reset(); dls.clear();
    },
  };
}
