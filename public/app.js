'use strict';
/*
 * Kee+ client.
 *
 * Offline-first: every note lives in memory and in localStorage, so the
 * app renders instantly and works without a connection. Changes are
 * marked dirty and pushed to /api/sync in the background; the server
 * answers with everything changed since our last known revision.
 * Conflicts: last write wins, by note.updatedAt.
 */

// ---------------------------------------------------------------- store

const K = { notes: 'mn.notes', rev: 'mn.rev', dirty: 'mn.dirty', view: 'mn.view', mini: 'mn.mini', sort: 'mn.sort', group: 'mn.group', collapsed: 'mn.collapsed', cardW: 'mn.cardW', cols: 'mn.cols', searchBottom: 'mn.searchBottom', catChip: 'mn.catChip', titleFirst: 'mn.titleFirst', navKeys: 'mn.navKeys', navShow: 'mn.navShow', setTab: 'mn.setTab', navOpen: 'mn.navOpen', toast: 'mn.toast', hideEmpty: 'mn.hideEmpty', catSort: 'mn.catSort', catGroup: 'mn.catGroup', textSize: 'mn.textSize', navSpace: 'mn.navSpace', altNav: 'mn.altNav', sideW: 'mn.sideW', navPins: 'mn.navPins', navHide: 'mn.navHide', editMode: 'mn.editMode', hintTab: 'mn.hintTab', pinSort: 'mn.pinSort', pinGroup: 'mn.pinGroup', groupSubs: 'mn.groupSubs' };
const TRASH_DAYS = 7;
const SETTINGS_ID = 'settings'; // one synced record, not a note: { kind: 'settings', categories }
const COLORS = ['default', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink', 'brown', 'gray'];

const notes = new Map();
const dirty = new Set();
let rev = 0;

function readLS(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function writeLS(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota or private mode */ }
}

for (const n of readLS(K.notes, [])) if (n && n.id) notes.set(n.id, normalize(n));
for (const id of readLS(K.dirty, [])) dirty.add(id);
rev = readLS(K.rev, 0);

let persistTimer = 0;
function persist() { clearTimeout(persistTimer); persistTimer = setTimeout(persistNow, 250); }
function persistNow() {
  clearTimeout(persistTimer);
  writeLS(K.notes, [...notes.values()]);
  writeLS(K.dirty, [...dirty]);
  writeLS(K.rev, rev);
}

// crypto.randomUUID needs a secure context; plain http over Tailscale is not one.
function uid() {
  return [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join('');
}

function blank(kind = 'text') {
  return { kind, title: '', body: '', items: [], files: [], color: 'default', theme: null, pinned: false, archived: false, trashed: false, trashedAt: 0 };
}

// Fill defaults missing from notes written by older code. Not a change, so
// it doesn't touch updatedAt.
function normalize(n) {
  if (!Array.isArray(n.files)) n.files = [];
  if (!Array.isArray(n.items)) n.items = [];
  return n;
}

function hasContent(n) {
  if (n.files && n.files.length > 0) return true; // image-only notes are real notes
  if (n.title && n.title.trim()) return true;
  return n.kind === 'list' ? n.items.some(i => i.text.trim()) : !!(n.body && n.body.trim());
}

// The editor's working copy and the stored note must never share an array,
// or in-place edits bypass updatedAt. Callers replace arrays, never mutate.
function copyArrays(obj) {
  const o = { ...obj };
  if (Array.isArray(o.items)) o.items = o.items.map(i => ({ ...i }));
  if (Array.isArray(o.files)) o.files = o.files.map(f => ({ ...f }));
  return o;
}

// draftKey -> note id, so an upload that finishes after its draft became a
// note (or after the editor moved on) still finds the right note.
const draftNotes = new Map();

function createNote(fields) {
  const t = Date.now();
  const n = { ...blank(), ...copyArrays(fields), id: uid(), deleted: false, createdAt: t, updatedAt: t };
  notes.set(n.id, n);
  touched(n.id);
  return n;
}

// editedAt: when the content last changed, for the "Last edited" sort.
// updatedAt moves on every write (sync needs that); editedAt only when a
// content field really changes, so a theme, pin or archive change (e.g. a
// drag onto a category) leaves the note where it was. Notes without it
// (older ones, imports) fall back to updatedAt, which is frozen on their
// first non-content write.
const CONTENT_KEYS = ['title', 'body', 'items', 'files', 'kind'];
const editedAt = n => n.editedAt || n.updatedAt;
function updateNote(id, patch) {
  const cur = notes.get(id);
  if (!cur) return null;
  patch = copyArrays(patch);
  const n = { ...cur, ...patch, id, updatedAt: Math.max(Date.now(), cur.updatedAt + 1) };
  const changed = CONTENT_KEYS.some(k => k in patch && JSON.stringify(patch[k]) !== JSON.stringify(cur[k]));
  n.editedAt = changed ? n.updatedAt : editedAt(cur);
  notes.set(id, n);
  touched(id);
  return n;
}

// Permanent delete keeps a tombstone so other devices learn about it.
function removeNote(id) { return updateNote(id, { deleted: true, title: '', body: '', items: [], files: [] }); }

function touched(id) {
  dirty.add(id);
  persist();
  scheduleSync();
  scheduleRender();
}

// App settings ride the normal sync as a record with a fixed id. Last write
// wins on the whole record, like a note. It carries title/body so code that
// treats it as a note doesn't crash.
const isSettings = n => n.id === SETTINGS_ID;
// Categories: [{ term, name?, parent?, swatch?, tune?, icon? }]. A main
// category has a palette colour (swatch, CAT_PALETTE) and a fine-tune (tune,
// cleanTune); its subs share both. icon: a CAT_ICONS id, else guessed from the
// name. Older records also carry h/s/v/c (the old pattern sliders, unused).
// The first release stored plain strings; read those as { term }.
function categories() {
  const s = notes.get(SETTINGS_ID);
  if (!s || s.deleted || !Array.isArray(s.categories)) return [];
  return s.categories.map(c => (typeof c === 'string' ? { term: c } : c)).filter(c => c && typeof c.term === 'string');
}
const sameTerm = (a, b) => a.toLowerCase() === b.toLowerCase();
function findCategory(term) { return categories().find(c => sameTerm(c.term, term)) || null; }
// A category's `term` is its key (notes, views and settings refer to it); what
// the UI shows is its name: `name` if set, else the term. Names are unique
// among the main categories and among the subs of one main, so "Misc" can sit
// under two mains; the second gets a key like "AI/Misc" (names have no "/").
const catName = c => (c && typeof c.name === 'string' && c.name.trim() ? c.name : c ? c.term : '');
function nameOf(term) { const c = findCategory(term); return c ? catName(c) : term; }
const cleanName = s => String(s || '').trim().replace(/\s+/g, ' ');
// The category with this name among a main's subs, or among the mains.
function findChild(name, parentTerm) {
  const sibs = parentTerm ? subsOf(parentTerm) : categories().filter(c => !catParent(c));
  return sibs.find(c => sameTerm(catName(c), name)) || null;
}
// The first candidate no category uses as its key, else the last one with ~2, ~3…
function uniqueKey(cands, cats) {
  const free = k => !cats.some(c => sameTerm(c.term, k));
  for (const k of cands) if (free(k)) return k;
  const base = cands[cands.length - 1];
  for (let i = 2; ; i++) if (free(`${base}~${i}`)) return `${base}~${i}`;
}
// The record with its name set (dropped when it equals the key).
function withName(c, name) { const { name: _, ...rest } = c; return name === c.term ? rest : { ...rest, name }; }

// Sub-categories, one level: a category may name a main category as its
// `parent`. A parent that is missing, is the category itself or has a parent
// of its own is ignored, and the category counts as a main one.
const parentRef = c => !!c && typeof c.parent === 'string' && !sameTerm(c.parent, c.term) && !!findCategory(c.parent);
function catParent(cat) {
  if (!parentRef(cat)) return null;
  const p = findCategory(cat.parent);
  return parentRef(p) ? null : p;
}
function subsOf(term) { return categories().filter(c => { const p = catParent(c); return !!p && sameTerm(p.term, term); }); }
// Lower-cased terms a category view shows: the category, plus its subs if it is a main one.
function catFamily(term) {
  const s = new Set([term.toLowerCase()]), c = findCategory(term);
  if (c && !catParent(c)) for (const x of subsOf(c.term)) s.add(x.term.toLowerCase());
  return s;
}
// The main category of a term (itself for a main one or an unknown term).
function mainTerm(term) { const c = findCategory(term), p = catParent(c); return p ? p.term : c ? c.term : term; }
function catLabel(term) { const c = findCategory(term), p = catParent(c); return p ? `${catName(p)} › ${catName(c)}` : c ? catName(c) : term; }
// A sub-category draws its parent's pattern and colour (catLook).
// A renamed category keeps its pattern: `look` holds the word it is drawn from.
function drawTerm(term) {
  const c = findCategory(term), m = catParent(c) || c;
  return m ? (typeof m.look === 'string' && m.look ? m.look : m.term) : term;
}

// A main category in a list of categories (setCategories works on new lists).
const isMainIn = (cats, c) => typeof c.parent !== 'string' || sameTerm(c.parent, c.term) || !cats.some(x => sameTerm(x.term, c.parent) && !(typeof x.parent === 'string' && cats.some(y => sameTerm(y.term, x.parent))));
// Palette colour per main category: its own swatch, else the next one no
// other main uses, in created order. setCategories stores them, so removing a
// category never recolours the others.
function swatchMap(cats) {
  const out = new Map(), taken = new Set(), mains = cats.filter(c => isMainIn(cats, c));
  for (const c of mains) if (paletteEntry(c.swatch)) { out.set(c.term.toLowerCase(), c.swatch); taken.add(c.swatch); }
  let i = 0;
  for (const c of mains) {
    if (out.has(c.term.toLowerCase())) continue;
    const p = CAT_PALETTE.find(x => !taken.has(x[0])) || CAT_PALETTE[i++ % CAT_PALETTE.length];
    taken.add(p[0]);
    out.set(c.term.toLowerCase(), p[0]);
  }
  return out;
}
let swatchCache = { at: null, map: new Map() };
function swatchOf(main) {
  const s = notes.get(SETTINGS_ID), at = s ? s.updatedAt : 0;
  if (swatchCache.at !== at) swatchCache = { at, map: swatchMap(categories()) };
  return swatchCache.map.get(main.term.toLowerCase()) || CAT_PALETTE[0][0];
}
const settingsRec = () => { const s = notes.get(SETTINGS_ID); return s && !s.deleted ? s : {}; };
// Settings › Categories switches, synced: patterns behind notes (default off), icons and the main category on card tags (default on).
const catPatterns = () => settingsRec().catPatterns === true;
const catIcons = () => settingsRec().catIcons !== false;
const catTagMain = () => settingsRec().catTagMain !== false;
// The look a category gives its notes (themes.js applyTheme): its main
// category's palette colour and fine-tune, and the pattern word.
// An unknown term (category removed) gets a hue from its word.
function catLook(term, tune) {
  const c = findCategory(term), m = catParent(c) || c, pe = m ? paletteEntry(swatchOf(m)) : null;
  return { term: drawTerm(term), hue: pe ? pe[2] : themeHue(term), sat: pe ? pe[3] : 50, tune: tune || (m ? m.tune : null), pattern: catPatterns() };
}
// A category's icon and why it has it: picked in Settings, one of the
// owner's words (Settings › Icons, settings.iconWords = {id: 'a, b'},
// synced, so private names stay out of the code), a built-in hint, or none
// (the plain tag).
function iconWhy(term) {
  const c = findCategory(term), name = c ? catName(c) : String(term || '');
  if (c && CAT_ICONS[c.icon]) return { id: c.icon, how: 'picked' };
  const t = name.toLowerCase();
  for (const [id, words] of userIconWords()) for (const w of words) if (wordIn(t, w)) return { id, how: 'word', word: w };
  const id = guessIcon(name);
  return { id, how: id === 'tag' ? 'none' : 'hint' };
}
const iconOf = term => iconWhy(term).id;
// "eating out" matches "Eating Out" and "eating out 2024", not "beating".
const wordIn = (text, w) => { const i = text.indexOf(w); return i >= 0 && !/[\p{L}\p{N}]/u.test(text[i - 1] || '') && !/[\p{L}\p{N}]/u.test(text[i + w.length] || ''); };
const splitWords = str => [...new Set(String(str || '').toLowerCase().split(',').map(w => w.trim()).filter(Boolean))];
let iconWordsKey = null, iconWordsList = [];
function userIconWords() {
  const raw = settingsRec().iconWords;
  const key = JSON.stringify(raw || null);
  if (key !== iconWordsKey) {
    iconWordsKey = key;
    iconWordsList = Object.entries(raw && typeof raw === 'object' ? raw : {}).filter(([id]) => CAT_ICONS[id]).map(([id, str]) => [id, splitWords(str)]).filter(([, w]) => w.length);
  }
  return iconWordsList;
}
function catIconEl(term, id) {
  const svg = icon('x');
  svg.setAttribute('class', 'ic cat-ic');
  svg.firstChild.setAttribute('href', '#ci-' + (id || iconOf(term)));
  return svg;
}
// Sidebar and search-chip mark: the icon in the category colour, or a dot
// in that colour when icons are off.
function catMark(el, term) {
  tint(el, term ? catLook(term) : null);
  el.replaceChildren(term ? catIconEl(term) : '');
  return el;
}
document.querySelector('svg defs').insertAdjacentHTML('beforeend', catIconSymbols());

// Rename a category: only its name changes. Its key stays, so notes, views,
// folds and the custom order need no update. The name must be free among its
// siblings. One Undo. Returns the category's term, or null when nothing changed.
function renameCategory(from, input) {
  const to = cleanName(input), cat = findCategory(from);
  if (!cat || !to || to === catName(cat)) return null;
  if (to.includes('/')) { toast('A category name can\u2019t contain "/"'); return null; }
  const p = catParent(cat), clash = findChild(to, p ? p.term : '');
  if (clash && !sameTerm(clash.term, cat.term)) { toast(`There is already a category "${catLabel(clash.term)}"`); return null; }
  const old = catName(cat), before = categories();
  setCategories(before.map(c => sameTerm(c.term, cat.term) ? withName(c, to) : c));
  navCatsKey = '';
  toast(`Renamed "${old}" to "${to}"`, () => { setCategories(before); navCatsKey = ''; });
  return cat.term;
}

// Add a category, or find it, and return its term. "travel/lisbon" or a
// parent (a main category's term, from a select) adds a sub-category,
// creating the main one if needed. A name is looked up only where it would go:
// among that main's subs, or among the mains.
function addCategory(input, parentTerm = '') {
  let name = cleanName(input), parentName = '';
  const slash = name.indexOf('/');
  if (slash > 0 && slash < name.length - 1) { parentName = cleanName(name.slice(0, slash)); name = cleanName(name.slice(slash + 1)); }
  if (!name) return null;
  if (name.includes('/')) { toast('A category name can\u2019t contain "/"'); return null; }
  let cats = categories(), p = null;
  if (parentName) { // a main by that name, else the one sub with that name (its main is used below)
    p = findChild(parentName, '');
    const subs = p ? [] : categories().filter(c => catParent(c) && sameTerm(catName(c), parentName));
    if (subs.length === 1) p = subs[0];
  }
  else if (parentTerm) p = findCategory(parentTerm);
  if (p && catParent(p)) p = catParent(p); // a sub can't have subs: use its main category
  if (p && sameTerm(catName(p), name)) return p.term; // "travel/travel" is the main itself
  if (parentName && !p) {
    const key = uniqueKey([parentName], cats);
    p = withName({ term: key }, parentName);
    cats = [...cats, p];
  } else {
    const known = findChild(name, p ? p.term : '');
    if (known) return known.term;
  }
  const key = uniqueKey(p ? [name, `${catName(p)}/${name}`] : [name], cats);
  setCategories([...cats, withName(p ? { term: key, parent: p.term } : { term: key }, name)]);
  return key;
}

// Display order of the categories (sidebar, palette, Settings, category
// groups): settings.catOrder = 'alpha' (default), 'created' (the order of
// settings.categories, which only ever appends) or 'custom'
// (settings.catCustom, a list of terms; categories missing from it follow in
// created order). Synced with the rest of the settings.
const CAT_ORDERS = { alpha: 'A–Z', created: 'Date created', custom: 'Custom' };
function catOrder() {
  const s = notes.get(SETTINGS_ID);
  return s && !s.deleted && CAT_ORDERS[s.catOrder] ? s.catOrder : 'alpha';
}
const termCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
// Main categories in display order, each followed by its subs in the same
// order (A–Z, Date created or Custom).
function orderedCats() {
  const flat = baseOrder(), subs = new Map(), out = [];
  for (const c of flat) {
    const p = catParent(c);
    if (!p) continue;
    const k = p.term.toLowerCase();
    if (!subs.has(k)) subs.set(k, []);
    subs.get(k).push(c);
  }
  for (const c of flat) if (!catParent(c)) out.push(c, ...(subs.get(c.term.toLowerCase()) || []));
  return out;
}
function baseOrder() {
  const cats = categories(), order = catOrder();
  if (order === 'alpha') return cats.slice().sort((a, b) => termCollator.compare(catName(a), catName(b)));
  if (order === 'created') return cats;
  const s = notes.get(SETTINGS_ID);
  const custom = Array.isArray(s.catCustom) ? s.catCustom.filter(t => typeof t === 'string').map(t => t.toLowerCase()) : [];
  const rank = t => { const i = custom.indexOf(t.toLowerCase()); return i < 0 ? custom.length : i; };
  return cats.map((c, i) => [c, i]).sort((a, b) => rank(a[0].term) - rank(b[0].term) || a[1] - b[1]).map(x => x[0]);
}

// Paint with the category's current colours; a removed category paints unadjusted.
function paint(el, theme) { applyTheme(el, theme && theme.term ? catLook(theme.term) : null); }
function setSettings(patch) {
  if (notes.has(SETTINGS_ID)) return updateNote(SETTINGS_ID, { ...patch, deleted: false });
  const t = Date.now();
  notes.set(SETTINGS_ID, normalize({ id: SETTINGS_ID, kind: 'settings', title: '', body: '', categories: [], ...patch, deleted: false, createdAt: t, updatedAt: t }));
  touched(SETTINGS_ID);
}
function setCategories(cats) {
  const sw = swatchMap(cats); // store every main's colour, so it never shifts
  setSettings({ categories: cats.map(c => (isMainIn(cats, c) && !paletteEntry(c.swatch) ? { ...c, swatch: sw.get(c.term.toLowerCase()) } : c)) });
}

// Custom note colours: settings.colors = { red: { hex, name }, … }, synced.
// Only changed colours are stored; the rest keep the CSS defaults.
const HEX_RE = /^#[0-9a-f]{6}$/i;
function userColors() {
  const s = notes.get(SETTINGS_ID);
  return s && !s.deleted && s.colors && typeof s.colors === 'object' ? s.colors : {};
}

function purgeOldTrash() {
  const cutoff = Date.now() - TRASH_DAYS * 864e5;
  for (const n of notes.values()) {
    if (n.trashed && !n.deleted && n.trashedAt && n.trashedAt < cutoff) removeNote(n.id);
  }
}

// ---------------------------------------------------------------- sync

let syncing = false, syncAgain = false, syncTimer = 0, retries = 0;
let bootV = null; // server's app version at our first sync; a change means a deploy

function scheduleSync(ms = 500) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms); }

async function sync() {
  clearTimeout(syncTimer);
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  for (const id of dirty) if (!notes.has(id)) dirty.delete(id);
  const sent = [...dirty].slice(0, 300).map(id => notes.get(id)); // a big import goes in batches (server body limit)
  if (sent.length) setSync('busy');
  try {
    const res = await fetch('api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ since: rev, changes: sent }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    // Only clear what did not change again while the request was in flight.
    for (const n of sent) if (notes.get(n.id)?.updatedAt === n.updatedAt) dirty.delete(n.id);
    let changed = false;
    for (const n of data.notes) {
      const cur = notes.get(n.id);
      if (!cur || n.updatedAt > cur.updatedAt) {
        notes.set(n.id, normalize(n));
        dirty.delete(n.id);
        changed = true;
      }
    }
    rev = data.rev;
    retries = 0;
    persist();
    // New code was deployed: save everything and reload, so old code never
    // runs against data written by new code.
    if (bootV === null) {
      bootV = data.v;
      if (bootV) $('#ver').textContent = 'v ' + bootV;
    } else if (data.v && data.v !== bootV) {
      persistNow();
      location.reload();
      return;
    }
    if (changed) {
      render();
      modalEd.refreshFromStore();
    }
    setSync(dirty.size ? 'busy' : 'ok');
    if (dirty.size > 0 && sent.length === 300) syncAgain = true; // next batch
  } catch {
    setSync('off');
    retries = Math.min(retries + 1, 6);
    scheduleSync(1000 * 2 ** retries);
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; scheduleSync(200); }
  }
}

function setSync(state) {
  const el = $('#sync');
  el.dataset.state = state;
  el.title = { ok: 'Synced', busy: 'Saving…', off: 'Offline: changes are kept on this device' }[state];
}

// Last chance to push when the page goes away (iOS kills background tabs).
function flush() {
  persistNow();
  if (!dirty.size || !navigator.sendBeacon) return;
  const changes = [...dirty].map(id => notes.get(id)).filter(Boolean);
  navigator.sendBeacon('api/sync', JSON.stringify({ since: rev, changes }));
}

// ---------------------------------------------------------------- dom helpers

const $ = (sel, root = document) => root.querySelector(sel);
const SVGNS = 'http://www.w3.org/2000/svg';

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

function icon(name) {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'ic');
  const use = document.createElementNS(SVGNS, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

function setIcon(btn, name) { btn.querySelector('use').setAttribute('href', '#i-' + name); }

function iconBtn(name, label, act, cls = '') {
  return h('button', { class: 'icon-btn ' + cls, type: 'button', 'aria-label': label, title: label, 'data-act': act }, icon(name));
}

function autosize(ta) {
  const scroller = ta.closest('.ed-scroll');
  const top = scroller ? scroller.scrollTop : 0;
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
  if (scroller) scroller.scrollTop = top;
}

// Links: http(s):// URLs (any host, so LAN names like http://nas:5000 work)
// and www.<name>.<tld>. Trailing punctuation is dropped, except a ")" that
// closes a "(" inside the URL (Wikipedia). Only what parses as a URL counts.
const URL_RE = /(?<![\w@.\/])(?:https?:\/\/|www\.)[^\s<>"]+/gi;
function findLinks(text) {
  const out = [];
  for (const m of String(text || '').matchAll(URL_RE)) {
    let u = m[0];
    while (u && (/[.,:;!?'"\]}*]$/.test(u) || (u.endsWith(')') && u.split('(').length < u.split(')').length))) u = u.slice(0, -1);
    const www = /^www\./i.test(u);
    let url;
    try { url = new URL(www ? 'https://' + u : u); } catch { continue; }
    if (!/^https?:$/.test(url.protocol) || !url.hostname) continue;
    if (www && !/^www\.[^.]+(\.[^.]+)*\.[a-z]{2,}$/i.test(url.hostname)) continue;
    out.push({ index: m.index, text: u, href: url.href });
  }
  return out;
}
function linkify(text) {
  const out = [];
  let last = 0;
  for (const l of findLinks(text)) {
    if (l.index > last) out.push(text.slice(last, l.index));
    out.push(h('a', { href: l.href, target: '_blank', rel: 'noopener noreferrer' }, l.text));
    last = l.index + l.text.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function fmtTime(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

const mqPhone = matchMedia('(max-width: 700px)');
// Mouse or trackpad: cards can be dragged. Not on touch, where a long press selects.
const mqMouse = matchMedia('(pointer: fine)');
const isTyping = el => !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable);
// Note editor (per device): 'md' shows the formatting marks in a plain text
// field, 'rich' shows the formatting. Both store the same text (format.js).
let editMode = readLS(K.editMode, 'rich') === 'md' ? 'md' : 'rich';
const FMT_KEYS = { b: 'bold', i: 'italic', u: 'underline' };

// ---------------------------------------------------------------- editor

const EDITOR_HTML = `
  <div class="ed-top">
    <button class="icon-btn ed-back" type="button" data-a="close" aria-label="Back"><svg class="ic"><use href="#i-back"/></svg></button>
    <button class="icon-btn ed-pin not-trash" type="button" data-a="pin" aria-label="Pin" title="Pin"><svg class="ic"><use href="#i-pin"/></svg></button>
  </div>
  <div class="ed-scroll">
    <div class="ed-files" hidden></div>
    <textarea class="ed-title" rows="1" placeholder="Title" enterkeyhint="next" aria-label="Title"></textarea>
    <textarea class="ed-body" rows="1" placeholder="Take a note…" aria-label="Note"></textarea>
    <div class="ed-rich" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Note" data-placeholder="Take a note…" hidden></div>
    <div class="ed-list" hidden></div>
    <div class="ed-links" hidden></div>
  </div>
  <div class="ed-quick">
    <button class="icon-btn" type="button" data-a="attach" aria-label="Attach file" title="Attach image or file"><svg class="ic"><use href="#i-clip"/></svg></button>
    <button class="icon-btn" type="button" data-a="quick-list" aria-label="New list" title="New list (L)"><svg class="ic"><use href="#i-check"/></svg></button>
  </div>
  <input class="ed-fileinput" type="file" accept="image/*,application/pdf" multiple hidden>
  <div class="ed-fmt not-trash" role="toolbar" aria-label="Formatting">
    <button class="fmt-btn" type="button" data-f="bold" aria-label="Bold" title="Bold (Ctrl+B)"><b>B</b></button>
    <button class="fmt-btn" type="button" data-f="italic" aria-label="Italic" title="Italic (Ctrl+I)"><i>I</i></button>
    <button class="fmt-btn" type="button" data-f="underline" aria-label="Underline" title="Underline (Ctrl+U)"><u>U</u></button>
    <button class="fmt-btn" type="button" data-f="strike" aria-label="Strikethrough" title="Strikethrough (Ctrl+Shift+X)"><s>S</s></button>
    <button class="fmt-btn" type="button" data-f="h1" aria-label="Heading 1" title="Heading 1 (Ctrl+Shift+1)">H1</button>
    <button class="fmt-btn" type="button" data-f="h2" aria-label="Heading 2" title="Heading 2 (Ctrl+Shift+2)">H2</button>
    <button class="fmt-btn" type="button" data-f="h0" aria-label="Normal text" title="Normal text (Ctrl+Shift+0)">Aa</button>
  </div>
  <div class="ed-foot">
    <button class="icon-btn not-trash" type="button" data-a="kind" aria-label="Show checkboxes" title="Show checkboxes"><svg class="ic"><use href="#i-check"/></svg></button>
    <button class="icon-btn not-trash" type="button" data-a="attach" aria-label="Attach file" title="Attach image or file"><svg class="ic"><use href="#i-clip"/></svg></button>
    <button class="icon-btn not-trash" type="button" data-a="color" aria-label="Category" title="Category"><svg class="ic"><use href="#i-palette"/></svg></button>
    <button class="icon-btn not-trash needs-note" type="button" data-a="archive" aria-label="Archive" title="Archive"><svg class="ic"><use href="#i-archive"/></svg></button>
    <button class="icon-btn not-trash" type="button" data-a="trash" aria-label="Delete" title="Delete"><svg class="ic"><use href="#i-trash"/></svg></button>
    <button class="icon-btn trash-only" type="button" data-a="restore" aria-label="Restore" title="Restore"><svg class="ic"><use href="#i-restore"/></svg></button>
    <button class="icon-btn trash-only" type="button" data-a="purge" aria-label="Delete forever" title="Delete forever"><svg class="ic"><use href="#i-purge"/></svg></button>
    <button class="ed-theme" type="button" data-a="color" hidden></button>
    <span class="ed-edited"></span>
    <button class="text-btn ed-close" type="button" data-a="close">Close</button>
  </div>`;

class Editor {
  constructor(root, mode) {
    this.root = root;
    this.mode = mode; // 'inline' (desktop composer) or 'modal'
    this.id = null;
    this.d = blank();
    root.innerHTML = EDITOR_HTML;
    this.title = $('.ed-title', root);
    this.body = $('.ed-body', root);
    this.rich = $('.ed-rich', root);
    this.list = $('.ed-list', root);
    this.edited = $('.ed-edited', root);
    this.files = $('.ed-files', root);
    this.links = $('.ed-links', root);
    this.linksKey = '';
    this.fileInput = $('.ed-fileinput', root);
    this.draftKey = uid();
    root.addEventListener('input', e => this.onInput(e));
    root.addEventListener('keydown', e => this.onKey(e));
    root.addEventListener('click', e => this.onClick(e));
    root.addEventListener('change', e => this.onChange(e));
    root.addEventListener('paste', e => this.onPaste(e));
    // Format buttons (phones) keep the focus and selection in the note.
    $('.ed-fmt', root).addEventListener('pointerdown', e => { if (e.target.closest('.fmt-btn')) e.preventDefault(); });
  }

  get expanded() { return !this.root.classList.contains('collapsed'); }
  // The body field in use: the plain text field or the rich one (setting).
  get bodyEl() { return editMode === 'rich' ? this.rich : this.body; }
  expand() { if (this.mode === 'inline' && !this.expanded) { this.root.classList.remove('collapsed'); this.titleHint(); this.sizeAll(); } }
  // Title first (setting): the collapsed composer shows the title field, so
  // its placeholder reads like the body's until the composer opens.
  titleHint() {
    this.root.classList.toggle('title-first', titleFirst);
    this.title.placeholder = this.mode === 'inline' && titleFirst && !this.expanded ? 'Take a note…' : 'Title';
    autosize(this.title); // it measured 0 while the collapsed composer hid it
  }

  // In a category view a new note starts with that category's theme.
  start(kind = 'text') { this.id = null; this.draftKey = uid(); this.d = { ...blank(kind), ...draftLook() }; this.fill(); }

  load(id) {
    const n = notes.get(id);
    this.id = id;
    this.d = copyArrays(n);
    this.fill();
  }

  // A sync brought a newer copy of the open note; take it unless the user is typing in it.
  refreshFromStore() {
    if (!this.id || $('#modal').hidden) return;
    const n = notes.get(this.id);
    if (!n || n.updatedAt === this.d.updatedAt || this.root.contains(document.activeElement)) return;
    if (n.deleted) return finishModal();
    this.load(this.id);
  }

  fill() {
    const d = this.d, ro = !!d.trashed;
    this.title.value = d.title;
    this.body.value = d.body;
    this.title.readOnly = this.body.readOnly = ro;
    this.body.hidden = d.kind === 'list' || editMode === 'rich';
    this.rich.hidden = d.kind === 'list' || editMode !== 'rich';
    if (editMode === 'rich') this.fillRich();
    this.rich.contentEditable = ro ? 'false' : 'true';
    this.root.classList.toggle('is-list', d.kind === 'list');
    this.list.hidden = d.kind !== 'list';
    if (d.kind === 'list') this.renderList();
    this.root.classList.toggle('trashed', ro);
    this.chrome();
    this.renderFiles();
  }

  fillRich() {
    this.rich.replaceChildren(...(this.d.body ? mdToRich(this.d.body) : []));
    this.rich.classList.toggle('is-empty', !this.d.body);
  }

  // Bold, italic, ... (Ctrl+B and so on, or the format buttons on phones).
  format(f) {
    if (this.d.kind === 'list' || this.d.trashed) return;
    const el = this.bodyEl;
    if (document.activeElement !== el) this.focusMain();
    const level = { h0: 0, h1: 1, h2: 2 }[f];
    if (editMode === 'rich') {
      if (level === undefined) richToggle(el, f);
      else { richSetHeading(el, level); this.syncRich(); }
    } else if (level === undefined) taToggleMark(el, f);
    else taSetHeading(el, level);
  }

  syncRich() {
    const body = richToMd(this.rich);
    this.rich.classList.toggle('is-empty', !body);
    if (body !== this.d.body) this.set({ body });
  }

  // Attachment strip: stored files plus uploads still running for this note.
  renderFiles() {
    const ro = !!this.d.trashed;
    const tiles = [...this.d.files.map(f => fileTile(f, ro)), ...pendingFor(this).map(pendingTile)];
    this.files.replaceChildren(...tiles);
    this.files.hidden = !tiles.length;
    this.sizeAll();
  }

  // Text fields can't hold links, so the links in the note are listed below
  // it, clickable. Rebuilt only when the set of links changes.
  renderLinks() {
    const d = this.d, seen = new Set(), links = [];
    for (const t of [d.title, d.kind === 'list' ? '' : d.body, ...(d.kind === 'list' ? d.items.map(i => i.text) : [])]) {
      for (const l of findLinks(t)) if (!seen.has(l.href)) { seen.add(l.href); links.push(l); }
    }
    const key = links.map(l => l.href).join('\n');
    if (key === this.linksKey) return;
    this.linksKey = key;
    this.links.replaceChildren(...links.map(l => {
      let label = l.text.replace(/^https?:\/\//i, '').replace(/\/$/, '');
      return h('a', { class: 'ed-link', href: l.href, target: '_blank', rel: 'noopener noreferrer', title: l.href },
        icon('link'), h('span', null, label));
    }));
    this.links.hidden = !links.length;
  }

  // Toolbar state that follows the data.
  chrome() {
    const d = this.d;
    this.renderLinks();
    this.root.dataset.color = d.color;
    paint(this.root, d.theme);
    this.root.classList.toggle('empty-draft', !this.id);
    const pin = $('[data-a=pin]', this.root);
    setIcon(pin, d.pinned ? 'pin-fill' : 'pin');
    pin.title = pin.ariaLabel = d.pinned ? 'Unpin' : 'Pin';
    pin.style.color = d.pinned ? 'var(--text)' : '';
    const kind = $('[data-a=kind]', this.root);
    setIcon(kind, d.kind === 'list' ? 'text' : 'check');
    kind.title = kind.ariaLabel = d.kind === 'list' ? 'Hide checkboxes' : 'Show checkboxes';
    const arch = $('[data-a=archive]', this.root);
    setIcon(arch, d.archived ? 'unarchive' : 'archive');
    arch.title = arch.ariaLabel = d.archived ? 'Unarchive' : 'Archive';
    // The note's category (else its legacy colour name), like the card tag.
    // A click opens the palette, as the palette button does.
    const tag = $('.ed-theme', this.root);
    const term = d.theme && d.theme.term;
    const text = term ? catLabel(term) : d.color && d.color !== 'default' ? colorName(d.color) : '';
    tag.replaceChildren(...(term ? [catIconEl(term)] : []), text);
    tag.hidden = !text;
    tag.title = tag.ariaLabel = (term ? 'Category: ' : 'Colour: ') + text;
    const n = this.id && notes.get(this.id);
    this.edited.textContent = n && this.mode === 'modal' ? 'Edited ' + fmtTime(editedAt(n)) : '';
  }

  sizeAll() { for (const ta of this.root.querySelectorAll('textarea')) autosize(ta); }

  // Apply a change. A new note is only created once it has content.
  set(patch) {
    Object.assign(this.d, patch);
    if (this.id) {
      const n = updateNote(this.id, patch);
      if (n) this.d.updatedAt = n.updatedAt;
    } else if (hasContent(this.d)) {
      const n = createNote(this.d);
      this.id = n.id;
      draftNotes.set(this.draftKey, n.id);
      this.d.updatedAt = n.updatedAt;
    }
    this.chrome();
  }

  setItems() { this.set({ items: this.d.items }); }

  // Where typing starts in a new note: the title or the body (setting).
  focusNew() {
    if (!titleFirst) return this.focusMain();
    this.title.focus();
    this.title.setSelectionRange(this.title.value.length, this.title.value.length);
  }

  focusMain(caret = 'end') {
    const ta = this.d.kind === 'list' ? ($('.li-addtext', this.list) || this.title) : this.bodyEl;
    ta.focus();
    if (ta === this.rich) {
      const r = document.createRange();
      r.selectNodeContents(ta);
      r.collapse(caret !== 'end');
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      return;
    }
    const p = caret === 'end' ? ta.value.length : 0;
    ta.setSelectionRange(p, p);
  }

  // Close: drop the note if it ended up empty, then reset.
  close() {
    if (this.id) {
      const n = notes.get(this.id);
      if (n && !n.deleted && !n.trashed && !hasContent(n)) removeNote(this.id);
    }
    this.id = null;
    this.draftKey = uid();
    this.d = { ...blank(), ...draftLook() };
    if (this.mode === 'inline') {
      this.fill();
      this.root.classList.add('collapsed');
      this.titleHint();
      scheduleRender(0);
    }
  }

  // next = true: save and immediately start another note (Ctrl/Cmd+Enter).
  done(next) {
    closePalette();
    if (this.mode === 'modal') return closeModal();
    const kind = this.d.kind;
    this.close();
    if (next) {
      this.start(kind);
      this.expand();
      this.focusNew();
    } else if (this.root.contains(document.activeElement)) {
      document.activeElement.blur();
    }
  }

  // ----- list items

  item(id) { return this.d.items.find(i => i.id === id); }

  renderList(focusId, caret = 'end') {
    const L = this.list, ro = !!this.d.trashed;
    const open = this.d.items.filter(i => !i.done), done = this.d.items.filter(i => i.done);
    const row = it => {
      const ta = h('textarea', { class: 'li-text', rows: '1', readonly: ro, 'aria-label': 'List item', enterkeyhint: 'next' });
      ta.value = it.text;
      return h('div', { class: 'li' + (it.done ? ' done' : ''), dataset: { id: it.id } },
        h('input', { type: 'checkbox', class: 'li-check', checked: it.done, disabled: ro, 'aria-label': 'Done' }),
        ta,
        ro ? null : h('button', { class: 'icon-btn li-del', type: 'button', 'data-a': 'del', 'aria-label': 'Delete item', tabindex: '-1' }, icon('x')));
    };
    L.replaceChildren(
      ...open.map(row),
      ro ? '' : h('div', { class: 'li li-add' }, icon('plus'),
        h('textarea', { class: 'li-addtext', rows: '1', placeholder: 'List item', 'aria-label': 'New list item', enterkeyhint: 'next' })),
      done.length ? h('div', { class: 'li-sep' }, `${done.length} checked item${done.length > 1 ? 's' : ''}`) : '',
      ...done.map(row),
    );
    for (const ta of L.querySelectorAll('textarea')) autosize(ta);
    if (focusId) {
      const ta = focusId === 'add' ? $('.li-addtext', L) : $(`.li[data-id="${focusId}"] .li-text`, L);
      if (ta) {
        ta.focus();
        const p = caret === 'end' ? ta.value.length : caret;
        ta.setSelectionRange(p, p);
      }
    }
  }

  addItems(texts, afterId) {
    const fresh = texts.map(text => ({ id: uid(), text, done: false }));
    const idx = afterId ? this.d.items.findIndex(i => i.id === afterId) : -1;
    if (idx >= 0) this.d.items.splice(idx + 1, 0, ...fresh);
    else this.d.items.push(...fresh);
    this.setItems();
    return fresh;
  }

  toggleKind() {
    const d = this.d;
    if (d.kind === 'text') {
      const items = d.body.split('\n').filter(s => s.trim()).map(text => ({ id: uid(), text, done: false }));
      this.set({ kind: 'list', items, body: '' });
    } else {
      this.set({ kind: 'text', body: d.items.map(i => i.text).join('\n'), items: [] });
    }
    this.fill();
    this.focusMain();
  }

  // ----- events

  onInput(e) {
    const t = e.target;
    this.expand();
    if (t === this.title) { this.set({ title: t.value }); autosize(t); }
    else if (t === this.body) { this.set({ body: t.value }); autosize(t); }
    else if (t === this.rich) {
      // Enter at the end of a heading starts a normal line.
      if (e.inputType === 'insertParagraph') {
        const b = richBlockAt(t);
        if (b && !b.textContent && b.className) b.removeAttribute('class');
      }
      this.syncRich();
    }
    else if (t.classList.contains('li-text')) {
      const it = this.item(t.closest('.li').dataset.id);
      if (it) { it.text = t.value; this.setItems(); }
      autosize(t);
    } else if (t.classList.contains('li-addtext') && t.value) {
      const [it] = this.addItems([t.value]);
      this.renderList(it.id);
    }
  }

  onKey(e) {
    const t = e.target;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); return this.done(true); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return this.done(false); }
    if (e.isComposing) return;

    // Formatting shortcuts in the note text: Ctrl/Cmd+B, I, U; Ctrl/Cmd+Shift+X
    // strikethrough, +1 / +2 headings, +0 normal text.
    if ((t === this.body || t === this.rich) && (e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      const f = !e.shiftKey ? FMT_KEYS[k]
        : k === 'x' ? 'strike' : { Digit1: 'h1', Digit2: 'h2', Digit0: 'h0' }[e.code];
      if (f) { e.preventDefault(); return this.format(f); }
    }

    if (t === this.title && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (this.d.kind === 'list') {
        const first = $('.li-text', this.list);
        first ? (first.focus(), first.setSelectionRange(0, 0)) : this.focusMain();
      } else {
        this.focusMain('start');
      }
      return;
    }

    const isItem = t.classList.contains('li-text'), isAdd = t.classList.contains('li-addtext');
    if (!isItem && !isAdd) return;
    const rows = [...this.list.querySelectorAll('.li-text, .li-addtext')];
    const at = rows.indexOf(t);

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isItem || t.readOnly) return;
      // Split the item at the caret, like a text editor.
      const it = this.item(t.closest('.li').dataset.id);
      const before = t.value.slice(0, t.selectionStart), after = t.value.slice(t.selectionEnd);
      it.text = before;
      const [fresh] = this.addItems([after], it.id);
      fresh.done = it.done;
      this.setItems();
      this.renderList(fresh.id, 0);
      return;
    }

    if (e.key === 'Backspace' && t.selectionStart === 0 && t.selectionEnd === 0) {
      const prev = rows[at - 1];
      if (isAdd) { if (prev) { e.preventDefault(); prev.focus(); prev.setSelectionRange(prev.value.length, prev.value.length); } return; }
      if (t.readOnly) return;
      e.preventDefault();
      const id = t.closest('.li').dataset.id, it = this.item(id);
      const prevIt = prev && prev.classList.contains('li-text') ? this.item(prev.closest('.li').dataset.id) : null;
      if (!t.value && !prevIt) { // empty first item: remove and go to the title
        this.d.items = this.d.items.filter(i => i.id !== id);
        this.setItems();
        this.renderList();
        this.title.focus();
        return;
      }
      if (!prevIt) return;
      const caret = prevIt.text.length;
      prevIt.text += it.text;
      this.d.items = this.d.items.filter(i => i.id !== id);
      this.setItems();
      this.renderList(prevIt.id, caret);
      return;
    }

    if ((e.key === 'ArrowUp' && t.selectionStart === 0) || (e.key === 'ArrowDown' && t.selectionEnd === t.value.length)) {
      const next = rows[at + (e.key === 'ArrowUp' ? -1 : 1)];
      if (next) { e.preventDefault(); next.focus(); }
    }
  }

  onChange(e) {
    const t = e.target;
    if (t === this.fileInput) {
      attach(t.files, this, false); // copies the list before resetting below
      t.value = '';
      return;
    }
    if (!t.classList.contains('li-check')) return;
    const it = this.item(t.closest('.li').dataset.id);
    if (!it) return;
    it.done = t.checked;
    this.setItems();
    this.renderList();
  }

  onPaste(e) {
    const fl = clipFiles(e.clipboardData);
    if (fl) {
      e.preventDefault();
      attach(fl, this, true);
      return;
    }
    const t = e.target;
    // The rich field takes plain text only (its formatting comes from the note's marks).
    if (this.rich.contains(t)) {
      e.preventDefault();
      document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
      return;
    }
    const isItem = t.classList.contains('li-text'), isAdd = t.classList.contains('li-addtext');
    if (!isItem && !isAdd) return;
    const text = e.clipboardData.getData('text');
    if (!text.includes('\n')) return;
    e.preventDefault();
    const lines = text.split(/\r?\n/).map(s => s.replace(/^\s*(?:[-*•]|\[[ xX]?\])\s+/, '').trimEnd()).filter(s => s.trim());
    if (!lines.length) return;
    let afterId = null;
    if (isItem) {
      const it = this.item(t.closest('.li').dataset.id);
      it.text = t.value.slice(0, t.selectionStart) + lines.shift() + t.value.slice(t.selectionEnd);
      afterId = it.id;
    }
    const fresh = lines.length ? this.addItems(lines, afterId) : (this.setItems(), []);
    this.renderList(fresh.length ? fresh.at(-1).id : afterId);
  }

  onClick(e) {
    const fb = e.target.closest('.fmt-btn');
    if (fb) return this.format(fb.dataset.f);
    const btn = e.target.closest('[data-a]');
    const tile = e.target.closest('.ef');
    if (!btn && tile && tile.dataset.fid) {
      const f = this.d.files.find(x => x.id === tile.dataset.fid);
      if (f) (mqPhone.matches && isImage(f) ? openViewer(f) : open(fileUrl(f), '_blank', 'noopener'));
      return;
    }
    if (!btn) {
      // A click anywhere in the closed composer opens it in the field the
      // "Start new notes with the title" setting picks; a click on a field
      // keeps that field.
      if (this.mode === 'inline' && !this.expanded) {
        const onField = e.target.closest('textarea, input, .ed-rich');
        this.expand();
        if (!onField) this.focusNew();
      }
      return;
    }
    const d = this.d, id = this.id;
    switch (btn.dataset.a) {
      case 'close': return this.done(false);
      case 'pin': return this.set({ pinned: !d.pinned });
      case 'kind': return this.toggleKind();
      case 'attach': return this.fileInput.click(); // synchronous: iOS needs the tap
      case 'rmfile': {
        const fid = btn.closest('.ef').dataset.fid;
        const snap = id ? { ...notes.get(id) } : null;
        this.set({ files: d.files.filter(f => f.id !== fid) });
        this.renderFiles();
        if (snap) {
          // Snapshot undo also revives the note if closing tombstoned it meanwhile.
          toast('File removed', () => {
            updateNote(id, { ...snap, files: [...snap.files] });
            for (const ed of [composer, modalEd]) if (ed.id === id) ed.load(id);
          });
        }
        return;
      }
      case 'color': return openPalette(btn, d, p => this.set(p));
      case 'quick-list':
        this.start('list');
        this.expand();
        return this.focusMain();
      case 'del': {
        const row = btn.closest('.li'), rows = [...this.list.querySelectorAll('.li-text, .li-addtext')];
        const prev = rows[rows.indexOf($('.li-text', row)) - 1];
        this.d.items = d.items.filter(i => i.id !== row.dataset.id);
        this.setItems();
        this.renderList(prev && prev.closest('.li').dataset.id, 'end');
        return;
      }
      case 'archive': {
        if (!id) return;
        const was = d.archived, pinned = d.pinned;
        this.set({ archived: !was, pinned: false });
        this.done(false);
        toast(was ? 'Note unarchived' : 'Note archived', () => updateNote(id, { archived: was, pinned }));
        return;
      }
      case 'trash': {
        if (id) {
          this.set({ trashed: true, trashedAt: Date.now() });
          toast('Note moved to Trash', () => updateNote(id, { trashed: false, trashedAt: 0 }));
        }
        return this.done(false);
      }
      case 'restore':
        updateNote(id, { trashed: false, trashedAt: 0 });
        toast('Note restored');
        return this.done(false);
      case 'purge': {
        const snap = { ...notes.get(id) };
        removeNote(id);
        toast('Note deleted forever', () => updateNote(id, snap));
        return this.done(false);
      }
    }
  }
}

// ---------------------------------------------------------------- views

const board = $('#board');
const emptyEl = $('#empty');
const composer = new Editor($('#composer'), 'inline');
const modalEd = new Editor($('#modalEditor'), 'modal');

// Views: notes, attachments, archive, trash, settings, or 'cat:<term>' for
// the notes of one theme category (sidebar entries under Notes).
let view = readLS(K.view, 'notes');
// (A stored 'color:<name>' view from before colours were dropped falls back to Notes.)
if (view === 'import') { view = 'settings'; writeLS(K.setTab, 'import'); } // Import is a Settings tab now
if (!['notes', 'pinned', 'attachments', 'archive', 'trash', 'settings'].includes(view) && !String(view).startsWith('cat:')) view = 'notes';
const viewCat = () => (view.startsWith('cat:') ? view.slice(4) : null);
const colorName = c => {
  const u = userColors()[c];
  return (u && typeof u.name === 'string' && u.name.trim()) || c[0].toUpperCase() + c.slice(1);
};

// Light-mode values of the CSS defaults (app.css :root).
const DEFAULT_HEX = {
  red: '#f9c5be', orange: '#fbd6ac', yellow: '#fbf0a5', green: '#d8efc5', teal: '#c4e8df', blue: '#cfe3f3',
  indigo: '#d6d8f7', purple: '#e7d4f1', pink: '#f7d4e4', brown: '#e7ddcc', gray: '#e3e3e0',
};
// Custom colours go in a <style> after app.css, overriding --c-<name> in both
// schemes. Cards and editors of that colour get the ink (text colour) that
// reads best on it, since a picked colour is used as is in either scheme.
const userColorStyle = document.head.appendChild(document.createElement('style'));
function applyUserColors(preview) {
  const cs = { ...userColors(), ...preview };
  const rules = [], inks = [];
  for (const c of Object.keys(DEFAULT_HEX)) {
    const hex = cs[c] && cs[c].hex;
    if (!HEX_RE.test(hex || '')) continue;
    rules.push(`--c-${c}: ${hex};`); // same in light and dark mode
    const ink = inkFor(hex);
    inks.push(`:is(.card, .editor)[data-color=${c}]:not([data-themed]) { --text: var(--ink-${ink}); --muted: var(--ink-${ink}-muted); --hover: var(--ink-${ink}-hover); }`);
  }
  const css = rules.length ? `:root { ${rules.join(' ')} }\n${inks.join('\n')}` : '';
  if (userColorStyle.textContent !== css) userColorStyle.textContent = css;
}
applyUserColors();
// What a new note starts with in the current view: a category's theme.
function draftLook() { return { theme: draftTheme(), color: 'default' }; }
function draftTheme() {
  const term = viewCat();
  return term ? { term, seed: newThemeSeed() } : null;
}

// Sidebar entries for the categories, rebuilt only when the list changes.
const navCats = $('#navCats');
let navCatsKey = '';
// Sidebar "Find category" field (per page, not saved).
let navFind = '';
const navFindBox = document.getElementById('navFind'), navFindInput = document.getElementById('navFindInput'), navFindX = document.getElementById('navFindX');
function setNavFind(v) { navFind = v; navFindInput.value = v; navFindX.hidden = !v; navCatsKey = ''; renderNavCats(); }
navFindInput.addEventListener('input', () => { navFind = navFindInput.value; navFindX.hidden = !navFind; navCatsKey = ''; renderNavCats(); });
navFindInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (navFind) setNavFind(''); else navFindInput.blur(); }
  else if (e.key === 'Enter') { // open the first match
    e.preventDefault();
    const first = navCats.querySelector('[data-view^="cat:"]');
    if (first && navFind) { setView(first.dataset.view); setNavFind(''); navFindInput.blur(); }
  } else if (e.key === 'ArrowDown') { const first = navCats.querySelector('.nav-item'); if (first) { e.preventDefault(); first.focus(); } }
});
navFindX.addEventListener('click', () => { setNavFind(''); navFindInput.focus(); });
let navCounts = new Map(); // live notes per category (lower-cased term), from renderNavCats()
// A main category with subs gets a fold button; open ones are kept per
// device (mn.navOpen, lower-cased terms). Viewing a sub keeps its parent open.
// Opened only while notes are dragged over the main entry (spring-loaded).
const dragOpen = new Set();
let navOpen = new Set((readLS(K.navOpen, []) || []).filter(t => typeof t === 'string'));
function renderNavCats() {
  const cats = orderedCats();
  const cur = viewCat(), curMain = cur !== null && catParent(findCategory(cur)) ? mainTerm(cur).toLowerCase() : '';
  // Notes per category (live notes; a main category counts its subs too).
  const own = new Map(), ownPin = new Map();
  for (const n of notes.values()) {
    if (n.deleted || n.archived || n.trashed || !n.theme || !n.theme.term || isSettings(n)) continue;
    const t = n.theme.term.toLowerCase();
    own.set(t, (own.get(t) || 0) + 1);
    if (n.pinned) ownPin.set(t, (ownPin.get(t) || 0) + 1);
  }
  const counts = new Map(), pins = new Map(); // pins: pinned notes, counted the same way
  for (const c of cats) {
    const t = c.term.toLowerCase(), p = catParent(c);
    for (const [m, o] of [[counts, own], [pins, ownPin]]) {
      m.set(t, (m.get(t) || 0) + (o.get(t) || 0));
      if (p) m.set(p.term.toLowerCase(), (m.get(p.term.toLowerCase()) || 0) + (o.get(t) || 0));
    }
  }
  // The category being viewed (and its main) stays shown even when empty.
  const keep = cur !== null && findCategory(cur) ? mainTerm(cur).toLowerCase() : '';
  navCounts = counts;
  const allPinned = [...notes.values()].filter(n => n.pinned && !n.deleted && !n.archived && !n.trashed && !isSettings(n)).length;
  const pc = document.getElementById('navPinnedCount');
  if (pc.textContent !== String(allPinned)) pc.textContent = String(allPinned);
  const key = JSON.stringify([cats, [...navOpen], [...dragOpen], curMain, keep, [...counts], [...pins], navFind, !!dragIds]);
  if (key === navCatsKey) return;
  navCatsKey = key;
  navKeyMap = catKeys(cats);
  const byTerm = new Map([...navKeyMap].map(([k, t]) => [t, k]));
  const entry = (term, sub) => {
    const dot = catMark(h('span', { class: 'nav-dot' }), term);
    const k = byTerm.get(term), label = catLabel(term), n = counts.get(term.toLowerCase()) || 0, pn = pins.get(term.toLowerCase()) || 0;
    const tip = `${label}: ${n} note${n === 1 ? '' : 's'}` + (pn ? `, ${pn} pinned` : '') + (k ? ` · shortcut ${k.toUpperCase()}` : '');
    const cls = (n ? '' : ' nav-empty') + (term.toLowerCase() === keep ? ' nav-keep' : '');
    return h('button', { class: 'nav-item' + (sub ? ' nav-sub' : '') + cls, type: 'button', dataset: { view: 'cat:' + term }, title: tip },
      dot, h('span', { class: 'nav-name' }, nameOf(term)),
      h('span', { class: 'nav-meta' }, // count and key share one tight slot
        h('span', { class: 'nav-count', 'aria-label': `${n} note${n === 1 ? '' : 's'}` + (pn ? `, ${pn} pinned` : '') }, String(n),
          pn ? h('span', { class: 'nav-pins' }, ` (${pn})`) : null),
        k ? h('kbd', { class: 'nav-key', title: 'Shortcut key', 'aria-hidden': 'true' }, k.toUpperCase()) : null));
  };
  const items = [];
  // Find field: a main shows when its name or one of its subs' names matches;
  // matching subs show under it, folded or not.
  const f = navFind.trim().toLowerCase(), hit = c => catName(c).toLowerCase().includes(f);
  navCats.classList.toggle('filtering', !!f);
  for (const c of cats) {
    if (catParent(c)) continue;
    let subs = cats.filter(x => { const p = catParent(x); return !!p && sameTerm(p.term, c.term); });
    if (f) {
      const subHits = subs.filter(hit);
      if (!hit(c) && !subHits.length) continue;
      if (subHits.length) { items.push(h('div', { class: 'nav-row' }, entry(c.term, false))); for (const s of subHits) items.push(entry(s.term, true)); }
      else items.push(entry(c.term, false));
      continue;
    }
    if (!subs.length) { items.push(entry(c.term, false)); continue; }
    const lc = c.term.toLowerCase(), open = navOpen.has(lc) || curMain === lc || dragOpen.has(lc) || !!dragIds;
    const fold = h('button', { class: 'nav-fold' + (open ? ' open' : ''), type: 'button', dataset: { fold: c.term }, 'aria-expanded': String(open),
      'aria-label': (open ? 'Hide' : 'Show') + ' sub-categories of ' + catName(c), title: open ? 'Hide sub-categories' : `Show ${subs.length} sub-categor${subs.length > 1 ? 'ies' : 'y'}` }, icon('chev'));
    items.push(h('div', { class: 'nav-row' + (counts.get(lc) ? '' : ' nav-empty') + (lc === keep ? ' nav-keep' : '') }, entry(c.term, false), fold));
    if (open) for (const s of subs) items.push(entry(s.term, true));
  }
  if (f && !items.length) items.push(h('p', { class: 'nav-none' }, 'No category matches'));
  navCats.replaceChildren(...items);
  navFindBox.hidden = !cats.length;
}
navCats.addEventListener('click', e => {
  const f = e.target.closest('[data-fold]');
  if (!f) return;
  const t = f.dataset.fold.toLowerCase();
  if (navOpen.has(t) || f.classList.contains('open')) navOpen.delete(t); else navOpen.add(t);
  // Closing while a sub is shown: go to the parent, or the fold would reopen.
  const cur = viewCat();
  if (!navOpen.has(t) && cur !== null && catParent(findCategory(cur)) && sameTerm(mainTerm(cur), t)) { setView('cat:' + mainTerm(cur)); navOpen.delete(t); }
  writeLS(K.navOpen, [...navOpen]);
  navCatsKey = '';
  renderNavCats();
  const again = navCats.querySelector(`[data-fold="${CSS.escape(f.dataset.fold)}"]`);
  if (again) again.focus();
});

// Category shortcut keys, in sidebar order: 1–9 and 0 for the first ten main
// categories, then a free letter for the rest and every sub-category,
// preferring one from the name. A (all notes), C, N and L
// stay reserved. key -> term, rebuilt with the sidebar.
const RESERVED_KEYS = new Set(['a', 'c', 'n', 'l']);
let navKeyMap = new Map();
function catKeys(cats) {
  const map = new Map(), used = new Set(RESERVED_KEYS);
  const digits = cats.filter(c => !catParent(c)).slice(0, 10);
  digits.forEach((c, i) => map.set(String((i + 1) % 10), c.term));
  for (const c of cats) {
    if (digits.includes(c)) continue;
    const free = ch => ch >= 'a' && ch <= 'z' && !used.has(ch);
    const k = [...catName(c).toLowerCase()].find(free) || [...'abcdefghijklmnopqrstuvwxyz'].find(free);
    if (!k) break; // out of letters
    used.add(k);
    map.set(k, c.term);
  }
  return map;
}
let query = '';

let renderTimer = 0;
function scheduleRender(ms = 150) { clearTimeout(renderTimer); renderTimer = setTimeout(render, ms); }

// Search text per note, lower-cased once and kept until the note changes
// (every change moves updatedAt), so a keystroke only runs includes().
const hayCache = new Map(); // id -> [updatedAt, text]
function matches(n, q) {
  let c = hayCache.get(n.id);
  const stamp = n.updatedAt + ':' + (notes.get(SETTINGS_ID)?.updatedAt || 0); // a rename changes the category text
  if (!c || c[0] !== stamp) {
    c = [stamp, (n.title + '\n' + n.body + '\n' + n.items.map(i => i.text).join('\n') + '\n' + n.files.map(f => f.name).join('\n') + '\n' + (n.theme ? catLabel(n.theme.term) : '')).toLowerCase()];
    hayCache.set(n.id, c);
  }
  return c[1].includes(q);
}

function render() {
  clearTimeout(renderTimer);
  boardMore.hidden = true; // the gallery and panels have no batches; fillBoard() sets it
  loadSort();
  document.documentElement.classList.toggle('cat-icons-on', catIcons());
  renderNavCats();
  applyUserColors();
  if (viewCat() !== null && !findCategory(viewCat())) { view = 'notes'; writeLS(K.view, view); } // category removed
  const cat = viewCat();
  const fam = cat !== null ? catFamily(cat) : null; // a main category shows its subs' notes too
  const inCat = n => !!n.theme && fam.has(n.theme.term.toLowerCase());
  updateSearchChip(cat);
  $('#settingsBtn').classList.toggle('active', view === 'settings');
  const q = query.trim().toLowerCase();
  if (!q) searchFolds.clear();
  board.classList.toggle('in-archive', view === 'archive' && !q); // every card there is archived
  const panel = view === 'settings' && !q;
  if (view === 'attachments' || panel) clearSel();
  if (view === 'attachments') {
    $('#viewTitle').textContent = 'Attachments';
    for (const b of document.querySelectorAll('#sidebar [data-view]')) b.classList.toggle('active', b.dataset.view === view);
    composer.root.hidden = true;
    $('#trashBar').hidden = true;
    sortBtn.hidden = false;
    zoomBtn.hidden = true;
    return renderGallery(q);
  }
  if (panel) {
    $('#viewTitle').textContent = 'Settings';
    for (const b of document.querySelectorAll('#sidebar [data-view]')) b.classList.toggle('active', b.dataset.view === view);
    composer.root.hidden = true;
    $('#trashBar').hidden = emptyEl.hidden = true;
    sortBtn.hidden = zoomBtn.hidden = true;
    return renderSettings();
  }
  const hideId = composer.id; // the composer's note joins the grid when it closes
  const list = [];
  let trashCount = 0;
  for (const n of notes.values()) {
    if (n.deleted || n.id === hideId || isSettings(n)) continue;
    if (n.trashed) trashCount++;
    // In a category view, search only that category (archived included, as
    // in the global search); elsewhere search every note outside Trash.
    if (q) { if (n.trashed || !matches(n, q) || (cat && !inCat(n))) continue; }
    else if (view === 'notes') { if (n.archived || n.trashed) continue; }
    else if (view === 'pinned') { if (!n.pinned || n.archived || n.trashed) continue; } // every category, and none
    else if (cat) { if (n.archived || n.trashed || !inCat(n)) continue; }
    else if (view === 'archive') { if (!n.archived || n.trashed) continue; }
    else if (!n.trashed) continue;
    list.push(n);
  }
  list.sort(SORTS[sortBy].cmp);
  if (selected.size) { // a selected note that left the view (archived, synced away…) drops out
    const shown = new Set(list.map(n => n.id));
    for (const id of selected) if (!shown.has(id)) selected.delete(id);
  }

  const sections = [];
  // Grouping: by main category outside a category view ('main', or 'tree'
  // with "Sub-categories too": each main's own notes, then one smaller
  // section per sub); inside a main category that has subs, by sub-category
  // ('sub', also only with "Sub-categories too"): its own notes first, then
  // one section per sub in Settings order.
  const catSubs = cat !== null && findCategory(cat) && !catParent(findCategory(cat)) ? subsOf(cat) : [];
  groupByCat = groupCats ? (!cat ? (groupSubs ? 'tree' : 'main') : catSubs.length && groupSubs ? 'sub' : false) : false;
  const pinFirst = ns => ns.filter(n => n.pinned).concat(ns.filter(n => !n.pinned));
  if (groupByCat === 'sub') {
    const main = findCategory(cat).term;
    const order = [main, ...orderedCats().filter(c => catSubs.includes(c)).map(c => c.term)];
    const groups = new Map(order.map(t => [t.toLowerCase(), [t, []]]));
    for (const n of list) groups.get(n.theme.term.toLowerCase())?.[1].push(n);
    for (const [term, ns] of groups.values()) if (ns.length) sections.push([nameOf(term), pinFirst(ns), term.toLowerCase()]);
  } else if (groupByCat) {
    // One collapsible section per main category (its subs' notes included),
    // in Settings order, then notes without one. Pinned notes lead inside
    // their section.
    const groups = new Map(orderedCats().filter(c => !catParent(c)).map(c => [c.term.toLowerCase(), [c.term, []]]));
    const none = [];
    for (const n of list) {
      const t = n.theme && mainTerm(n.theme.term);
      if (!t) { none.push(n); continue; }
      if (!groups.has(t.toLowerCase())) groups.set(t.toLowerCase(), [t, []]);
      groups.get(t.toLowerCase())[1].push(n);
    }
    const order = orderedCats();
    for (const [term, ns] of groups.values()) {
      if (!ns.length) continue;
      const key = term.toLowerCase();
      const subs = groupByCat === 'tree' ? order.filter(c => sameTerm(catParent(c)?.term || '', term)) : [];
      const inSubs = new Set();
      const subSecs = subs.map(c => {
        const k = c.term.toLowerCase(), sns = ns.filter(n => n.theme.term.toLowerCase() === k);
        for (const n of sns) inSubs.add(n);
        return [catName(c), pinFirst(sns), k, { sub: true }];
      }).filter(x => x[1].length);
      if (!subSecs.length) { sections.push([nameOf(term), pinFirst(ns), key]); continue; }
      // The main section's label counts every note of the family; folding it
      // folds its sub-sections too.
      sections.push([nameOf(term), pinFirst(ns.filter(n => !inSubs.has(n))), key, { n: ns.length }]);
      if (!folds().has(key)) sections.push(...subSecs);
    }
    if (none.length) sections.push(['No category', pinFirst(none), '']);
  }
  const resultLabel = q && list.length ? `${list.length} result${list.length > 1 ? 's' : ''}${cat ? ' in ' + catLabel(cat) : ''}` : null;
  if (groupByCat) {
    if (resultLabel) sections.unshift([resultLabel, []]); // a label with no cards above the groups
  } else if (!q && (view === 'notes' || cat)) {
    const pinned = list.filter(n => n.pinned), others = list.filter(n => !n.pinned);
    if (pinned.length) sections.push(['Pinned', pinned]);
    if (others.length) sections.push([pinned.length ? 'Others' : null, others]);
  } else if (list.length) {
    sections.push([resultLabel, list]);
  }
  const anchor = scrollAnchor();
  // Same view, query and order as last time (a sync, an edit, closing a
  // note): keep at least as many cards as were shown, so the scroll position
  // survives. Anything else starts again with one batch.
  const boardKey = [view, q, sortBy, groupByCat].join('\n');
  const want = boardKey === page.key ? Math.max(BATCH, page.shown) : BATCH;
  page = { key: boardKey, sections, si: 0, ni: 0, grid: null, shown: 0, ctx: cardCtx() };
  board.replaceChildren();
  fillBoard(want);

  emptyEl.hidden = list.length > 0;
  $('p', emptyEl).textContent = q ? (cat ? `No matching notes in "${catLabel(cat)}"` : 'No matching notes')
    : cat ? `Notes in "${catLabel(cat)}" appear here`
    : { notes: 'Notes you add appear here', pinned: 'Pinned notes from every category appear here', settings: '', archive: 'Your archived notes appear here', trash: 'No notes in Trash' }[view];

  $('#viewTitle').textContent = cat !== null ? catLabel(cat) : { notes: 'Kee+', pinned: 'Pinned', settings: 'Kee+', archive: 'Archive', trash: 'Trash' }[view];
  for (const b of document.querySelectorAll('#sidebar [data-view]')) b.classList.toggle('active', b.dataset.view === view);
  composer.root.hidden = !(view === 'notes' || cat) || !!q;
  $('#trashBar').hidden = view !== 'trash' || !!q || trashCount === 0;
  updateSelBar();
  sortBtn.hidden = zoomBtn.hidden = false;
  layout();
  restoreScroll(anchor);
  pumpBoard();
}

// The board is built in batches: render() adds the first BATCH cards (more
// to keep the scroll position), and the rest follow as #boardMore, a marker
// below the board, comes within 1500px of the screen. A search keystroke or
// a view switch thus builds a few dozen cards, not every match.
const BATCH = 24;
let page = { key: null, sections: [], si: 0, ni: 0, grid: null, shown: 0, ctx: '' };
const boardMore = h('div', { id: 'boardMore', 'aria-hidden': 'true' });
board.after(boardMore);

// Append up to n cards, continuing where the last call stopped. Returns the
// new elements (section grids' labels and cards) for layout().
function fillBoard(n) {
  const added = [];
  const s = page.sections;
  while (n > 0 && page.si < s.length) {
    const [label, ns, key, opt = {}] = s[page.si];
    if (!page.grid) {
      let head = null, cls = 'grid', shut = false;
      if (key === undefined) head = label ? h('h2', { class: 'section-label' }, label) : null;
      else {
        shut = folds().has(key);
        cls = 'grid group' + (shut ? ' shut' : '') + (opt.sub ? ' group-sub' : '') + (opt.n && !ns.length && !shut ? ' group-bare' : '');
        head = h('h2', { class: 'section-label' },
          h('button', { class: 'group-btn', type: 'button', 'aria-expanded': String(!shut), dataset: { group: key } },
            icon('chev'), h('span', null, label), h('span', { class: 'group-n' }, String(opt.n || ns.length))));
      }
      page.grid = h('div', { class: cls }, head);
      board.append(page.grid);
      if (head) added.push(head);
      if (shut) page.ni = ns.length; // a folded group shows its label only
    }
    while (n > 0 && page.ni < ns.length) {
      const el = cardFor(ns[page.ni++]);
      page.grid.append(el);
      added.push(el);
      page.shown++;
      n--;
    }
    if (page.ni >= ns.length) { page.si++; page.ni = 0; page.grid = null; }
  }
  boardMore.hidden = page.si >= s.length;
  return added;
}

// More cards while the marker is near the screen. Runs after render() and
// from the observer; loops a frame at a time, since the observer only fires
// when the marker crosses the margin, not while it stays inside.
let pumpFrame = 0;
function pumpBoard() {
  if (pumpFrame || boardMore.hidden) return;
  pumpFrame = requestAnimationFrame(() => {
    pumpFrame = 0;
    if (boardMore.hidden || board.hidden) return;
    if (boardMore.getBoundingClientRect().top > innerHeight + 1500) return;
    layout(fillBoard(BATCH));
    pumpBoard();
  });
}
new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) pumpBoard(); }, { rootMargin: '0px 0px 1500px 0px' }).observe(boardMore);

// Built cards are kept and reused while the note and the things a card shows
// besides the note (categories and colours, grouping, the category view,
// mouse or touch) stay the same. Only the selection ring is set each time.
const cardCache = new Map(); // id -> { sig, el }
function cardCtx() {
  const s = notes.get(SETTINGS_ID);
  return [s ? s.updatedAt : 0, groupByCat, viewCat(), mqMouse.matches].join('|');
}
function cardFor(n) {
  const sig = n.updatedAt + '|' + page.ctx;
  let c = cardCache.get(n.id);
  if (!c || c.sig !== sig) {
    c = { sig, el: card(n) };
    cardCache.set(n.id, c);
    if (cardCache.size > notes.size + 200) for (const id of cardCache.keys()) if (!notes.has(id)) cardCache.delete(id);
  } else c.el.classList.toggle('sel', selected.has(n.id));
  return c.el;
}

// Rebuilding the grid drops the page to a few pixels tall until layout()
// sets the spans, and the browser clamps the scroll to the top meanwhile.
// So render() notes the cards in view first (top to bottom, with their
// screen position) and afterwards scrolls the first one that still exists
// back to where it was. A note that left the view (moved to another
// category, archived…) is skipped, so the notes around it stay put.
function scrollAnchor() {
  if (scrollY <= 0) return null;
  const marks = [];
  for (const el of board.querySelectorAll('.card')) {
    const r = el.getBoundingClientRect();
    if (r.bottom > 0 && r.top < innerHeight) marks.push([el.dataset.id, r.top]);
  }
  marks.sort((a, b) => a[1] - b[1]);
  return { y: scrollY, marks };
}
function restoreScroll(anchor) {
  if (!anchor) return;
  for (const [id, top] of anchor.marks) {
    const el = board.querySelector(`.card[data-id="${id}"]`);
    if (el) return scrollTo(0, scrollY + el.getBoundingClientRect().top - top);
  }
  scrollTo(0, anchor.y);
}

// Group by category: the grid has one section per category (render), and each group
// can be collapsed. Collapsed groups are a per-device preference, like sort.
// Search results start with every group open, so a saved fold never hides a
// match; folds made while searching last until the search is cleared.
let groupByCat = false; // false, 'main', 'tree' or 'sub' (see render)
const collapsed = new Set(readLS(K.collapsed, []));
const searchFolds = new Set();
const folds = () => (query.trim() ? searchFolds : collapsed);
board.addEventListener('click', e => {
  const b = e.target.closest('.group-btn');
  if (!b) return;
  const key = b.dataset.group, f = folds();
  if (!f.delete(key)) f.add(key);
  if (f === collapsed) writeLS(K.collapsed, [...collapsed]);
  render();
});

function card(n) {
  const el = h('article', { class: 'card' + (selected.has(n.id) ? ' sel' : ''), tabindex: '0', dataset: { id: n.id, color: n.color || 'default' } });
  if (!n.trashed && mqMouse.matches) el.draggable = true; // drag onto a sidebar category
  paint(el, n.theme);
  el.append(h('button', { class: 'c-sel', type: 'button', 'aria-label': 'Select note', title: 'Select' }, icon('tick')));
  if (!n.trashed) {
    const pin = iconBtn(n.pinned ? 'pin-fill' : 'pin', n.pinned ? 'Unpin' : 'Pin', 'pin', 'c-pin' + (n.pinned ? ' on' : ''));
    el.append(pin);
  }
  const imgs = n.files.filter(isImage), docs = n.files.filter(f => !isImage(f));
  if (imgs.length) el.append(cardMedia(imgs)); // after the pin: .c-pin.on + :not(.c-media)
  if (n.title) el.append(h('h3', { class: 'c-title' }, linkify(n.title)));
  if (n.kind === 'list') {
    const open = n.items.filter(i => !i.done && i.text.trim()), done = n.items.filter(i => i.done);
    if (open.length) {
      el.append(h('ul', { class: 'c-items' }, open.slice(0, 10).map(it =>
        h('li', null, h('input', { type: 'checkbox', class: 'c-check', 'data-item': it.id, 'aria-label': 'Done', disabled: n.trashed }), h('span', null, linkify(it.text))))));
    }
    if (open.length > 10) el.append(h('div', { class: 'c-more' }, `+ ${open.length - 10} more`));
    if (done.length) el.append(h('div', { class: 'c-more' }, `+ ${done.length} checked item${done.length > 1 ? 's' : ''}`));
  } else if (n.body.trim()) {
    el.append(h('div', { class: 'c-body' }, mdNodes(n.body)));
  }
  if (docs.length) el.append(cardDocs(docs));
  if (!hasContent(n)) el.append(h('div', { class: 'c-empty' }, 'Empty note'));
  // Archived notes say so (search results, category views); Archive hides it.
  const tags = [cardTag(n), n.archived && !n.trashed ? h('span', { class: 'c-tag c-arch', title: 'In Archive' }, icon('archive'), h('span', null, 'Archived')) : null].filter(Boolean);
  el.append(h('div', { class: 'c-foot' }, tags.length ? h('div', { class: 'c-tags' }, tags) : null, h('div', { class: 'c-actions' }, n.trashed
    ? [iconBtn('restore', 'Restore', 'restore'), iconBtn('purge', 'Delete forever', 'purge')]
    : [iconBtn('palette', 'Category', 'color'),
      n.archived ? iconBtn('unarchive', 'Unarchive', 'unarchive') : iconBtn('archive', 'Archive', 'archive'),
      iconBtn('trash', 'Delete', 'trash')])));
  return el;
}

// Bottom-left label: the note's category, else its colour name. Left out in
// that category's or colour's own view, where every note has it.
// Grouped, a main category's notes sit under its label; a sub's keep the tag.
// A sub-category's tag shows its own name; the tooltip names its main one.
function cardTag(n) {
  const term = n.theme && n.theme.term, vc = viewCat();
  const hide = !!term && ((vc !== null && sameTerm(term, vc)) || groupByCat === 'sub' || groupByCat === 'tree' || (groupByCat === 'main' && !catParent(findCategory(term))));
  // The colour already names the main category, so a sub shows only its own
  // name (with its icon); the full "main › sub" is the tooltip. With
  // "Show the main category on cards" a sub's tag starts with its main's name,
  // except where the view or the group label already names it.
  if (!term || hide) return term ? null : colorTag(n);
  const main = catParent(findCategory(term));
  const showMain = main && catTagMain() && !(vc !== null && sameTerm(main.term, vc)) && groupByCat !== 'main';
  return h('span', { class: 'c-tag', title: catLabel(term) }, catIconEl(term),
    h('span', null, showMain ? h('span', { class: 'c-tag-main' }, catName(main) + ' \u203a ') : null, nameOf(term)));
}
function colorTag(n) {
  const text = n.color && n.color !== 'default' ? colorName(n.color) : '';
  return text ? h('span', { class: 'c-tag', title: 'Colour' }, text) : null;
}

// Masonry on CSS grid: rows are 4px tall and each card spans enough rows
// for its height. One read pass, then one write pass, keeps it to two layouts.
function layout(els) {
  const kids = els || board.querySelectorAll('.grid > *');
  if (!kids.length || !board.firstChild) return;
  const gap = parseFloat(getComputedStyle(board.firstChild).columnGap) || 16;
  const heights = Array.from(kids, el => el.getBoundingClientRect().height);
  kids.forEach((el, i) => {
    const extra = el.classList.contains('card') ? gap : 8;
    el.style.gridRowEnd = 'span ' + Math.max(1, Math.ceil((heights[i] + extra) / 4));
  });
}

let lastWidth = 0;
new ResizeObserver(([entry]) => {
  const w = entry.contentRect.width;
  if (w !== lastWidth) { lastWidth = w; layout(); }
}).observe(board);

// Views other than Notes sit on a history entry, so Back (the iOS edge
// swipe, Android back) returns to Notes instead of leaving the app.
function setView(v, fromPop) {
  if (composer.expanded) composer.done(false);
  const onEntry = history.state && history.state.view;
  if (!fromPop && v !== 'notes' && !onEntry) history.pushState({ view: true }, '');
  if (!fromPop && v === 'notes' && onEntry) history.back(); // popstate finds Notes shown: no-op
  view = v;
  writeLS(K.view, v);
  // Opening a main category with subs unfolds it in the sidebar (stays open
  // until folded by hand).
  const vc = viewCat(), vcat = vc !== null ? findCategory(vc) : null;
  if (vcat && !catParent(vcat) && subsOf(vcat.term).length && !navOpen.has(vcat.term.toLowerCase())) {
    navOpen.add(vcat.term.toLowerCase());
    writeLS(K.navOpen, [...navOpen]);
  }
  selected.clear();
  // An untouched draft follows the view: themed in a category, plain in Notes.
  if (!composer.id) { Object.assign(composer.d, draftLook()); composer.chrome(); }
  document.body.classList.remove('side-open');
  $('#scrim').hidden = true;
  render();
  scrollTo(0, 0);
}

function act(action, id, btn) {
  const n = notes.get(id);
  if (!n) return;
  switch (action) {
    case 'pin': updateNote(id, { pinned: !n.pinned }); break;
    case 'color': return openPalette(btn, n, p => { updateNote(id, p); render(); });
    case 'archive':
      updateNote(id, { archived: true, pinned: false });
      toast('Note archived', () => updateNote(id, { archived: false, pinned: n.pinned }));
      break;
    case 'unarchive':
      updateNote(id, { archived: false });
      toast('Note unarchived', () => updateNote(id, { archived: true }));
      break;
    case 'trash':
      updateNote(id, { trashed: true, trashedAt: Date.now() });
      toast('Note moved to Trash', () => updateNote(id, { trashed: false, trashedAt: 0 }));
      break;
    case 'restore':
      updateNote(id, { trashed: false, trashedAt: 0 });
      toast('Note restored', () => updateNote(id, { trashed: true, trashedAt: Date.now() }));
      break;
    case 'purge': {
      const snap = { ...n };
      removeNote(id);
      toast('Note deleted forever', () => updateNote(id, snap));
      break;
    }
  }
  render();
}

board.addEventListener('click', e => {
  const el = e.target.closest('.card');
  const tile = e.target.closest('.tile');
  if (tile) return openModal(tile.dataset.id);
  if (lpFired) { lpFired = false; e.preventDefault(); return; } // the tap that ended a long press
  // Select mode: a click anywhere on a card (links, checkboxes too) toggles it.
  if (el && (selected.size || e.target.closest('.c-sel'))) {
    e.preventDefault();
    return toggleSel(el.dataset.id);
  }
  if (!el || e.target.closest('a')) return;
  const id = el.dataset.id;
  const check = e.target.closest('.c-check');
  if (check) {
    const n = notes.get(id);
    updateNote(id, { items: n.items.map(i => i.id === check.dataset.item ? { ...i, done: !i.done } : i) });
    render();
    return;
  }
  const btn = e.target.closest('[data-act]');
  if (btn) return act(btn.dataset.act, id, btn);
  openModal(id);
});
board.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.target.classList.contains('card') || e.target.classList.contains('tile'))) openModal(e.target.dataset.id);
});

// ---------------------------------------------------------------- sort

// Order of the note grid, per device (localStorage). Pinned notes keep their
// own section; the order applies inside each section, in search and Trash too.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
// What a title sort reads: the title, else the text, else the list items.
const sortLabel = n => (n.title.trim() || mdPlain(n.body).trim() || n.items.map(i => i.text).join(' ').trim());
// Untitled-and-empty notes go last in both directions.
const byLabel = dir => (a, b) => {
  const x = sortLabel(a), y = sortLabel(b);
  if (!x || !y) return (!x) - (!y) || b.createdAt - a.createdAt;
  return dir * collator.compare(x, y) || b.createdAt - a.createdAt;
};
const SORTS = {
  created: { label: 'Date created, newest first', cmp: (a, b) => b.createdAt - a.createdAt },
  createdAsc: { label: 'Date created, oldest first', cmp: (a, b) => a.createdAt - b.createdAt },
  edited: { label: 'Last edited, newest first', cmp: (a, b) => editedAt(b) - editedAt(a) },
  editedAsc: { label: 'Last edited, oldest first', cmp: (a, b) => editedAt(a) - editedAt(b) },
  title: { label: 'Title, A–Z', cmp: byLabel(1) },
  titleDesc: { label: 'Title, Z–A', cmp: byLabel(-1) },
};
// Grouping by category is a separate toggle (default on) that combines with
// any sort: one section per category in Settings order, sorted inside.
// Before it, "Category" was a sort of its own; a stored 'category' becomes
// the default sort with grouping on.
// Three sort settings: one for all notes (Notes, Archive, Trash, Attachments,
// search), one shared by every category view and one for Pinned. Each keeps
// its own sort and grouping; the other two start as the all-notes one.
function readSort(sortKey, groupKey, fallback) {
  let by = readLS(sortKey, fallback ? fallback.by : 'created');
  const g = readLS(groupKey, null);
  let group = g === null ? (fallback ? fallback.group : true) : g !== false;
  if (by === 'category') { by = 'created'; group = true; }
  if (!SORTS[by]) by = 'created';
  return { by, group };
}
const SORT_KEYS = { all: [K.sort, K.group], cat: [K.catSort, K.catGroup], pinned: [K.pinSort, K.pinGroup] };
const sortScopeOf = () => (viewCat() !== null ? 'cat' : view === 'pinned' ? 'pinned' : 'all');
const sortKeys = () => SORT_KEYS[sortScopeOf()];
let sortBy = 'created', groupCats = true, sortScope = null, sortUiReady = false;
function loadSort() {
  const scope = sortScopeOf();
  if (scope === sortScope) return;
  sortScope = scope;
  const all = readSort(K.sort, K.group);
  ({ by: sortBy, group: groupCats } = scope === 'all' ? all : readSort(...SORT_KEYS[scope], all));
  if (sortUiReady) sortBtnLabel();
}
loadSort();

const sortBtn = $('#sortBtn'), sortMenu = $('#sortMenu');
sortMenu.append(...Object.entries(SORTS).map(([key, { label }]) =>
  h('button', { class: 'menu-item', type: 'button', role: 'menuitemradio', dataset: { sort: key } }, icon('tick'), h('span', null, label))),
  h('div', { class: 'menu-sep', role: 'separator' }),
  h('button', { class: 'menu-item', type: 'button', role: 'menuitemcheckbox', dataset: { groupToggle: '' } }, icon('tick'), h('span', null, 'Group by category')),
  h('button', { class: 'menu-item menu-sub', type: 'button', role: 'menuitemcheckbox', dataset: { subsToggle: '' } }, icon('tick'), h('span', null, 'Sub-categories too')));
// "Sub-categories too": grouping also splits each main category by its
// sub-categories. Per device, one setting for every view, default on.
let groupSubs = readLS(K.groupSubs, true) !== false;
function sortBtnLabel() {
  sortBtn.title = sortBtn.ariaLabel = 'Sort · ' + SORTS[sortBy].label + (groupCats ? ' · grouped by category' : '');
}

// Zoom: card size, per device. Desktop sets the card width (the window decides
// how many fit in a row); phones set the number of cards per row. The slider
// always reads "right = bigger cards", so on phones it runs 3 → 1 columns.
const ZOOM = {
  desk: { min: 160, max: 400, step: 20, def: 240 },
  phone: { min: 1, max: 3, def: 2 },
};
const clampNum = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
let cardW = clampNum(readLS(K.cardW, ZOOM.desk.def), ZOOM.desk.min, ZOOM.desk.max, ZOOM.desk.def);
let cols = clampNum(readLS(K.cols, ZOOM.phone.def), ZOOM.phone.min, ZOOM.phone.max, ZOOM.phone.def);

function applyZoom() {
  const rs = document.documentElement.style;
  rs.setProperty('--card-w', cardW + 'px');
  rs.setProperty('--cols', cols);
  document.documentElement.dataset.cols = cols;
  layout(); // same board width, new card heights: the observer won't fire
}

// Its own toolbar button and popup (#zoomBtn, #zoomMenu), next to sort.
const zoomBtn = $('#zoomBtn'), zoomMenu = $('#zoomMenu');
const zoomInput = h('input', { type: 'range', class: 'zoom-input', 'aria-label': 'Card size' });
const zoomOut = h('output', { class: 'zoom-val' });
zoomMenu.append(
  h('label', { class: 'zoom' },
    h('span', { class: 'zoom-head' }, h('span', null, 'Zoom'), zoomOut),
    h('span', { class: 'zoom-row' }, h('span', { class: 'zoom-a', 'aria-hidden': 'true' }, 'A'), zoomInput, h('span', { class: 'zoom-a big', 'aria-hidden': 'true' }, 'A'))));

function zoomText() { return mqPhone.matches ? `${cols} per row` : `${cardW} px`; }
function fillZoom() {
  const phone = mqPhone.matches, z = phone ? ZOOM.phone : ZOOM.desk;
  zoomInput.min = phone ? 1 : z.min;
  zoomInput.max = phone ? 3 : z.max;
  zoomInput.step = phone ? 1 : z.step;
  zoomInput.value = phone ? 4 - cols : cardW;
  zoomOut.textContent = zoomText();
}
zoomInput.addEventListener('input', () => {
  const v = Number(zoomInput.value);
  if (mqPhone.matches) cols = 4 - v; else cardW = v;
  zoomOut.textContent = zoomText();
  applyZoom();
});
zoomInput.addEventListener('change', () => { writeLS(K.cardW, cardW); writeLS(K.cols, cols); });

// Sort and zoom popups hang below their button, right-aligned to it.
function placeMenu(menu, btn) {
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  const r = btn.getBoundingClientRect();
  menu.style.top = r.bottom + 6 + 'px';
  menu.style.right = Math.max(8, innerWidth - r.right) + 'px';
}
function openZoomMenu() {
  closeSortMenu();
  fillZoom();
  placeMenu(zoomMenu, zoomBtn);
}
function closeZoomMenu() { zoomMenu.hidden = true; zoomBtn.setAttribute('aria-expanded', 'false'); }
// Phones have only 3 steps, too few for a fiddly slider: each tap cycles
// 3 -> 2 -> 1 -> 3 cards per row, no popup.
function zoomBtnLabel() {
  const t = mqPhone.matches ? `Cards per row: ${cols} (tap to change)` : 'Zoom';
  zoomBtn.title = t;
  zoomBtn.setAttribute('aria-label', t);
  if (mqPhone.matches) zoomBtn.removeAttribute('aria-haspopup'); else zoomBtn.setAttribute('aria-haspopup', 'dialog');
}
zoomBtn.addEventListener('click', () => {
  if (mqPhone.matches) {
    cols = cols > ZOOM.phone.min ? cols - 1 : ZOOM.phone.max;
    writeLS(K.cols, cols);
    applyZoom();
    zoomBtnLabel();
    return;
  }
  zoomMenu.hidden ? openZoomMenu() : closeZoomMenu();
});
zoomBtnLabel();

function openSortMenu() {
  closeZoomMenu();
  for (const b of sortMenu.querySelectorAll('[data-sort]')) {
    b.classList.toggle('on', b.dataset.sort === sortBy);
    b.setAttribute('aria-checked', String(b.dataset.sort === sortBy));
  }
  const g = sortMenu.querySelector('[data-group-toggle]');
  g.classList.toggle('on', groupCats);
  g.setAttribute('aria-checked', String(groupCats));
  const gs = sortMenu.querySelector('[data-subs-toggle]');
  gs.classList.toggle('on', groupSubs);
  gs.setAttribute('aria-checked', String(groupSubs));
  gs.disabled = !groupCats;
  placeMenu(sortMenu, sortBtn);
}
function closeSortMenu() { sortMenu.hidden = true; sortBtn.setAttribute('aria-expanded', 'false'); }

sortBtn.addEventListener('click', () => (sortMenu.hidden ? openSortMenu() : closeSortMenu()));
sortMenu.addEventListener('click', e => {
  if (e.target.closest('[data-group-toggle]')) {
    groupCats = !groupCats;
    writeLS(sortKeys()[1], groupCats);
  } else if (e.target.closest('[data-subs-toggle]')) {
    groupSubs = !groupSubs;
    writeLS(K.groupSubs, groupSubs);
  } else {
    const b = e.target.closest('[data-sort]');
    if (!b) return;
    sortBy = b.dataset.sort;
    writeLS(sortKeys()[0], sortBy);
  }
  sortBtnLabel();
  closeSortMenu();
  render();
});
sortUiReady = true;
sortBtnLabel();
applyZoom();

// ---------------------------------------------------------------- select mode

// Pick several notes and act on all of them from the bar over the top bar.
// Desktop: the circle at a card's top left (on hover). Touch: long press.
// While anything is selected, a click on a card toggles it instead of opening it.
const selected = new Set();
const selbar = $('#selbar');
let lpTimer = 0, lpXY = null, lpFired = false;

const selNotes = () => [...selected].map(id => notes.get(id)).filter(n => n && !n.deleted);

function toggleSel(id) {
  if (!selected.delete(id)) selected.add(id);
  const el = board.querySelector(`.card[data-id="${id}"]`);
  if (el) el.classList.toggle('sel', selected.has(id));
  updateSelBar();
}

function clearSel() {
  if (!selected.size) return;
  selected.clear();
  for (const el of board.querySelectorAll('.card.sel')) el.classList.remove('sel');
  updateSelBar();
}

function updateSelBar() {
  const ns = selNotes(), on = ns.length > 0;
  selbar.hidden = !on;
  document.body.classList.toggle('selecting', on);
  if (!on) return;
  $('#selCount').textContent = ns.length + ' selected';
  selbar.classList.toggle('in-trash', ns.every(n => n.trashed));
  const allPinned = ns.every(n => n.pinned), allArch = ns.every(n => n.archived);
  const pin = $('[data-sa=pin]', selbar), arch = $('[data-sa=archive]', selbar);
  setIcon(pin, allPinned ? 'pin-fill' : 'pin');
  pin.title = $('span', pin).textContent = allPinned ? 'Unpin' : 'Pin';
  setIcon(arch, allArch ? 'unarchive' : 'archive');
  arch.title = $('span', arch).textContent = allArch ? 'Unarchive' : 'Archive';
}

// Escape ends select mode wherever focus is. Capture phase: the composer
// (focused on load on desktop) would otherwise swallow the key.
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !selected.size || !modal.hidden || !pal.hidden || !sortMenu.hidden || !zoomMenu.hidden) return;
  e.preventDefault();
  e.stopPropagation();
  clearSel();
}, true);

// Drag a box from empty space with the mouse to select the notes it touches.
// Adds to the current selection. Card rects are read once, in page
// coordinates, so scrolling mid-drag still lines up.
const band = document.body.appendChild(h('div', { class: 'band', hidden: true }));
let drag = null;
addEventListener('pointerdown', e => {
  if (e.pointerType !== 'mouse' || e.button !== 0 || mqPhone.matches || !modal.hidden) return;
  if (view === 'attachments' || (view === 'settings' && !query.trim())) return;
  if (!$('#main').contains(e.target) || e.target.closest('.card, .editor, .trash-bar, button, a, input, textarea')) return;
  drag = { x: e.clientX + scrollX, y: e.clientY + scrollY, on: false, base: new Set(selected), cards: null };
});
addEventListener('pointermove', e => {
  if (!drag) return;
  const x = e.clientX + scrollX, y = e.clientY + scrollY;
  if (!drag.on) {
    if (Math.hypot(x - drag.x, y - drag.y) < 6) return;
    drag.on = true;
    document.body.classList.add('banding');
    getSelection().removeAllRanges();
    drag.cards = [...board.querySelectorAll('.card')].map(el => {
      const r = el.getBoundingClientRect();
      return { el, id: el.dataset.id, l: r.left + scrollX, t: r.top + scrollY, r: r.right + scrollX, b: r.bottom + scrollY };
    });
    band.hidden = false;
  }
  const l = Math.min(x, drag.x), t = Math.min(y, drag.y), r = Math.max(x, drag.x), b = Math.max(y, drag.y);
  Object.assign(band.style, { left: l - scrollX + 'px', top: t - scrollY + 'px', width: r - l + 'px', height: b - t + 'px' });
  selected.clear();
  for (const id of drag.base) selected.add(id);
  for (const c of drag.cards) if (c.l < r && c.r > l && c.t < b && c.b > t) selected.add(c.id);
  for (const c of drag.cards) c.el.classList.toggle('sel', selected.has(c.id));
  updateSelBar();
});
function endDrag() {
  if (!drag) return;
  if (drag.on) { band.hidden = true; document.body.classList.remove('banding'); }
  drag = null;
}
addEventListener('pointerup', endDrag);
addEventListener('pointercancel', endDrag);

// Drag notes onto a sidebar category to give them its theme. Desktop only
// (cards are draggable with a fine pointer). A selected card drags the whole
// selection. Only our own data type is set, so a drop on a text field inserts
// nothing, and the file-drop handlers (which look for 'Files') ignore it.
const NOTE_DRAG = 'application/x-mynotes-notes';
let dragIds = null, dragSideTop = 0;
// While notes are dragged every main shows its subs, so the list grows. Scroll
// the sidebar so the dragged note's main category and its subs sit in the
// middle (the view's category for a note without one), where the likely drop
// targets are. A family taller than the sidebar shows from its top.
function centerDragCat(id) {
  const n = notes.get(id), t = n && n.theme && n.theme.term && findCategory(n.theme.term) ? n.theme.term : viewCat();
  if (t === null || !findCategory(t)) return;
  const fam = catFamily(mainTerm(t)), side = $('#sidebar');
  let top = Infinity, bottom = -Infinity;
  for (const el of navCats.querySelectorAll('[data-view^="cat:"]')) {
    if (!fam.has(el.dataset.view.slice(4).toLowerCase())) continue;
    const r = el.getBoundingClientRect();
    top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom);
  }
  if (top === Infinity) return;
  const s = side.getBoundingClientRect();
  const want = bottom - top > s.height - 16 ? top - s.top - 8 : (top + bottom) / 2 - (s.top + s.height / 2);
  side.scrollTop += want;
}
board.addEventListener('dragstart', e => {
  const el = e.target.closest && e.target.closest('.card');
  if (!el || !el.draggable) return;
  const id = el.dataset.id;
  dragIds = selected.has(id) ? [...selected] : [id];
  e.dataTransfer.clearData(); // drop the link/image data the browser filled in
  e.dataTransfer.setData(NOTE_DRAG, dragIds.join(','));
  e.dataTransfer.effectAllowed = 'move';
  document.body.classList.add('note-drag');
  dragSideTop = $('#sidebar').scrollTop;
  // Every category is a drop target: show the hidden empty ones (CSS) and
  // every main's subs. Deferred: changing the DOM in dragstart can cancel the drag.
  setTimeout(() => { if (dragIds) { navCatsKey = ''; renderNavCats(); centerDragCat(id); } }, 0);
});
// The drop re-renders the grid, and a detached card's dragend never reaches
// the board, so the drop cleans up too.
function endNoteDrag() {
  dragIds = null;
  document.body.classList.remove('note-drag');
  for (const t of navCats.querySelectorAll('.drop')) t.classList.remove('drop');
  springAt('');
  dragOpen.clear();
  navCatsKey = ''; renderNavCats(); // fold back what the drag opened
  $('#sidebar').scrollTop = dragSideTop; // and scroll back
}
// Holding dragged notes over a closed main category with subs opens it after
// a moment, so they can be dropped on a sub-category.
let springTimer = 0, springTerm = '';
function springAt(term) {
  if (term === springTerm) return;
  clearTimeout(springTimer);
  springTerm = term;
  if (term) springTimer = setTimeout(() => {
    if (!dragIds || springTerm !== term) return;
    dragOpen.add(term.toLowerCase());
    navCatsKey = '';
    renderNavCats();
    const again = navCats.querySelector(`[data-view="cat:${CSS.escape(term)}"]`);
    if (again) again.classList.add('drop');
  }, 500);
}
board.addEventListener('dragend', endNoteDrag);
// The fold button counts as its main category's entry.
const catTarget = e => (dragIds && e.target.closest
  ? e.target.closest('#navCats [data-view^="cat:"]') || e.target.closest('#navCats .nav-row')?.querySelector('[data-view^="cat:"]') || null
  : null);
navCats.addEventListener('dragover', e => {
  const t = catTarget(e);
  const fold = t && t.parentElement.classList.contains('nav-row') && t.nextElementSibling;
  springAt(fold && !fold.classList.contains('open') ? t.dataset.view.slice(4) : '');
  if (!t) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  for (const o of navCats.querySelectorAll('.drop')) if (o !== t) o.classList.remove('drop');
  t.classList.add('drop');
});
navCats.addEventListener('dragleave', e => {
  if (!navCats.contains(e.relatedTarget)) springAt(''); // left the sidebar: don't open late
  const t = catTarget(e);
  if (t && !t.contains(e.relatedTarget)) t.classList.remove('drop');
});
navCats.addEventListener('drop', e => {
  const t = catTarget(e);
  if (!t) return;
  e.preventDefault();
  const term = t.dataset.view.slice(4), ids = dragIds;
  endNoteDrag();
  const ns = ids.map(id => notes.get(id)).filter(n => n && !n.deleted && !n.trashed && !(n.theme && sameTerm(n.theme.term, term)));
  if (!ns.length) return;
  const snap = ns.map(n => [n.id, { theme: n.theme }]);
  for (const n of ns) updateNote(n.id, { theme: { term, seed: newThemeSeed() } });
  const k = ns.length;
  toast(`${k} note${k > 1 ? 's' : ''} moved to ${catLabel(term)}`, () => { for (const [id, old] of snap) updateNote(id, old); });
  selected.clear();
  // Re-render only once the drag has ended: removing the dragged card inside
  // the drop handler leaves Chrome's drag session hanging, and the page then
  // doesn't update until the next click. The timer covers a lost dragend.
  let done = false;
  const go = () => { if (done) return; done = true; document.removeEventListener('dragend', go, true); render(); };
  document.addEventListener('dragend', go, true);
  setTimeout(go, 250);
});

// Apply a patch to every selected note, with one Undo for all of them.
// keep: the fields Undo restores.
function bulk(msg, keep, patchFor, clear = true) {
  const ns = selNotes();
  if (!ns.length) return;
  const snap = ns.map(n => [n.id, Object.fromEntries(keep.map(k => [k, n[k]]))]);
  for (const n of ns) updateNote(n.id, patchFor(n));
  const k = ns.length;
  toast(`${k} note${k > 1 ? 's' : ''} ${msg}`, () => { for (const [id, old] of snap) updateNote(id, old); });
  if (clear) selected.clear();
  render();
}

selbar.addEventListener('click', e => {
  const b = e.target.closest('[data-sa]');
  if (!b) return;
  const ns = selNotes();
  switch (b.dataset.sa) {
    case 'clear': return clearSel();
    case 'pin': {
      const pin = !ns.every(n => n.pinned);
      return bulk(pin ? 'pinned' : 'unpinned', ['pinned'], () => ({ pinned: pin }), false);
    }
    case 'archive': {
      const arch = !ns.every(n => n.archived);
      return bulk(arch ? 'archived' : 'unarchived', ['archived', 'pinned'], () => (arch ? { archived: true, pinned: false } : { archived: false }));
    }
    case 'trash': return bulk('moved to Trash', ['trashed', 'trashedAt'], () => ({ trashed: true, trashedAt: Date.now() }));
    case 'restore': return bulk('restored', ['trashed', 'trashedAt'], () => ({ trashed: false, trashedAt: 0 }));
    case 'purge': {
      const snaps = ns.map(n => ({ ...n }));
      for (const n of snaps) removeNote(n.id);
      const k = snaps.length;
      toast(`${k} note${k > 1 ? 's' : ''} deleted forever`, () => { for (const sn of snaps) updateNote(sn.id, sn); });
      selected.clear();
      return render();
    }
    case 'color': {
      // Shared colour/theme is shown as current. Themes draw the same for every note (applyTheme).
      const same = k => ns.every(n => JSON.stringify(n[k] || null) === JSON.stringify(ns[0][k] || null));
      const cur = { color: same('color') ? ns[0].color : null, theme: same('theme') ? ns[0].theme : null };
      const snap = ns.map(n => [n.id, { color: n.color, theme: n.theme || null }]);
      return openPalette(b, cur, p => {
        for (const n of selNotes()) updateNote(n.id, p.theme ? { theme: { term: p.theme.term, seed: newThemeSeed() } } : p);
        const k = snap.length;
        toast(`${k} note${k > 1 ? 's' : ''} updated`, () => { for (const [id, old] of snap) updateNote(id, old); });
        selected.clear(); // done: leave select mode, like archive and delete
        render();
      });
    }
  }
});

// Long press on a card starts (or extends) the selection on touch screens.
board.addEventListener('touchstart', e => {
  lpFired = false;
  const el = e.target.closest('.card');
  if (!el || e.touches.length !== 1) return;
  lpXY = [e.touches[0].clientX, e.touches[0].clientY];
  clearTimeout(lpTimer);
  lpTimer = setTimeout(() => {
    lpFired = true;
    lpXY = null;
    toggleSel(el.dataset.id);
    if (navigator.vibrate) navigator.vibrate(10);
  }, 450);
}, { passive: true });
board.addEventListener('touchmove', e => {
  if (lpXY && Math.hypot(e.touches[0].clientX - lpXY[0], e.touches[0].clientY - lpXY[1]) > 10) { clearTimeout(lpTimer); lpXY = null; }
}, { passive: true });
board.addEventListener('touchend', () => { clearTimeout(lpTimer); lpXY = null; });
board.addEventListener('touchcancel', () => { clearTimeout(lpTimer); lpXY = null; });
board.addEventListener('contextmenu', e => { if (lpFired && e.target.closest('.card')) e.preventDefault(); });

// ---------------------------------------------------------------- modal

const modal = $('#modal');

function showModal() {
  if (composer.expanded) composer.done(false);
  modal.hidden = false;
  document.documentElement.classList.add('modal-open');
  modalEd.sizeAll();
  history.pushState({ editor: true }, '');
}

function openModal(id) {
  modalEd.load(id);
  showModal();
  if (!mqPhone.matches && !modalEd.d.trashed) modalEd.focusMain();
}

// Called straight from a tap handler so iOS opens the keyboard.
function openNew(kind) {
  if (query) clearSearch();
  if (view !== 'notes' && !viewCat()) setView('notes');
  if (!mqPhone.matches) {
    if (composer.id) composer.close();
    composer.start(kind);
    composer.expand();
    composer.focusNew();
    scrollTo(0, 0);
    return;
  }
  modalEd.start(kind);
  modal.hidden = false;
  modalEd.focusNew();
  showModal();
}

function closeModal() {
  if (modal.hidden) return;
  if (history.state && history.state.editor) history.back(); // popstate finishes it
  else finishModal();
}

function finishModal() {
  if (modal.hidden) return;
  closePalette();
  if (modal.contains(document.activeElement)) document.activeElement.blur();
  modalEd.close();
  modal.hidden = true;
  document.documentElement.classList.remove('modal-open');
  render();
}

// Image viewer (phones): a full-screen image over the note, with Back (to the
// note) and Close (the note too). It has its own history entry on top of the
// modal's, so the back gesture closes it first. A new tab would open without
// any UI in the home-screen app.
const viewer = $('#viewer'), viewerImg = $('#viewerImg');
let viewerThenNote = false; // Close: the note goes too
function openViewer(f) {
  viewerImg.src = fileUrl(f);
  viewerImg.alt = f.name;
  viewer.hidden = false;
  history.pushState({ viewer: true }, '');
}
function closeViewer(thenNote = false) {
  if (viewer.hidden) return;
  viewerThenNote = thenNote;
  // Close leaves both entries (viewer, then the modal's editor entry) in one
  // step: a history.back() from inside popstate is not reliable.
  const steps = thenNote && history.state && history.state.viewer ? -2 : -1;
  if (history.state && history.state.viewer) history.go(steps); // popstate finishes it
  else finishViewer();
}
function finishViewer() {
  viewer.hidden = true;
  viewerImg.removeAttribute('src');
  if (viewerThenNote) { viewerThenNote = false; history.state && history.state.editor ? closeModal() : finishModal(); }
}
$('#viewerBack').addEventListener('click', () => closeViewer());
$('#viewerClose').addEventListener('click', () => closeViewer(true));
addEventListener('keydown', e => {
  if (e.key === 'Escape' && !viewer.hidden) { e.preventDefault(); e.stopImmediatePropagation(); closeViewer(); }
}, true);

addEventListener('popstate', () => {
  if (!viewer.hidden) return finishViewer();
  if (!modal.hidden) return finishModal();
  if (view !== 'notes' && !(history.state && history.state.view)) setView('notes', true);
});
if (view !== 'notes' && !(history.state && history.state.view)) history.pushState({ view: true }, ''); // restored view
$('#modalScrim').addEventListener('click', closeModal);

// Keep the full-screen phone editor above the on-screen keyboard.
if (window.visualViewport) {
  const vv = visualViewport, rs = document.documentElement.style;
  const update = () => { rs.setProperty('--vvh', vv.height + 'px'); rs.setProperty('--vvt', vv.offsetTop + 'px'); };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}

// ---------------------------------------------------------------- palette

// Themes only: "None" first, then the Settings categories. "None" clears the
// theme and any legacy colour; picking either closes the palette.
const pal = $('#palette');
let palPick = null, palCur = null;
const palThemes = h('div', { class: 'pal-themes' });
// New theme: adds the category (if new), gives it to the note(s) being edited
// and closes the palette. Built once so typed text survives fillPalette().
const palInput = h('input', { class: 'cat-input', type: 'text', placeholder: 'New category', title: 'New category, e.g. ocean. Typing main/sub (travel/lisbon) also makes a sub-category.', maxlength: '81', autocomplete: 'off', enterkeyhint: 'done', 'aria-label': 'New category' });
// Where the new theme goes: a main category, or under one (a sub-category).
const palParent = h('select', { class: 'cat-parent', 'aria-label': 'Add as' });
const palAdd = h('form', { class: 'pal-add' }, palParent, palInput, h('button', { class: 'text-btn', type: 'submit' }, 'Add'));
palAdd.addEventListener('submit', e => {
  e.preventDefault();
  if (!palPick) return;
  const term = addCategory(palInput.value, palParent.value);
  if (!term) return;
  const pick = palPick;
  palInput.value = '';
  palParent.value = '';
  closePalette();
  pick({ theme: { term, seed: newThemeSeed() } });
});
// The category list scrolls; the add form and "Edit categories" stay below it.
pal.append(palThemes, palAdd, h('button', { class: 'text-btn pal-manage', type: 'button', 'data-manage': '' }, 'Edit categories'));

function fillPalette() {
  const cur = palCur.theme;
  const cats = orderedCats();
  fillParentSelect(palParent, cats.filter(c => !catParent(c)).map(c => c.term), palParent.dataset.want || palParent.value);
  palParent.dataset.want = '';
  const tile = (term, cls = '') => {
    const sel = !!cur && sameTerm(cur.term, term);
    const b = h('button', { class: 'th' + cls + (sel ? ' sel' : ''), type: 'button', dataset: { term }, title: catLabel(term) }, catIconEl(term), h('span', null, nameOf(term)));
    paint(b, { term, seed: 0 });
    return b;
  };
  // A main category with subs is one box: its tile across the top, its subs
  // as smaller tiles below, joined by a line, so the family reads as one.
  const items = [];
  for (const c of cats) {
    if (catParent(c)) continue;
    const subs = cats.filter(x => { const p = catParent(x); return !!p && sameTerm(p.term, c.term); });
    if (!subs.length) { items.push(tile(c.term)); continue; }
    items.push(h('div', { class: 'pal-group', role: 'group', 'aria-label': catName(c) + ' and its sub-categories' },
      tile(c.term, ' main'),
      h('div', { class: 'pal-subs' }, subs.map(s => tile(s.term, ' sub')))));
  }
  palThemes.replaceChildren(
    h('button', { class: 'th th-none' + (!cur && (!palCur.color || palCur.color === 'default') ? ' sel' : ''), type: 'button', 'data-none': '', title: 'No category' }, h('span', null, 'None')),
    ...items);
}

pal.addEventListener('click', e => {
  if (!palPick) return;
  if (e.target.closest('[data-none]')) {
    palPick({ color: 'default', theme: null });
    return closePalette();
  }
  const th = e.target.closest('.th');
  if (th) {
    palPick({ theme: { term: th.dataset.term, seed: newThemeSeed() } });
    return closePalette();
  }
  if (e.target.closest('[data-manage]')) {
    closePalette();
    closeModal();
    setView('settings');
  }
});

// cur: the note (or editor draft); pick(patch) applies { color, theme } changes.
function openPalette(anchor, cur, pick) {
  palPick = pick;
  palCur = { color: cur.color, theme: cur.theme || null };
  // A new category goes under the note's category, else the category being
  // viewed (the main one of a sub), else it is a main category.
  const vc = viewCat(), nt = cur.theme && cur.theme.term;
  const base = nt && findCategory(nt) ? nt : vc !== null && findCategory(vc) ? vc : null;
  palParent.value = '';
  palParent.dataset.want = base ? mainTerm(base) : '';
  fillPalette();
  pal.hidden = false;
  const r = anchor.getBoundingClientRect(), pw = pal.offsetWidth, ph = pal.offsetHeight;
  const x = Math.min(Math.max(8, r.left - 8), innerWidth - pw - 8);
  let y = r.bottom + 6;
  if (y + ph > innerHeight - 8) y = Math.max(8, r.top - ph - 6);
  pal.style.left = x + 'px';
  pal.style.top = y + 'px';
  const sel = palThemes.querySelector('.th.sel');
  if (sel) sel.scrollIntoView({ block: 'center' });
  // Ready to type a new category. Not on touch screens: the keyboard would
  // cover the list when the user only wants to pick one.
  if (mqMouse.matches) palInput.focus({ preventScroll: true });
}
function closePalette() { pal.hidden = true; palPick = null; }

// ---------------------------------------------------------------- settings

// Built once and kept: a render triggered by sync must not wipe what is being typed.
const catInput = h('input', { class: 'cat-input', type: 'text', placeholder: 'New category, e.g. ocean, work, recipes', maxlength: '40', autocomplete: 'off', enterkeyhint: 'done', 'aria-label': 'New category' });
const catList = h('div', { class: 'cat-list' });
// Add form: where the new category goes. Options follow the main categories.
const catParentSel = h('select', { class: 'cat-parent', 'aria-label': 'Add as' });
function fillParentSelect(sel, mains, value) {
  const opts = [['', 'Main category'], ...mains.map(t => [t, 'Under ' + nameOf(t)])];
  const key = JSON.stringify(opts);
  if (sel.dataset.key !== key) {
    sel.replaceChildren(...opts.map(([v, l]) => h('option', { value: v }, l)));
    sel.dataset.key = key;
  }
  sel.value = mains.some(t => sameTerm(t, value)) ? mains.find(t => sameTerm(t, value)) : '';
}
// Phone layout: search bar above the bottom bar (default) or in the top bar. Per device.
const searchBottomBox = h('input', { type: 'checkbox', class: 'set-check' });
function applySearchPos() {
  const on = readLS(K.searchBottom, true) !== false;
  searchBottomBox.checked = on;
  document.documentElement.classList.toggle('search-bottom', on);
}
searchBottomBox.addEventListener('change', () => { writeLS(K.searchBottom, searchBottomBox.checked); applySearchPos(); });
applySearchPos();
// Note editor: Markdown (marks shown) or rich text. Same stored text.
const editModeSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Note editor' },
  [['rich', 'Rich text'], ['md', 'Markdown']].map(([value, label]) =>
    h('label', null, h('input', { type: 'radio', name: 'editMode', value, checked: value === editMode }), h('span', null, label))));
editModeSeg.addEventListener('change', e => {
  editMode = e.target.value === 'rich' ? 'rich' : 'md';
  writeLS(K.editMode, editMode);
  for (const ed of [composer, modalEd]) ed.fill();
  renderHintFmt();
});
// Sidebar shortcuts: a second tab lists the formatting keys for the editor
// in use (named after it); Markdown also shows the marks they type.
const HINT_FMT = [
  [['B'], 'Bold', '**bold**'], [['I'], 'Italic', '_italic_'], [['U'], 'Underline', '++underline++'],
  [['Shift', 'X'], 'Strikethrough', '~~strike~~'], [['Shift', '1'], 'Heading 1', '# '], [['Shift', '2'], 'Heading 2', '## '],
  [['Shift', '0'], 'Normal text', null],
];
function renderHintFmt() {
  const md = editMode === 'md';
  $('#hintTab-fmt').textContent = md ? 'Markdown' : 'Rich text';
  $('#hintFmt').replaceChildren(
    h('dl', null, HINT_FMT.flatMap(([keys, label, mark]) => [
      h('dt', null, h('kbd', null, 'Ctrl'), ...keys.flatMap(k => [' ', h('kbd', null, k)])),
      h('dd', null, label, md && mark ? [' ', h('code', { class: 'hint-mark' }, mark)] : null),
    ])),
    h('p', null, md ? 'Marks show in the note; cards show the formatting.' : 'Select text first, or format what you type next.'));
}
function showHintTab(id) {
  for (const b of document.querySelectorAll('.nav-hint-tabs [role=tab]')) b.setAttribute('aria-selected', String(b.dataset.hint === id));
  $('#hintKeys').hidden = id !== 'keys';
  $('#hintFmt').hidden = id !== 'fmt';
}
$('.nav-hint-tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-hint]');
  if (!b) return;
  writeLS(K.hintTab, b.dataset.hint);
  showHintTab(b.dataset.hint);
});
renderHintFmt();
showHintTab(readLS(K.hintTab, 'keys') === 'fmt' ? 'fmt' : 'keys');
// New notes start in the title or the body. Per device, default title.
let titleFirst = readLS(K.titleFirst, true) !== false;
const titleFirstBox = h('input', { type: 'checkbox', class: 'set-check' });
titleFirstBox.checked = titleFirst;
titleFirstBox.addEventListener('change', () => {
  titleFirst = titleFirstBox.checked;
  writeLS(K.titleFirst, titleFirst);
  composer.titleHint();
  modalEd.titleHint();
});
// What the sidebar categories show on the right: shortcut keys (boxed
// letters), note counts (plain numbers), both or nothing. Per device,
// default keys; the keys work either way and never show on touch screens.
// The first release stored a checkbox, mn.navKeys (false = nothing).
const NAV_SHOW = { keys: 'Shortcut keys', counts: 'Note counts', both: 'Both', none: 'Nothing' };
function navShow() {
  const v = readLS(K.navShow, null);
  return NAV_SHOW[v] ? v : readLS(K.navKeys, true) === false ? 'none' : 'keys';
}
const navShowSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Sidebar categories show' },
  Object.entries(NAV_SHOW).map(([value, label]) =>
    h('label', null, h('input', { type: 'radio', name: 'navShow', value }), h('span', null, label))));
function applyNavShow() {
  const v = navShow();
  for (const r of navShowSeg.querySelectorAll('input')) r.checked = r.value === v;
  document.documentElement.classList.toggle('nav-keys', v === 'keys' || v === 'both');
  document.documentElement.classList.toggle('nav-counts', v === 'counts' || v === 'both');
}
navShowSeg.addEventListener('change', e => { if (NAV_SHOW[e.target.value]) { writeLS(K.navShow, e.target.value); applyNavShow(); } });
applyNavShow();
// Empty categories (no notes outside Archive and Trash) are faded; this hides
// them. They show again while notes are dragged, so they can take a drop.
// Pinned notes in brackets after the note count, "5 (2)" (per device, default on).
const navPinsBox = h('input', { type: 'checkbox', class: 'set-check' });
function applyNavPins() { document.documentElement.classList.toggle('nav-pins-on', readLS(K.navPins, true) !== false); }
navPinsBox.checked = readLS(K.navPins, true) !== false;
navPinsBox.addEventListener('change', () => { writeLS(K.navPins, navPinsBox.checked); applyNavPins(); });
applyNavPins();
// Sidebar entries that can be switched off (per device; by default all on
// except the shortcuts list).
// Their views still work (e.g. a stored view, Alt+arrows skip nothing).
const NAV_PARTS = [['find', 'Find category field'], ['pinned', 'Pinned'], ['attachments', 'Attachments'], ['archive', 'Archive'], ['trash', 'Trash'], ['shortcuts', 'Shortcuts list']];
// Unset: only the shortcuts list is off.
function navHidden() { const v = readLS(K.navHide, ['shortcuts']); return new Set(Array.isArray(v) ? v : []); }
function applyNavHide() { const hid = navHidden(); for (const [id] of NAV_PARTS) document.documentElement.classList.toggle('no-nav-' + id, hid.has(id)); }
applyNavHide();
const navPartsEl = h('div', { class: 'set-checks' }, NAV_PARTS.map(([id, label]) => {
  const box = h('input', { type: 'checkbox', class: 'set-check', dataset: { part: id } });
  box.checked = !navHidden().has(id);
  box.addEventListener('change', () => {
    const hid = navHidden();
    if (box.checked) hid.delete(id); else hid.add(id);
    writeLS(K.navHide, [...hid]);
    applyNavHide();
  });
  return h('label', { class: 'set-check-row' }, box, h('span', null, label));
}));
const hideEmptyBox = h('input', { type: 'checkbox', class: 'set-check' });
function applyHideEmpty() { document.documentElement.classList.toggle('hide-empty', readLS(K.hideEmpty, true) !== false); }
hideEmptyBox.checked = readLS(K.hideEmpty, true) !== false;
hideEmptyBox.addEventListener('change', () => { writeLS(K.hideEmpty, hideEmptyBox.checked); applyHideEmpty(); });
applyHideEmpty();
// Text size of the sidebar entries and the note cards, 70–120 %, per device.
// Applied while the slider moves; cards change height, so the grid is relaid.
const TEXT_SIZE = { min: 70, max: 120, def: 100 };
const textPct = () => { const v = Math.round(Number(readLS(K.textSize, TEXT_SIZE.def))); return v >= TEXT_SIZE.min && v <= TEXT_SIZE.max ? v : TEXT_SIZE.def; };
const textSizeIn = h('input', { type: 'range', class: 'zoom-input', min: String(TEXT_SIZE.min), max: String(TEXT_SIZE.max), step: '5', 'aria-label': 'Text size of sidebar and notes' });
const textSizeVal = h('span', { class: 'set-val' });
let textFrame = 0;
function applyTextSize(pct, relayout) {
  document.documentElement.style.setProperty('--ts', String(pct / 100));
  textSizeVal.textContent = pct + ' %';
  if (relayout && !textFrame) textFrame = requestAnimationFrame(() => { textFrame = 0; layout(); });
}
textSizeIn.value = String(textPct());
applyTextSize(textPct(), false);
textSizeIn.addEventListener('input', () => { const v = Number(textSizeIn.value); applyTextSize(v, true); writeLS(K.textSize, v); });
// Sidebar spacing: the height of each entry, 60–120 %, per device, live.
const NAV_SPACE = { min: 60, max: 120, def: 60 };
const spacePct = () => { const v = Math.round(Number(readLS(K.navSpace, NAV_SPACE.def))); return v >= NAV_SPACE.min && v <= NAV_SPACE.max ? v : NAV_SPACE.def; };
const navSpaceIn = h('input', { type: 'range', class: 'zoom-input', min: String(NAV_SPACE.min), max: String(NAV_SPACE.max), step: '5', 'aria-label': 'Spacing of sidebar entries' });
const navSpaceVal = h('span', { class: 'set-val' });
function applyNavSpace(pct) {
  document.documentElement.style.setProperty('--sp', String(pct / 100));
  navSpaceVal.textContent = pct + ' %';
}
navSpaceIn.value = String(spacePct());
applyNavSpace(spacePct());
navSpaceIn.addEventListener('input', () => { const v = Number(navSpaceIn.value); applyNavSpace(v); writeLS(K.navSpace, v); });
// Alt+Up/Down switches categories (setting, per device, default on).
let altNav = readLS(K.altNav, true) !== false;
function applyAltNav() { document.documentElement.classList.toggle('no-alt-nav', !altNav); }
applyAltNav();
const altNavBox = h('input', { type: 'checkbox', class: 'set-check' });
altNavBox.checked = altNav;
altNavBox.addEventListener('change', () => { altNav = altNavBox.checked; writeLS(K.altNav, altNav); applyAltNav(); });
function stepCategory(dir) {
  const hide = document.documentElement.classList.contains('hide-empty'), cur = viewCat();
  const seq = ['notes', ...(navHidden().has('pinned') ? [] : ['pinned']), ...orderedCats()
    .filter(c => !hide || navCounts.get(c.term.toLowerCase()) || (cur !== null && sameTerm(cur, c.term)))
    .map(c => 'cat:' + c.term)];
  const i = Math.max(0, cur !== null ? seq.findIndex(v => v.startsWith('cat:') && sameTerm(v.slice(4), cur)) : seq.indexOf(view));
  const next = seq[i + dir];
  if (next && next !== view) setView(next);
}
const catChipBox = h('input', { type: 'checkbox', class: 'set-check' });
catChipBox.checked = readLS(K.catChip, true) !== false;
catChipBox.addEventListener('change', () => { catChip = catChipBox.checked; writeLS(K.catChip, catChip); updateSearchChip(viewCat()); });

// Notifications (toasts): on/off, position and duration. Per device, like the
// search bar. Off hides the toast, but Ctrl/Cmd+Z still undoes for its duration.
const TOAST_POS = { tl: 'Top left', tr: 'Top right', c: 'Center', bl: 'Bottom left', br: 'Bottom right' };
function toastPrefs() {
  const p = readLS(K.toast, null) || {};
  const secs = Math.round(Number(p.secs));
  return {
    on: p.on !== false,
    pos: TOAST_POS[p.pos] ? p.pos : 'br',
    secs: secs >= 2 && secs <= 20 ? secs : 6,
  };
}
const toastOnBox = h('input', { type: 'checkbox', class: 'set-check' });
const toastPosSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Notification position' },
  h('span', { class: 'seg-label' }, 'Position'),
  Object.entries(TOAST_POS).map(([value, label]) =>
    h('label', null, h('input', { type: 'radio', name: 'toastPos', value }), h('span', null, label))));
const toastSecs = h('input', { type: 'range', class: 'zoom-input', min: '2', max: '20', step: '1', 'aria-label': 'Notification duration' });
const toastSecsVal = h('span', { class: 'set-val' });
function applyToastPrefs() {
  const p = toastPrefs();
  toastOnBox.checked = p.on;
  for (const r of toastPosSeg.querySelectorAll('input')) r.checked = r.value === p.pos;
  toastSecs.value = p.secs;
  toastSecsVal.textContent = p.secs + ' s';
  toastPosSeg.classList.toggle('off', !p.on);
  toastSecs.disabled = !p.on;
  document.documentElement.dataset.toastPos = p.pos;
}
function saveToastPrefs(preview) {
  const pos = toastPosSeg.querySelector('input:checked');
  writeLS(K.toast, { on: toastOnBox.checked, pos: pos ? pos.value : 'br', secs: Number(toastSecs.value) });
  applyToastPrefs();
  if (preview && toastOnBox.checked) toast('Notifications show here');
}
toastOnBox.addEventListener('change', () => saveToastPrefs(true));
toastPosSeg.addEventListener('change', () => saveToastPrefs(true));
toastSecs.addEventListener('input', () => { toastSecsVal.textContent = toastSecs.value + ' s'; });
toastSecs.addEventListener('change', () => saveToastPrefs(true));
applyToastPrefs();

// ---------------------------------------------------------------- import view

// Google Keep import (import.js). Built once, like Settings, so a sync
// render never wipes the progress.
const keepDir = h('input', { type: 'file', multiple: true, hidden: true });
keepDir.webkitdirectory = true;
const keepFiles = h('input', { type: 'file', multiple: true, accept: '.json,image/*', hidden: true });
const importStatus = h('p', { class: 'import-status', role: 'status' });
const importBar = h('progress', { class: 'import-bar', max: 1, value: 0, hidden: true });
let importing = false;
const importEl = h('div', { class: 'import' },
  h('h2', null, 'Import from Google Keep'),
  h('ol', { class: 'import-steps' },
    h('li', null, 'Go to takeout.google.com, select only Keep, and download the export.'),
    h('li', null, 'Unzip it. The notes are in Takeout/Keep: a .json and an .html file per note, plus the images.'),
    h('li', null, 'Choose that Keep folder below. On a phone, choose the files instead: select all of them.')),
  h('p', { class: 'settings-hint' }, `Imported notes go to the "${IMPORT_TERM}" category and keep their title, text, lists, images, colour, pin, archive state and dates. Labels become #tags in the text. Notes already imported are skipped, so importing again is safe.`),
  h('div', { class: 'import-btns' },
    h('button', { class: 'text-btn primary', type: 'button', 'data-imp': 'dir' }, icon('import'), 'Choose Keep folder'),
    h('button', { class: 'text-btn', type: 'button', 'data-imp': 'files' }, 'Choose files')),
  keepDir, keepFiles, importBar, importStatus);

function renderImport() {
  for (const b of importEl.querySelectorAll('[data-imp]')) b.disabled = importing;
}

importEl.addEventListener('click', e => {
  const b = e.target.closest('[data-imp]');
  if (!b || importing) return;
  (b.dataset.imp === 'dir' ? keepDir : keepFiles).click(); // synchronously in the tap (iOS)
});

async function runImport(input) {
  const list = Array.from(input.files || []);
  input.value = '';
  if (!list.length || importing) return;
  if (!list.some(f => /\.json$/i.test(f.name))) {
    importStatus.textContent = 'No Keep notes found: pick the Keep folder or its .json files.';
    return;
  }
  importing = true;
  renderImport();
  importBar.hidden = false;
  try {
    const r = await importKeep(list, ({ done, total, phase }) => {
      importBar.max = Math.max(total, 1);
      importBar.value = done;
      importStatus.textContent = `${phase}… ${done} / ${total}`;
    });
    const parts = [`Imported ${r.notes} note${r.notes === 1 ? '' : 's'}`];
    if (r.images) parts.push(`${r.images} image${r.images === 1 ? '' : 's'}`);
    if (r.dupes) parts.push(`${r.dupes} already imported`);
    if (r.skipped) parts.push(`${r.skipped} empty or unreadable skipped`);
    if (r.failedImages) parts.push(`${r.failedImages} image${r.failedImages === 1 ? '' : 's'} failed`);
    importStatus.textContent = parts.join(' · ') + '.';
    if (r.ids.length) {
      const ids = r.ids;
      toast(`Imported ${ids.length} notes`, () => { for (const id of ids) removeNote(id); importStatus.textContent = 'Import undone.'; });
    }
  } catch (err) {
    importStatus.textContent = 'Import stopped: ' + (err && err.message || err);
  } finally {
    importing = false;
    importBar.hidden = true;
    render();
  }
}
keepDir.addEventListener('change', () => runImport(keepDir));
keepFiles.addEventListener('change', () => runImport(keepFiles));

// Category look switches (synced, Settings › Categories).
const catPatternsBox = h('input', { type: 'checkbox', class: 'set-check' });
const catIconsBox = h('input', { type: 'checkbox', class: 'set-check' });
const catTagMainBox = h('input', { type: 'checkbox', class: 'set-check' });
catTagMainBox.addEventListener('change', () => { setSettings({ catTagMain: catTagMainBox.checked }); render(); });
catPatternsBox.addEventListener('change', () => { setSettings({ catPatterns: catPatternsBox.checked }); render(); });
catIconsBox.addEventListener('change', () => { setSettings({ catIcons: catIconsBox.checked }); navCatsKey = ''; render(); });

// Category order: A–Z, created or custom (up/down buttons on each row).
// Switching to custom starts from the order currently shown.
const catOrderSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Category order' },
  h('span', { class: 'seg-label' }, 'Order'),
  Object.entries(CAT_ORDERS).map(([value, label]) =>
    h('label', null, h('input', { type: 'radio', name: 'catOrder', value }), h('span', null, label))));
catOrderSeg.addEventListener('change', e => {
  const v = e.target.value;
  if (!CAT_ORDERS[v] || v === catOrder()) return;
  const s = notes.get(SETTINGS_ID);
  const patch = { catOrder: v };
  if (v === 'custom' && !(s && Array.isArray(s.catCustom) && s.catCustom.length)) patch.catCustom = orderedCats().map(c => c.term);
  setSettings(patch);
  render();
});

// Settings tabs: one group at a time, the last one remembered per device.
const SET_TABS = [['general', 'General'], ['categories', 'Categories'], ['icons', 'Icons'], ['import', 'Import']];
let setTab = SET_TABS.some(t => t[0] === readLS(K.setTab, '')) ? readLS(K.setTab, '') : 'general';
const setTabBar = h('div', { class: 'set-tabs', role: 'tablist', 'aria-label': 'Settings' },
  ...SET_TABS.map(([id, label]) => h('button', { class: 'set-tab', type: 'button', role: 'tab', id: 'setTab-' + id, 'aria-controls': 'setPane-' + id, dataset: { tab: id } }, label)));
function showSetTab(id, focus) {
  setTab = id;
  writeLS(K.setTab, id);
  for (const b of setTabBar.children) {
    const on = b.dataset.tab === id;
    b.setAttribute('aria-selected', on);
    b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  }
  for (const p of settingsEl.querySelectorAll('.set-pane')) p.hidden = p.dataset.tab !== id;
}
setTabBar.addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) showSetTab(b.dataset.tab); });
setTabBar.addEventListener('keydown', e => {
  const i = SET_TABS.findIndex(t => t[0] === setTab);
  const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
  if (!d) return;
  e.preventDefault();
  showSetTab(SET_TABS[(i + d + SET_TABS.length) % SET_TABS.length][0], true);
});
const setPane = (id, ...kids) => h('div', { class: 'set-pane', role: 'tabpanel', id: 'setPane-' + id, 'aria-labelledby': 'setTab-' + id, dataset: { tab: id } }, ...kids);

// Settings › Icons: every category with its icon and why, and every icon
// with its built-in words, the owner's words and the categories using it.
const icoCatList = h('div', { class: 'ico-cats' });
const icoGrid = h('div', { class: 'ico-grid' });
const icoFind = h('input', { type: 'search', placeholder: 'Find icon or word', 'aria-label': 'Find icon or word', autocomplete: 'off' });
icoFind.addEventListener('input', () => renderIcons(true));
// The built-in hints as plain words: /\bpets?\b|wi-?fi/ -> pet, wifi.
// Groups keep their first choice (bak(e|ing) -> bake), an optional "s" goes,
// an optional space or dash stays (home ?lab -> home lab).
const hintWords = id => CAT_ICON_HINTS.filter(([, i]) => i === id)
  .flatMap(([re]) => re.source.replace(/\(([^)|]*)\|[^)]*\)/g, '$1').split('|'))
  .map(w => w.replace(/\\b/g, '').replace(/s\?/g, '').replace(/\?/g, '').replace(/\\(.)/g, '$1').trim()).filter(Boolean);
function iconPicker(term) {
  const c = findCategory(term), why = iconWhy(term);
  const sel = h('select', { class: 'ico-sel', dataset: { icoTerm: c.term }, 'aria-label': 'Icon of ' + catLabel(c.term) },
    h('option', { value: '' }, 'Auto' + (c.icon && CAT_ICONS[c.icon] ? '' : ' (' + CAT_ICONS[why.id][0] + ')')),
    ...Object.entries(CAT_ICONS).map(([id, [label]]) => h('option', { value: id }, label)));
  sel.value = c.icon && CAT_ICONS[c.icon] ? c.icon : '';
  return sel;
}
function renderIcons(gridOnly) {
  const a = document.activeElement;
  if (a && settingsEl.contains(a) && a.matches('.ico-words input')) return; // don't wipe words being typed
  if (!gridOnly) {
    const cats = orderedCats();
    icoCatList.replaceChildren(...cats.map(c => {
      const why = iconWhy(c.term), sub = !!catParent(c);
      const how = { picked: 'Picked', word: 'Your word \u201c' + why.word + '\u201d', hint: 'From the name', none: 'No match' }[why.how];
      const row = h('div', { class: 'ico-cat' + (sub ? ' sub' : '') + (why.how === 'none' ? ' is-none' : '') },
        catMark(h('span', { class: 'ico-mark' }), c.term), h('span', { class: 'ico-name' }, catName(c)), h('span', { class: 'ico-how' }, how), iconPicker(c.term));
      return row;
    }));
    if (!cats.length) icoCatList.append(h('p', { class: 'settings-hint' }, 'No categories yet.'));
  }
  const q = icoFind.value.trim().toLowerCase(), mine = settingsRec().iconWords || {}, cats = categories();
  icoGrid.replaceChildren(...Object.entries(CAT_ICONS).flatMap(([id, [label]]) => {
    const words = hintWords(id), own = typeof mine[id] === 'string' ? mine[id] : '';
    if (q && ![label, id, own, ...words].some(w => w.toLowerCase().includes(q))) return [];
    const users = cats.filter(c => iconOf(c.term) === id);
    const svg = icon('x'); svg.setAttribute('class', 'ic'); svg.firstChild.setAttribute('href', '#ci-' + id);
    return [h('div', { class: 'ico-card' },
      h('div', { class: 'ico-head' }, svg, h('b', null, label), h('code', null, id)),
      h('div', { class: 'ico-words-built' }, words.length ? 'Built in: ' + words.join(', ') : 'No built-in words'),
      h('label', { class: 'ico-words' }, h('span', null, 'Your words'),
        h('input', { type: 'text', value: own, placeholder: 'e.g. mia, eating out', dataset: { icoWords: id }, autocomplete: 'off', spellcheck: 'false' })),
      users.length ? h('div', { class: 'ico-users' }, 'Used by ' + users.map(c => catName(c)).join(', ')) : null)];
  }));
  if (!icoGrid.firstChild) icoGrid.append(h('p', { class: 'settings-hint' }, 'No icon matches.'));
}
// Your words: saved on change (blur or Enter). A word belongs to one icon;
// adding it here removes it from any other.
function setIconWords(id, str) {
  const words = splitWords(str), cur = { ...(settingsRec().iconWords || {}) };
  for (const k of Object.keys(cur)) if (k !== id) { const rest = splitWords(cur[k]).filter(w => !words.includes(w)); if (rest.length) cur[k] = rest.join(', '); else delete cur[k]; }
  if (words.length) cur[id] = words.join(', '); else delete cur[id];
  setSettings({ iconWords: cur });
  navCatsKey = '';
}
icoGrid.addEventListener('change', e => {
  const i = e.target.closest('[data-ico-words]');
  if (!i) return;
  setIconWords(i.dataset.icoWords, i.value);
  i.blur();
  render();
});
icoGrid.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('[data-ico-words]')) e.target.blur(); });
icoCatList.addEventListener('change', e => {
  const s = e.target.closest('[data-ico-term]');
  if (!s) return;
  patchCategory(s.dataset.icoTerm, { icon: s.value || undefined });
  navCatsKey = '';
  render();
});

const settingsEl = h('section', { class: 'settings' }, setTabBar,
  setPane('general',
  h('p', { class: 'settings-hint set-note' }, 'Everything on this tab is saved on this device only.'),
  h('h2', null, 'Notes and search'),
  h('label', { class: 'set-row' }, titleFirstBox,
    h('span', null, h('b', null, 'Start new notes with the title'), h('span', { class: 'settings-hint' }, 'Typing in a new note goes to the title first; Enter moves on to the note. Off: straight into the note.'))),
  h('div', { class: 'set-block' },
    h('b', null, 'Note editor'),
    h('span', { class: 'settings-hint' }, 'Formatting: Ctrl+B bold, Ctrl+I italic, Ctrl+U underline, Ctrl+Shift+X strikethrough, Ctrl+Shift+1 or 2 heading, Ctrl+Shift+0 normal text (\u2318 on a Mac); buttons on phones. Markdown shows the marks, like **bold**; rich text shows bold as bold. Both keep the same notes.'),
    editModeSeg),
  h('label', { class: 'set-row' }, catChipBox,
    h('span', null, h('b', null, 'Show the category in the search box'), h('span', { class: 'settings-hint' }, 'In a category, the search box shows it and searches only its notes; its × searches all notes.'))),
  h('label', { class: 'set-row' }, searchBottomBox,
    h('span', null, h('b', null, 'Search bar at the bottom on phones'), h('span', { class: 'settings-hint' }, 'Easier to reach with a thumb.'))),
  h('h2', null, 'Sidebar'),
  h('div', { class: 'set-block' },
    h('b', null, 'Show in the sidebar'),
    h('span', { class: 'settings-hint' }, 'Notes and the categories are always there. Hiding an entry keeps its notes (the shortcuts still work without their list): archiving and deleting still work, and the notes come back when you show it again.'),
    navPartsEl),
  h('div', { class: 'set-block' },
    h('b', null, 'Next to each category'),
    h('span', { class: 'settings-hint' }, 'Shortcut keys are boxed letters like ', h('kbd', { class: 'nav-key nav-key-demo' }, 'T'), ': press 1–9 and 0 for the first ten main categories, then the letter shown. They work either way and don\u2019t show on touch screens. Note counts are plain numbers like ', h('span', { class: 'nav-count nav-count-demo' }, '12'), ': notes outside Archive and Trash, a main category\u2019s including its sub-categories.'),
    navShowSeg),
  h('label', { class: 'set-row' }, navPinsBox,
    h('span', null, h('b', null, 'Show pinned notes with the note counts'), h('span', { class: 'settings-hint' }, 'Like 5 (2): five notes, two of them pinned. Shown when note counts are on.'))),
  h('label', { class: 'set-row' }, hideEmptyBox,
    h('span', null, h('b', null, 'Hide empty categories'), h('span', { class: 'settings-hint' }, 'Categories with no notes outside Archive and Trash. When shown, they are faded. They appear while you drag notes or find a category.'))),
  h('h2', null, 'Size'),
  h('div', { class: 'set-block set-block-flush' },
    h('span', { class: 'settings-hint' }, 'Text: the sidebar and note cards. Spacing: the height of each sidebar entry, so more categories fit.'),
    h('label', { class: 'set-range' }, h('span', { class: 'seg-label' }, 'Text'), textSizeIn, textSizeVal),
    h('label', { class: 'set-range' }, h('span', { class: 'seg-label' }, 'Spacing'), navSpaceIn, navSpaceVal)),
  h('h2', null, 'Keyboard'),
  h('label', { class: 'set-row' }, altNavBox,
    h('span', null, h('b', null, 'Switch categories with Alt+\u2191 / Alt+\u2193'), h('span', { class: 'settings-hint' }, 'Steps through Notes, Pinned and the categories, sub-categories included, in sidebar order. All shortcuts are listed at the bottom of the sidebar.'))),
  h('h2', null, 'Notifications'),
  h('label', { class: 'set-row' }, toastOnBox,
    h('span', null, h('b', null, 'Show notifications'), h('span', { class: 'settings-hint' }, 'Messages like "Note archived" with Undo. When off, Ctrl/⌘+Z still undoes.'))),
  h('div', { class: 'set-toast' }, toastPosSeg,
    h('label', { class: 'set-range' }, h('span', { class: 'seg-label' }, 'Show for'), toastSecs, toastSecsVal))),
  setPane('categories',
  h('h2', null, 'Categories'),
  h('p', { class: 'settings-hint' }, 'Each main category has its own colour; its sub-categories share it and are told apart by their icon and name. Give a note a category from its palette button. Open a category below to change its colour, icon or place.'),
  h('p', { class: 'settings-hint' }, 'A sub-category sits inside a main one: add it with + on the main category, pick "Under …" here, or type main/sub (travel/lisbon). Opening the main category shows its sub-categories\u2019 notes too.'),
  h('label', { class: 'set-row' }, catIconsBox,
    h('span', null, h('b', null, 'Icons'), h('span', { class: 'settings-hint' }, 'An icon per category in the sidebar, on cards and in the category picker, guessed from the name unless you pick one. Off: a coloured dot.'))),
  h('label', { class: 'set-row' }, catTagMainBox,
    h('span', null, h('b', null, 'Show the main category on cards'), h('span', { class: 'settings-hint' }, 'A sub-category\u2019s tag reads \u201cAI \u203a LLMs\u201d instead of \u201cLLMs\u201d. Left out where the view or the group already names the main category.'))),
  h('label', { class: 'set-row' }, catPatternsBox,
    h('span', null, h('b', null, 'Background patterns'), h('span', { class: 'settings-hint' }, 'Draw a pattern made from the category\u2019s name behind its notes, in its colour. Off: plain tinted cards.'))),
  h('form', { class: 'cat-add' }, catInput, catParentSel, h('button', { class: 'text-btn', type: 'submit' }, 'Add')),
  catOrderSeg,
  catList),
  setPane('icons',
    h('h2', null, 'Icons'),
    h('p', { class: 'settings-hint' }, 'A category gets the icon you pick for it, else the first icon whose words appear in its name: your words first, then the built-in ones. No match: the plain tag. Your words sync to every device and are a good place for names, e.g. people.'),
    h('h3', { class: 'set-h3' }, 'Categories'),
    icoCatList,
    h('h3', { class: 'set-h3' }, 'Available icons'),
    h('div', { class: 'nav-find ico-find' }, icon('search'), icoFind),
    icoGrid),
  setPane('import', importEl));
showSetTab(setTab);

// Fine-tune sliders per main category, on top of its palette colour.
const TUNE_SLIDERS = [
  // key, label, min, max, step, stored -> slider, slider -> stored, value text
  ['h', 'Hue', -60, 60, 2, t => t.h, x => x, x => (x > 0 ? '+' : '') + x + '°'],
  ['s', 'Saturation', 0, 200, 10, t => Math.round(t.s * 100), x => x / 100, x => x + '%'],
  ['v', 'Brightness', -100, 100, 10, t => Math.round(t.v * 100), x => x / 100, x => (x > 0 ? '+' : '') + x],
  ['c', 'Intensity', 0, 100, 5, t => Math.round(t.c * 100), x => x / 100, x => x + '%'],
];
let openCat = null;   // term whose panel is shown
let tuneOpen = false; // its Fine-tune section is open
let catDrag = false;  // a slider is being dragged: don't rebuild the list under it

function tuneTrack(key, hue) {
  if (key === 'h') return `linear-gradient(90deg, hsl(${hue - 60} 65% 60%), hsl(${hue} 65% 60%), hsl(${hue + 60} 65% 60%))`;
  if (key === 's') return `linear-gradient(90deg, hsl(${hue} 0% 60%), hsl(${hue} 100% 55%))`;
  if (key === 'c') return `linear-gradient(90deg, hsl(${hue} 40% 92%), hsl(${hue} 70% 55%))`;
  return `linear-gradient(90deg, hsl(${hue} 45% 25%), hsl(${hue} 60% 90%))`;
}

// Preview: a little card in the category's look, with its icon.
function catTile(term, tune) {
  const t = h('div', { class: 'cat-tile' }, catIconEl(term));
  applyTheme(t, catLook(term, tune));
  return t;
}

// i, all: position among its siblings (main categories, or one main's subs).
function catRow(cat, i, all, mains) {
  const { term } = cat, open = openCat !== null && sameTerm(openCat, term);
  const parent = catParent(cat), subs = parent ? [] : subsOf(term);
  const tiles = [catTile(term)];
  // Live notes, as in the sidebar: a main category counts its subs too.
  const cnt = t => navCounts.get(t.toLowerCase()) || 0, n = cnt(term);
  const subN = subs.reduce((a, s) => a + cnt(s.term), 0);
  const meta = [`${n} note${n === 1 ? '' : 's'}`];
  if (subs.length) meta.push(`${subs.length} sub`);
  const metaTitle = (subs.length ? `${n} notes: ${n - subN} in ${catName(cat)}, ${subN} in its sub-categories` : `${n} note${n === 1 ? '' : 's'}`)
    + ' (not counting Archive and Trash)';
  const row = h('div', { class: 'cat' + (open ? ' open' : '') + (parent ? ' cat-sub' : ''), dataset: { term } },
    h('div', { class: 'cat-head' },
      h('span', { class: 'cat-grip', 'aria-hidden': 'true', title: 'Drag to reorder, or onto a main category to move it there' }, icon('grip')),
      h('button', { class: 'cat-toggle', type: 'button', 'data-toggle': '', 'aria-expanded': String(open), title: 'Colour, icon and place' },
        h('div', { class: 'cat-prev' }, tiles),
        h('span', { class: 'cat-term' }, catName(cat), h('span', { class: 'cat-n', title: metaTitle }, ' · ' + meta.join(' · '))),
        icon('palette')),
      h('button', { class: 'icon-btn', type: 'button', 'data-rename': '', 'aria-label': 'Rename ' + term, title: 'Rename' }, icon('pencil')),
      parent ? null : h('button', { class: 'icon-btn', type: 'button', 'data-addsub': '', 'aria-label': 'Add a sub-category to ' + term, title: 'Add sub-category' }, icon('plus')),
      catOrder() === 'custom' ? [
        h('button', { class: 'icon-btn', type: 'button', 'data-move': '-1', disabled: i === 0, 'aria-label': 'Move ' + term + ' up', title: 'Move up' }, icon('chev-up')),
        h('button', { class: 'icon-btn', type: 'button', 'data-move': '1', disabled: i === all.length - 1, 'aria-label': 'Move ' + term + ' down', title: 'Move down' }, icon('chev'))] : null,
      h('button', { class: 'icon-btn', type: 'button', 'data-rm': '', 'aria-label': 'Remove ' + term, title: 'Remove' }, icon('x'))));
  // Renaming: the name becomes a field. Enter or ✓ saves, Esc or × cancels.
  if (renamingCat !== null && sameTerm(renamingCat, term)) {
    const input = h('input', { class: 'cat-input cat-rename-input', type: 'text', value: catName(cat), maxlength: '40', autocomplete: 'off', enterkeyhint: 'done', 'aria-label': 'New name for ' + catName(cat), 'data-rename-input': '' });
    row.firstChild.replaceWith(h('form', { class: 'cat-head cat-rename' },
      h('div', { class: 'cat-prev' }, tiles),
      input,
      h('button', { class: 'icon-btn', type: 'submit', 'aria-label': 'Save name', title: 'Save (Enter)' }, icon('tick')),
      h('button', { class: 'icon-btn', type: 'button', 'data-rename-cancel': '', 'aria-label': 'Cancel rename', title: 'Cancel (Esc)' }, icon('x'))));
  }
  if (open) {
    let where;
    if (subs.length) where = h('p', { class: 'settings-hint cat-where' }, 'Main category with sub-categories.');
    else {
      const sel = h('select', { class: 'cat-parent', 'data-parent': '', 'aria-label': 'Place of ' + term });
      fillParentSelect(sel, mains.filter(t => !sameTerm(t, term)), parent ? parent.term : '');
      where = h('label', { class: 'cat-slider cat-where' }, h('span', null, 'Place'), sel);
    }
    const panel = [];
    if (parent) panel.push(h('p', { class: 'settings-hint' }, `Colour: from ${catName(parent)}.`));
    else {
      const cur = swatchOf(cat), tune = cleanTune(cat.tune), look = catLook(term);
      panel.push(h('div', { class: 'cat-field' }, h('span', null, 'Colour'),
        h('div', { class: 'cat-swatches', role: 'radiogroup', 'aria-label': 'Colour of ' + catName(cat) },
          CAT_PALETTE.map(([id, label, hh, ss]) => h('button', {
            class: 'cat-swatch', type: 'button', role: 'radio', 'aria-checked': String(id === cur), 'aria-label': label, title: label,
            'data-swatch': id, style: `--sw: hsl(${hh} ${ss}% 58%)`,
          })))));
      const fine = h('details', { class: 'cat-tune', open: tuneOpen },
        h('summary', null, 'Fine-tune colour'),
        TUNE_SLIDERS.map(([key, label, min, max, step, toSlider, , text]) => {
          const val = toSlider(tune);
          const input = h('input', { type: 'range', min, max, step, value: val, 'data-k': key, 'aria-label': label + ' ' + term });
          input.style.setProperty('--track', tuneTrack(key, look.hue));
          return h('label', { class: 'cat-slider' }, h('span', null, label), input, h('output', null, text(val)));
        }),
        h('button', { class: 'text-btn', type: 'button', 'data-reset': '', disabled: Object.keys(NO_TUNE).every(k => tune[k] === NO_TUNE[k]) }, 'Reset'));
      panel.push(fine);
    }
    const curIcon = CAT_ICONS[cat.icon] ? cat.icon : '';
    panel.push(h('div', { class: 'cat-field' }, h('span', null, 'Icon'),
      h('div', { class: 'cat-icon-grid', role: 'radiogroup', 'aria-label': 'Icon of ' + catName(cat) },
        h('button', { class: 'cat-icon-btn cat-icon-auto', type: 'button', role: 'radio', 'aria-checked': String(!curIcon), 'data-icon': '', title: 'Guess from the name' },
          catIconEl(term, guessIcon(catName(cat))), h('span', null, 'Auto')),
        Object.entries(CAT_ICONS).map(([id, [label]]) => h('button', {
          class: 'cat-icon-btn', type: 'button', role: 'radio', 'aria-checked': String(id === curIcon), 'aria-label': label, title: label, 'data-icon': id,
        }, catIconEl(term, id))))));
    panel.push(where);
    row.append(h('div', { class: 'cat-adj' }, panel));
  }
  return row;
}

function renderSettings() {
  if (board.firstChild !== settingsEl || board.childNodes.length !== 1) board.replaceChildren(settingsEl);
  renderImport();
  for (const r of catOrderSeg.querySelectorAll('input')) r.checked = r.value === catOrder();
  catPatternsBox.checked = catPatterns();
  catIconsBox.checked = catIcons();
  catTagMainBox.checked = catTagMain();
  renderIcons();
  if (catDrag) return;
  if (document.activeElement && document.activeElement.matches('[data-rename-input]') && catList.contains(document.activeElement)) return; // don't wipe a name being typed
  const cats = orderedCats(), mains = cats.filter(c => !catParent(c)).map(c => c.term);
  if (document.activeElement !== catParentSel) fillParentSelect(catParentSel, mains, catParentSel.value);
  catList.replaceChildren(...cats.map(c => {
    const p = catParent(c);
    const sibs = cats.filter(x => { const q = catParent(x); return p ? !!q && sameTerm(q.term, p.term) : !q; });
    return catRow(c, sibs.indexOf(c), sibs, mains);
  }));
  if (!cats.length) catList.append(h('p', { class: 'settings-hint' }, 'No categories yet.'));
}

// The fine-tune currently shown by a row's sliders.
function rowTune(row) {
  const t = {};
  for (const [key, , , , , , fromSlider] of TUNE_SLIDERS) t[key] = fromSlider(Number($(`input[data-k=${key}]`, row).value));
  return t;
}
// Change one field of a category (colour, tune, icon). One Undo per change
// would flood the toasts; the old value is a click away.
function patchCategory(term, patch) {
  setCategories(categories().map(c => {
    if (!sameTerm(c.term, term)) return c;
    const out = { ...c, ...patch };
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete out[k];
    return out;
  }));
}

let renamingCat = null; // term whose name is being edited in Settings
function endRename(save) {
  const field = catList.querySelector('[data-rename-input]');
  const from = renamingCat, to = save && field ? field.value : null;
  renamingCat = null;
  if (field) field.blur(); // renderSettings() leaves the list alone while the field has focus
  const done = to !== null ? renameCategory(from, to) : null;
  render();
  // Keep keyboard focus on the row's pencil.
  const again = [...catList.querySelectorAll('.cat')].find(r => sameTerm(r.dataset.term, done || from || ''));
  if (again) $('[data-rename]', again)?.focus();
}
settingsEl.addEventListener('submit', e => {
  e.preventDefault();
  if (e.target.closest('.cat-rename')) return endRename(true);
  const term = addCategory(catInput.value, catParentSel.value);
  if (!term) return;
  openCat = term; // new category opens with its sliders
  catInput.value = '';
  render();
});

settingsEl.addEventListener('click', e => {
  const row = e.target.closest('.cat');
  if (!row) return;
  const term = row.dataset.term;
  // Custom order: swap with the neighbour and keep focus on the same button.
  // Siblings only: main categories among themselves (their subs follow), or
  // subs inside their main one. orderedCats() regroups the swapped list.
  const mv = e.target.closest('[data-move]');
  if (mv) {
    const cats = orderedCats(), me = cats.find(c => sameTerm(c.term, term)), p = catParent(me);
    const sibs = cats.filter(x => { const q = catParent(x); return p ? !!q && sameTerm(q.term, p.term) : !q; });
    const si = sibs.indexOf(me), sj = si + Number(mv.dataset.move);
    if (si < 0 || sj < 0 || sj >= sibs.length) return;
    const terms = cats.map(c => c.term), i = cats.indexOf(me), j = cats.indexOf(sibs[sj]);
    [terms[i], terms[j]] = [terms[j], terms[i]];
    setSettings({ catCustom: terms });
    render();
    const again = [...catList.querySelectorAll('.cat')].find(r => sameTerm(r.dataset.term, term));
    const btn = again && $(`[data-move="${mv.dataset.move}"]`, again);
    if (btn) (btn.disabled ? $('[data-move]:not([disabled])', again) : btn)?.focus();
    return;
  }
  if (e.target.closest('[data-toggle]')) {
    openCat = openCat !== null && sameTerm(openCat, term) ? null : term;
    tuneOpen = false;
    return render();
  }
  if (e.target.closest('[data-rename]')) {
    renamingCat = term;
    render();
    const field = catList.querySelector('[data-rename-input]');
    if (field) { field.focus(); field.select(); }
    return;
  }
  if (e.target.closest('[data-rename-cancel]')) return endRename(false);
  if (e.target.closest('[data-addsub]')) {
    fillParentSelect(catParentSel, orderedCats().filter(c => !catParent(c)).map(c => c.term), term);
    catInput.focus();
    catInput.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  if (e.target.closest('[data-reset]')) {
    const before = categories();
    patchCategory(term, { tune: undefined });
    toast(`Colour of "${catLabel(term)}" reset`, () => setCategories(before));
    return render();
  }
  const sw = e.target.closest('[data-swatch]');
  if (sw) { patchCategory(term, { swatch: sw.dataset.swatch, tune: undefined }); navCatsKey = ''; return render(); }
  const ib = e.target.closest('[data-icon]');
  if (ib) { patchCategory(term, { icon: ib.dataset.icon || undefined }); navCatsKey = ''; return render(); }
  // Removing a category clears its theme from every note that has it
  // (archived and trashed too); its sub-categories become main ones. Undo
  // puts back the categories and each theme.
  if (e.target.closest('[data-rm]')) {
    const before = categories(), subs = subsOf(term).length, gone = findCategory(term), goneLabel = catLabel(term);
    const mainNames = new Set(before.filter(c => !catParent(c) && !sameTerm(c.term, term)).map(c => catName(c).toLowerCase()));
    const themed = [...notes.values()]
      .filter(n => !n.deleted && !isSettings(n) && n.theme && sameTerm(n.theme.term, term))
      .map(n => [n.id, n.theme]);
    setCategories(before.filter(c => !sameTerm(c.term, term)).map(c => {
      if (typeof c.parent !== 'string' || !sameTerm(c.parent, term)) return c;
      const { parent, ...rest } = c;
      rest.swatch = swatchOf(gone); // promoted subs keep the colour they had
      if (gone.tune) rest.tune = gone.tune;
      let name = catName(c);
      if (mainNames.has(name.toLowerCase())) name = `${name} (${catName(gone)})`; // keep main names unique
      mainNames.add(name.toLowerCase());
      return withName(rest, name);
    }));
    for (const [id] of themed) updateNote(id, { theme: null });
    const k = themed.length;
    toast(`Category "${goneLabel}" removed` + (k ? `, cleared from ${k} note${k > 1 ? 's' : ''}` : '') + (subs ? `; ${subs} sub-categor${subs > 1 ? 'ies are' : 'y is'} now main` : ''), () => {
      setCategories(before);
      for (const [id, theme] of themed) updateNote(id, { theme });
    });
    render();
  }
});

// Dragging: repaint this row's previews only. Releasing: save, which syncs.
settingsEl.addEventListener('input', e => {
  const input = e.target.closest('input[data-k]');
  if (!input) return;
  const row = input.closest('.cat'), tune = rowTune(row);
  const sl = TUNE_SLIDERS.find(x => x[0] === input.dataset.k);
  input.nextElementSibling.textContent = sl[7](Number(input.value));
  for (const t of row.querySelectorAll('.cat-tile')) applyTheme(t, catLook(row.dataset.term, tune));
});
settingsEl.addEventListener('change', e => {
  // Place: move a category under a main one (it takes that look, shifted)
  // or make it a main category again. One Undo.
  const place = e.target.closest('select[data-parent]');
  if (place) {
    const term = place.closest('.cat').dataset.term, to = place.value, before = categories();
    const p = to ? findCategory(to) : null;
    if (to && (!p || catParent(p))) return;
    const me = findCategory(term), clash = me && findChild(catName(me), p ? p.term : '');
    if (clash && !sameTerm(clash.term, term)) { toast(`There is already a category "${catLabel(clash.term)}"`); return render(); }
    setCategories(before.map(c => {
      if (!sameTerm(c.term, term)) return c;
      const { parent, ...rest } = c;
      return p ? { ...rest, parent: p.term } : rest;
    }));
    toast(p ? `"${nameOf(term)}" moved under ${catName(p)}` : `"${nameOf(term)}" is a main category now`, () => setCategories(before));
    return render();
  }
  const input = e.target.closest('input[data-k]');
  if (!input) return;
  const row = input.closest('.cat'), term = row.dataset.term, key = input.dataset.k;
  catDrag = false;
  tuneOpen = true; // the sliders sit in the Fine-tune section
  patchCategory(term, { tune: rowTune(row) });
  navCatsKey = '';
  render();
  // Rebuilt row: keep keyboard focus on the slider so arrow keys keep working.
  const again = [...catList.querySelectorAll('.cat')].find(r => sameTerm(r.dataset.term, term));
  if (again) $(`input[data-k=${key}]`, again).focus();
});
settingsEl.addEventListener('keydown', e => {
  if (e.key === 'Escape' && e.target.matches('[data-rename-input]')) { e.preventDefault(); e.stopPropagation(); endRename(false); }
});

// Drag a category by its grip (mouse or touch; pointer events, so it works
// on phones too). Where it lands:
// - the middle of a main category's row: becomes its last sub-category;
// - a gap: takes that place. The row below the gap decides the level: a
//   sub-category there makes it a sibling sub, anything else a main one.
// A main category with subs moves with them and stays a main one. A drop
// that changes the order switches the order to Custom. One Undo.
let catMove = null; // { term, block, x0, y0, on, ghost, line, drop, raf, vy }
const DRAG_START = 5; // px before a press on the grip becomes a drag
catList.addEventListener('pointerdown', e => {
  const grip = e.target.closest('.cat-grip');
  if (!grip || e.button > 0 || renamingCat !== null) return;
  const term = grip.closest('.cat').dataset.term;
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  const cats = orderedCats(), me = findCategory(term);
  const block = [me.term, ...(catParent(me) ? [] : cats.filter(c => sameTerm(catParent(c)?.term || '', me.term)).map(c => c.term))];
  catMove = { term, block, x0: e.clientX, y0: e.clientY, on: false, drop: null, vy: 0, raf: 0, grip, flat: cats.map(c => c.term) };
});
catList.addEventListener('pointermove', e => {
  const m = catMove;
  if (!m) return;
  if (!m.on) {
    if (Math.hypot(e.clientX - m.x0, e.clientY - m.y0) < DRAG_START) return;
    m.on = true;
    catDrag = true; // no list rebuild under the drag
    document.body.classList.add('cat-moving');
    for (const r of catList.querySelectorAll('.cat')) if (m.block.some(t => sameTerm(t, r.dataset.term))) r.classList.add('is-dragged');
    m.ghost = h('div', { class: 'cat-ghost' }, catMark(h('span', { class: 'ico-mark' }), m.term), h('span', null, catLabel(m.term)));
    m.line = h('div', { class: 'cat-drop-line', hidden: true });
    document.body.append(m.ghost, m.line);
  }
  m.ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 8}px)`;
  m.drop = catDropAt(e.clientX, e.clientY);
  showCatDrop(m.drop);
  // Scroll the page while near the top or bottom edge.
  const edge = 60, top = $('.topbar') ? $('.topbar').getBoundingClientRect().bottom : 0;
  m.vy = e.clientY < top + edge ? -Math.ceil((top + edge - e.clientY) / 4) : e.clientY > innerHeight - edge ? Math.ceil((e.clientY - innerHeight + edge) / 4) : 0;
  m.lastX = e.clientX; m.lastY = e.clientY;
  if (m.vy && !m.raf) {
    const step = () => {
      if (!catMove || !catMove.vy) { if (catMove) catMove.raf = 0; return; }
      scrollBy(0, catMove.vy);
      catMove.drop = catDropAt(catMove.lastX, catMove.lastY);
      showCatDrop(catMove.drop);
      catMove.raf = requestAnimationFrame(step);
    };
    m.raf = requestAnimationFrame(step);
  }
});
// The drop under the pointer: { kind: 'into', main } or { kind: 'gap', index,
// parent } (index into the flat order without the dragged block), or null.
function catDropAt(x, y) {
  const m = catMove;
  const el = document.elementFromPoint(x, y), row = el && el.closest('.cat');
  if (!row || !catList.contains(row) || m.block.some(t => sameTerm(t, row.dataset.term))) return null;
  const term = row.dataset.term, cat = findCategory(term), r = row.querySelector('.cat-head').getBoundingClientRect();
  const me = findCategory(m.term), hasSubs = m.block.length > 1;
  const f = (y - r.top) / r.height;
  const rest = m.flat.filter(t => !m.block.some(b => sameTerm(b, t)));
  const at = rest.findIndex(t => sameTerm(t, term));
  if (!catParent(cat) && f > 0.3 && f < 0.7) {
    if (hasSubs || sameTerm(catParent(me)?.term || '', term)) return null; // already there, or would nest two levels
    return { kind: 'into', main: term, row };
  }
  const index = f <= 0.5 ? at : at + 1;
  // The row below the gap sets the level: a sub there makes a sibling sub
  // (so just below a main with subs means its first sub); a main category or
  // the end of the list means main level.
  const below = rest[index], belowCat = below ? findCategory(below) : null;
  const parent = belowCat && catParent(belowCat) ? catParent(belowCat).term : '';
  if (parent && hasSubs) return null;
  return { kind: 'gap', index, parent, row, after: f > 0.5 };
}
function showCatDrop(d) {
  const m = catMove;
  for (const r of catList.querySelectorAll('.cat.is-into')) r.classList.remove('is-into');
  m.line.hidden = !d || d.kind !== 'gap';
  if (!d) return;
  if (d.kind === 'into') return d.row.classList.add('is-into');
  const r = d.row.getBoundingClientRect(), list = catList.getBoundingClientRect();
  const y = d.after ? r.bottom + 4 : r.top - 4;
  const indent = d.parent ? 28 : 0;
  Object.assign(m.line.style, { top: y - 1.5 + 'px', left: list.left + indent + 'px', width: list.width - indent + 'px' });
}
function endCatMove(drop) {
  const m = catMove;
  if (!m) return;
  catMove = null;
  cancelAnimationFrame(m.raf);
  document.body.classList.remove('cat-moving');
  if (m.ghost) m.ghost.remove();
  if (m.line) m.line.remove();
  for (const r of catList.querySelectorAll('.is-dragged, .is-into')) r.classList.remove('is-dragged', 'is-into');
  catDrag = false;
  if (m.on && drop && m.drop) applyCatMove(m, m.drop);
  else render();
}
catList.addEventListener('pointerup', () => endCatMove(true));
catList.addEventListener('pointercancel', () => endCatMove(false));
addEventListener('keydown', e => { if (catMove && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endCatMove(false); } }, true);
// No click (opening the row) after a drag.
catList.addEventListener('click', e => { if (e.target.closest('.cat-grip')) e.stopPropagation(); }, true);
function applyCatMove(m, d) {
  const s = settingsRec(), before = { categories: categories(), catOrder: s.catOrder, catCustom: s.catCustom };
  const me = findCategory(m.term), from = catParent(me)?.term || '';
  const to = d.kind === 'into' ? d.main : d.parent;
  if (!sameTerm(from, to)) {
    const clash = findChild(catName(me), to);
    if (clash && !sameTerm(clash.term, me.term)) { toast(`There is already a category "${catLabel(clash.term)}"`); return render(); }
  }
  const cats = categories().map(c => {
    if (!sameTerm(c.term, me.term)) return c;
    const { parent, ...rest } = c;
    return to ? { ...rest, parent: findCategory(to).term } : rest;
  });
  const patch = {};
  let reordered = false;
  if (d.kind === 'gap') {
    const rest = m.flat.filter(t => !m.block.some(b => sameTerm(b, t)));
    const terms = [...rest.slice(0, d.index), ...m.block, ...rest.slice(d.index)];
    reordered = terms.some((t, i) => !sameTerm(t, m.flat[i]));
    if (reordered) { patch.catCustom = terms; patch.catOrder = 'custom'; }
  }
  if (sameTerm(from, to) && !reordered) return render();
  setCategories(cats);
  if (Object.keys(patch).length) setSettings(patch);
  navCatsKey = '';
  const name = catName(me);
  const what = !sameTerm(from, to) ? (to ? `"${name}" moved under ${catName(findCategory(to))}` : `"${name}" is a main category now`) : `"${name}" moved`;
  const order = reordered && before.catOrder !== 'custom' ? '; order is now Custom' : '';
  toast(what + order, () => { setSettings({ categories: before.categories, catOrder: before.catOrder, catCustom: before.catCustom }); navCatsKey = ''; });
  render();
}
settingsEl.addEventListener('pointerdown', e => { if (e.target.closest('input[data-k]')) catDrag = true; });
settingsEl.addEventListener('toggle', e => { if (e.target.matches('.cat-tune')) tuneOpen = e.target.open; }, true);
addEventListener('pointerup', () => { catDrag = false; });
addEventListener('pointercancel', () => { catDrag = false; });

// ---------------------------------------------------------------- toast

const toastEl = $('#toast');
let toastTimer = 0, toastUndo = null;
function toast(msg, undo) {
  $('span', toastEl).textContent = msg;
  $('button', toastEl).hidden = !undo;
  toastUndo = undo || null;
  const p = toastPrefs();
  toastEl.hidden = !p.on;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, p.secs * 1000);
}
function hideToast() { toastEl.hidden = true; toastUndo = null; }
function undo() {
  if (!toastUndo) return;
  const fn = toastUndo;
  hideToast();
  fn();
  render();
}
$('button', toastEl).addEventListener('click', undo);

// ---------------------------------------------------------------- chrome

const search = $('#search');
function clearSearch() {
  search.value = query = '';
  $('#clearSearch').hidden = true;
  render();
}
// One render per frame: fast typing coalesces into the latest query.
let searchFrame = 0;
search.addEventListener('input', () => {
  query = search.value;
  $('#clearSearch').hidden = !query;
  if (!searchFrame) searchFrame = requestAnimationFrame(() => { searchFrame = 0; render(); });
});
search.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.stopPropagation(); clearSearch(); search.blur(); }
  // Backspace in an empty box drops the category, like deleting a tag.
  else if (e.key === 'Backspace' && !search.value && !searchChip.hidden) { e.preventDefault(); leaveSearchCat(); }
});

// Category chip: in a category view the search box shows the category (a
// search there finds only its notes). Its x, or Backspace in an empty box,
// goes back to Notes and keeps the typed text, so the search covers every
// note. A per-device setting (mn.catChip, default on); off hides the chip and
// a category view still searches only its own notes.
const searchChip = $('#searchChip');
let catChip = readLS(K.catChip, true) !== false;
function updateSearchChip(cat) {
  const show = catChip && cat !== null;
  if (show) {
    const label = catLabel(cat);
    if ($('#searchChipText').textContent !== label) {
      $('#searchChipText').textContent = label;
      catMark($('#searchChipDot'), cat);
    }
    searchChip.title = 'Searching in ' + label;
  }
  searchChip.hidden = !show;
  search.placeholder = show ? 'Search in this category' : 'Search';
}
function leaveSearchCat() {
  setView('notes');
  search.focus();
}
$('#searchChipX').addEventListener('click', e => { e.preventDefault(); leaveSearchCat(); });
$('#clearSearch').addEventListener('click', () => { clearSearch(); search.focus(); });

$('#menuBtn').addEventListener('click', () => {
  if (mqPhone.matches) {
    const open = document.body.classList.toggle('side-open');
    $('#scrim').hidden = !open;
  } else {
    writeLS(K.mini, document.body.classList.toggle('side-mini'));
    layout();
  }
});
$('#scrim').addEventListener('click', () => { document.body.classList.remove('side-open'); $('#scrim').hidden = true; });
// The app name and icon (top left) go home: Notes, no search, at the top.
function goHome() {
  if (query) clearSearch();
  if (view !== 'notes') setView('notes');
  else scrollTo(0, 0);
}
$('#brand').addEventListener('click', goHome);
// Settings: the cog at the top right; a second click goes back to Notes.
$('#settingsBtn').addEventListener('click', () => setView(view === 'settings' ? 'notes' : 'settings'));
$('#brand').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goHome(); } });
$('#sidebar').addEventListener('click', e => {
  const b = e.target.closest('[data-view]');
  // Clicking the active category or colour again goes back to all notes.
  if (b) setView(b.dataset.view === view && /^(cat|color):/.test(view) ? 'notes' : b.dataset.view);
});
if (readLS(K.mini, false)) document.body.classList.add('side-mini');

// Sidebar width: drag the handle on its right edge (desktop, not in the mini
// sidebar). Saved per device; a double-click resets it. Phones keep their own.
const SIDE_W = { min: 180, max: 440, def: 248 };
const sideHandle = h('div', { class: 'side-resize', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize sidebar', title: 'Drag to resize · double-click to reset' });
document.body.append(sideHandle);
const clampSide = w => Math.min(SIDE_W.max, Math.max(SIDE_W.min, Math.round(w)));
function applySideW() {
  const w = Number(readLS(K.sideW, 0));
  if (w && !mqPhone.matches) document.documentElement.style.setProperty('--side-w', clampSide(w) + 'px');
  else document.documentElement.style.removeProperty('--side-w');
}
applySideW();
mqPhone.addEventListener('change', applySideW);
let sideDrag = null, sideFrame = 0;
sideHandle.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  e.preventDefault();
  sideHandle.setPointerCapture(e.pointerId);
  sideDrag = { x: e.clientX, w: $('#sidebar').getBoundingClientRect().width };
  document.body.classList.add('side-resizing');
});
sideHandle.addEventListener('pointermove', e => {
  if (!sideDrag) return;
  const w = clampSide(sideDrag.w + e.clientX - sideDrag.x);
  document.documentElement.style.setProperty('--side-w', w + 'px');
  sideDrag.now = w;
  if (!sideFrame) sideFrame = requestAnimationFrame(() => { sideFrame = 0; layout(); });
});
const endSideDrag = () => {
  if (!sideDrag) return;
  if (sideDrag.now) writeLS(K.sideW, sideDrag.now);
  sideDrag = null;
  document.body.classList.remove('side-resizing');
};
sideHandle.addEventListener('pointerup', endSideDrag);
sideHandle.addEventListener('pointercancel', endSideDrag);
sideHandle.addEventListener('dblclick', () => { localStorage.removeItem(K.sideW); applySideW(); layout(); });

$('#emptyTrash').addEventListener('click', () => {
  const snaps = [...notes.values()].filter(n => n.trashed && !n.deleted).map(n => ({ ...n }));
  for (const n of snaps) removeNote(n.id);
  toast(`${snaps.length} note${snaps.length > 1 ? 's' : ''} deleted forever`, () => { for (const s of snaps) updateNote(s.id, s); });
  render();
});

$('#fab').addEventListener('click', () => openNew('text'));
$('#mNewText').addEventListener('click', () => openNew('text'));
$('#mNewList').addEventListener('click', () => openNew('list'));
$('#mAttach').addEventListener('click', () => {
  openNew('text');
  (mqPhone.matches ? modalEd : composer).fileInput.click(); // same tap, or iOS ignores it
});

// ---------------------------------------------------------------- attachments: drop and paste

const hasFileDrag = e => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');

// Which editor a file drop/drag at this point belongs to (null: none).
function dropEditor(e) {
  const path = e.composedPath();
  if (!modal.hidden) return path.includes(modalEd.root) && !modalEd.d.trashed ? modalEd : null;
  return path.includes(composer.root) && !composer.root.hidden ? composer : null;
}
function markDrop(ed) {
  composer.root.classList.toggle('drop-target', ed === composer);
  modalEd.root.classList.toggle('drop-target', ed === modalEd);
}

// Only file drags are intercepted; dragging text between fields still works.
let dragDepth = 0;
document.addEventListener('dragenter', e => { if (hasFileDrag(e)) dragDepth++; });
document.addEventListener('dragleave', e => {
  if (hasFileDrag(e) && --dragDepth <= 0) { dragDepth = 0; markDrop(null); }
});
document.addEventListener('dragover', e => {
  if (!hasFileDrag(e)) return;
  e.preventDefault(); // or a missed drop navigates away from the app
  markDrop(dropEditor(e));
});
document.addEventListener('drop', e => {
  if (!hasFileDrag(e)) return;
  e.preventDefault();
  dragDepth = 0;
  markDrop(null);
  let ed = dropEditor(e);
  if (!ed) {
    if (mqPhone.matches || !modal.hidden) return;
    openNew('text');
    ed = composer;
  }
  attach(e.dataTransfer.files, ed, false);
});

// Pasting files with no field focused starts a new note (desktop only).
document.addEventListener('paste', e => {
  if (e.defaultPrevented || mqPhone.matches || !modal.hidden || isTyping(e.target)) return;
  const fl = clipFiles(e.clipboardData);
  if (!fl) return;
  e.preventDefault();
  openNew('text');
  attach(fl, composer, true);
});

// Clicking anywhere else saves and closes the composer; also closes the palette.
// composedPath() still lists nodes that a click handler removed meanwhile.
document.addEventListener('click', e => {
  const path = e.composedPath();
  if (!pal.hidden && !path.includes(pal) && !path.some(el => el.dataset && (el.dataset.a === 'color' || el.dataset.act === 'color'))) closePalette();
  if (!sortMenu.hidden && !path.includes(sortMenu) && !path.includes(sortBtn)) closeSortMenu();
  if (!zoomMenu.hidden && !path.includes(zoomMenu) && !path.includes(zoomBtn)) closeZoomMenu();
  if (composer.expanded && !path.includes(composer.root) && !path.includes(pal) && !path.includes(toastEl)) composer.done(false);
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!pal.hidden) return closePalette();
    if (!sortMenu.hidden) return closeSortMenu();
    if (!zoomMenu.hidden) return closeZoomMenu();
    if (selected.size && modal.hidden) return clearSel();
    if (!modal.hidden) return closeModal();
    if (document.body.classList.contains('side-open')) return $('#scrim').click();
    return;
  }
  // Alt+Up/Down: previous/next category in sidebar order (Notes first), subs
  // included, empty ones skipped while they are hidden. Works in the collapsed
  // composer too, which has focus on load.
  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')
    && altNav && modal.hidden && pal.hidden && (!isTyping(e.target) || (e.target.closest('#composer') && !composer.expanded))) {
    e.preventDefault();
    return stepCategory(e.key === 'ArrowDown' ? 1 : -1);
  }
  if (e.altKey || isTyping(e.target)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && toastUndo) { e.preventDefault(); return undo(); }
  if (e.ctrlKey || e.metaKey || !modal.hidden) return;
  const k = e.key.toLowerCase();
  if (k === 'c' || k === 'n') { e.preventDefault(); openNew('text'); }
  else if (k === 'l') { e.preventDefault(); openNew('list'); }
  else if (k === 'a' && !e.shiftKey) { e.preventDefault(); goHome(); }
  else if (e.key === '?' || (e.shiftKey && e.code === 'Slash')) { // Shift+/: find a category in the sidebar
    if (navFindBox.hidden || getComputedStyle(navFindBox).display === 'none') return;
    e.preventDefault(); navFindInput.focus(); navFindInput.select();
  }
  else if (k === '/') { e.preventDefault(); search.focus(); search.select(); }
  else if (!e.shiftKey && navKeyMap.has(k)) { e.preventDefault(); setView('cat:' + navKeyMap.get(k)); }
});

mqPhone.addEventListener('change', () => {
  closeZoomMenu(); // its slider is set up for the other layout
  zoomBtnLabel(); // phones cycle on tap, desktop opens the slider
  document.body.classList.remove('side-open');
  $('#scrim').hidden = true;
  if (composer.expanded) composer.done(false);
  render();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush();
  else sync();
});
addEventListener('pagehide', flush);
addEventListener('online', () => sync());
setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 30000);

// ---------------------------------------------------------------- pull to refresh

// Phone: pull the note list down from the top to sync now. The home-screen
// app has no pull-to-refresh of its own, and the browser's (a page reload)
// is switched off in CSS so only this one runs.
const ptr = $('#ptr');
const PTR_MAX = 90, PTR_GO = 64;
let ptrY0 = null, ptrX0 = 0, ptrDy = 0, ptrBusy = false;

// A fresh sync that starts after the pull; waits out one already in flight.
// Capped, so a hung request can't leave the spinner turning.
function syncNow() {
  const run = (async () => {
    while (syncing) await new Promise(r => setTimeout(r, 100));
    await sync();
  })();
  return Promise.race([run, new Promise(r => setTimeout(r, 10000))]);
}

function ptrShow(dy, state) {
  ptr.hidden = false;
  ptr.dataset.state = state;
  ptr.style.setProperty('--pull', dy + 'px');
  ptr.style.setProperty('--turn', Math.min(1, dy / PTR_GO) * 270 + 'deg');
}
function ptrHide() {
  ptr.dataset.state = 'done';
  setTimeout(() => { if (ptr.dataset.state === 'done') ptr.hidden = true; }, 200);
}

document.addEventListener('touchstart', e => {
  ptrY0 = null;
  if (!ptrBusy) ptrDy = 0; // per touch; the sidebar swipe reads it too
  if (ptrBusy || !mqPhone.matches || !modal.hidden || e.touches.length !== 1) return;
  if (scrollY > 0 || document.body.classList.contains('side-open') || !pal.hidden) return;
  if (e.target.closest('.sidebar, .bottombar, .topbar, input, textarea')) return;
  ptrY0 = e.touches[0].clientY;
  ptrX0 = e.touches[0].clientX;
  ptrDy = 0;
}, { passive: true });

document.addEventListener('touchmove', e => {
  if (ptrY0 === null) return;
  const dy = e.touches[0].clientY - ptrY0, dx = e.touches[0].clientX - ptrX0;
  if (ptrDy === 0 && (dy <= 0 || Math.abs(dx) > dy)) { ptrY0 = null; return; } // a scroll or a swipe
  e.preventDefault();
  ptrDy = Math.min(PTR_MAX, dy * 0.5);
  ptrShow(ptrDy, ptrDy >= PTR_GO ? 'ready' : 'pull');
}, { passive: false });

async function ptrEnd() {
  if (ptrY0 === null) return;
  ptrY0 = null;
  if (ptrDy < PTR_GO) return ptrHide();
  ptrBusy = true;
  ptrShow(PTR_GO, 'busy');
  await syncNow();
  ptrBusy = false;
  ptrHide();
  if ($('#sync').dataset.state === 'off') toast('Offline: changes are kept on this device');
}
document.addEventListener('touchend', ptrEnd);
document.addEventListener('touchcancel', () => { ptrY0 = null; ptrHide(); });

// ---------------------------------------------------------------- swipe for the sidebar

// Phone: swipe right on the note list to open the sidebar, swipe left to
// close it. Decided at touchend, so vertical scrolling, pull-to-refresh and
// long press are not affected.
let swipe = null;
document.addEventListener('touchstart', e => {
  swipe = null;
  if (!mqPhone.matches || !modal.hidden || e.touches.length !== 1 || !pal.hidden) return;
  if (e.target.closest('input, textarea, .selbar, .menu')) return;
  swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
}, { passive: true });
document.addEventListener('touchend', e => {
  if (!swipe || ptrDy > 0) { swipe = null; return; } // a pull to refresh is not a swipe
  const tch = e.changedTouches[0], dx = tch.clientX - swipe.x, dy = tch.clientY - swipe.y;
  const quick = Date.now() - swipe.t < 600;
  swipe = null;
  if (!quick || Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) / 2) return;
  const open = document.body.classList.contains('side-open');
  if (dx > 0 && !open) {
    document.body.classList.add('side-open');
    $('#scrim').hidden = false;
  } else if (dx < 0 && open) {
    document.body.classList.remove('side-open');
    $('#scrim').hidden = true;
  }
});

// ---------------------------------------------------------------- start

composer.start();
purgeOldTrash();
render();
composer.titleHint();
if (!mqPhone.matches && matchMedia('(pointer: fine)').matches) (titleFirst ? composer.title : composer.bodyEl).focus();
sync();
