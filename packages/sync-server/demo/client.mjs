/* Dev demo: two panes on one page, each with its own Y.Doc and WebSocket, editing the first shot of a room.
   Bundled by `npm run build:demo` (esbuild) into dist/client.js. */
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { orderedShots, setText } from '../src/schema.mjs';

const q = new URLSearchParams(location.search);
const room = q.get('room'), token = q.get('token');
const wsBase = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/r`;

/** Two-way bind a text field to a Y.Text, keeping the caret in place when remote edits land. */
function bind(el, ytext) {
  el.value = ytext.toString();
  el.addEventListener('input', () => setText(ytext, el.value));
  ytext.observe(ev => {
    if (ev.transaction.local) return;
    let s = el.selectionStart, e = el.selectionEnd, pos = 0;
    for (const op of ev.delta) {
      if (op.retain) pos += op.retain;
      else if (op.insert) { const n = op.insert.length; if (pos < s) s += n; if (pos < e) e += n; pos += n; }
      else if (op.delete) { const n = op.delete; if (pos < s) s -= Math.min(n, s - pos); if (pos < e) e -= Math.min(n, e - pos); }
    }
    el.value = ytext.toString();
    if (document.activeElement === el) el.setSelectionRange(s, e);
  });
}

function pane(root) {
  const doc = new Y.Doc();
  // disableBc: otherwise the two panes would talk over BroadcastChannel and skip the server (and the offline toggle)
  const provider = new WebsocketProvider(wsBase, room, doc, { params: { token }, disableBc: true });
  const status = root.querySelector('.status'), toggle = root.querySelector('.toggle');
  const show = () => {
    const s = !provider.shouldConnect ? 'offline' : provider.wsconnected ? (provider.synced ? 'online' : 'syncing') : 'connecting';
    status.textContent = s; status.dataset.state = s; root.dataset.state = s;
    toggle.textContent = provider.shouldConnect ? 'Go offline' : 'Go online';
  };
  provider.on('status', show); provider.on('sync', show);
  provider.on('connection-close', ev => {
    if (ev && ev.code >= 4400 && ev.code < 4500) { provider.disconnect(); status.textContent = `rejected (${ev.code} ${ev.reason})`; status.dataset.state = 'rejected'; }
  });
  toggle.onclick = () => { provider.shouldConnect ? provider.disconnect() : provider.connect(); show(); };
  provider.once('sync', () => {
    const shot = orderedShots(doc)[0];
    if (!shot) { status.textContent = 'room has no shots'; return; }
    bind(root.querySelector('.title'), shot.get('title'));
    bind(root.querySelector('.notes'), shot.get('notes'));
    root.querySelectorAll('input,textarea').forEach(el => { el.disabled = false; });
    root.dataset.ready = '1';
  });
  show();
}

if (!room || !token) document.body.insertAdjacentHTML('afterbegin', '<p class="err">Open this page with ?room=…&amp;token=… (npm run create-project prints the link).</p>');
else document.querySelectorAll('.pane').forEach(pane);
