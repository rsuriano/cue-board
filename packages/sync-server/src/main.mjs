// @ts-check
/* npm start. Settings come from the environment:
   PORT (3300) · HOST (127.0.0.1) · DATA_DIR (./data) · MAX_MESSAGE_BYTES (2 MiB) · MAX_CONNS_PER_IP (16)
   TRUST_PROXY=1 (take the client IP from X-Forwarded-For; only behind your own reverse proxy, see SPIKE.md)
   TRUSTED_PROXY_HOPS (1: how many of your own proxies append to X-Forwarded-For; the client IP is that many entries from the right)
   MAX_BUFFERED_BYTES (8 MiB: a client whose unsent queue would pass this is dropped)
   SERVE_DEMO=1 (serve demo/ at /demo/, dev only) · LOG_LEVEL (info) */
import { startServer } from './server.mjs';
import { createLogger } from './log.mjs';
import { installSafetyNet } from './safety-net.mjs';

const env = process.env, num = (/** @type {string | undefined} */ v, /** @type {number} */ d) => (v ? Number(v) : d);
const log = createLogger(env.LOG_LEVEL);
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
});
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, async () => {
  log.info('shutting down', { signal: sig });
  const force = setTimeout(() => process.exit(1), 5000); force.unref();
  await srv?.close();
  process.exit(0);
});
