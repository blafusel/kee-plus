// Note formatting (declarations only; loads before app.js).
//
// A text note's body is stored as plain text with a small Markdown subset,
// whichever editor wrote it, so sync, search and old clients see text:
//   **bold**   _italic_ (also *italic*)   ++underline++   ~~strikethrough~~
//   "# " / "## " at the start of a line: heading 1 / 2
// A backslash keeps a marker character literal (\*, \_, \~, \+, \#, \\).
// Marks never cross a line. The Markdown editor shows the marks; the rich
// editor (contenteditable) shows the formatting and writes the same text.

const FMT = {
  bold: { mark: '**', tag: 'B' },
  italic: { mark: '_', tag: 'I' },
  underline: { mark: '++', tag: 'U' },
  strike: { mark: '~~', tag: 'S' },
};
// Opening marks, longest first. '*' is an alternative italic mark.
const MD_OPEN = [['**', 'bold'], ['++', 'underline'], ['~~', 'strike'], ['*', 'italic'], ['_', 'italic']];
const MD_ESC = /[\\*_~+#]/;
const isWord = c => !!c && /[\p{L}\p{N}_]/u.test(c);
const isSpace = c => !c || /\s/.test(c);

function escapedAt(s, i) {
  let n = 0;
  while (i - 1 - n >= 0 && s[i - 1 - n] === '\\') n++;
  return n % 2 === 1;
}

// A mark opening at i: {fmt, len, end} with end the index of the closing mark.
function mdOpenAt(s, i, links) {
  for (const [mk, fmt] of MD_OPEN) {
    if (!s.startsWith(mk, i)) continue;
    const j = i + mk.length;
    if (isSpace(s[j])) continue;
    if (mk === '_' && isWord(s[i - 1])) continue; // snake_case stays text
    if (mk === '*' && s[j] === '*') continue;
    let k = s.indexOf(mk, j + 1);
    while (k !== -1) {
      const ok = !isSpace(s[k - 1]) && !escapedAt(s, k) && !links.some(l => k >= l.index && k < l.index + l.text.length)
        && !(mk === '*' && (s[k + 1] === '*' || s[k - 1] === '*'))
        && !(mk === '_' && isWord(s[k + mk.length]));
      if (ok) return { fmt, len: mk.length, end: k };
      k = s.indexOf(mk, k + 1);
    }
  }
  return null;
}

// One line -> tokens: {t: 'text', v} or {t: 'bold' | ..., kids}.
function mdInline(s) {
  const links = findLinks(s);
  const out = [];
  let buf = '', i = 0;
  const push = () => { if (buf) out.push({ t: 'text', v: buf }); buf = ''; };
  while (i < s.length) {
    const link = links.find(l => l.index === i);
    if (link) { buf += link.text; i += link.text.length; continue; } // marks inside a URL stay text
    if (s[i] === '\\' && MD_ESC.test(s[i + 1] || '')) { buf += s[i + 1]; i += 2; continue; }
    const m = mdOpenAt(s, i, links);
    if (m) {
      push();
      out.push({ t: m.fmt, kids: mdInline(s.slice(i + m.len, m.end)) });
      i = m.end + m.len;
      continue;
    }
    buf += s[i++];
  }
  push();
  return out;
}

function mdLines(text) {
  return String(text || '').split('\n').map(line => {
    const m = /^(#{1,2}) (.*)$/.exec(line);
    return m ? { h: m[1].length, kids: mdInline(m[2]) } : { h: 0, kids: mdInline(line) };
  });
}

function mdTokensToNodes(tokens, links) {
  return tokens.flatMap(tk => tk.t === 'text'
    ? (links ? linkify(tk.v) : [tk.v])
    : [h(FMT[tk.t].tag.toLowerCase(), { class: 'md-' + tk.t }, mdTokensToNodes(tk.kids, links))]);
}

// Card body: formatted, links clickable, for a white-space: pre-wrap box.
function mdNodes(text) {
  const out = [];
  mdLines(text).forEach((ln, i) => {
    if (i) out.push('\n');
    const kids = mdTokensToNodes(ln.kids, true);
    out.push(...(ln.h ? [h('span', { class: 'md-h' + ln.h }, kids)] : kids));
  });
  return out;
}

// Text without marks (sort labels).
function mdPlain(text) {
  const flat = tokens => tokens.map(tk => (tk.t === 'text' ? tk.v : flat(tk.kids))).join('');
  return mdLines(text).map(ln => flat(ln.kids)).join('\n');
}

// Rich editor content: one <div> per line, as browsers make on Enter.
function mdToRich(text) {
  return mdLines(text).map(ln => {
    const kids = mdTokensToNodes(ln.kids, false);
    return h('div', ln.h ? { class: 'md-h' + ln.h } : null, kids.length ? kids : h('br'));
  });
}

// ---- rich editor DOM -> Markdown

// Escape only what could read as a mark; URLs stay as they are.
function mdEscapePart(s) {
  return s.replace(/\\/g, '\\\\')
    .replace(/\*/g, (m, i, str) => (isSpace(str[i - 1]) && isSpace(str[i + 1]) ? '*' : '\\*'))
    .replace(/~(?=~)|(?<=~)~/g, '\\~').replace(/\+(?=\+)|(?<=\+)\+/g, '\\+')
    .replace(/_/g, (m, i, str) => ((!isWord(str[i - 1]) && !isSpace(str[i + 1])) || (!isSpace(str[i - 1]) && !isWord(str[i + 1])) ? '\\_' : '_'));
}
function mdEscape(s) {
  s = s.replace(/ /g, ' ');
  let out = '', last = 0;
  for (const l of findLinks(s)) {
    out += mdEscapePart(s.slice(last, l.index)) + l.text;
    last = l.index + l.text.length;
  }
  return out + mdEscapePart(s.slice(last));
}

// Marks go inside surrounding spaces and never cross a line.
function mdWrap(inner, mk) {
  return inner.split('\n').map(seg => {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(seg);
    return m[2] ? m[1] + mk + m[2] + mk + m[3] : seg;
  }).join('\n');
}

function richFormats(el) {
  const t = el.tagName, st = el.style, f = [];
  if (t === 'B' || t === 'STRONG' || /^(bold|[6-9]00)$/.test(st.fontWeight)) f.push('bold');
  if (t === 'I' || t === 'EM' || st.fontStyle === 'italic') f.push('italic');
  if (t === 'U' || t === 'INS' || /underline/.test(st.textDecorationLine || st.textDecoration)) f.push('underline');
  if (t === 'S' || t === 'STRIKE' || t === 'DEL' || /line-through/.test(st.textDecorationLine || st.textDecoration)) f.push('strike');
  return f;
}

const RICH_BLOCK = /^(DIV|P|H[1-6]|LI|UL|OL|BLOCKQUOTE|PRE)$/;
function richToMd(root) {
  let out = '';
  const lines = [];
  const atStart = () => !out || out.endsWith('\n');
  const inline = node => {
    let s = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) s += mdEscape(n.data);
      else if (n.nodeName === 'BR') s += '\n';
      else if (n.nodeType === 1 && RICH_BLOCK.test(n.nodeName)) s += '\n' + inline(n) + '\n';
      else if (n.nodeType === 1) {
        let inner = inline(n);
        for (const f of richFormats(n)) inner = mdWrap(inner, FMT[f].mark);
        s += inner;
      }
    }
    return s;
  };
  const block = (node, level) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 1 && RICH_BLOCK.test(n.nodeName)) {
        if (!atStart()) out += '\n';
        const hl = /md-h1/.test(n.className) || n.nodeName === 'H1' ? 1 : /md-h2/.test(n.className) || n.nodeName === 'H2' ? 2 : level;
        if (n.querySelector(':scope > div, :scope > p')) { block(n, hl); continue; }
        lines.push([out.length, hl]);
        out += inline(n);
        if (!atStart()) out += '\n';
      } else {
        if (atStart()) lines.push([out.length, level]);
        out += n.nodeType === 3 ? mdEscape(n.data) : n.nodeName === 'BR' ? '\n' : n.nodeType === 1 ? inline({ childNodes: [n] }) : '';
      }
    }
  };
  block(root, 0);
  if (out.endsWith('\n')) out = out.slice(0, -1);
  // Escape "# " typed at a line start, then add heading marks.
  const ls = out.split('\n');
  let pos = 0;
  const heads = new Map(lines.map(([p, hl]) => [p, hl]));
  return ls.map(line => {
    const hl = heads.get(pos) || 0;
    pos += line.length + 1;
    const body = line.replace(/^(#{1,6} )/, '\\$1');
    return hl && body.trim() ? '#'.repeat(hl) + ' ' + body : body;
  }).join('\n');
}

// ---- Markdown editor (textarea) commands

// Replace a range through the editing pipeline, so Undo works and 'input' fires.
function taReplace(ta, a, b, text, selA, selB) {
  ta.focus();
  ta.setSelectionRange(a, b);
  const ok = text ? document.execCommand('insertText', false, text) : document.execCommand('delete');
  if (!ok) {
    ta.setRangeText(text, a, b, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  ta.setSelectionRange(selA, selB);
}

function taToggleMark(ta, fmt) {
  const mk = FMT[fmt].mark, v = ta.value;
  let a = ta.selectionStart, b = ta.selectionEnd;
  // Already marked just outside or just inside the selection: remove.
  if (v.slice(a - mk.length, a) === mk && v.slice(b, b + mk.length) === mk) {
    return taReplace(ta, a - mk.length, b + mk.length, v.slice(a, b), a - mk.length, b - mk.length);
  }
  const sel = v.slice(a, b);
  if (sel.length >= 2 * mk.length + 1 && sel.startsWith(mk) && sel.endsWith(mk)) {
    const inner = sel.slice(mk.length, -mk.length);
    return taReplace(ta, a, b, inner, a, a + inner.length);
  }
  if (a === b) return taReplace(ta, a, b, mk + mk, a + mk.length, a + mk.length);
  // Marks go inside surrounding spaces, per line.
  const wrapped = mdWrap(sel, mk);
  const lead = /^\s*/.exec(sel)[0].length, trail = /\s*$/.exec(sel)[0].length;
  return taReplace(ta, a, b, wrapped, a + lead, a + wrapped.length - trail);
}

// Heading level 1 or 2 on the lines in the selection; 0 or the same level again: normal text.
function taSetHeading(ta, level) {
  const v = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
  const s = v.lastIndexOf('\n', a - 1) + 1;
  let e = v.indexOf('\n', b);
  if (e === -1) e = v.length;
  const lines = v.slice(s, e).split('\n');
  const want = '#'.repeat(level) + ' ';
  const all = level && lines.every(l => l.startsWith(want) && !l.startsWith(want.slice(0, -1) + '#'));
  const out = lines.map(l => {
    const bare = l.replace(/^#{1,2} /, '');
    return all || !level ? bare : want + bare;
  }).join('\n');
  const d = out.length - (e - s);
  taReplace(ta, s, e, out, Math.max(s, a + (lines.length === 1 ? d : 0)), Math.max(s, b + d));
}

// ---- rich editor commands

function richBlockAt(root) {
  const sel = getSelection();
  if (!sel.rangeCount || !root.contains(sel.anchorNode)) return null;
  let n = sel.anchorNode;
  if (n === root) {
    n = root.childNodes[Math.min(sel.anchorOffset, root.childNodes.length - 1)];
    if (!n) return null;
  }
  while (n.parentNode !== root) n = n.parentNode;
  if (n.nodeType === 1 && n.nodeName === 'DIV') return n;
  // Text straight in the root (the browser's first line): wrap it in a div.
  document.execCommand('formatBlock', false, 'div');
  n = getSelection().anchorNode;
  while (n && n.parentNode !== root) n = n.parentNode;
  return n && n.nodeName === 'DIV' ? n : null;
}

function richToggle(root, fmt) {
  const cmd = { bold: 'bold', italic: 'italic', underline: 'underline', strike: 'strikeThrough' }[fmt];
  document.execCommand('styleWithCSS', false, false);
  document.execCommand(cmd);
}

function richSetHeading(root, level) {
  const sel = getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const first = richBlockAt(root);
  if (!first) return;
  const blocks = [...root.children].filter(d => d === first || range.intersectsNode(d));
  const cls = 'md-h' + level;
  const all = level && blocks.every(d => d.classList.contains(cls));
  for (const d of blocks) {
    d.classList.remove('md-h1', 'md-h2');
    if (level && !all) d.classList.add(cls);
    if (!d.classList.length) d.removeAttribute('class');
  }
}
