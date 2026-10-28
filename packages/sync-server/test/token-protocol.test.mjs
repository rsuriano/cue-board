import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { tmpDir, server, makeRoom } from './helpers.mjs';

/** Raw socket with subprotocols: resolves with { result: 'joined' | close code, protocol }. */
function joinWith(url, protocols) {
  return new Promise(ok => {
    const ws = new WebSocket(url, protocols);
    ws.on('error', () => {});
    ws.once('message', () => { ok({ result: 'joined', protocol: ws.protocol }); ws.close(); });
    ws.on('close', code => ok({ result: code, protocol: ws.protocol }));
  });
}

test('(s) the token can travel as the second subprotocol, so it stays out of URLs; only "cueboard" is echoed back', async () => {
  const dir = tmpDir(), { id, token } = makeRoom(dir);
  const srv = await server(dir, 3369);
  try {
    const url = `${srv.url}/${id}`;
    assert.deepEqual(await joinWith(url, ['cueboard', token]), { result: 'joined', protocol: 'cueboard' });
    assert.equal((await joinWith(url, ['cueboard', 'x' + token.slice(1)])).result, 4401);
    // no "cueboard": the server selects no subprotocol, so the client itself aborts the handshake
    assert.notEqual((await joinWith(url, ['other', token])).result, 'joined', 'the token only counts after "cueboard"');
    assert.equal((await joinWith(url, ['cueboard'])).result, 4401);
    assert.equal((await joinWith(`${url}?token=${token}`, [])).result, 'joined', 'the query parameter still works');
  } finally { await srv.close(); }
});

test('(t) the server never logs the token or the Sec-WebSocket-Protocol header, at any level', async () => {
  const dir = tmpDir(), { id, token } = makeRoom(dir), lines = [];
  const rec = lv => (msg, fields = {}) => lines.push(JSON.stringify({ level: lv, msg, ...fields }));
  const log = { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
  const srv = await server(dir, 3372, { log, maxConnsPerIp: 3 });
  const bad = 'x' + token.slice(1);
  try {
    const url = `${srv.url}/${id}`;
    assert.equal((await joinWith(url, ['cueboard', token])).result, 'joined');
    assert.equal((await joinWith(url, ['cueboard', bad])).result, 4401);
    assert.equal((await joinWith(`${srv.url}/no-such-room-0000000`, ['cueboard', token])).result, 4404);
    assert.equal((await joinWith(`${url}?token=${token}`, [])).result, 'joined');
    assert.equal((await joinWith(`${url}?token=${bad}`, [])).result, 4401);
    // a malformed message and a refusal for too many connections, both logged with details
    const ws = new WebSocket(url, ['cueboard', token]);
    await new Promise(ok => ws.once('message', ok)); ws.send('not binary');
    assert.equal(await new Promise(ok => ws.on('close', ok)), 4400);
    const open = await Promise.all([1, 2, 3].map(() => new Promise(ok => {
      const w = new WebSocket(url, ['cueboard', token]); w.on('error', () => {}); w.once('message', () => ok(w)); w.on('close', () => ok(w));
    })));
    assert.equal((await joinWith(url, ['cueboard', token])).result, 4429);
    open.forEach(w => w.close());
  } finally { await srv.close(); }
  assert.ok(lines.some(l => /rejected: bad token/.test(l)) && lines.some(l => /malformed/.test(l)) && lines.some(l => /too many/.test(l)), 'the paths above were logged');
  const all = lines.join('\n');
  assert.ok(!all.includes(token) && !all.includes(bad), 'no token in the log');
  assert.ok(!/protocol|cueboard,/i.test(all), 'no subprotocol header in the log');
});
