// @ts-check
/* npm start. Settings come from the environment; a missing secret turns its part off, never the service:
   PORT (3400) · HOST (127.0.0.1) · DATA_DIR (./data: codes.json, users.db) · PRODUCTS_FILE (products.json next to src/)
   SESSION_KEY_FILE   the session signing key, made on first start (0600); its public half, <file>.pub, is what the sync
                      server's AUTH_PUBLIC_KEY_FILE points at. Unset: no sessions at all.
   LEMONSQUEEZY_API_KEY  orders lookup for "Log in" by email. Unset: log in by email is off (receipt links still work).
   RESEND_API_KEY + MAIL_FROM ("Bedrock Labs <login@bedrocklabs.dev>")  magic-link emails. Unset: email login and codes off.
   CORS_ORIGINS (the apps' origins, comma-separated) · TRUST_PROXY=1 (client IP from X-Forwarded-For, behind your proxy)
   LOGIN_PER_HOUR (5: login lookups per IP and per email) · LOG_LEVEL (info) */
import fs from 'node:fs';
import { startAuth } from './server.mjs';
import { loadSigningKey } from './token.mjs';

const env = process.env;
const srv = await startAuth({
  port: Number(env.PORT || 3400), host: env.HOST || '127.0.0.1', dataDir: env.DATA_DIR || './data',
  products: JSON.parse(fs.readFileSync(env.PRODUCTS_FILE || new URL('../products.json', import.meta.url), 'utf8')),
  signingKey: env.SESSION_KEY_FILE ? loadSigningKey(env.SESSION_KEY_FILE) : null,
  lsApiKey: env.LEMONSQUEEZY_API_KEY || '', resendKey: env.RESEND_API_KEY || '', mailFrom: env.MAIL_FROM || 'Bedrock Labs <login@bedrocklabs.dev>',
  corsOrigins: (env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean), trustProxy: env.TRUST_PROXY === '1',
  loginPerHour: Number(env.LOGIN_PER_HOUR || 5), logLevel: env.LOG_LEVEL,
});
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, async () => {
  const force = setTimeout(() => process.exit(1), 5000); force.unref();
  await srv.close();
  process.exit(0);
});
