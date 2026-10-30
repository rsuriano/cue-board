#!/usr/bin/env node
// @ts-check
/* npm run list-reports [-- --data-dir <dir>]
   Problem reports sent from the app, newest first: id, when, build, phone or desktop, errors, the start of the text.
   show-report <id> prints one in full. */
import { parseArgs } from 'node:util';
import { ReportStore } from '../src/reports.mjs';

const { values } = parseArgs({ options: { 'data-dir': { type: 'string' } } });
const list = new ReportStore(values['data-dir'] || process.env.DATA_DIR || './data').list();
if (!list.length) { console.log('no reports yet'); process.exit(0); }
// stored text is already free of control characters; this keeps one report on one line whatever the file holds
const flat = (/** @type {unknown} */ v, /** @type {number} */ n) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim().slice(0, n);
for (const r of list) {
  const kind = r.phone === true ? 'phone  ' : r.phone === false ? 'desktop' : '?      ';
  const errs = Array.isArray(r.errors) ? r.errors.length : 0;
  console.log(`${flat(r.id, 10)}  ${flat(r.received, 19).replace('T', ' ')}  ${flat(r.build || '-', 12).padEnd(12)}  ${kind}  ${String(errs).padStart(2)} err  ${r.unreadable ? '(unreadable)' : flat(r.text, 80)}`);
}
