#!/usr/bin/env node
// @ts-check
/* npm run clear-reports -- --older-than 30d [--data-dir <dir>]
   Deletes problem reports received longer ago than that (d = days, h = hours). The server already keeps at most
   MAX_REPORTS (500). */
import { parseArgs } from 'node:util';
import { ReportStore } from '../src/reports.mjs';

const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, 'older-than': { type: 'string' } } });
const m = /^(\d+)([dh])$/.exec(values['older-than'] || '');
if (!m) { console.error('usage: clear-reports --older-than <N>d|<N>h   (e.g. 30d)'); process.exit(64); }
const ms = Number(m[1]) * (m[2] === 'd' ? 86_400_000 : 3_600_000);
const n = new ReportStore(values['data-dir'] || process.env.DATA_DIR || './data').clearOlderThan(ms);
console.log(`removed ${n} report${n === 1 ? '' : 's'} older than ${values['older-than']}`);
