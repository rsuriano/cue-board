#!/usr/bin/env node
// @ts-check
/* npm run revoke-code -- <code id> [--data-dir <dir>]
   Revokes a code (ids from list-codes). Every verified token it gave out stops working at its next use: those browsers
   can't create rooms anymore. Rooms they already created stay, with their owners. */
import { parseArgs } from 'node:util';
import { AccessStore } from '../src/access.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'data-dir': { type: 'string' } } });
const id = positionals[0];
if (!id) { console.error('usage: npm run revoke-code -- <code id>'); process.exit(64); }
if (!new AccessStore(values['data-dir'] || process.env.DATA_DIR || './data').revokeCode(id)) { console.error(`no code ${id} (see list-codes)`); process.exit(1); }
console.log(`revoked ${id}: its verified tokens no longer create rooms`);
