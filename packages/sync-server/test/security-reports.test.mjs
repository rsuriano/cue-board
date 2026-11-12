// Security review, finding 8: reports need no token, and 5 per IP per hour against 200 a day for everyone meant about
// 40 addresses could use up the day's reports for everybody. Now each IP also has a daily limit (10) and the shared
// pool is 2000, so it takes 200 addresses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpDir, server } from './helpers.mjs';
import { netKey } from '../src/api.mjs';

const post = (srv, ip) => fetch(srv.httpUrl + '/reports', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: '{"text":"flood"}' }).then(r => r.status);

test('40 addresses sending as much as they can do not use up the reports for everyone (default limits)', async () => {
  const dir = tmpDir(), srv = await server(dir, 0, { trustProxy: true, maxReports: 50 });
  try {
    let stored = 0;
    for (let ip = 0; ip < 40; ip++) for (let k = 0; k < 6; k++) if ((await post(srv, '203.0.113.' + ip)) === 201) stored++;
    assert.equal(stored, 200, '5 an hour from each');
    assert.equal(await post(srv, '198.51.100.1'), 201, 'a real user still gets through');
  } finally { await srv.close(); }
});

test('IPv6: every address of one /64 shares the per-IP limits', async () => {
  const dir = tmpDir(), srv = await server(dir, 0, { trustProxy: true, maxReports: 50 });
  try {
    let ok = 0;
    for (let i = 1; i <= 8; i++) if ((await post(srv, `2001:db8:1:2::${i.toString(16)}`)) === 201) ok++;
    assert.equal(ok, 5, 'one /64, one hourly limit');
    assert.equal(await post(srv, '2001:db8:1:3::1'), 201, 'another /64 is another key');
    assert.equal(netKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), netKey('2001:0db8:0001:0002::9'));
    assert.equal(netKey('::ffff:198.51.100.7'), '198.51.100.7');
    assert.equal(netKey('198.51.100.7'), '198.51.100.7');
    assert.equal(netKey('::1'), '0:0:0:0::/64');
  } finally { await srv.close(); }
});

test('one address: 10 a day, even when the hourly window has passed', async () => {
  let t = Date.now(); const real = Date.now; Date.now = () => t;
  const dir = tmpDir(), srv = await server(dir, 0, { trustProxy: true, maxReports: 50 });
  try {
    let ok = 0;
    for (let h = 0; h < 4; h++) { for (let k = 0; k < 5; k++) if ((await post(srv, '203.0.113.9')) === 201) ok++; t += 3600_001; }
    assert.equal(ok, 10);
    t += 24 * 3600_000;
    assert.equal(await post(srv, '203.0.113.9'), 201, 'the next day');
  } finally { Date.now = real; await srv.close(); }
});
