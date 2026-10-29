#!/usr/bin/env node
// @ts-check
/* npm run list-codes [-- --data-dir <dir>]
   Every verification code: id, label, when it was made, how many browsers redeemed it, its cap, and whether it's revoked.
   Codes themselves are never shown (only their hashes are stored). */
import { parseArgs } from 'node:util';
import { AccessStore } from '../src/access.mjs';

const { values } = parseArgs({ options: { 'data-dir': { type: 'string' } } });
const list = new AccessStore(values['data-dir'] || process.env.DATA_DIR || './data').listCodes();
if (!list.length) { console.log('no codes yet: npm run create-code -- --label "<who>"'); process.exit(0); }
for (const c of list) console.log(`${c.id}  ${c.revoked ? 'revoked ' : 'active  '} ${c.uses}${c.maxUsers ? '/' + c.maxUsers : ''} redeemed  ${c.created.slice(0, 10)}  ${c.label}`);
