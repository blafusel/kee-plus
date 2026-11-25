'use strict';
/*
 * Note themes: background images generated from a category term and a seed.
 *
 * No AI and no network. The term picks a hue range and a set of motifs:
 * from a small keyword table when it knows the word, from a hash of the
 * term otherwise. The seed picks one variation inside that. Notes store
 * { term, seed }, but applyTheme draws seed 0 for all of them, so every note
 * of a category looks the same on every device.
 *
 * Loaded before app.js; declarations only (event wiring lives in app.js).
 */

// [pattern, [hue from, hue to], motifs, saturation scale]
const THEME_HINTS = [
  [/\b(ocean|sea|beach|water|swim|surf|sail|lake|river|boat|fish|island|coast)/, [180, 215], ['waves', 'bubbles', 'waves']],
  [/\b(forest|tree|wood|garden|plant|nature|hike|hiking|park|leaf|green|flower)/, [85, 150], ['leaves', 'topo', 'blobs']],
  [/\b(mountain|travel|trip|vacation|holiday|journey|camp|outdoor|ski)/, [150, 210], ['hills', 'topo']],
  [/\b(fire|sun|summer|hot|energy|desert)/, [10, 45], ['rays', 'blobs']],
  [/\b(idea|thought|inspiration|brainstorm|creative|art|design|draw|paint)/, [40, 60], ['rays', 'confetti', 'blobs']],
  [/\b(work|office|job|project|meeting|business|career|task|todo)/, [205, 235], ['grid', 'stripes'], 0.7],
  [/\b(code|dev|tech|computer|software|server|nas)/, [160, 200], ['grid', 'dots'], 0.7],
  [/\b(money|finance|budget|bank|tax|invest|bill|expense|price)/, [120, 160], ['grid', 'dots']],
  [/\b(food|recipe|cook|cooking|kitchen|eat|dinner|lunch|breakfast|bake|coffee)/, [15, 40], ['dots', 'blobs', 'stripes']],
  [/\b(shop|shopping|buy|grocery|groceries|gift|wishlist)/, [290, 330], ['confetti', 'dots']],
  [/\b(love|family|kid|kids|home|friend|friends|baby|wedding|birthday)/, [330, 360], ['blobs', 'confetti', 'bubbles']],
  [/\b(health|sport|fitness|gym|run|running|workout|doctor|medical)/, [0, 15], ['stripes', 'waves']],
  [/\b(music|song|band|concert|guitar|piano|podcast)/, [260, 290], ['waves', 'rays']],
  [/\b(night|sleep|dream|space|star|stars|moon)/, [225, 260], ['stars'], 0.8],
  [/\b(book|books|read|reading|study|school|learn|learning|university|note|journal)/, [25, 45], ['stripes', 'topo'], 0.6],
  [/\b(winter|snow|ice|cold|christmas)/, [195, 215], ['stars', 'bubbles'], 0.5],
  [/\b(autumn|fall|harvest|halloween)/, [20, 40], ['leaves', 'blobs']],
  [/\b(car|bike|transport|commute|train|drive)/, [0, 360], ['stripes', 'grid'], 0.5],
];
const THEME_MOTIFS = ['waves', 'bubbles', 'leaves', 'topo', 'hills', 'rays', 'confetti', 'grid', 'dots', 'blobs', 'stripes', 'stars'];

// FNV-1a: a stable 32-bit number for a string.
function hashStr(s) {
  let x = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193); }
  return x >>> 0;
}

// mulberry32: small seeded PRNG, returns floats in [0, 1).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function newThemeSeed() { return crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff; }

// What a term means for the image: hue range, motifs, saturation.
function themeBase(term) {
  const t = term.trim().toLowerCase();
  for (const [re, hues, motifs, sat = 1] of THEME_HINTS) if (re.test(t)) return { hues, motifs, sat };
  const r = rng(hashStr(t));
  const h0 = Math.floor(r() * 360);
  const m = THEME_MOTIFS.filter(() => r() < 0.3);
  return { hues: [h0, h0 + 30], motifs: m.length ? m : [THEME_MOTIFS[hashStr(t) % THEME_MOTIFS.length]], sat: 0.6 + r() * 0.4 };
}

const f1 = n => Math.round(n * 10) / 10;

// Relative luminance (WCAG) of '#rrggbb' or 'hsl(h s% l%)'.
function luminance(color) {
  let rgb;
  const m = /^hsl\(\s*(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/.exec(color);
  if (m) {
    const h = ((+m[1] % 360) + 360) % 360, s = Math.min(1, m[2] / 100), l = Math.min(1, m[3] / 100);
    const a = s * Math.min(l, 1 - l), k = n => (n + h / 30) % 12;
    rgb = [0, 8, 4].map(n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)));
  } else {
    const n = parseInt(color.slice(1), 16);
    rgb = [n >> 16, (n >> 8) & 255, n & 255].map(x => x / 255);
  }
  const [r, g, b] = rgb.map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Text colour for a background: 'dark' or 'light' ink, whichever contrasts
// more (WCAG ratio against the two inks in app.css, --ink-dark/--ink-light).
const INK_LUM = { dark: luminance('#1d1c1a'), light: luminance('#ecebe7') };
function inkFor(color) {
  const L = luminance(color);
  return (L + 0.05) / (INK_LUM.dark + 0.05) >= (INK_LUM.light + 0.05) / (L + 0.05) ? 'dark' : 'light';
}

// A category's colour adjustment: h = hue shift in degrees (-180..180),
// s = saturation (0..4: up to 2 a factor on the term's own saturation, from
// 2 to 4 a blend up to full saturation), v = brightness shift (-1..1, a few
// lightness points), c = intensity (0..1: pulls the background from pale
// (light mode) or dark (dark mode) to mid lightness, so a theme can be a
// full, vivid colour; text colour follows through inkFor).
// Default for new categories, Reset, and categories saved before the sliders.
const NO_ADJ = { h: 0, s: 2, v: 1, c: 0 };
function cleanAdj(a) {
  const num = (x, lo, hi, d) => (typeof x === 'number' && isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d);
  return { h: num(a && a.h, -180, 180, 0), s: num(a && a.s, 0, 4, NO_ADJ.s), v: num(a && a.v, -1, 1, NO_ADJ.v), c: num(a && a.c, 0, 1, NO_ADJ.c) };
}

// Middle of the term's hue range: where the hue slider's track is centred.
function themeHue(term) {
  const { hues } = themeBase(term);
  return ((hues[0] + hues[1]) / 2) % 360;
}

// The SVG for one theme in one colour scheme. Contrast between background
// and motifs stays low on purpose: the note's text sits on top of it.
// Brightness moves the whole palette by a few lightness points; intensity
// moves it toward 50% lightness, keeping the motifs' offsets.
function themeSvg(term, seed, dark, adj = NO_ADJ) {
  const base = themeBase(term);
  const r = rng(hashStr(term.trim().toLowerCase()) ^ seed);
  const between = (a, b) => a + r() * (b - a);
  const pick = arr => arr[Math.floor(r() * arr.length)];
  // Draw from the generator in the same order whatever adj is, so sliders
  // recolour a variation without reshuffling its shapes.
  const hue = (between(base.hues[0], base.hues[1]) + adj.h + 720) % 360;
  const hue2 = (hue + between(-35, 35) + 360) % 360;
  const sat = x => {
    const at2 = Math.min(100, x * base.sat * Math.min(adj.s, 2));
    return f1(adj.s <= 2 ? at2 : at2 + (100 - at2) * (adj.s - 2) / 2);
  };
  const pull = adj.c * (50 - (dark ? 17 : 91)); // background to 50% at full intensity
  const L = x => f1(Math.min(100, Math.max(0, x + pull + adj.v * (dark ? 6 : 5))));
  const col = dark
    ? { bg: `hsl(${f1(hue)} ${sat(30)}% ${L(17)}%)`, a: `hsl(${f1(hue2)} ${sat(32)}% ${L(25)}%)`, b: `hsl(${f1(hue)} ${sat(28)}% ${L(22)}%)` }
    : { bg: `hsl(${f1(hue)} ${sat(60)}% ${L(91)}%)`, a: `hsl(${f1(hue2)} ${sat(55)}% ${L(82)}%)`, b: `hsl(${f1(hue)} ${sat(50)}% ${L(86)}%)` };
  const W = 300, H = 400;
  const motif = pick(base.motifs);
  const out = [];
  const fill = () => (r() < 0.5 ? col.a : col.b);
  const op = (lo = 0.5, hi = 0.95) => f1(between(lo, hi) * 10) / 10;

  switch (motif) {
    case 'waves': {
      const n = 4 + Math.floor(r() * 4), amp = between(8, 26), len = between(80, 180);
      for (let i = 0; i < n; i++) {
        const y0 = H * (0.25 + 0.75 * (i / n)) + between(-15, 15);
        let d = `M${f1(-between(0, len))} ${f1(y0)}`;
        for (let x = -len; x < W + len; x += len) d += ` q${f1(len / 4)} ${f1(-amp)} ${f1(len / 2)} 0 t${f1(len / 2)} 0`;
        out.push(`<path d="${d} V${H} H0Z" fill="${fill()}" opacity="${op(0.35, 0.7)}"/>`);
      }
      break;
    }
    case 'bubbles': case 'dots': {
      const n = motif === 'dots' ? 40 + Math.floor(r() * 50) : 14 + Math.floor(r() * 16);
      const [lo, hi] = motif === 'dots' ? [2, 7] : [6, 42];
      for (let i = 0; i < n; i++) {
        const rad = between(lo, hi);
        const ring = motif === 'bubbles' && r() < 0.4;
        out.push(`<circle cx="${f1(between(0, W))}" cy="${f1(between(0, H))}" r="${f1(rad)}" ${ring ? `fill="none" stroke="${fill()}" stroke-width="${f1(between(2, 5))}"` : `fill="${fill()}"`} opacity="${op()}"/>`);
      }
      break;
    }
    case 'blobs': {
      const n = 3 + Math.floor(r() * 4);
      for (let i = 0; i < n; i++) out.push(`<circle cx="${f1(between(-40, W + 40))}" cy="${f1(between(-40, H + 40))}" r="${f1(between(60, 170))}" fill="${fill()}" opacity="${op(0.4, 0.8)}"/>`);
      break;
    }
    case 'leaves': {
      const n = 10 + Math.floor(r() * 14);
      for (let i = 0; i < n; i++) {
        const x = between(-10, W + 10), y = between(-10, H + 10), l = between(24, 64), w = l * between(0.35, 0.55);
        out.push(`<path d="M0 0 Q${f1(w)} ${f1(l / 2)} 0 ${f1(l)} Q${f1(-w)} ${f1(l / 2)} 0 0Z" transform="translate(${f1(x)} ${f1(y)}) rotate(${f1(between(0, 360))})" fill="${fill()}" opacity="${op()}"/>`);
      }
      break;
    }
    case 'topo': {
      const cx = between(0, W), cy = between(0, H), rings = 9 + Math.floor(r() * 6), wob = [r(), r(), r()].map(v => v * 6.283);
      for (let i = 1; i <= rings; i++) {
        const R = i * between(20, 30);
        let d = '';
        for (let k = 0; k <= 48; k++) {
          const a = (k / 48) * 6.283;
          const rr = R * (1 + 0.12 * Math.sin(3 * a + wob[0]) + 0.08 * Math.sin(5 * a + wob[1] + i * 0.3));
          d += (k ? 'L' : 'M') + f1(cx + rr * Math.cos(a)) + ' ' + f1(cy + rr * Math.sin(a));
        }
        out.push(`<path d="${d}Z" fill="none" stroke="${i % 2 ? col.a : col.b}" stroke-width="2.5" opacity="${op(0.6, 1)}"/>`);
      }
      break;
    }
    case 'hills': {
      const n = 3 + Math.floor(r() * 3);
      for (let i = 0; i < n; i++) {
        const y = H * (0.45 + 0.5 * (i / n));
        let d = `M0 ${f1(y)}`;
        for (let x = 0; x <= W; x += 50) d += ` L${x} ${f1(y - between(0, 70))}`;
        out.push(`<path d="${d} L${W} ${H} L0 ${H}Z" fill="${i % 2 ? col.a : col.b}" opacity="${op(0.6, 0.9)}" stroke-linejoin="round"/>`);
      }
      break;
    }
    case 'rays': {
      const cx = pick([0, W, between(0, W)]), cy = pick([0, H, between(0, H)]), n = 10 + Math.floor(r() * 10);
      for (let i = 0; i < n; i += 2) {
        const a1 = (i / n) * 6.283, a2 = ((i + 1) / n) * 6.283, R = 700;
        out.push(`<path d="M${f1(cx)} ${f1(cy)} L${f1(cx + R * Math.cos(a1))} ${f1(cy + R * Math.sin(a1))} L${f1(cx + R * Math.cos(a2))} ${f1(cy + R * Math.sin(a2))}Z" fill="${fill()}" opacity="${op(0.4, 0.75)}"/>`);
      }
      out.push(`<circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(between(40, 90))}" fill="${col.a}"/>`);
      break;
    }
    case 'confetti': {
      const n = 30 + Math.floor(r() * 30);
      for (let i = 0; i < n; i++) {
        const w = between(5, 14), hgt = between(3, 7);
        out.push(`<rect x="${f1(-w / 2)}" y="${f1(-hgt / 2)}" width="${f1(w)}" height="${f1(hgt)}" rx="1.5" transform="translate(${f1(between(0, W))} ${f1(between(0, H))}) rotate(${f1(between(0, 180))})" fill="${fill()}" opacity="${op(0.7, 1)}"/>`);
      }
      break;
    }
    case 'grid': {
      const step = between(18, 34), rot = between(-20, 20);
      let d = '';
      for (let x = -H; x < W + H; x += step) d += `M${f1(x)} ${-H}V${2 * H}`;
      for (let y = -H; y < 2 * H; y += step) d += `M${-H} ${f1(y)}H${W + H}`;
      const cells = [];
      for (let i = 0; i < 8; i++) cells.push(`<rect x="${f1(Math.floor(between(0, W) / step) * step)}" y="${f1(Math.floor(between(0, H) / step) * step)}" width="${f1(step)}" height="${f1(step)}" fill="${col.a}" opacity="${op(0.6, 1)}"/>`);
      out.push(`<g transform="rotate(${f1(rot)} ${W / 2} ${H / 2})">${cells.join('')}<path d="${d}" stroke="${col.b}" stroke-width="1.5" fill="none"/></g>`);
      break;
    }
    case 'stripes': {
      const w = between(10, 40), rot = pick([-45, -30, 30, 45, 90, 0]) + between(-6, 6);
      const rects = [];
      for (let x = -H; x < W + H; x += w * between(1.6, 3)) rects.push(`<rect x="${f1(x)}" y="${-H}" width="${f1(w * between(0.4, 1))}" height="${3 * H}" fill="${fill()}" opacity="${op(0.5, 0.9)}"/>`);
      out.push(`<g transform="rotate(${f1(rot)} ${W / 2} ${H / 2})">${rects.join('')}</g>`);
      break;
    }
    case 'stars': {
      const n = 40 + Math.floor(r() * 40);
      for (let i = 0; i < n; i++) out.push(`<circle cx="${f1(between(0, W))}" cy="${f1(between(0, H))}" r="${f1(between(0.8, 2.4))}" fill="${col.a}" opacity="${op(0.6, 1)}"/>`);
      for (let i = 0; i < 6; i++) {
        const x = between(10, W - 10), y = between(10, H - 10), s2 = between(5, 11), t = s2 / 4;
        out.push(`<path d="M${f1(x)} ${f1(y - s2)}L${f1(x + t)} ${f1(y - t)}L${f1(x + s2)} ${f1(y)}L${f1(x + t)} ${f1(y + t)}L${f1(x)} ${f1(y + s2)}L${f1(x - t)} ${f1(y + t)}L${f1(x - s2)} ${f1(y)}L${f1(x - t)} ${f1(y - t)}Z" fill="${col.a}"/>`);
      }
      out.push(`<circle cx="${f1(between(40, W - 40))}" cy="${f1(between(30, 120))}" r="${f1(between(22, 40))}" fill="${col.b}" opacity=".9"/>`);
      break;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice"><rect width="${W}" height="${H}" fill="${col.bg}"/>${out.join('')}</svg>`;
}

// CSS values for a theme, cached: cards re-render often and the strings never change.
const themeCache = new Map();
function themeVars(theme, adj) {
  const key = [theme.term, theme.seed, adj.h, adj.s, adj.v, adj.c].join('\n');
  let v = themeCache.get(key);
  if (!v) {
    if (themeCache.size > 500) themeCache.clear(); // slider drags make many one-off keys
    const light = themeSvg(theme.term, theme.seed, false, adj), dark = themeSvg(theme.term, theme.seed, true, adj);
    const uri = svg => 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
    const bg = svg => /<rect [^>]*fill="([^"]+)"/.exec(svg)[1]; // base colour, for UI drawn on top
    v = { tl: uri(light), td: uri(dark), nl: bg(light), nd: bg(dark) };
    v.il = inkFor(v.nl); v.id = inkFor(v.nd); // text colour per scheme
    themeCache.set(key, v);
  }
  return v;
}

// Paint an element (card, editor, palette tile) with a theme, or clear it.
// adj: the category's colour adjustment (none if the category is gone).
function applyTheme(el, theme, adj) {
  const props = ['--tl', '--td', '--tnl', '--tnd'];
  if (!theme || !theme.term) {
    delete el.dataset.themed;
    delete el.dataset.inkL;
    delete el.dataset.inkD;
    for (const p of props) el.style.removeProperty(p);
    return;
  }
  // One look per category: every note of a term draws seed 0, whatever seed
  // it stores (older notes have random ones).
  const v = themeVars({ term: theme.term, seed: 0 }, cleanAdj(adj));
  el.dataset.themed = '';
  el.style.setProperty('--tl', v.tl);
  el.style.setProperty('--td', v.td);
  el.style.setProperty('--tnl', v.nl);
  el.style.setProperty('--tnd', v.nd);
  el.dataset.inkL = v.il; // app.css picks the text colour from these
  el.dataset.inkD = v.id;
}
