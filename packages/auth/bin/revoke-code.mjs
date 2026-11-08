#!/usr/bin/env node
// @ts-check
/* npm run revoke-code -- <code id> [--data-dir <dir>]
   Revokes a code (ids from list-codes): it opens no new sessions, and everyone who came in with it loses access at
   their session's next daily check (within 24h). Rooms they already created stay, with their owners. */
import { parseArgs } from 'node:util';
import { CodeStore } from '../src/codes.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'data-dir': { type: 'string' } } });
const id = positionals[0];
if (!id) { console.error('usage: npm run revoke-code -- <code id>'); process.exit(64); }
if (!new CodeStore(values['data-dir'] || process.env.DATA_DIR || './data').revokeCode(id)) { console.error(`no code ${id} (see list-codes)`); process.exit(1); }
console.log(`revoked ${id}: its users lose access within 24h`);
