// Kee+ online demo: this service worker plays the server, so the unchanged
// app runs on a static host (GitHub Pages). Everything stays in the
// visitor's browser: notes in IndexedDB, uploaded files in the Cache API.
// It starts from demo/data.json (made by tools/build_demo.py from the same
// made-up notes as the screenshots) and answers the same API as server.py:
//   POST api/sync              {since, changes} -> {rev, v, notes}
//   GET  api/notes?since=N     everything newer than N
//   PUT  api/files/<id>[/thumb] upload (type sniffed from the first bytes)
//   GET  api/files/<id>[/thumb] the file
// Conflicts are last-write-wins on updatedAt, and a rejected (older) change
// gets the stored copy back, as on the real server.
'use strict';

const DB = 'kee-demo', STORE = 'state', FILES = 'kee-demo-files';
const V = 'demo'; // constant: the app reloads when this changes
const MAX_FILE = 20 * 2 ** 20;
const BASE = new URL('./', self.location).pathname; // e.g. /kee-plus/

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// --- state: {rev, notes: {id: {rev, data}}} in one IndexedDB record -------
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, mode), st = tx.objectStore(STORE);
    const r = fn(st);
    tx.oncomplete = () => { db.close(); res(r && r.result); };
    tx.onerror = () => { db.close(); rej(tx.error); };
  });
}
const loadState = () => idbDo('readonly', st => st.get('state'));
const saveState = s => idbDo('readwrite', st => st.put(s, 'state'));

// The seed: timestamps move forward so "2 days ago" stays 2 days ago.
async function seed() {
  const res = await fetch(BASE + 'demo/data.json', { cache: 'no-cache' });
  const { generatedAt, notes } = await res.json();
  const shift = Date.now() - generatedAt;
  const state = { rev: 0, notes: {} };
  const move = n => {
    for (const k of ['createdAt', 'updatedAt', 'editedAt', 'trashedAt']) if (n[k]) n[k] += shift;
    for (const f of n.files || []) if (f.at) f.at += shift;
    return n;
  };
  for (const n of notes) state.notes[n.id] = { rev: ++state.rev, data: move(n) };
  return state;
}

// One request at a time touches the state.
let queue = Promise.resolve();
const locked = fn => (queue = queue.then(fn, fn));
let cached = null;
async function state() {
  if (!cached) cached = (await loadState()) || (await seed().then(async s => { await saveState(s); return s; }));
  return cached;
}

function syncNotes(s, changes, since) {
  const rejected = [];
  for (const note of Array.isArray(changes) ? changes : []) {
    if (!note || typeof note !== 'object') continue;
    const id = note.id, upd = note.updatedAt;
    if (typeof id !== 'string' || !id || id.length > 64 || typeof upd !== 'number') continue;
    const cur = s.notes[id];
    if (cur && cur.data.updatedAt > upd) { rejected.push(id); continue; }
    s.notes[id] = { rev: ++s.rev, data: note };
  }
  const out = Object.values(s.notes).filter(x => x.rev > since).sort((a, b) => a.rev - b.rev).map(x => x.data);
  const seen = new Set(out.map(n => n.id));
  for (const id of rejected) if (!seen.has(id)) out.push(s.notes[id].data);
  return { rev: s.rev, v: V, notes: out };
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

function sniff(b) {
  const at = (i, ...xs) => xs.every((x, k) => b[i + k] === x);
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  if (at(0, 0x25, 0x50, 0x44, 0x46)) return 'application/pdf';
  return null;
}

async function handle(req, path) {
  if (path === 'api/sync' && req.method === 'POST') {
    let body;
    try { body = JSON.parse((await req.text()) || '{}'); } catch { return json({ error: 'bad request' }, 400); }
    return locked(async () => {
      const s = await state();
      const out = syncNotes(s, body.changes || [], Number(body.since) || 0);
      await saveState(s);
      return json(out);
    });
  }
  if (path === 'api/notes' && req.method === 'GET') {
    const since = Number(new URL(req.url).searchParams.get('since')) || 0;
    return locked(async () => json(syncNotes(await state(), [], since)));
  }
  const m = /^api\/files\/([A-Za-z0-9_-]{1,64})(\/thumb)?$/.exec(path);
  if (m) {
    const key = BASE + 'api/files/' + m[1] + (m[2] || '');
    const cache = await caches.open(FILES);
    if (req.method === 'PUT') {
      if (req.headers.get('X-Mynotes') !== '1') return json({ error: 'forbidden' }, 403);
      const buf = new Uint8Array(await req.arrayBuffer());
      if (buf.length > MAX_FILE) return json({ error: 'too large' }, 413);
      const type = sniff(buf);
      if (!type) return json({ error: 'unsupported type' }, 415);
      await cache.put(key, new Response(buf, { headers: { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' } }));
      return json({ id: m[1], type, size: buf.length }, 201);
    }
    if (req.method === 'GET') {
      const hit = await cache.match(key);
      if (hit) return hit;
      if (!m[2]) { // a seeded image ships with the site
        const res = await fetch(BASE + 'demo/files/' + m[1] + '.png');
        if (res.ok) return res;
      }
      return json({ error: 'not found' }, 404);
    }
  }
  if (path === 'api/files' && req.method === 'GET') return json([]);
  return json({ error: 'not found' }, 404);
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE + 'api/')) return;
  e.respondWith(handle(e.request, url.pathname.slice(BASE.length)));
});

// "Reset demo": forget everything; the next sync seeds again.
self.addEventListener('message', e => {
  if (e.data !== 'reset') return;
  e.waitUntil(locked(async () => {
    cached = null;
    await idbDo('readwrite', st => st.delete('state'));
    await caches.delete(FILES);
    e.source && e.source.postMessage('reset-done');
  }));
});
