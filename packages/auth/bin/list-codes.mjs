#!/usr/bin/env node
// @ts-check
/* npm run list-codes [-- --data-dir <dir>]
   Every invite code: id, state, emails that used it (and its cap), when it was made, label. Codes are never shown. */
import { parseArgs } from 'node:util';
import { CodeStore } from '../src/codes.mjs';
import { Users } from '../src/users.mjs';

const { values } = parseArgs({ options: { 'data-dir': { type: 'string' } } });
const dir = values['data-dir'] || process.env.DATA_DIR || './data', list = new CodeStore(dir).read(), users = new Users(dir);
if (!list.length) console.log('no codes yet: npm run create-code -- --label "<who>"');
for (const c of list) console.log(`${c.id}  ${c.revoked ? 'revoked ' : 'active  '} ${users.seats(c.id)}${c.maxUsers ? '/' + c.maxUsers : ''} used  ${String(c.created).slice(0, 10)}  ${c.label}`);
users.close();
