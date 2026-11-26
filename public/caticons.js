'use strict';
/*
 * Category colours and icons (declarations only; loads before app.js).
 *
 * Each main category has one colour from CAT_PALETTE; its sub-categories
 * share it and are told apart by their icon and name. Icons are drawn here
 * (24x24, stroked with currentColor) and guessed from the name unless the
 * category picked one.
 */

// Well-spaced hues: [id, label, hue, saturation %]. New main categories take
// the next one nobody uses, in this order.
const CAT_PALETTE = [
  ['violet', 'Violet', 262, 70], ['teal', 'Teal', 168, 55], ['blue', 'Blue', 212, 75],
  ['amber', 'Amber', 38, 85], ['pink', 'Pink', 350, 75], ['green', 'Green', 88, 50],
  ['orange', 'Orange', 22, 85], ['cyan', 'Cyan', 190, 70], ['indigo', 'Indigo', 235, 60],
  ['magenta', 'Magenta', 300, 55], ['red', 'Red', 4, 70], ['slate', 'Slate', 215, 15],
];
const paletteEntry = id => CAT_PALETTE.find(p => p[0] === id) || null;

const CAT_ICONS = {
  tag: ['Tag', '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.5"/>'],
  folder: ['Folder', '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>'],
  sparkles: ['AI', '<path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>'],
  image: ['Image', '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>'],
  message: ['Chat', '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>'],
  film: ['Video', '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4M3 12h18"/>'],
  chip: ['Hardware', '<rect x="6" y="6" width="12" height="12" rx="1.5"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>'],
  code: ['Code', '<path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>'],
  network: ['Network', '<rect x="9" y="2" width="6" height="5" rx="1"/><rect x="2" y="17" width="6" height="5" rx="1"/><rect x="16" y="17" width="6" height="5" rx="1"/><path d="M12 7v5M5 17v-5h14v5"/>'],
  server: ['Server', '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/>'],
  lock: ['Lock', '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'],
  cloud: ['Cloud', '<path d="M7 18a5 5 0 1 1 1.1-9.9A6 6 0 0 1 19.5 10 4 4 0 0 1 18 18z"/>'],
  laptop: ['Laptop', '<rect x="4" y="4" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>'],
  phone: ['Phone', '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>'],
  plane: ['Travel', '<path d="M2 13.5 22 4l-6 17-4.5-6.5z"/><path d="m11.5 14.5 3-3"/>'],
  pin: ['Place', '<path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>'],
  globe: ['World', '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'],
  mountain: ['Outdoors', '<path d="m2 20 7-12 4 6 3-4 6 10z"/>'],
  sun: ['Sun', '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'],
  car: ['Car', '<path d="M5 17H3v-5l2-5h14l2 5v5h-2"/><path d="M3 12h18"/><circle cx="7.5" cy="17" r="2"/><circle cx="16.5" cy="17" r="2"/><path d="M9.5 17h5"/>'],
  bike: ['Bike', '<circle cx="5.5" cy="17" r="3.5"/><circle cx="18.5" cy="17" r="3.5"/><path d="M5.5 17 9 9h6l3.5 8M9 9l3 8h1M14 6h2"/>'],
  home: ['Home', '<path d="M3 11 12 3l9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>'],
  sofa: ['Furniture', '<path d="M5 11V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4"/><path d="M3 13a2 2 0 0 1 4 0v2h10v-2a2 2 0 0 1 4 0v5H3z"/><path d="M5 18v2M19 18v2"/>'],
  cart: ['Shopping', '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.6 12.4a1 1 0 0 0 1 .8h9.7a1 1 0 0 0 1-.8L21 7H6"/>'],
  box: ['Package', '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>'],
  gift: ['Gift', '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M5 12v9h14v-9M12 8v13"/><path d="M12 8C10 4 7 4 7 6s3 2 5 2c2 0 5 0 5-2s-3-2-5 2"/>'],
  money: ['Money', '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 12h.01M18 12h.01"/>'],
  briefcase: ['Work', '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18"/>'],
  calendar: ['Calendar', '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'],
  todo: ['To do', '<path d="M10 6h11M10 12h11M10 18h11"/><path d="m3 6 1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17"/>'],
  note: ['Note', '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>'],
  bulb: ['Idea', '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>'],
  book: ['Book', '<path d="M4 19V5a2 2 0 0 1 2-2h14v15H6a2 2 0 0 0-2 2 2 2 0 0 0 2 2h14"/>'],
  cap: ['School', '<path d="m2 9 10-5 10 5-10 5z"/><path d="M6 11v5c3 2.5 9 2.5 12 0v-5M22 9v6"/>'],
  mail: ['Mail', '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>'],
  user: ['Person', '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'],
  users: ['People', '<circle cx="9" cy="8" r="3.5"/><path d="M2 20a7 7 0 0 1 14 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M22 20a7 7 0 0 0-4-6.3"/>'],
  heart: ['Love', '<path d="M12 20s-8-4.9-8-10.5A4.5 4.5 0 0 1 12 6a4.5 4.5 0 0 1 8 3.5C20 15.1 12 20 12 20z"/>'],
  paw: ['Pets', '<circle cx="5.5" cy="11" r="2"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="6" r="2"/><circle cx="18.5" cy="11" r="2"/><path d="M12 12c-3 0-6 4-6 6.5 0 1.5 1.5 2 3 1.5s2-.8 3-.8 1.5.3 3 .8 3 0 3-1.5C18 16 15 12 12 12z"/>'],
  health: ['Health', '<path d="M3 12h4l3-7 4 14 3-7h4"/>'],
  dumbbell: ['Fitness', '<path d="M6 7v10M3 9v6M18 7v10M21 9v6M6 12h12"/>'],
  pot: ['Cooking', '<path d="M4 11h16v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z"/><path d="M2 11h2M20 11h2M8 11a4 4 0 0 1 8 0M12 7V5"/>'],
  cocktail: ['Going out', '<path d="M4 4h16l-8 9z"/><path d="M12 13v7M8 20h8M7.5 8h9"/>'],
  piggy: ['Savings', '<ellipse cx="11" cy="12" rx="7" ry="5.5"/><path d="M18 10.5h2.5v3H18M8 17v3M14 17v3M8 7.5 7 4.5l3.5 2M10 9h3M15 10.5h.01"/>'],
  food: ['Food', '<path d="M7 3v8M4 3v5a3 3 0 0 0 6 0V3M7 11v10"/><path d="M17 21V3c-2.2 1-3.5 3.5-3.5 7v3H17"/>'],
  coffee: ['Coffee', '<path d="M4 9h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 11h1.5a2.5 2.5 0 0 1 0 5H17M8 2v3M12 2v3"/>'],
  leaf: ['Nature', '<path d="M5 21c0-9 5-15 15-16 0 10-6 15-14 15"/><path d="m5 21 8-8"/>'],
  music: ['Music', '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'],
  camera: ['Camera', '<path d="M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="4"/>'],
  game: ['Games', '<rect x="2" y="7" width="20" height="11" rx="4"/><path d="M6 12.5h4M8 10.5v4M15 12h.01M18 13.5h.01"/>'],
  shapes: ['Misc', '<circle cx="7" cy="7" r="4"/><rect x="13" y="3" width="8" height="8" rx="1"/><path d="M7 13l4 7H3zM17 13v8M13 17h8"/>'],
  star: ['Star', '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3l-5.5 2.9 1-6.2L3 9.6l6.2-.9z"/>'],
};

// Name -> icon, first match wins (specific words before general ones).
const CAT_ICON_HINTS = [
  [/image|photo|picture|\bpics?\b|gallery|\bart\b|drawing|illustrat/, 'image'],
  [/llm|gpt|claude|chat|prompt|message/, 'message'],
  [/video|movie|film|cinema|youtube|\btv\b|series|stream/, 'film'],
  [/\bai\b|machine learning|\bml\b|agent/, 'sparkles'],
  [/hardware|\bcpu|\bgpu|chip|compute|\bpc\b|\bbuild/, 'chip'],
  [/software|code|coding|\bdev\b|develop|program|script|\bgit\b|\bapi\b/, 'code'],
  [/network|wi-?fi|\blan\b|router|\bdns\b|internet/, 'network'],
  [/\bnas\b|server|storage|backup|home ?lab|docker|self-?host/, 'server'],
  [/tailscale|\bvpn\b|security|password|\block|secret|privacy/, 'lock'],
  [/cloud|\baws\b|azure|weather/, 'cloud'],
  [/overseas|travel|trip|flight|vacation|holiday|abroad/, 'plane'],
  [/local|place|\bmaps?\b|location|\bcity\b|nearby/, 'pin'],
  [/furniture|chair|sofa|couch|interior|decor/, 'sofa'],
  [/\btech\b|laptop|computer|gadget|device/, 'laptop'],
  [/phone|mobile|iphone|android/, 'phone'],
  [/\bkee\b|kee\+|\bnotes?\b|\bdocs?\b|writing|journal/, 'note'],
  [/idea|brainstorm|inspiration/, 'bulb'],
  [/todo|to do|\btasks?\b|chores|checklist/, 'todo'],
  [/school|universit|course|class|exam/, 'cap'],
  [/book|\bread|study|learn/, 'book'],
  [/shop|\bbuy|grocer|\bstore\b|wishlist/, 'cart'],
  [/package|deliver|shipping|\border|amazon|moving/, 'box'],
  [/gift|present|birthday|christmas/, 'gift'],
  [/retire|pension|saving|\b401k|piggy/, 'piggy'],
  [/money|financ|budget|\bbank|\btax|invest|\bbills?\b|expense|price|crypto/, 'money'],
  [/\bwork\b|\bjob\b|office|career|business|client/, 'briefcase'],
  [/event|calendar|meeting|appointment|schedule|\bplans?\b/, 'calendar'],
  [/mail|letter|newsletter/, 'mail'],
  [/coffee|\bcafe|\btea\b/, 'coffee'],
  [/recipe|\bcook|kitchen|\bbak(e|ing)/, 'pot'],
  [/going out|nightlife|\bbars?\b|\bpubs?\b|party|parties|cocktail|drinks/, 'cocktail'],
  [/food|\beat\b|eating|\bdin(e|ing)\b|dinner|lunch|breakfast|restaurant|takeaway/, 'food'],
  [/\bgym\b|fitness|sport|workout|running/, 'dumbbell'],
  [/health|doctor|medic|\bsick/, 'health'],
  [/\bpets?\b|\bdogs?\b|\bcats?\b|animal/, 'paw'],
  [/hike|hiking|mountain|outdoor|\bcamp|\bski/, 'mountain'],
  [/bike|cycling|bicycle/, 'bike'],
  [/\bcars?\b|\bauto\b|vehicle|garage/, 'car'],
  [/summer|\bsun\b|beach/, 'sun'],
  [/nature|plant|garden|forest|\beco\b/, 'leaf'],
  [/music|song|\bband\b|concert|podcast|spotify/, 'music'],
  [/camera|photograph/, 'camera'],
  [/\bgames?\b|gaming|console/, 'game'],
  [/world|\bweb\b|website|language|news/, 'globe'],
  [/people|friends|\bteam\b|contacts|social|\bkids\b|family/, 'users'],
  [/love|partner|wedding|dating/, 'heart'],
  [/\bhome\b|house|apartment|flat\b/, 'home'],
  [/favou?rite|important|\bstar\b|\bbest\b/, 'star'],
  [/\bmisc|\bother|stuff|general|random/, 'shapes'],
  [/\bperson|personal|myself|\bme\b/, 'user'],
  [/project|archive|\bfiles?\b/, 'folder'],
];
function guessIcon(name) {
  const t = String(name || '').toLowerCase();
  for (const [re, id] of CAT_ICON_HINTS) if (re.test(t)) return id;
  return 'tag';
}

// <symbol>s for the sprite in index.html (app.js adds them once).
function catIconSymbols() {
  return Object.entries(CAT_ICONS).map(([id, [, body]]) => `<symbol id="ci-${id}" viewBox="0 0 24 24">${body}</symbol>`).join('');
}

// A category's colours from its palette hue and fine-tune
// (tune: h = hue shift in degrees, s = saturation factor 0..2,
// v = brightness -1..1, c = intensity 0..1, how strongly the card is tinted).
const NO_TUNE = { h: 0, s: 1, v: 0, c: 0 };
function cleanTune(t) {
  const num = (x, lo, hi, d) => (typeof x === 'number' && isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d);
  return { h: num(t && t.h, -180, 180, 0), s: num(t && t.s, 0, 2, 1), v: num(t && t.v, -1, 1, 0), c: num(t && t.c, 0, 1, 0) };
}
function lookColors(hue, sat, tune) {
  const t = cleanTune(tune), H = f1(((hue + t.h) % 360 + 360) % 360), S = Math.min(100, sat * t.s);
  const clampL = x => f1(Math.min(98, Math.max(4, x)));
  const hsl = (s, l) => `hsl(${H} ${f1(Math.min(100, s))}% ${clampL(l)}%)`;
  return {
    bgL: hsl(S * (0.6 + 0.4 * t.c), 95 + t.v * 2 - t.c * 14),
    bgD: hsl(S * (0.25 + 0.4 * t.c), 20 + t.v * 4 + t.c * 9),
    accL: hsl(S, 52 + t.v * 6),
    accD: hsl(S, 68 + t.v * 6),
    txtL: hsl(S, 34 + t.v * 4),
    txtD: hsl(S * 0.9, 74 + t.v * 4),
    H, S,
  };
}
