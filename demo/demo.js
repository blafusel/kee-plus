// Kee+ online demo bootstrap. tools/build_demo.py puts this first in <head>.
// The app needs its "server" (sw.js) before it runs, so the first visit
// stops loading, installs the service worker and reloads once. Afterwards
// a small banner says it's a demo and offers Reset.
'use strict';
(function () {
  const fail = msg => { window.stop(); document.documentElement.innerHTML = '<body style="font:16px system-ui;padding:24px;background:#151413;color:#eee">' + msg + '</body>'; };
  if (!('serviceWorker' in navigator)) return fail('This demo needs a browser with service workers (not a private window in some browsers).');
  // After Reset: clear the app's local copy before the app runs. (Clearing
  // it before the reload doesn't stick: the app saves again on unload.)
  try {
    if (sessionStorage.getItem('kee-demo-reset')) {
      sessionStorage.removeItem('kee-demo-reset');
      for (const k of Object.keys(localStorage)) if (k.startsWith('mn.')) localStorage.removeItem(k);
    }
  } catch { /* storage blocked: the demo can't work anyway */ }
  const reg = navigator.serviceWorker.register('sw.js');
  if (!navigator.serviceWorker.controller) {
    window.stop(); // don't run the app without its server
    document.documentElement.innerHTML = '<body style="font:16px system-ui;padding:24px;background:#151413;color:#eee">Loading the Kee+ demo…</body>';
    let done = false;
    const go = () => { if (!done) { done = true; location.reload(); } };
    navigator.serviceWorker.addEventListener('controllerchange', go);
    reg.then(() => navigator.serviceWorker.ready).then(() => { if (navigator.serviceWorker.controller) go(); setTimeout(go, 3000); })
      .catch(e => fail('Could not start the demo: ' + e.message));
    return;
  }

  // The app keeps its copy in localStorage under mn.*; other pages on this
  // origin (github.io) keep theirs, so only ours are cleared (see above).
  function reset() {
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data !== 'reset-done') return;
      try { sessionStorage.setItem('kee-demo-reset', '1'); } catch { /* see above */ }
      location.reload();
    });
    navigator.serviceWorker.controller.postMessage('reset');
  }

  addEventListener('DOMContentLoaded', () => {
    const css = document.createElement('style');
    css.textContent = `
      .demo-pill { position: fixed; z-index: 70; left: 12px; bottom: 12px; display: flex; align-items: center; gap: 10px;
        padding: 6px 8px 6px 14px; border-radius: 18px; font: 13px system-ui, sans-serif;
        background: rgba(20, 20, 20, .88); color: #f2f2f2; box-shadow: 0 2px 10px rgba(0, 0, 0, .35); }
      .demo-pill a { color: #f0b400; }
      .demo-pill button { border: 0; border-radius: 12px; padding: 4px 10px; font: inherit; font-weight: 600;
        background: #f0b400; color: #1d1c1a; cursor: pointer; }
      .demo-pill .x { background: none; color: #bbb; padding: 4px 6px; }
      @media (max-width: 700px) { .demo-pill { left: 50%; transform: translateX(-50%); bottom: auto;
        top: calc(env(safe-area-inset-top) + 66px); white-space: nowrap; } }`;
    document.head.append(css);
    const pill = document.createElement('div');
    pill.className = 'demo-pill';
    pill.innerHTML = '<span><b>Demo</b> · notes stay in this browser · <a href="https://github.com/blafusel/kee-plus" target="_blank" rel="noopener">GitHub</a></span>';
    const r = document.createElement('button');
    r.type = 'button'; r.textContent = 'Reset'; r.title = 'Start again from the demo notes';
    r.addEventListener('click', reset);
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'x'; x.textContent = '✕'; x.title = 'Hide'; x.setAttribute('aria-label', 'Hide demo banner');
    x.addEventListener('click', () => pill.remove());
    pill.append(r, x);
    document.body.append(pill);
  });
})();
