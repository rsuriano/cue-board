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
