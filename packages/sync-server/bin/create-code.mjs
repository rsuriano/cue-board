#!/usr/bin/env node
// @ts-check
/* npm run create-code -- --label "Nacho" [--max-users N] [--data-dir <dir>]
   A verification code for one person or one group. Whoever enters it in the app ("Share this project") gets a
   long-lived verified token and can create rooms. The code is printed once, here, and stored hashed; --max-users caps how
   many browsers may redeem it (default: no cap). Safe to run while the server runs (it reads codes.json on every use). */
import { parseArgs } from 'node:util';
import { AccessStore } from '../src/access.mjs';

const { values } = parseArgs({ options: { label: { type: 'string' }, 'max-users': { type: 'string' }, 'data-dir': { type: 'string' } } });
if (!values.label) { console.error('usage: npm run create-code -- --label "<who>" [--max-users N] [--data-dir <dir>]'); process.exit(64); }
try {
  const max = values['max-users'] === undefined ? null : Number(values['max-users']);
  const r = new AccessStore(values['data-dir'] || process.env.DATA_DIR || './data').createCode({ label: values.label, maxUsers: max });
  console.log(`code:   ${r.code}\nid:     ${r.id}\nlabel:  ${r.label}${r.maxUsers ? `\nusers:  up to ${r.maxUsers}` : ''}\n\nGive the code to ${r.label}. It is not stored anywhere in clear: if it's lost, revoke it and make a new one.`);
} catch (err) { console.error(/** @type {Error} */ (err).message); process.exit(1); }
