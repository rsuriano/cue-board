// @ts-check
/* npm start. Settings come from the environment:
   PORT (3300) · HOST (127.0.0.1) · DATA_DIR (./data) · MAX_MESSAGE_BYTES (2 MiB) · MAX_CONNS_PER_IP (16)
   TRUST_PROXY=1 (take the client IP from X-Forwarded-For; only behind your own reverse proxy, see SPIKE.md)
   TRUSTED_PROXY_HOPS (1: how many of your own proxies append to X-Forwarded-For; the client IP is that many entries from the right)
   MAX_BUFFERED_BYTES (8 MiB: a client whose unsent queue would pass this is dropped)
   RELAY_ROOM_BYTES_PER_SEC (8 MiB) · RELAY_IP_BYTES_PER_SEC (4 MiB) · RELAY_MAX_TRANSFER_BYTES (2 GiB: largest file relayed, sent to clients): media relay caps
   RELAY_TOTAL_BYTES_PER_SEC (16 MiB: the whole server) · RELAY_ACCOUNT_BYTES_PER_DAY (20 GiB: all rooms one account
     created; rooms without an account each have their own) · RELAY_ACCOUNT_TRANSFERS (32 files relayed at once per account)
   CORS_ORIGINS (comma-separated app origins allowed to call the HTTP API, e.g. https://cue.bedrocklabs.dev; empty: no
     browser origin is allowed, so rooms can't be created from the app) · MAX_ROOMS (10000: rooms on disk, then 507)
   MAX_ROOM_BYTES (64 MiB: a room's update log; an update that would pass it is refused with 4413)
   MAX_PENDING_BYTES (4 MiB: updates waiting for a missing dependency, per room, held in memory; past it the sender gets 4400)
   CREATE_PER_HOUR (30: rooms one account may create per hour, a safety net; counted from the rooms on disk too, so a
     restart doesn't reset it) · MAX_ROOMS_PER_ACCOUNT (20: rooms one account may have on disk, then 429 account_cap)
   MIN_FREE_DISK_BYTES (1 GiB: under this much free space on DATA_DIR's disk, new rooms get 507 disk_full and updates 4413)
   AUTH_PUBLIC_KEY_FILE (auth's session public key, <SESSION_KEY_FILE>.pub from packages/auth; unset: nobody can create
     rooms from the app, everything else works)
   REPORTS_PER_HOUR (5: problem reports per IP per hour) · REPORTS_PER_DAY (200: from everyone) · MAX_REPORTS (500 kept)
   SERVE_DEMO=1 (serve demo/ at /demo/, dev only) · LOG_LEVEL (info) */
import { startServer } from './server.mjs';
import { createLogger } from './log.mjs';
import { installSafetyNet } from './safety-net.mjs';
import { RELAY_MAX_FILE } from './media-limits.mjs';
import fs from 'node:fs';
import { createPublicKey } from 'node:crypto';

const env = process.env, num = (/** @type {string | undefined} */ v, /** @type {number} */ d) => (v ? Number(v) : d);
const log = createLogger(env.LOG_LEVEL);
const authPublicKey = env.AUTH_PUBLIC_KEY_FILE ? createPublicKey(fs.readFileSync(env.AUTH_PUBLIC_KEY_FILE)) : null;
if (!authPublicKey) log.warn('room creation off: AUTH_PUBLIC_KEY_FILE not set');
/** @type {Awaited<ReturnType<typeof startServer>> | undefined} */ let srv;
installSafetyNet(log, () => {
  const force = setTimeout(() => process.exit(1), 2000); force.unref();
  Promise.resolve(srv?.close()).finally(() => process.exit(1));
});
srv = await startServer({
  port: num(env.PORT, 3300), host: env.HOST || '127.0.0.1', dataDir: env.DATA_DIR || './data',
  maxMessageBytes: num(env.MAX_MESSAGE_BYTES, 2 * 1024 * 1024), maxConnsPerIp: num(env.MAX_CONNS_PER_IP, 16),
  maxBufferedBytes: num(env.MAX_BUFFERED_BYTES, 8 * 1024 * 1024),
  trustProxy: env.TRUST_PROXY === '1', trustedProxyHops: num(env.TRUSTED_PROXY_HOPS, 1), serveDemo: env.SERVE_DEMO === '1', logLevel: env.LOG_LEVEL,
  corsOrigins: (env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  maxRooms: num(env.MAX_ROOMS, 10_000), maxRoomBytes: num(env.MAX_ROOM_BYTES, 64 * 1024 * 1024),
  maxPendingBytes: num(env.MAX_PENDING_BYTES, 4 * 1024 * 1024), createPerHour: num(env.CREATE_PER_HOUR, 30), authPublicKey,
  maxRoomsPerAccount: num(env.MAX_ROOMS_PER_ACCOUNT, 20), minFreeDiskBytes: num(env.MIN_FREE_DISK_BYTES, 1024 * 1024 * 1024),
  reportsPerHour: num(env.REPORTS_PER_HOUR, 5), reportsPerDay: num(env.REPORTS_PER_DAY, 200), maxReports: num(env.MAX_REPORTS, 500),
  media: {
    relayRoomBytesPerSec: num(env.RELAY_ROOM_BYTES_PER_SEC, 8 * 1024 * 1024), relayIpBytesPerSec: num(env.RELAY_IP_BYTES_PER_SEC, 4 * 1024 * 1024),
    relayMaxTransferBytes: num(env.RELAY_MAX_TRANSFER_BYTES, RELAY_MAX_FILE),
    relayTotalBytesPerSec: num(env.RELAY_TOTAL_BYTES_PER_SEC, 16 * 1024 * 1024),
    relayAccountBytesPerDay: num(env.RELAY_ACCOUNT_BYTES_PER_DAY, 20 * 1024 * 1024 * 1024),
    relayAccountTransfers: num(env.RELAY_ACCOUNT_TRANSFERS, 32),
  },
});
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, async () => {
  log.info('shutting down', { signal: sig });
  const force = setTimeout(() => process.exit(1), 5000); force.unref();
  await srv?.close();
  process.exit(0);
});
