// Criterion 9 (auth's half): the real entrypoint (npm start = src/main.mjs) starts on a free port with a temp data dir,
// answers /health, makes its signing key on first start, stops on SIGTERM and frees the port.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers.mjs';

export const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const portOpen = port => new Promise(ok => { const c = net.connect(port, '127.0.0.1'); c.on('connect', () => { c.destroy(); ok(true); }); c.on('error', () => ok(false)); });

test('(9) auth starts from src/main.mjs, answers /health, stops on SIGTERM and closes its port', async () => {
  const dir = tmpDir(), port = await freePort(), keyFile = path.join(dir, 'keys', 'session.key');
  const env = { PATH: process.env.PATH, PORT: String(port), DATA_DIR: path.join(dir, 'data'), SESSION_KEY_FILE: keyFile, LOG_LEVEL: 'info' };
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/main.mjs', import.meta.url))], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; child.stderr.on('data', d => { err += d; });
  const exited = new Promise(ok => child.on('exit', code => ok(code)));
  try {
    let r = null;
    for (let i = 0; i < 100 && !r; i++) { try { r = await fetch(`http://127.0.0.1:${port}/health`); } catch { await new Promise(ok => setTimeout(ok, 50)); } }
    assert.ok(r, 'auth never answered: ' + err);
    assert.equal(r.status, 200); assert.equal((await r.json()).ok, true);
    assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600, 'the signing key is made on first start, private');
    assert.match(fs.readFileSync(keyFile + '.pub', 'utf8'), /BEGIN PUBLIC KEY/, 'and its public half, for the sync server');
    assert.match(err, /lemon squeezy off/i, 'missing LEMONSQUEEZY_API_KEY is said once, at start');
  } finally { child.kill('SIGTERM'); }
  assert.equal(await exited, 0);
  assert.equal(await portOpen(port), false, 'port closed');
});
