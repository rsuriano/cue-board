// Security review, finding 7: the media relay had per-room and per-IP rates but no total, so one account with several
// rooms and devices could use it as a free data pipe. Now: a server-wide rate, a daily byte budget per account (all the
// rooms it created) and a cap on files relayed at once per account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { K, DROP, createMediaRelay } from '../src/media-relay.mjs';
import { tmpDir, server, signSession } from './helpers.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const sock = () => ({ OPEN: 1, readyState: 1, bufferedAmount: 0 });
const enc = (to, payload) => { const e = encoding.createEncoder(); encoding.writeVarUint(e, K.RELAY); encoding.writeVarUint(e, to); encoding.writeVarUint8Array(e, payload); return decoding.createDecoder(encoding.toUint8Array(e)); };
const chunk = (tag, i, n) => { const h = Buffer.alloc(13); h[0] = 2; tag.copy(h, 1); h.writeUInt32BE(i, 9); return Buffer.concat([h, randomBytes(n)]); };

/** a relay whose sends are recorded; `pair(room, ipBase)` puts two sockets in a room. Returns a send() that says whether
    the frame was relayed (true) or the sender got DROPPED (the reason byte). */
function setup(opts) {
  const sent = [];
  const relay = createMediaRelay({ relayRoomBytesPerSec: 1e9, relayIpBytesPerSec: 1e9, ...opts }, quiet, (ws, m) => sent.push([ws, m]));
  let ip = 0;
  const pair = room => {
    const a = sock(), b = sock(); relay.attach(room, a, '10.0.0.' + ++ip); const bid = relay.attach(room, b, '10.0.1.' + ip);
    return (payload) => {
      const n = sent.length; relay.handle(room, a, enc(bid, payload));
      for (const [ws, m] of sent.slice(n)) {
        const d = decoding.createDecoder(m); decoding.readVarUint(d); const kind = decoding.readVarUint(d); decoding.readVarUint(d);
        if (ws === b && kind === K.RELAY) return true;
        if (ws === a && kind === K.DROPPED) return decoding.readVarUint8Array(d)[0];
      }
      return null;
    };
  };
  return { relay, pair };
}

test('daily bytes per account: every room the account created shares one budget; other accounts are unaffected', () => {
  const { pair } = setup({ relayAccountBytesPerDay: 250_000 });   // four 60 KB chunks fit, a fifth doesn't
  const a1 = pair({ id: 'room-a1', account: 'acct-a' }), a2 = pair({ id: 'room-a2', account: 'acct-a' }), b = pair({ id: 'room-b', account: 'acct-b' });
  const tag = randomBytes(8);
  for (let i = 0; i < 4; i++) assert.equal(a1(chunk(tag, i, 60_000)), true);
  assert.equal(a1(chunk(tag, 4, 60_000)), DROP.RATE, 'past the budget in the first room');
  assert.equal(a2(chunk(randomBytes(8), 0, 60_000)), DROP.RATE, 'and in another room of the same account');
  assert.equal(b(chunk(randomBytes(8), 0, 60_000)), true, 'another account still relays');
  // rooms without an account (CLI rooms) each have their own budget
  const l1 = pair({ id: 'legacy-1' }), l2 = pair({ id: 'legacy-2' });
  for (let i = 0; i < 4; i++) assert.equal(l1(chunk(tag, i, 60_000)), true);
  assert.equal(l1(chunk(tag, 4, 60_000)), DROP.RATE);
  assert.equal(l2(chunk(tag, 0, 60_000)), true);
  // a day later the budget is back
  const t = Date.now; Date.now = () => t() + 24 * 3600_000 + 1;
  try { assert.equal(a2(chunk(randomBytes(8), 0, 60_000)), true); } finally { Date.now = t; }
});

test('files relayed at once per account are capped; a transfer idle for 30 s frees its place', () => {
  const { pair } = setup({ relayAccountTransfers: 2 });
  const r1 = pair({ id: 'r1', account: 'acct' }), r2 = pair({ id: 'r2', account: 'acct' });
  const t1 = randomBytes(8), t2 = randomBytes(8), t3 = randomBytes(8);
  assert.equal(r1(chunk(t1, 0, 1000)), true);
  assert.equal(r2(chunk(t2, 0, 1000)), true);
  assert.equal(r1(chunk(t1, 1, 1000)), true, 'a running transfer goes on');
  assert.equal(r2(chunk(t3, 0, 1000)), DROP.RATE, 'a third file waits');
  const t = Date.now; Date.now = () => t() + 31_000;
  try { assert.equal(r2(chunk(t3, 0, 1000)), true, 'after the others went idle'); } finally { Date.now = t; }
});

test('the whole server has one relay rate, whatever the rooms, accounts and IPs', () => {
  const { pair } = setup({ relayTotalBytesPerSec: 100_000 });   // 200 KB burst
  const sends = Array.from({ length: 5 }, (_, i) => pair({ id: 'room' + i, account: 'acct' + i }));
  let through = 0, dropped = 0;
  for (let k = 0; k < 4; k++) for (const s of sends) (s(chunk(randomBytes(8), 0, 20_000)) === true ? through++ : dropped++);
  assert.ok(through <= 10 && dropped >= 10, `through ${through}, dropped ${dropped}`);
});

test('a room created from the app carries its account to the relay; reloading the room keeps it', async () => {
  const dir = tmpDir(), srv = await server(dir, 0);
  try {
    const r = await fetch(srv.httpUrl + '/rooms', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signSession() }, body: '{}' }).then(x => x.json());
    const { default: WebSocket } = await import('ws');
    const ws = new WebSocket(`${srv.url}/${r.roomId}`, ['cueboard', r.token]);
    await new Promise(ok => ws.once('message', ok));
    assert.match(srv.rooms.get(r.roomId).account, /^[0-9a-f]{64}$/);
    ws.terminate();
  } finally { await srv.close(); }
});
