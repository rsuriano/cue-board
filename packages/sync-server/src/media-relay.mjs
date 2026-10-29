// @ts-check
/* Media signaling and fallback relay (docs/media-p2p.md). The server never sees file contents: peers of one room exchange
   small opaque signaling messages (WebRTC offers, answers, candidates, all sealed with a key only the clients have) and,
   when two of them can't connect directly, opaque sealed chunks. Nothing is stored; every frame is forwarded at once
   or dropped.

   Wire format, after the Yjs-style message type MSG_MEDIA (10):
     client -> server   varuint kind · varuint to (peer id, 0 = everyone else in the room, SIGNAL only) · varUint8Array payload
     server -> client   varuint kind · varuint from (peer id)                                         · varUint8Array payload
   kinds: 1 WELCOME (from = your own id, payload = varuint count + the ids already here + varuint the relay's per-file
            cap in bytes; older servers sent no cap) · 2 SIGNAL · 3 RELAY
          4 JOINED (from = the new peer) · 5 LEFT (from = the peer that left) · 6 DROPPED (from = the relay target;
          payload = one reason byte: 1 rate cap, 2 transfer cap, 3 target busy or gone, then the frame's 8-byte tag)
   A RELAY payload starts with a frame type byte and an 8-byte transfer tag (the first 8 bytes of the file's sha256,
   which the room's doc already shows the server). A chunk frame (type 2) then has its u32 chunk index: the per-file cap
   is on the index (`i < ceil(cap / 64 KiB)`), so a file up to the cap always fits and a chunk sent again (a re-ask after
   a timeout, a retry) never counts twice. Nothing per transfer is kept. */
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { MEDIA_CHUNK, RELAY_MAX_FILE } from './media-limits.mjs';

export const MSG_MEDIA = 10;
export const K = { WELCOME: 1, SIGNAL: 2, RELAY: 3, JOINED: 4, LEFT: 5, DROPPED: 6 };
export const DROP = { RATE: 1, TRANSFER: 2, BUSY: 3 };

export const RELAY_DEFAULTS = {
  signalMaxBytes: 16 * 1024,                 // one sealed offer/answer with candidates is ~2-6 KB
  signalPerConnPerSec: 40, signalPerRoomPerSec: 200,
  relayMaxFrameBytes: 80 * 1024,             // a 64 KiB chunk + headers + GCM tag
  relayRoomBytesPerSec: 8 * 1024 * 1024, relayIpBytesPerSec: 4 * 1024 * 1024,
  relayMaxTransferBytes: RELAY_MAX_FILE,     // largest file relayed; also sent to each client (media-limits.mjs)
  relayMaxBufferedBytes: 2 * 1024 * 1024,    // target socket's queue; past this a frame is dropped, never queued
};

/** Token bucket: `rate` per second, holds up to 2 s worth. */
export class Bucket {
  constructor(/** @type {number} */ rate, now = Date.now()) { this.rate = rate; this.cap = rate * 2; this.v = this.cap; this.t = now; }
  take(/** @type {number} */ n, now = Date.now()) {
    this.v = Math.min(this.cap, this.v + ((now - this.t) / 1000) * this.rate); this.t = now;
    if (this.v < n) return false;
    this.v -= n; return true;
  }
}

/**
 * @param {Partial<typeof RELAY_DEFAULTS>} opts
 * @param {{ debug: Function, info: Function, warn: Function, error: Function }} log
 * @param {(ws: any, msg: Uint8Array) => void} send   the server's send (drops slow readers)
 */
export function createMediaRelay(opts, log, send) {
  const o = { ...RELAY_DEFAULTS, ...opts };
  let nextId = 1;
  /** @type {Map<string, Bucket>} */ const ipBuckets = new Map();
  const maxChunks = Math.ceil(o.relayMaxTransferBytes / MEDIA_CHUNK);
  /** Forget the per-IP buckets that are full again (idle for 2 s or more): at most every 10 s, and on each detach. */
  let swept = Date.now();
  function sweep(now = Date.now(), force = false) {
    if (!force && now - swept < 10_000) return;
    swept = now;
    for (const [ip, b] of ipBuckets) { b.take(0, now); if (b.v >= b.cap) ipBuckets.delete(ip); }
  }
  const stats = { signals: 0, relayed: 0, relayedBytes: 0, dropped: 0 };
  /** per room: peers by id, buckets, and when a drop was last logged */
  /** @type {WeakMap<object, { peers: Map<number, any>, sig: Bucket, bytes: Bucket, warned: number, drops: number }>} */
  const state = new WeakMap();
  const roomState = (/** @type {object} */ room) => {
    let s = state.get(room);
    if (!s) { s = { peers: new Map(), sig: new Bucket(o.signalPerRoomPerSec), bytes: new Bucket(o.relayRoomBytesPerSec), warned: 0, drops: 0 }; state.set(room, s); }
    return s;
  };
  const frame = (/** @type {number} */ kind, /** @type {number} */ from, /** @type {Uint8Array} */ payload) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_MEDIA); encoding.writeVarUint(enc, kind); encoding.writeVarUint(enc, from); encoding.writeVarUint8Array(enc, payload);
    return encoding.toUint8Array(enc);
  };
  const ids = (/** @type {number[]} */ l) => { const e = encoding.createEncoder(); encoding.writeVarUint(e, l.length); l.forEach(x => encoding.writeVarUint(e, x)); return encoding.toUint8Array(e); };
  const none = new Uint8Array(0);

  /** Count a dropped frame; log at most one line per room every 10 s (counts only, never contents). */
  function dropped(/** @type {any} */ rs, /** @type {string} */ roomId, /** @type {string} */ why) {
    stats.dropped++; rs.drops++;
    const now = Date.now();
    if (now - rs.warned > 10_000) { log.warn('media frames dropped', { room: roomId, why, frames: rs.drops }); rs.warned = now; rs.drops = 0; }
  }

  return {
    stats, sweep,
    /** how many per-IP buckets are kept (tests) */
    get ipBuckets() { return ipBuckets.size; },
    /** A socket joined `room`: give it a peer id, tell it who's here, tell the others. */
    attach(/** @type {{ id: string }} */ room, /** @type {any} */ ws, /** @type {string} */ ip) {
      const rs = roomState(room), id = nextId++;
      if (nextId > 0x7fffffff) nextId = 1;
      ws.media = { id, ip, sig: new Bucket(o.signalPerConnPerSec) };
      const w = encoding.createEncoder();
      encoding.writeUint8Array(w, ids([...rs.peers.keys()])); encoding.writeVarUint(w, o.relayMaxTransferBytes);
      send(ws, frame(K.WELCOME, id, encoding.toUint8Array(w)));
      for (const p of rs.peers.values()) send(p, frame(K.JOINED, id, none));
      rs.peers.set(id, ws);
      return id;
    },
    detach(/** @type {{ id: string }} */ room, /** @type {any} */ ws) {
      const rs = roomState(room), m = ws.media;
      if (!m || rs.peers.get(m.id) !== ws) return;
      rs.peers.delete(m.id);
      for (const p of rs.peers.values()) send(p, frame(K.LEFT, m.id, none));
      sweep(Date.now(), true);
    },
    /** A MSG_MEDIA message from `ws`, type already read. Throws on a malformed one (the server closes with 4400). */
    handle(/** @type {{ id: string }} */ room, /** @type {any} */ ws, /** @type {decoding.Decoder} */ dec) {
      const rs = roomState(room), m = ws.media;
      if (!m) throw new Error('media before join');
      const kind = decoding.readVarUint(dec), to = decoding.readVarUint(dec), payload = decoding.readVarUint8Array(dec);
      if (decoding.hasContent(dec)) throw new Error('trailing bytes');
      if (kind === K.SIGNAL) {
        if (payload.length > o.signalMaxBytes) throw new Error('signal too big');
        if (!m.sig.take(1) || !rs.sig.take(1)) { dropped(rs, room.id, 'signal rate'); return; }
        stats.signals++;
        const msg = frame(K.SIGNAL, m.id, payload);
        if (to === 0) { for (const [pid, p] of rs.peers) if (pid !== m.id) send(p, msg); }
        else { const p = rs.peers.get(to); if (p && to !== m.id) send(p, msg); }
        return;
      }
      if (kind === K.RELAY) {
        if (payload.length > o.relayMaxFrameBytes) throw new Error('relay frame too big');
        if (payload.length < 9) throw new Error('relay frame too short');
        const target = to !== m.id ? rs.peers.get(to) : undefined;
        // the sender is told why, and which transfer (its tag), so it can stop sending what can't get through
        const drop = (/** @type {number} */ why, /** @type {string} */ what) => {
          dropped(rs, room.id, what);
          const d = new Uint8Array(9); d[0] = why; d.set(payload.subarray(1, 9), 1);
          send(ws, frame(K.DROPPED, to, d));
        };
        if (!target || target.readyState !== target.OPEN || target.bufferedAmount + payload.length > o.relayMaxBufferedBytes) { drop(DROP.BUSY, 'target busy'); return; }
        if (payload[0] === 2 && payload.length >= 13 && new DataView(payload.buffer, payload.byteOffset, payload.length).getUint32(9) >= maxChunks) {
          drop(DROP.TRANSFER, 'transfer cap'); return;
        }
        const now = Date.now();
        sweep(now);
        let ipb = ipBuckets.get(m.ip);
        if (!ipb) { ipb = new Bucket(o.relayIpBytesPerSec, now); ipBuckets.set(m.ip, ipb); }
        if (!rs.bytes.take(payload.length, now) || !ipb.take(payload.length, now)) { drop(DROP.RATE, 'rate cap'); return; }
        stats.relayed++; stats.relayedBytes += payload.length;
        send(target, frame(K.RELAY, m.id, payload));   // forwarded as is; nothing is kept
        return;
      }
      throw new Error('unknown media kind ' + kind);
    },
  };
}
