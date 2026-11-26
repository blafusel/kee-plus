#!/usr/bin/env node
// Take the README screenshots and the demo GIF from a demo server.
//
//   MYNOTES_DB=/tmp/kee-demo/notes.db PORT=8765 python3 server.py   # other shell
//   python3 tools/seed_demo.py http://localhost:8765
//   node tools/screenshots.mjs http://localhost:8765
//   node tools/screenshots.mjs http://localhost:8765 drag-drop.gif   # one GIF
//
// Drives `chromium --headless=new` over the DevTools protocol with Node's
// built-in WebSocket (Node 22+); no npm packages. Each run uses a fresh
// browser profile, so nothing from a real browser leaks in. Writes PNGs to
// docs/screenshots/ and, if ffmpeg is installed, the GIFs next to them.
// Everything is taken in dark mode. The GIF scenes change the demo data, so
// seed a fresh server for each run.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.argv[2] || 'http://localhost:8765').replace(/\/$/, '') + '/';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'screenshots');
// Port 0: Chromium picks a free port and writes it to DevToolsActivePort in
// the profile. A fixed port could attach to another tool's browser.
const CHROME = process.env.CHROME || 'chromium';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DESKTOP = { name: 'desktop', width: 1280, height: 820, mobile: false };

async function cdpConnect(profile) {
  for (let i = 0; i < 50; i++) {
    try {
      const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find(p => p.type === 'page');
      if (page) return client(page.webSocketDebuggerUrl);
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('Chromium did not start');
}

function client(url) {
  const ws = new WebSocket(url);
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) {
      const { resolve, reject } = waiting.get(m.id);
      waiting.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return new Promise(res => { ws.onopen = () => res({ send, close: () => ws.close() }); });
}

async function evaluate(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${expr}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
}

async function waitFor(cdp, expr, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await evaluate(cdp, `(() => { try { return !!(${expr}); } catch { return false; } })()`)) return;
    await sleep(100);
  }
  throw new Error('Timed out waiting for ' + expr);
}

// Let layout and images settle before a shot.
async function settle(cdp) {
  // Lazy images below the fold never load; wait only for the ones in view.
  await waitFor(cdp, `[...document.images].every(i => i.complete || i.getBoundingClientRect().top > innerHeight)`);
  await evaluate(cdp, `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
  await sleep(400);
}

async function shot(cdp, file, clip) {
  await settle(cdp);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  writeFileSync(join(OUT, file), Buffer.from(data, 'base64'));
  console.log('wrote', file);
}

async function setup(cdp, dev, prefs = {}, scheme = 'dark') {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: dev.width, height: dev.height, deviceScaleFactor: dev.mobile ? 2 : 1, mobile: dev.mobile,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: dev.mobile, ...(dev.mobile ? { maxTouchPoints: 5 } : {}) });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  // Start every config from a clean origin: notes come fresh from the server.
  await cdp.send('Page.navigate', { url: BASE + 'favicon.ico' });
  await sleep(200);
  await evaluate(cdp, `localStorage.clear(); ${Object.entries(prefs).map(([k, v]) =>
    `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(JSON.stringify(v))});`).join('')}`);
  await cdp.send('Page.navigate', { url: BASE });
  await waitFor(cdp, `notes.size > 20 && document.querySelectorAll('#board .card').length > 0`);
  // The composer autofocuses on load; blur it so no caret shows.
  await evaluate(cdp, `document.activeElement && document.activeElement.blur()`);
}

const blur = cdp => evaluate(cdp, `document.activeElement && document.activeElement.blur()`);
const noteId = title => `[...notes.values()].find(n => n.title === ${JSON.stringify(title)}).id`;

const TALL = { ...DESKTOP, height: 1180 };
const view = term => `setView('cat:' + categories().find(c => catName(c) === ${JSON.stringify(term)}).term)`;

async function screenshots(cdp) {
  // Notes, ungrouped: the masonry board.
  await setup(cdp, DESKTOP, { 'mn.group': false });
  await shot(cdp, 'notes-desktop.png');
  // Background patterns instead of flat colours.
  await evaluate(cdp, `setSettings({ catPatterns: true }); render()`);
  await shot(cdp, 'patterns-desktop.png');
  await evaluate(cdp, `setSettings({ catPatterns: false }); render()`);
  // Grouped by category and sub-category (the defaults).
  await setup(cdp, DESKTOP);
  await evaluate(cdp, `scrollTo(0, document.querySelector('[data-group="travel"]').getBoundingClientRect().top + scrollY - 80)`);
  await shot(cdp, 'grouped-desktop.png');
  await evaluate(cdp, `scrollTo(0, 0)`);
  // The sort menu: three sorts, both directions, grouping switches.
  await evaluate(cdp, `openSortMenu()`);
  await shot(cdp, 'sort-menu-desktop.png');
  await evaluate(cdp, `closeSortMenu()`);
  // A main category's view: grouped by its subs, counts and keys in the sidebar.
  await setup(cdp, DESKTOP, { 'mn.navShow': 'both' });
  await evaluate(cdp, view('Travel'));
  await shot(cdp, 'category-view-desktop.png');
  await evaluate(cdp, `setView('attachments')`);
  await shot(cdp, 'attachments-desktop.png');

  // A new note gets a new category from the palette: main/sub typed in.
  await setup(cdp, DESKTOP);
  await evaluate(cdp, `composer.root.click(); composer.title.focus()`);
  await evaluate(cdp, `composer.title.value = 'Basil cuttings'; composer.title.dispatchEvent(new Event('input', { bubbles: true }))`);
  await evaluate(cdp, `document.querySelector('#composer [data-a="color"]').click()`);
  await waitFor(cdp, `!pal.hidden`);
  await evaluate(cdp, `palInput.value = 'Garden/Herbs'`);
  await shot(cdp, 'palette-desktop.png');
  await evaluate(cdp, `closePalette(); composer.close()`);

  // Editors: rich text and Markdown, same note.
  await setup(cdp, DESKTOP);
  await evaluate(cdp, `openModal(${noteId('Local LLM setup')})`);
  await blur(cdp);
  await shot(cdp, 'editor-rich-desktop.png');
  await evaluate(cdp, `closeModal()`);
  await setup(cdp, DESKTOP, { 'mn.editMode': 'md' });
  await evaluate(cdp, `openModal(${noteId('Local LLM setup')})`);
  await blur(cdp);
  await shot(cdp, 'editor-markdown-desktop.png');
  await evaluate(cdp, `closeModal()`);

  // The sidebar's shortcuts list and its formatting tab.
  await setup(cdp, DESKTOP, { 'mn.navHide': [] });
  const side = await evaluate(cdp, `(() => { const r = document.querySelector('#sidebar').getBoundingClientRect(); return { x: 0, y: r.top, width: Math.round(r.width), height: Math.round(r.height) }; })()`);
  await evaluate(cdp, `document.querySelector('#hintTab-keys').click()`);
  await shot(cdp, 'shortcuts-desktop.png', side);
  await evaluate(cdp, `document.querySelector('#hintTab-fmt').click()`);
  await shot(cdp, 'shortcuts-format-desktop.png', side);

  // Settings: a main category open (colour, fine-tune, icon), the Icons
  // tab with the owner's words, the Import tab.
  await setup(cdp, TALL);
  await evaluate(cdp, `setView('settings'); showSetTab('categories'); openCat = categories().find(c => catName(c) === 'Travel').term; tuneOpen = true; render()`);
  await evaluate(cdp, `scrollTo(0, document.querySelector('.set-pane .cat.open').getBoundingClientRect().top + scrollY - 150)`);
  await shot(cdp, 'settings-categories-desktop.png');
  await setup(cdp, { ...DESKTOP, height: 1540 });
  await evaluate(cdp, `setView('settings'); showSetTab('icons'); icoFind.value = 'person'; renderIcons(); scrollTo(0, 0)`);
  await shot(cdp, 'settings-icons-desktop.png');
  await setup(cdp, TALL);
  await evaluate(cdp, `setView('settings')`);
  await evaluate(cdp, `icoFind.value = ''; showSetTab('import'); scrollTo(0, 0)`);
  await shot(cdp, 'import-desktop.png', { x: 0, y: 0, width: 1280, height: 720 });
  await evaluate(cdp, `showSetTab('general')`);
}

// --- GIFs -------------------------------------------------------------------
// Each scene records frames at 10 fps while it drives the page with real
// mouse and key events. A drawn cursor dot shows where the clicks go
// (headless Chromium has no visible pointer).

const CURSOR = `(() => {
  if (document.getElementById('demo-cursor')) return;
  const c = document.createElement('div');
  c.id = 'demo-cursor';
  c.style.cssText = 'position:fixed;z-index:99999;left:640px;top:410px;width:22px;height:22px;margin:-11px 0 0 -11px;' +
    'border-radius:50%;background:rgba(255,255,255,.35);border:2px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.8);' +
    'pointer-events:none;transition:left .35s ease,top .35s ease,transform .15s';
  document.body.append(c);
})()`;

function recorder(cdp) {
  const dir = mkdtempSync(join(tmpdir(), 'kee-frames-'));
  let n = 0;
  const r = {
    async frame(repeat = 1) {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      for (let i = 0; i < repeat; i++) writeFileSync(join(dir, `f${String(n++).padStart(4, '0')}.png`), Buffer.from(data, 'base64'));
    },
    // Frames over `ms` while something animates.
    async hold(ms) {
      for (let t = 0; t < ms; t += 100) { await r.frame(); await sleep(60); }
    },
    async type(text, every = 2) {
      for (let i = 0; i < text.length; i++) {
        await cdp.send('Input.insertText', { text: text[i] });
        if (i % every === every - 1) await r.frame();
      }
      await r.frame();
    },
    async key(key, code, vk, modifiers = 0, text) {
      const k = { key, code, windowsVirtualKeyCode: vk, modifiers };
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k, ...(text ? { text } : {}) });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
    },
    // Move the cursor dot to the element `expr` returns, then click it.
    async click(expr) {
      await evaluate(cdp, CURSOR);
      const p = await evaluate(cdp, `(() => { const e = ${expr}; if (!e) return null; e.scrollIntoView({ block: 'nearest' });
        const b = e.getBoundingClientRect(); const x = b.left + Math.min(b.width / 2, 60), y = b.top + b.height / 2;
        const c = document.getElementById('demo-cursor'); c.style.left = x + 'px'; c.style.top = y + 'px'; return { x, y }; })()`);
      if (!p) throw new Error('Nothing to click: ' + expr);
      await r.hold(400);
      await evaluate(cdp, `document.getElementById('demo-cursor').style.transform = 'scale(.7)'`);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
      }
      await evaluate(cdp, `document.getElementById('demo-cursor').style.transform = ''`);
    },
    // Slide a range input through `values`, firing input events, then change.
    async slide(expr, values) {
      for (const v of values) {
        await evaluate(cdp, `(() => { const e = ${expr}; e.value = ${v}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await r.frame();
      }
      await evaluate(cdp, `(${expr}).dispatchEvent(new Event('change', { bubbles: true }))`);
    },
    save(file, width = 960) {
      const out = join(OUT, file);
      const res = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '10', '-i', join(dir, 'f%04d.png'),
        '-vf', `scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer`,
        out], { stdio: 'inherit' });
      rmSync(dir, { recursive: true, force: true });
      if (res.status !== 0) throw new Error('ffmpeg failed for ' + file);
      console.log('wrote', file);
    },
  };
  return r;
}

const range = (from, to, step) => {
  const out = [];
  for (let v = from; step > 0 ? v <= to : v >= to; v += step) out.push(v);
  return out;
};
const card = title => `document.querySelector('#board .card[data-id="' + ${noteId(title)} + '"]')`;

// Quick capture: type a note, save with Ctrl+Enter, see it land.
async function gifCapture(cdp) {
  const r = recorder(cdp);
  await setup(cdp, DESKTOP, { 'mn.group': false });
  await settle(cdp);
  await r.frame(8);
  await r.click(`document.querySelector('#composer')`);
  await evaluate(cdp, `composer.title.focus()`);
  await r.type('Call the plumber');
  await evaluate(cdp, `composer.bodyEl.focus()`);
  await r.type('Kitchen tap drips. Tuesday after 4 pm works.', 3);
  await r.frame(4);
  await r.key('Enter', 'Enter', 13, 2); // Ctrl+Enter: save and start the next note
  await blur(cdp);
  await settle(cdp);
  await r.frame(20);
  r.save('demo.gif');
}

// A new category while writing a note: palette, "main/sub", Enter.
async function gifNewCategory(cdp) {
  const r = recorder(cdp);
  await setup(cdp, DESKTOP);
  await settle(cdp);
  await r.frame(6);
  await r.click(`document.querySelector('#composer')`);
  await evaluate(cdp, `composer.title.focus()`);
  await r.type('Basil cuttings');
  await evaluate(cdp, `composer.bodyEl.focus()`);
  await r.type('Root them in water, pot up after 2 weeks.', 3);
  await r.frame(3);
  await r.click(`document.querySelector('#composer [data-a="color"]')`);
  await r.hold(700);
  await r.click(`palInput`);
  await r.type('Garden/Herbs', 1);
  await r.hold(400);
  await r.key('Enter', 'Enter', 13, 0, '\r');
  await r.hold(1000);
  await evaluate(cdp, `composer.bodyEl.focus()`);
  await r.key('Enter', 'Enter', 13, 2);
  await blur(cdp);
  await settle(cdp);
  await r.hold(800);
  await r.click(`document.querySelector('#sidebar [data-view="cat:' + categories().find(c => catName(c) === 'Garden').term + '"]')`);
  await settle(cdp);
  await r.hold(1800);
  r.save('new-category.gif');
}

// Sorting and grouping: Keep has neither.
async function gifSorting(cdp) {
  const r = recorder(cdp);
  await setup(cdp, DESKTOP, { 'mn.group': false });
  await settle(cdp);
  await r.frame(8);
  await r.click(`document.querySelector('#sortBtn')`);
  await r.hold(700);
  await r.click(`document.querySelector('#sortMenu [data-sort="title"]')`);
  await settle(cdp);
  await r.hold(1200);
  await r.click(`document.querySelector('#sortBtn')`);
  await r.hold(500);
  await r.click(`document.querySelector('#sortMenu [data-group-toggle]')`);
  await settle(cdp);
  await r.hold(1600);
  await r.click(`document.querySelector('#sortBtn')`);
  await r.hold(500);
  await r.click(`document.querySelector('#sortMenu [data-subs-toggle]')`);
  await settle(cdp);
  await r.hold(1300);
  await r.click(`document.querySelector('#sortBtn')`);
  await r.hold(500);
  await r.click(`document.querySelector('#sortMenu [data-subs-toggle]')`);
  await settle(cdp);
  await r.hold(1000);
  await r.click(`document.querySelector('#board [data-group="ai"]')`);
  await settle(cdp);
  await r.hold(1000);
  await r.click(`document.querySelector('#zoomBtn')`);
  await r.hold(500);
  const zoom = `document.querySelector('#zoomMenu input[type=range]')`;
  const z = await evaluate(cdp, `(() => { const e = ${zoom}; return [Number(e.min), Number(e.max), Number(e.value)]; })()`);
  const step = Math.max(1, Math.round((z[1] - z[0]) / 15));
  await r.slide(zoom, [...range(z[2], z[0], -step), ...range(z[0], z[1], step), ...range(z[1], z[2], -step)]);
  await r.hold(1200);
  r.save('sorting.gif');
}

// Colours and icons in Settings: swatch, fine-tune, icon, then patterns.
async function gifColours(cdp) {
  const r = recorder(cdp);
  await setup(cdp, DESKTOP);
  await settle(cdp);
  await r.frame(6);
  await r.click(`document.querySelector('#settingsBtn')`);
  await settle(cdp);
  await r.hold(400);
  await r.click(`document.querySelector('#setTab-categories')`);
  await r.hold(500);
  const row = `[...document.querySelectorAll('.set-pane .cat')].find(x => catName(findCategory(x.dataset.term)) === 'Travel')`;
  await r.click(`${row}.querySelector('[data-toggle]')`);
  await r.hold(700);
  await r.click(`${row}.querySelector('[data-swatch="cyan"]')`);
  await r.hold(700);
  await r.click(`${row}.querySelector('[data-swatch="orange"]')`);
  await r.hold(700);
  await r.click(`${row}.querySelector('.cat-tune summary')`);
  await r.hold(500);
  const slider = k => `${row}.querySelector('input[data-k="${k}"]')`;
  await r.slide(slider('h'), [...range(0, 30, 4), ...range(26, -20, -4), ...range(-16, 0, 4)]);
  await r.slide(slider('c'), range(0, 60, 6));
  await r.hold(600);
  await r.click(`${row}.querySelector('[data-icon="globe"]')`);
  await r.hold(1000);
  await evaluate(cdp, `scrollTo({ top: 0 })`);
  await r.hold(300);
  await r.click(`catPatternsBox`);
  await r.hold(600);
  await r.click(`document.querySelector('#brand')`);
  await settle(cdp);
  await r.hold(2200);
  r.save('colours.gif');
}

// Drag and drop: file a note by dropping it on a sidebar category, then a
// selection of two at once. Headless Chromium draws no drag image, so the
// scene moves a faded copy of the card with the cursor, and fires the same
// DragEvents a real drag would (dragstart, dragover, drop, dragend).
async function gifDragDrop(cdp) {
  const r = recorder(cdp);
  await setup(cdp, DESKTOP, { 'mn.group': false, 'mn.navShow': 'counts' });
  await evaluate(cdp, `${card('App idea')}.scrollIntoView({ block: 'center' })`);
  await settle(cdp);
  await r.frame(6);
  const catEntry = name => `document.querySelector('#navCats [data-view="cat:' + categories().find(c => catName(c) === ${JSON.stringify(name)}).term + '"]')`;
  async function drag(cardExpr, targetExpr) {
    await evaluate(cdp, CURSOR);
    // Cards are draggable only with a mouse (pointer: fine), which headless
    // Chromium never reports, even with media emulation.
    const from = await evaluate(cdp, `(() => { const k = ${cardExpr}; k.draggable = true; k.scrollIntoView({ block: 'nearest' }); const b = k.getBoundingClientRect();
      const g = k.cloneNode(true); g.id = 'demo-ghost';
      g.style.cssText = 'position:fixed;z-index:99998;pointer-events:none;margin:0;opacity:.8;width:' + b.width + 'px;left:0;top:0;' +
        'transform-origin:0 0;box-shadow:0 8px 24px rgba(0,0,0,.6);transition:none';
      document.body.append(g);
      window.__dt = new DataTransfer();
      k.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: __dt }));
      return { x: b.left + 40, y: b.top + 30, ox: 40, oy: 30 }; })()`);
    await sleep(50);
    const to = await evaluate(cdp, `(() => { const t = ${targetExpr}; const b = t.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 }; })()`);
    const steps = 14;
    for (let i = 0; i <= steps; i++) {
      const f = i / steps, e = f < .5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
      const x = from.x + (to.x - from.x) * e, y = from.y + (to.y - from.y) * e;
      await evaluate(cdp, `(() => {
        const c = document.getElementById('demo-cursor'); c.style.transition = 'none'; c.style.left = ${x} + 'px'; c.style.top = ${y} + 'px';
        const g = document.getElementById('demo-ghost'); g.style.transform = 'translate(' + (${x} - ${from.ox} * .6) + 'px,' + (${y} - ${from.oy} * .6) + 'px) scale(.6)';
        const el = document.elementFromPoint(${x}, ${y});
        if (el) el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y}, dataTransfer: __dt }));
      })()`);
      await r.frame();
    }
    await r.hold(500);
    await evaluate(cdp, `(() => {
      const el = document.elementFromPoint(${to.x}, ${to.y});
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: ${to.x}, clientY: ${to.y}, dataTransfer: __dt }));
      document.getElementById('demo-ghost').remove();
      board.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: __dt }));
      document.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
      document.getElementById('demo-cursor').style.transition = '';
    })()`);
    await settle(cdp);
    await r.hold(1600);
  }
  // The select circle shows on hover only, which headless Chromium lacks:
  // point the cursor at the card's corner and click the circle in the page.
  async function select(cardExpr) {
    await evaluate(cdp, CURSOR);
    await evaluate(cdp, `(() => { const b = ${cardExpr}.getBoundingClientRect(); const c = document.getElementById('demo-cursor');
      c.style.left = (b.left + 14) + 'px'; c.style.top = (b.top + 14) + 'px'; })()`);
    await r.hold(400);
    await evaluate(cdp, `${cardExpr}.querySelector('.c-sel').click()`);
    await r.frame();
  }
  await drag(card('App idea'), catEntry('Work'));
  // Select two notes, then drag one of them: both move.
  await evaluate(cdp, `${card('Door code')}.scrollIntoView({ block: 'center', behavior: 'smooth' })`);
  for (let i = 0; i < 10; i++) await r.frame();
  await r.hold(300);
  await select(card('Door code'));
  await r.hold(300);
  await select(card('Car service'));
  await r.hold(700);
  await drag(card('Car service'), catEntry('Family'));
  await r.hold(800);
  await evaluate(cdp, `syncNow()`);
  r.save('drag-drop.gif');
}

// Keyboard: a key per category, Alt+Down steps through them, subs included.
async function gifKeyboard(cdp) {
  const r = recorder(cdp);
  await setup(cdp, DESKTOP, { 'mn.group': false, 'mn.navShow': 'both' });
  await blur(cdp);
  await settle(cdp);
  await r.frame(8);
  // Headless keys leave no trace, so show each one as a badge.
  const badge = label => evaluate(cdp, `(() => {
    let b = document.getElementById('demo-key');
    if (!b) { b = document.createElement('div'); b.id = 'demo-key'; document.body.append(b);
      b.style.cssText = 'position:fixed;z-index:99999;right:24px;bottom:24px;padding:10px 18px;border-radius:10px;' +
        'background:rgba(240,240,240,.9);color:#111;font:600 22px system-ui;box-shadow:0 2px 10px rgba(0,0,0,.5)'; }
    b.textContent = ${JSON.stringify(label)};
  })()`);
  const keyOf = name => evaluate(cdp, `[...navKeyMap].find(([, t]) => sameTerm(t, categories().find(c => catName(c) === ${JSON.stringify(name)}).term))[0]`);
  for (const name of ['Recipes', 'Books', 'Travel']) {
    const k = await keyOf(name);
    await badge(k.toUpperCase());
    const code = /\d/.test(k) ? 'Digit' + k : 'Key' + k.toUpperCase();
    await r.key(k, code, k.toUpperCase().charCodeAt(0), 0, k);
    await settle(cdp);
    await r.hold(900);
  }
  for (let i = 0; i < 4; i++) {
    await badge('Alt + ↓');
    await r.key('ArrowDown', 'ArrowDown', 40, 1); // Alt+Down
    await settle(cdp);
    await r.hold(700);
  }
  await badge('A');
  await r.key('a', 'KeyA', 65, 0, 'a'); // back to all notes
  await settle(cdp);
  await r.hold(1200);
  r.save('keyboard.gif');
}

// Each scene changes the demo data, so they run after the screenshots, in
// this order. Run against a freshly seeded server.
const SCENES = { 'keyboard.gif': gifKeyboard, 'sorting.gif': gifSorting, 'drag-drop.gif': gifDragDrop,
  'demo.gif': gifCapture, 'new-category.gif': gifNewCategory, 'colours.gif': gifColours };
const ONLY = process.argv.slice(3); // GIF names to make; none: everything

async function gifs(cdp) {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) {
    console.log('ffmpeg not found: skipping the GIFs');
    return;
  }
  await gifKeyboard(cdp); // changes nothing, so first
  await gifSorting(cdp);
  await gifDragDrop(cdp);
  await gifCapture(cdp);
  await gifNewCategory(cdp);
  await gifColours(cdp); // changes Travel's look and turns patterns on: last
}

mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'kee-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-color-profile=srgb',
  'about:blank',
], { stdio: 'ignore' });

let code = 0;
try {
  const cdp = await cdpConnect(profile);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  if (ONLY.length) {
    for (const name of ONLY) {
      if (!SCENES[name]) throw new Error('Unknown scene ' + name + '; known: ' + Object.keys(SCENES).join(', '));
      await SCENES[name](cdp);
    }
  } else {
    await screenshots(cdp);
    await gifs(cdp);
  }
  cdp.close();
} catch (e) {
  console.error(e.message);
  code = 1;
} finally {
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
process.exit(code);
