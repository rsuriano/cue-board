// @ts-check
/* Media signaling and fallback relay (docs/media-p2p.md). The server never sees file contents: peers of one room exchange
   small opaque signaling messages (WebRTC offers, answers, candidates, all sealed with a key only the clients have) and,
   when two of them can't connect directly, opaque sealed chunks. Nothing is stored; every frame is forwarded at once
   or dropped.

   Wire format, after the Yjs-style message type MSG_MEDIA (10):
     client -> server   varuint kind · varuint to (peer id, 0 = everyone else in the room, SIGNAL only) · varUint8Array payload
     server -> client   varuint kind · varuint from (peer id)                                         · varUint8Array payload
   kinds: 1 WELCOME (from = your own id, payload = varuint count + the ids already here) · 2 SIGNAL · 3 RELAY
          4 JOINED (from = the new peer) · 5 LEFT (from = the peer that left) · 6 DROPPED (from = the relay target;
          payload = one reason byte: 1 rate cap, 2 transfer cap, 3 target busy or gone)
   A RELAY payload starts with a version byte and an 8-byte transfer tag (the first 8 bytes of the file's sha256, which
   the room's doc already shows the server); the per-transfer byte cap counts per (sender, target, tag). */
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

export const MSG_MEDIA = 10;
export const K = { WELCOME: 1, SIGNAL: 2, RELAY: 3, JOINED: 4, LEFT: 5, DROPPED: 6 };
export const DROP = { RATE: 1, TRANSFER: 2, BUSY: 3 };

export const RELAY_DEFAULTS = {
  signalMaxBytes: 16 * 1024,                 // one sealed offer/answer with candidates is ~2-6 KB
  signalPerConnPerSec: 40, signalPerRoomPerSec: 200,
  relayMaxFrameBytes: 80 * 1024,             // a 64 KiB chunk + headers + GCM tag
  relayRoomBytesPerSec: 8 * 1024 * 1024, relayIpBytesPerSec: 4 * 1024 * 1024,
  relayMaxTransferBytes: 600 * 1024 * 1024,  // the clients' default per-file limit (500 MB) plus the envelope overhead
  relayMaxTransfersPerConn: 256,
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
    stats,
    /** A socket joined `room`: give it a peer id, tell it who's here, tell the others. */
    attach(/** @type {{ id: string }} */ room, /** @type {any} */ ws, /** @type {string} */ ip) {
      const rs = roomState(room), id = nextId++;
      if (nextId > 0x7fffffff) nextId = 1;
      ws.media = { id, ip, sig: new Bucket(o.signalPerConnPerSec), transfers: new Map() };
      send(ws, frame(K.WELCOME, id, ids([...rs.peers.keys()])));
      for (const p of rs.peers.values()) send(p, frame(K.JOINED, id, none));
      rs.peers.set(id, ws);
      return id;
    },
    detach(/** @type {{ id: string }} */ room, /** @type {any} */ ws) {
      const rs = roomState(room), m = ws.media;
      if (!m || rs.peers.get(m.id) !== ws) return;
      rs.peers.delete(m.id);
      for (const p of rs.peers.values()) { send(p, frame(K.LEFT, m.id, none)); p.media.transfers.forEach((/** @type {any} */ _, /** @type {string} */ k) => { if (k.startsWith(m.id + ':')) p.media.transfers.delete(k); }); }
      const b = ipBuckets.get(m.ip);
      if (b) { b.take(0); if (b.v >= b.cap) ipBuckets.delete(m.ip); }   // idle long enough to be full again: forget it
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
        if (!target || target.readyState !== target.OPEN || target.bufferedAmount + payload.length > o.relayMaxBufferedBytes) {
          dropped(rs, room.id, 'target busy'); send(ws, frame(K.DROPPED, to, Uint8Array.of(DROP.BUSY))); return;
        }
        const key = to + ':' + Buffer.from(payload.subarray(1, 9)).toString('hex');
        const sofar = m.transfers.get(key) || 0;
        if (sofar + payload.length > o.relayMaxTransferBytes || (!m.transfers.has(key) && m.transfers.size >= o.relayMaxTransfersPerConn)) {
          dropped(rs, room.id, 'transfer cap'); send(ws, frame(K.DROPPED, to, Uint8Array.of(DROP.TRANSFER))); return;
        }
        let ipb = ipBuckets.get(m.ip);
        if (!ipb) { ipb = new Bucket(o.relayIpBytesPerSec); ipBuckets.set(m.ip, ipb); }
        if (!rs.bytes.take(payload.length) || !ipb.take(payload.length)) {
          dropped(rs, room.id, 'rate cap'); send(ws, frame(K.DROPPED, to, Uint8Array.of(DROP.RATE))); return;
        }
        m.transfers.set(key, sofar + payload.length);
        stats.relayed++; stats.relayedBytes += payload.length;
        send(target, frame(K.RELAY, m.id, payload));   // forwarded as is; nothing is kept
        return;
      }
      throw new Error('unknown media kind ' + kind);
    },
  };
}
