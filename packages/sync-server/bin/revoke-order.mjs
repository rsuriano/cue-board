#!/usr/bin/env node
// @ts-check
/* npm run revoke-order -- <order id> [--data-dir <dir>]
   Revokes a paid order's token (the Lemon Squeezy order id, as in the server log), for a refund the order_refunded webhook
   missed or one made outside Lemon Squeezy. That browser can't create rooms anymore, from its next request, and
   POST /access/restore won't hand the token back. The order goes in revoked-orders.json, a file only the CLI writes (as
   codes.json), so this is safe while the server runs; verified.json is only read. Rooms it already created stay, with
   their owners. */
import { parseArgs } from 'node:util';
import { AccessStore } from '../src/access.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'data-dir': { type: 'string' } } });
const id = positionals[0];
if (!id) { console.error('usage: npm run revoke-order -- <order id>'); process.exit(64); }
const r = new AccessStore(values['data-dir'] || process.env.DATA_DIR || './data').revokeOrderByOperator(id);
if (r === 'unknown') { console.error(`no paid order ${id} in verified.json`); process.exit(1); }
console.log(r === 'already' ? `${id} was already revoked` : `revoked order ${id}: its token no longer creates rooms`);
