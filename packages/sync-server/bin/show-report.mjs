#!/usr/bin/env node
// @ts-check
/* npm run show-report -- <id> [--data-dir <dir>]
   One problem report as pretty JSON (the id comes from list-reports). */
import { parseArgs } from 'node:util';
import { ReportStore, REPORT_ID } from '../src/reports.mjs';

const { values, positionals } = parseArgs({ options: { 'data-dir': { type: 'string' } }, allowPositionals: true });
const id = positionals[0] || '';
if (!REPORT_ID.test(id)) { console.error('usage: show-report <id>   (10 letters and digits, from list-reports)'); process.exit(64); }
const r = new ReportStore(values['data-dir'] || process.env.DATA_DIR || './data').get(id);
if (!r) { console.error(`no report ${id}`); process.exit(1); }
// JSON.stringify escapes control characters, so nothing in a report can drive the terminal
console.log(JSON.stringify(r, null, 2));
