#!/usr/bin/env node
// @ts-check
/* npm run attach-owner -- <roomId> [--data-dir <dir>]
   Gives a room an owner token (a legacy room made by create-project has none; this also replaces a lost one). Prints an
   owner link for the app (APP_URL, like create-project): opening it in the owner's browser stores the owner token with
   the project, so that browser can replace the invite link and delete the room. Keep the owner link to yourself; the
   invite link is the one to share. The token is in the #fragment (never sent to a server). */
import { parseArgs } from 'node:util';
import { ProjectStore } from '../src/store.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'data-dir': { type: 'string' } } });
const id = positionals[0], store = new ProjectStore(values['data-dir'] || process.env.DATA_DIR || './data');
if (!id) { console.error('usage: npm run attach-owner -- <roomId>'); process.exit(64); }
if (!store.exists(id)) { console.error(`no room ${id}`); process.exit(1); }
const owner = store.setOwner(id), invite = store.addToken(id), appUrl = (process.env.APP_URL || '').replace(/#.*$/, '');
console.log(`room:   ${id}\nowner:  ${owner}` + (appUrl ? `\nowner link (for the owner's browser only): ${appUrl}#join=${id}.${invite}.${owner}` : '\n(set APP_URL to also print an owner link for the app)'));
