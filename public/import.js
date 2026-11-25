'use strict';
/*
 * Import from Google Keep (Google Takeout).
 *
 * Takeout gives one .json per note (plus an .html copy we ignore) and the
 * attached images next to them. The user picks the Keep folder, or the
 * files, in the Import view; everything runs in the browser and goes
 * through the normal note store and sync.
 *
 * Loaded BEFORE app.js and contains declarations only, like files.js.
 *
 * - Every imported note gets the theme of the "imported" category, which
 *   is created if missing. The Keep colour is kept as `color`; it shows
 *   once the theme is removed.
 * - Keep's created and edited times are kept, so sorting by date works.
 * - Labels become "#label" tags at the end of the body (searchable).
 * - `keep` holds the Takeout file name. Notes already imported (and not
 *   deleted forever) are skipped, so importing the same folder twice is safe.
 * - Images are uploaded first, then the note is created with them, like
 *   any attachment: a note never points at bytes the server doesn't have.
 */

const IMPORT_TERM = 'imported';
const IMPORT_WORKERS = 3; // parallel image uploads

// Keep's API names. Keep shows CERULEAN as "Blue" and BLUE as "Dark blue".
const KEEP_COLORS = {
  DEFAULT: 'default', RED: 'red', ORANGE: 'orange', YELLOW: 'yellow', GREEN: 'green', TEAL: 'teal',
  CERULEAN: 'blue', BLUE: 'indigo', PURPLE: 'purple', PINK: 'pink', BROWN: 'brown', GRAY: 'gray',
};

const usecToMs = u => (Number.isFinite(+u) && +u > 0 ? Math.round(+u / 1000) : 0);
const stem = name => name.replace(/^.*\//, '').replace(/\.[^.]*$/, '');

// One Keep JSON -> note fields (no id), or null when there is nothing to keep.
function keepToNote(j, key) {
  if (!j || typeof j !== 'object') return null;
  const created = usecToMs(j.createdTimestampUsec) || Date.now();
  const edited = Math.max(usecToMs(j.userEditedTimestampUsec), created);
  const tags = Array.isArray(j.labels)
    ? j.labels.map(l => l && typeof l.name === 'string' ? '#' + l.name.trim().replace(/\s+/g, '_') : '').filter(t => t.length > 1)
    : [];
  const n = {
    kind: 'text', title: typeof j.title === 'string' ? j.title : '', body: '', items: [], files: [],
    color: KEEP_COLORS[j.color] || 'default', pinned: !!j.isPinned, archived: !!j.isArchived,
    trashed: !!j.isTrashed, trashedAt: j.isTrashed ? Date.now() : 0, // Trash empties 7 days after the import
    createdAt: created, updatedAt: edited, keep: key,
  };
  if (Array.isArray(j.listContent) && j.listContent.length) {
    n.kind = 'list';
    n.items = j.listContent
      .filter(i => i && typeof i.text === 'string')
      .map(i => ({ id: uid(), text: i.text.replace(/\n+$/, ''), done: !!i.isChecked }));
    if (tags.length) n.body = tags.join(' ');
  } else {
    const text = typeof j.textContent === 'string' ? j.textContent.replace(/\s+$/, '') : '';
    const lower = text.toLowerCase();
    const extra = tags.filter(t => !lower.includes(t.toLowerCase())); // typed in the text already
    n.body = extra.length ? (text ? text + '\n\n' : '') + extra.join(' ') : text;
  }
  const atts = Array.isArray(j.attachments) ? j.attachments.filter(a => a && typeof a.filePath === 'string') : [];
  if (!atts.length && !hasContent(n)) return null;
  return { note: n, atts: atts.map(a => a.filePath) };
}

// Make sure the category exists, so the sidebar shows it and its colours apply.
function ensureImportCategory() {
  const cats = categories();
  if (!cats.some(c => sameTerm(c.term, IMPORT_TERM))) setCategories([...cats, { term: IMPORT_TERM, ...NO_ADJ }]);
}

// Store a note as given (keeps Keep's timestamps), through the normal
// persist/sync path.
function addImported(fields) {
  const n = { ...blank(), ...copyArrays(fields), id: uid(), deleted: false, theme: { term: IMPORT_TERM, seed: newThemeSeed() } };
  notes.set(n.id, n);
  touched(n.id);
  return n.id;
}

async function uploadForImport(file) {
  const p = await prepareFile(file, false);
  const id = uid();
  await putFile(id, p.blob, p.name, false);
  const meta = { id, name: p.name, type: p.type, size: p.blob.size, at: Date.now() };
  if (p.w) { meta.w = p.w; meta.h = p.h; }
  if (p.thumb) {
    try { await putFile(id, p.thumb, p.name, true); meta.thumb = true; } catch { meta.thumb = false; }
  }
  return meta;
}

// fileList: every file the user picked (a folder or a selection).
// progress({ done, total, phase }) is called as work goes on.
async function importKeep(fileList, progress) {
  const all = Array.from(fileList || []);
  const jsons = all.filter(f => /\.json$/i.test(f.name));
  const byName = new Map(), byStem = new Map();
  for (const f of all) {
    if (/\.(json|html|txt)$/i.test(f.name)) continue;
    byName.set(f.name, f);
    byStem.set(stem(f.name), f); // Takeout sometimes names .jpeg what the JSON calls .jpg
  }
  const have = new Set();
  for (const n of notes.values()) if (!n.deleted && n.keep) have.add(n.keep);

  const res = { notes: 0, skipped: 0, dupes: 0, images: 0, failedImages: 0, ids: [] };
  const jobs = [];
  let done = 0;
  progress({ done, total: jsons.length, phase: 'Reading notes' });
  for (const f of jsons) {
    let j = null;
    try { j = JSON.parse(await f.text()); } catch { /* not a Keep note */ }
    const key = stem(f.name);
    if (!j || typeof j !== 'object' || !('isTrashed' in j || 'textContent' in j || 'listContent' in j)) { res.skipped++; continue; }
    if (have.has(key)) { res.dupes++; continue; }
    const parsed = keepToNote(j, key);
    if (!parsed) { res.skipped++; continue; }
    have.add(key);
    if (!parsed.atts.length) {
      res.ids.push(addImported(parsed.note));
      res.notes++;
    } else {
      jobs.push(parsed);
    }
    if (++done % 100 === 0) progress({ done, total: jsons.length, phase: 'Reading notes' });
  }
  if (res.notes) ensureImportCategory();

  // Notes with images: upload, then create the note with what made it.
  let next = 0, up = 0;
  progress({ done: 0, total: jobs.length, phase: 'Uploading images' });
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const files = [];
      for (const path of job.atts) {
        const file = byName.get(path.replace(/^.*\//, '')) || byStem.get(stem(path));
        if (!file) { res.failedImages++; continue; }
        try { files.push(await uploadForImport(file)); res.images++; } catch { res.failedImages++; }
      }
      const note = { ...job.note, files };
      if (hasContent(note)) {
        ensureImportCategory();
        res.ids.push(addImported(note));
        res.notes++;
      } else {
        res.skipped++;
      }
      progress({ done: ++up, total: jobs.length, phase: 'Uploading images' });
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMPORT_WORKERS, jobs.length) }, worker));
  return res;
}
