#!/usr/bin/env node
// Take the README screenshots and the demo GIF from a demo server.
//
//   MYNOTES_DB=/tmp/kee-demo/notes.db PORT=8765 python3 server.py   # other shell
//   python3 tools/seed_demo.py http://localhost:8765
//   node tools/screenshots.mjs http://localhost:8765
//
// Drives `chromium --headless=new` over the DevTools protocol with Node's
// built-in WebSocket (Node 22+); no npm packages. Each run uses a fresh
// browser profile, so nothing from a real browser leaks in. Writes PNGs to
// docs/screenshots/ and, if ffmpeg is installed, the GIFs next to them.
// The GIF scenes change the demo data, so seed a fresh server for each run.

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
const PHONE = { name: 'phone', width: 390, height: 844, mobile: true };

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
  await waitFor(cdp, `[...document.images].every(i => i.complete)`);
  await evaluate(cdp, `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
  await sleep(400);
}

async function shot(cdp, file) {
  await settle(cdp);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, file), Buffer.from(data, 'base64'));
  console.log('wrote', file);
}

async function setup(cdp, dev, scheme, prefs = {}) {
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

const noteId = title => `[...notes.values()].find(n => n.title === ${JSON.stringify(title)}).id`;

async function screenshots(cdp) {
  for (const scheme of ['light', 'dark']) {
    for (const dev of [DESKTOP, PHONE]) {
      const tag = `${dev.name}-${scheme}`;
      await setup(cdp, dev, scheme, { 'mn.group': false });
      await shot(cdp, `notes-${tag}.png`);

      await evaluate(cdp, `openModal(${noteId('Lisbon in May')})`);
      await evaluate(cdp, `document.activeElement && document.activeElement.blur()`);
      await shot(cdp, `editor-${tag}.png`);
      await evaluate(cdp, `closeModal()`);

      if (dev === PHONE) continue; // the rest reads best on desktop
      await setup(cdp, dev, scheme, { 'mn.group': true, 'mn.catGroup': true, 'mn.navShow': 'both' });
      await shot(cdp, `categories-${tag}.png`);
      // A main category with subs: grouped by sub, unfolded in the sidebar.
      await evaluate(cdp, `setView('cat:travel')`);
      await shot(cdp, `category-view-${tag}.png`);
      // Search inside the category: the chip in the search box.
      await evaluate(cdp, `search.value = 'tram'; search.dispatchEvent(new Event('input', { bubbles: true }))`);
      await shot(cdp, `search-chip-${tag}.png`);
      await evaluate(cdp, `clearSearch()`);
      // The category picker: mains with their subs, one box each.
      await evaluate(cdp, `openModal(${noteId('Where to eat in Lisbon')})`);
      await evaluate(cdp, `document.querySelector('#modalEditor [data-a="color"]').click()`);
      await waitFor(cdp, `!pal.hidden`);
      await shot(cdp, `palette-${tag}.png`);
      await evaluate(cdp, `closePalette(); closeModal()`);
      await evaluate(cdp, `setView('attachments')`);
      await shot(cdp, `attachments-${tag}.png`);
      await evaluate(cdp, `setView('settings'); showSetTab('categories')`);
      await shot(cdp, `settings-${tag}.png`);
    }
  }
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
    'border-radius:50%;background:rgba(30,30,30,.35);border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);' +
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
const blur = cdp => evaluate(cdp, `document.activeElement && document.activeElement.blur()`);

// Quick capture: type a note, save with Ctrl+Enter, see it land.
async function gifCapture(cdp) {
  const r = recorder(cdp);
  await setup(cdp, DESKTOP, 'light', { 'mn.group': false });
  await settle(cdp);
  await r.frame(8);
  await r.click(`document.querySelector('#composer')`);
  await evaluate(cdp, `document.querySelector('#composer .ed-title').focus()`);
  await r.type('Call the plumber');
  await evaluate(cdp, `document.querySelector('#composer .ed-body').focus()`);
  await r.type('Kitchen tap drips. Tuesday after 4 pm works.', 3);
  await r.frame(4);
  await r.key('Enter', 'Enter', 13, 2); // Ctrl+Enter: save and start the next note
  await blur(cdp);
  await settle(cdp);
  await r.frame(20);
  r.save('demo.gif');
}

// Theming: type a word, get a generated background; tune it in Settings.
async function gifTheming(cdp) {
  const r = recorder(cdp);
  await setup(cdp, DESKTOP, 'light', { 'mn.group': false });
  await settle(cdp);
  await r.frame(6);
  await r.click(card('Podcast recommendations'));
  await blur(cdp);
  await r.hold(600);
  await r.click(`document.querySelector('#modalEditor [data-a="color"]')`);
  await r.hold(500);
  await r.click(`document.querySelector('#palette .cat-input')`);
  await r.type('music', 1);
  await r.key('Enter', 'Enter', 13, 0, '\r');
  await blur(cdp);
  await r.hold(1200);
  await r.click(`document.querySelector('#modalEditor [data-a="color"]')`);
  await r.hold(500);
  await r.click(`document.querySelector('#palette .cat-input')`);
  await r.type('ocean', 1);
  await r.key('Enter', 'Enter', 13, 0, '\r');
  await blur(cdp);
  await r.hold(1200);
  await evaluate(cdp, `closeModal()`);
  await settle(cdp);
  await r.hold(800);
  await r.click(`document.querySelector('#settingsBtn')`);
  await settle(cdp);
  await r.hold(500);
  await r.click(`document.querySelector('#setTab-categories')`);
  await r.hold(500);
  const row = `document.querySelector('.set-pane .cat[data-term="ocean"]')`;
  await r.click(`${row}.querySelector('[data-toggle]')`);
  await r.hold(600);
  const slider = k => `${row}.querySelector('input[data-k="${k}"]')`;
  await r.slide(slider('h'), [...range(0, 120, 10), ...range(110, -60, -10)]);
  await r.slide(slider('c'), range(0, 60, 5));
  await r.hold(1500);
  r.save('theming.gif');
}

// Sorting: Keep has none. Group by category, collapse groups, resize cards.
async function gifSorting(cdp) {
  const r = recorder(cdp);
  await setup(cdp, DESKTOP, 'light', { 'mn.group': false });
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
  await r.hold(1500);
  await r.click(`document.querySelector('#board [data-group="books"]')`);
  await settle(cdp);
  await r.hold(600);
  await r.click(`document.querySelector('#board [data-group="garden"]')`);
  await settle(cdp);
  await r.hold(1200);
  await r.click(`document.querySelector('#zoomBtn')`);
  await r.hold(500);
  const zoom = `document.querySelector('#zoomMenu input[type=range]')`;
  const z = await evaluate(cdp, `(() => { const e = ${zoom}; return [Number(e.min), Number(e.max), Number(e.value)]; })()`);
  const step = Math.max(1, Math.round((z[1] - z[0]) / 15));
  await r.slide(zoom, [...range(z[2], z[0], -step), ...range(z[0], z[1], step), ...range(z[1], z[2], -step)]);
  await r.hold(1200);
  r.save('sorting.gif');
}

// Categories: each one is a sidebar view; a note written there joins it.
async function gifCategories(cdp) {
  const r = recorder(cdp);
  await setup(cdp, DESKTOP, 'dark', { 'mn.group': false });
  await settle(cdp);
  await r.frame(6);
  await r.click(`document.querySelector('#sidebar [data-view="cat:travel"]')`);
  await settle(cdp);
  await r.hold(1200);
  await r.click(`document.querySelector('#sidebar [data-view="cat:recipes"]')`);
  await settle(cdp);
  await r.hold(1000);
  await r.click(`document.querySelector('#sidebar [data-view="cat:travel"]')`);
  await settle(cdp);
  await r.hold(500);
  await r.click(`document.querySelector('#composer')`);
  await evaluate(cdp, `document.querySelector('#composer .ed-title').focus()`);
  await r.type('Weekend in the Alps');
  await evaluate(cdp, `document.querySelector('#composer .ed-body').focus()`);
  await r.type('Train Friday 17:12. Hut booked for 2 nights.', 3);
  await r.frame(4);
  await r.key('Enter', 'Enter', 13, 2);
  await blur(cdp);
  await settle(cdp);
  await r.hold(1200);
  await r.click(`document.querySelector('#sidebar [data-view="notes"]')`);
  await settle(cdp);
  await r.hold(1800);
  r.save('categories.gif');
}

// Keyboard: a key per category, Alt+Down steps through them, subs included.
async function gifKeyboard(cdp) {
  const r = recorder(cdp);
  await setup(cdp, DESKTOP, 'light', { 'mn.group': false, 'mn.navShow': 'both' });
  await blur(cdp);
  await settle(cdp);
  await r.frame(8);
  // Headless keys leave no trace, so show each one as a badge.
  const badge = label => evaluate(cdp, `(() => {
    let b = document.getElementById('demo-key');
    if (!b) { b = document.createElement('div'); b.id = 'demo-key'; document.body.append(b);
      b.style.cssText = 'position:fixed;z-index:99999;right:24px;bottom:24px;padding:10px 18px;border-radius:10px;' +
        'background:rgba(20,20,20,.82);color:#fff;font:600 22px system-ui;box-shadow:0 2px 10px rgba(0,0,0,.3)'; }
    b.textContent = ${JSON.stringify(label)};
  })()`);
  const keyOf = term => evaluate(cdp, `[...navKeyMap].find(([, t]) => t === ${JSON.stringify(term)})[0]`);
  for (const term of ['recipes', 'books', 'travel']) {
    const k = await keyOf(term);
    await badge(k.toUpperCase());
    await r.key(k, 'Digit' + k, k.toUpperCase().charCodeAt(0), 0, k);
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
async function gifs(cdp) {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) {
    console.log('ffmpeg not found: skipping the GIFs');
    return;
  }
  await gifKeyboard(cdp); // changes nothing, so first
  await gifCapture(cdp);
  await gifSorting(cdp);
  await gifCategories(cdp);
  await gifTheming(cdp);
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
  await screenshots(cdp);
  await gifs(cdp);
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
