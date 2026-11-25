'use strict';
/*
 * Kee+ attachments (client).
 *
 * Loaded BEFORE app.js and contains declarations only: no top-level code
 * that touches app.js bindings or the DOM. Classic scripts share one
 * global scope, so these functions use app.js globals (notes, updateNote,
 * createNote, toast, h, icon, board, composer, modalEd, draftNotes, ...)
 * when they are called. All event wiring lives in app.js.
 *
 * Flow: prepare (downscale + thumbnail) -> PUT main -> PUT thumb ->
 * attachTo (add the reference). A note never refers to bytes the server
 * doesn't have. While an upload runs, the editor shows it from
 * `pendingUploads`, which is UI state only (not persisted or synced).
 */

const ATT = {
  MAX_EDGE: 2000,          // long edge of stored images, px
  THUMB_W: 480,            // thumbnail width, px
  THUMB_MAX_H: 1440,       // thumbnail height cap, px (tall images are cropped at the top)
  PNG_KEEP_MAX: 1.5 * 2 ** 20, // PNGs up to this size stay PNG (sharp screenshots)
  JPEG_Q: 0.85,
  THUMB_Q: 0.8,
  MAX_FILE: 20 * 2 ** 20,  // hint only; the server's MYNOTES_MAX_FILE_MB decides
  MAX_PER_DROP: 10,
};
const ATT_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
const ATT_EXT = /\.(jpe?g|png|gif|webp|pdf|heic|heif)$/i;

const pendingUploads = [];

const isImage = f => typeof f.type === 'string' && f.type.startsWith('image/');
const fileUrl = (f, thumb) => 'api/files/' + f.id + (thumb && f.thumb ? '/thumb' : '');

// Files from a paste or drop. A paste that also carries plain text (e.g.
// copied from a word processor) stays a text paste.
function clipFiles(cd) {
  if (!cd || !cd.files || !cd.files.length) return null;
  if ([...cd.types].includes('text/plain')) return null;
  return cd.files;
}

function fileKind(file) {
  const type = file.type || '';
  if (type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf';
  if (type === 'image/gif') return 'gif';
  if (type.startsWith('image/') || ATT_EXT.test(file.name || '')) return 'image';
  return null;
}

function pastedName(ext) {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `Pasted image ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${ext}`;
}

function withExt(name, ext) {
  const base = (name || 'image').replace(/\.[^.]*$/, '');
  return base + '.' + ext;
}

async function decodeImage(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

// Draw (a top crop of) src into a w x h canvas and encode it.
function encode(src, w, h, type, quality, cropH) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
  const sw = src.width, sh = cropH || src.height;
  ctx.drawImage(src, 0, 0, sw, sh, 0, 0, w, h);
  return new Promise((resolve, reject) =>
    c.toBlob(b => (b ? resolve(b) : reject(new Error("Can't read this image"))), type, quality));
}

// -> {blob, type, name, w?, h?, thumb: Blob|null}; throws Error(user message).
async function prepareFile(file, pasted) {
  const kind = fileKind(file);
  if (!kind) throw new Error("This file type isn't supported");
  const tooBig = () => new Error(`File too large (max ${ATT.MAX_FILE / 2 ** 20} MB)`);
  if (kind === 'pdf') {
    if (file.size > ATT.MAX_FILE) throw tooBig();
    return { blob: file, type: 'application/pdf', name: file.name || 'document.pdf', thumb: null };
  }
  if (kind === 'gif' && file.size > ATT.MAX_FILE) throw tooBig();
  let src;
  try { src = await decodeImage(file); } catch { throw new Error("Can't read this image"); }
  try {
    const sw = src.width, sh = src.height;
    let blob = null, type, w = sw, h = sh;
    if (kind === 'gif') {
      blob = file; type = 'image/gif'; // keep the animation
    } else {
      const s = Math.min(1, ATT.MAX_EDGE / Math.max(sw, sh));
      w = Math.max(1, Math.round(sw * s));
      h = Math.max(1, Math.round(sh * s));
      if (file.type === 'image/png') {
        blob = await encode(src, w, h, 'image/png');
        type = 'image/png';
        if (blob.size > ATT.PNG_KEEP_MAX) blob = null;
      }
      if (!blob) { blob = await encode(src, w, h, 'image/jpeg', ATT.JPEG_Q); type = 'image/jpeg'; }
    }
    if (blob.size > ATT.MAX_FILE) throw tooBig();
    const tw = Math.min(ATT.THUMB_W, sw);
    const fullH = Math.round(sh * tw / sw);
    const th = Math.max(1, Math.min(fullH, ATT.THUMB_MAX_H));
    const thumb = await encode(src, tw, th, 'image/jpeg', ATT.THUMB_Q, th < fullH ? th * sw / tw : 0);
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' }[type];
    const name = pasted ? pastedName(ext) : type === file.type ? file.name : withExt(file.name, ext);
    return { blob, type, name, w, h, thumb };
  } finally {
    if (src.close) src.close();
  }
}

async function putFile(id, blob, name, thumb) {
  let res;
  try {
    res = await fetch('api/files/' + id + (thumb ? '/thumb' : ''), {
      method: 'PUT',
      headers: { 'X-Mynotes': '1', 'X-Filename': encodeURIComponent(name) },
      body: blob,
    });
  } catch {
    throw new Error("Couldn't attach: upload failed");
  }
  if (res.ok) return;
  throw new Error({
    413: `File too large (max ${ATT.MAX_FILE / 2 ** 20} MB)`,
    415: "This file type isn't supported",
    507: 'Storage on the NAS is full',
  }[res.status] || "Couldn't attach this file");
}

function refreshFileStrips() {
  composer.renderFiles();
  modalEd.renderFiles();
}

// Upload files one after another (keeps their order) and attach each to
// the note the editor held when the user attached them.
async function attach(fileList, editor, pasted) {
  const list = Array.from(fileList || []); // copy before any await: inputs reset their FileList
  if (!list.length || editor.d.trashed) return;
  if (list.length > ATT.MAX_PER_DROP) {
    toast(`Only ${ATT.MAX_PER_DROP} files at a time`);
    list.length = ATT.MAX_PER_DROP;
  }
  editor.expand();
  const target = { noteId: editor.id, draftKey: editor.draftKey };
  const jobs = list.map(file => ({
    key: uid(), target, file, name: file.name, type: file.type,
    url: fileKind(file) && fileKind(file) !== 'pdf' ? URL.createObjectURL(file) : null,
  }));
  pendingUploads.push(...jobs);
  refreshFileStrips();
  for (const job of jobs) {
    try {
      const p = await prepareFile(job.file, pasted);
      const id = uid();
      await putFile(id, p.blob, p.name, false);
      const meta = { id, name: p.name, type: p.type, size: p.blob.size, at: Date.now() };
      if (p.w) { meta.w = p.w; meta.h = p.h; }
      if (p.thumb) {
        try { await putFile(id, p.thumb, p.name, true); meta.thumb = true; } catch { meta.thumb = false; }
      }
      attachTo(target, meta);
    } catch (e) {
      toast(e.message || "Couldn't attach this file");
    } finally {
      pendingUploads.splice(pendingUploads.indexOf(job), 1);
      if (job.url) URL.revokeObjectURL(job.url);
      refreshFileStrips();
    }
  }
}

function pendingFor(editor) {
  return pendingUploads.filter(p =>
    (editor.id && (p.target.noteId === editor.id || draftNotes.get(p.target.draftKey) === editor.id)) ||
    (!editor.id && p.target.draftKey === editor.draftKey));
}

// Add the reference to the right note, whatever happened to the editor
// while the upload ran (see the design doc, Technical Plan step 7).
function attachTo(target, meta) {
  const id = target.noteId || draftNotes.get(target.draftKey);
  if (id) {
    const n = notes.get(id);
    if (!n || n.deleted) return; // deleted meanwhile; the cleanup removes the file
    const saved = updateNote(id, { files: [...n.files, meta] });
    for (const ed of [composer, modalEd]) {
      if (ed.id === id) {
        ed.d.files = [...ed.d.files, { ...meta }];
        ed.d.updatedAt = saved.updatedAt;
      }
    }
    return;
  }
  for (const ed of [composer, modalEd]) {
    if (!ed.id && ed.draftKey === target.draftKey) {
      ed.set({ files: [...ed.d.files, meta] });
      return;
    }
  }
  createNote({ files: [meta] }); // the draft was closed before it had content
}

function fileTile(f, readOnly) {
  return h('div', { class: 'ef' + (isImage(f) ? '' : ' ef-doc'), dataset: { fid: f.id }, title: f.name },
    isImage(f)
      ? h('img', { src: fileUrl(f, true), alt: f.name, loading: 'lazy' })
      : [icon('file'), h('span', { class: 'ef-name' }, f.name)],
    readOnly ? null : h('button', { class: 'icon-btn ef-x', type: 'button', 'data-a': 'rmfile', 'aria-label': 'Remove file', title: 'Remove file' }, icon('x')));
}

function pendingTile(p) {
  return h('div', { class: 'ef pending' + (p.url ? '' : ' ef-doc'), title: p.name },
    p.url ? h('img', { src: p.url, alt: '' }) : [icon('file'), h('span', { class: 'ef-name' }, p.name)],
    h('span', { class: 'ef-spin', 'aria-label': 'Uploading' }));
}

function cardMedia(imgs) {
  const f = imgs[0];
  const img = h('img', {
    class: 'c-img', src: fileUrl(f, true), alt: f.name, loading: 'lazy', width: f.w, height: f.h,
    style: f.w && f.h ? `aspect-ratio: ${f.w} / ${f.h}` : null,
  });
  img.onerror = () => img.classList.add('missing');
  return h('div', { class: 'c-media' }, img,
    imgs.length > 1 ? h('span', { class: 'c-more-img' }, '+' + (imgs.length - 1)) : null);
}

function cardDocs(docs) {
  return h('div', { class: 'c-files' }, docs.map(f =>
    h('a', { class: 'c-file', href: fileUrl(f), target: '_blank', rel: 'noopener', title: f.name },
      icon('file'), h('span', null, f.name))));
}

// The "Attachments" view: every file in live, non-trashed notes, in the
// note grid's sort order (sortBy, SORTS in app.js). The date sorts use the
// file's own upload time; the others sort by the note, newest file first
// inside a note. With "Group by category" on (groupCats) the tiles are
// grouped like the grid, with the same collapsible sections (collapsed, per
// device).
const tileAt = ([f, n]) => f.at || n.createdAt;
function tileCmp(key) {
  if (key === 'created') return (a, b) => tileAt(b) - tileAt(a);
  if (key === 'createdAsc') return (a, b) => tileAt(a) - tileAt(b);
  const cmp = SORTS[key].cmp;
  return (a, b) => cmp(a[1], b[1]) || tileAt(b) - tileAt(a);
}

function galleryTiles(tiles) {
  return h('div', { class: 'gallery' }, tiles.map(([f, n]) =>
    h('div', { class: 'tile' + (isImage(f) ? '' : ' tile-doc'), tabindex: '0', dataset: { id: n.id }, title: f.name + (n.title ? ' — ' + n.title : '') },
      isImage(f)
        ? h('img', { src: fileUrl(f, true), alt: f.name, loading: 'lazy' })
        : [icon('file'), h('span', { class: 'tile-name' }, f.name)])));
}

function renderGallery(q) {
  const tiles = [];
  for (const n of notes.values()) {
    if (n.deleted || n.trashed || isSettings(n)) continue;
    for (const f of n.files) {
      if (q && !(f.name.toLowerCase().includes(q) || matches(n, q))) continue;
      tiles.push([f, n]);
    }
  }
  tiles.sort(tileCmp(sortBy));
  const parts = [];
  if (groupCats && !q) {
    const groups = new Map(orderedCats().filter(c => !catParent(c)).map(c => [c.term.toLowerCase(), [c.term, []]]));
    const none = [];
    for (const t of tiles) {
      const term = t[1].theme && mainTerm(t[1].theme.term); // subs sit in their main category
      if (!term) { none.push(t); continue; }
      if (!groups.has(term.toLowerCase())) groups.set(term.toLowerCase(), [term, []]);
      groups.get(term.toLowerCase())[1].push(t);
    }
    const sections = [...groups.values()].filter(([, ts]) => ts.length).map(([term, ts]) => [nameOf(term), ts, term.toLowerCase()]);
    if (none.length) sections.push(['No category', none, '']);
    for (const [label, ts, key] of sections) {
      const shut = collapsed.has(key);
      parts.push(h('div', { class: 'gallery-group group' + (shut ? ' shut' : '') },
        h('h2', { class: 'section-label' },
          h('button', { class: 'group-btn', type: 'button', 'aria-expanded': String(!shut), dataset: { group: key } },
            icon('chev'), h('span', null, label), h('span', { class: 'group-n' }, String(ts.length)))),
        shut ? null : galleryTiles(ts)));
    }
  } else if (tiles.length) parts.push(galleryTiles(tiles));
  board.replaceChildren(...parts);
  emptyEl.hidden = tiles.length > 0;
  $('p', emptyEl).textContent = q ? 'No matching notes' : 'Files you attach appear here';
}
