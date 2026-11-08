#!/usr/bin/env node
// @ts-check
/* npm run create-code -- --label "Nacho" [--max-users N] [--data-dir <dir>]
   An invite code for one person or one group: with their email it opens a session (as a purchase does). Printed once,
   stored hashed; --max-users caps how many emails may use it (default: no cap). Safe while the service runs. */
import { parseArgs } from 'node:util';
import { CodeStore } from '../src/codes.mjs';

const { values } = parseArgs({ options: { label: { type: 'string' }, 'max-users': { type: 'string' }, 'data-dir': { type: 'string' } } });
if (!values.label) { console.error('usage: npm run create-code -- --label "<who>" [--max-users N] [--data-dir <dir>]'); process.exit(64); }
try {
  const max = values['max-users'] === undefined ? null : Number(values['max-users']);
  const r = new CodeStore(values['data-dir'] || process.env.DATA_DIR || './data').createCode({ label: values.label, maxUsers: max });
  console.log(`code:   ${r.code}\nid:     ${r.id}\nlabel:  ${r.label}${r.maxUsers ? `\nusers:  up to ${r.maxUsers}` : ''}\n\nGive the code to ${r.label}. It is not stored anywhere in clear: if it's lost, revoke it and make a new one.`);
} catch (err) { console.error(/** @type {Error} */ (err).message); process.exit(1); }
