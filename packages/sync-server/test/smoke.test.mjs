// Criterion 9 (the sync server's half): the real entrypoint (npm start = src/main.mjs) starts on a free port with a temp
// data dir and auth's public key, answers /health, stops on SIGTERM and frees the port.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir, AUTH_KEYS, signSession } from './helpers.mjs';

const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const portOpen = port => new Promise(ok => { const c = net.connect(port, '127.0.0.1'); c.on('connect', () => { c.destroy(); ok(true); }); c.on('error', () => ok(false)); });

test('(9) the sync server starts from src/main.mjs with AUTH_PUBLIC_KEY_FILE, answers /health, takes a session, stops on SIGTERM and closes its port', async () => {
  const dir = tmpDir(), port = await freePort(), pub = path.join(dir, 'session.key.pub');
  fs.writeFileSync(pub, AUTH_KEYS.publicKey.export({ type: 'spki', format: 'pem' }));
  const env = { PATH: process.env.PATH, PORT: String(port), DATA_DIR: path.join(dir, 'data'), AUTH_PUBLIC_KEY_FILE: pub, LOG_LEVEL: 'warn' };
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/main.mjs', import.meta.url))], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; child.stderr.on('data', d => { err += d; });
  const exited = new Promise(ok => child.on('exit', code => ok(code)));
  try {
    let r = null;
    for (let i = 0; i < 100 && !r; i++) { try { r = await fetch(`http://127.0.0.1:${port}/health`); } catch { await new Promise(ok => setTimeout(ok, 50)); } }
    assert.ok(r, 'the sync server never answered: ' + err);
    assert.equal(r.status, 200); assert.equal((await r.json()).ok, true);
    r = await fetch(`http://127.0.0.1:${port}/rooms`, { method: 'POST', headers: { authorization: 'Bearer ' + signSession(), 'content-type': 'application/json' }, body: '{"name":"smoke"}' });
    assert.equal(r.status, 201, 'the key from the file checks sessions');
  } finally { child.kill('SIGTERM'); }
  assert.equal(await exited, 0);
  assert.equal(await portOpen(port), false, 'port closed');
});
