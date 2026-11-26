# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Kee+ (repo name: mynotes, container name: kee-plus) is a self-hosted Google Keep–style notes app. It runs as one container on a Synology NAS and is used from an iPhone and a desktop browser over the LAN or Tailscale. The goal is to make adding a note as fast as possible. There is no build step, no framework and no runtime dependency (Python stdlib + vanilla JS); keep it that way.

## Design decisions

**Offline-first client.** The in-memory `notes` Map is the source of truth and is mirrored to localStorage. The UI renders from it immediately; the network is never on the render path. Every write goes through `createNote` / `updateNote` / `removeNote` → `touched()`, which marks the note dirty, persists (debounced), schedules a sync and schedules a render. Mutating a note in place skips all of that.

**Sync protocol.** The server assigns a global, increasing `rev` to every accepted write. The client sends `{since: rev, changes: dirtyNotes}` and gets back every note with `rev > since`. Conflicts are last-write-wins on the client's `updatedAt`.
- The server must return its own copy of every change it *rejected* as stale. Otherwise the client clears the dirty flag and silently keeps a version the server never stored.
- The client clears a dirty flag only if the note's `updatedAt` is unchanged since the request was sent. Edits typed while the request is in flight stay dirty.
- `updatedAt = max(Date.now(), prev + 1)`, so two quick edits never share a timestamp.
- The server doesn't check the content type, because `navigator.sendBeacon` (used to flush when the page is hidden or closed) posts `text/plain`. CSRF is blocked by the Origin check instead (below).
- Request guard (`Handler.parse_request`, every method): the `Host` must be an IP literal, `localhost` or a name in `MYNOTES_HOSTS`, else 421. That blocks DNS rebinding, where an attacker's domain re-resolves to the NAS and the page reads `/api/notes`. Every non-GET/HEAD request with an `Origin` must have that Origin's host:port equal to `Host`, else 403. Browsers send `Origin` on all POST/PUT, same-origin and `sendBeacon` included; no `Origin` means a non-browser client (`tools/`, curl) and is allowed. A reverse proxy in front must pass the original `Host` through.
- Every sync response carries `v`, a hash of the files in `public/` computed at server start. A client running old code reloads at its next successful sync after a deploy that changes `public/`, after `persistNow()`. This is what makes a data-model change safe to deploy: old code never gets to run against new data. The server must be restarted for `v` to change.

**Deletes are tombstones** (`deleted: true`, content wiped). That lets the delete reach other devices. Trash is purged on the client after 7 days. Undo for "delete forever" re-applies a snapshot through `updateNote`.

**Drafts.** A new note is created only once `hasContent()` is true, so toggling the colour or pin on an empty draft stores nothing. Closing an editor on an empty note tombstones it. Call `composer.close()` before `composer.start()`, or an emptied note leaks into storage.

**One `Editor` class, two instances.**
- Inline composer: desktop only, autofocused on load, collapsed until input.
- Modal editor: opens existing notes, and new notes on phones, where it is full screen.

While the composer is open, its note is kept out of the grid, so the grid doesn't reflow on every keystroke; the note appears when the composer closes. Ctrl/⌘+Enter saves and immediately starts the next note.

New notes start in the body, or in the title with the per-device setting `mn.titleFirst` ("Start new notes with the title", default on). `focusNew()` applies it for `openNew()`, Ctrl/⌘+Enter and a click on the closed composer outside its fields (its padding); opening an existing note still focuses the body (`focusMain()`). With title first, the collapsed composer shows the title field (`.title-first`) with the placeholder "Take a note…" (`titleHint()`), back to "Title" once it opens.

Settings › General › Sidebar › "Show in the sidebar" switches off the Find field, Pinned, Attachments, Archive, Trash and the Shortcuts list (`NAV_PARTS`, `mn.navHide`, `html.no-nav-<id>`; unset means only the Shortcuts list is off); their views still work. The Shortcuts list (`.nav-hint`) is sticky at the bottom of the sidebar with a top border, so a long category list scrolls behind it; hiding it hides the border too. Shift+/ focuses the Find field (ignored when it is hidden). The General tab is grouped Notes and search, Sidebar, Size, Keyboard, Notifications; everything on it is per device, said once at the top.

"Pinned" (sidebar, under the Find category field; view `pinned`) lists every live pinned note from every category and from none, sorted and grouped like Notes; it has no composer and shows the total as its count. Alt+↑/↓ goes Notes, Pinned, then the categories.

The app name and icon at the top left (`#brand`) go home: Notes, search cleared, scrolled to the top (`goHome()`). Settings is the cog at the top right (`#settingsBtn`, highlighted in Settings; a second click goes back to Notes), not a sidebar entry.

Category shortcut keys: `catKeys()` gives the sidebar categories, in sidebar order, 1–9 and 0, then a free letter (preferring one from the name). A (all notes, `goHome()`), C, N and L stay reserved (`RESERVED_KEYS`); add any new single-key shortcut there. Alt+↑/↓ steps through Notes and the categories in `orderedCats()` order, subs included, skipping empty ones while they are hidden (`stepCategory()`, `navCounts`); it works in the collapsed composer and is a per-device setting (`mn.altNav`, default on, `html.no-alt-nav` hides its line in the shortcuts list). `navKeyMap` is rebuilt with the sidebar. The keys always work. What the right of each sidebar category shows is a per-device setting, "Sidebar categories show" (`mn.navShow`: `keys` (default), `counts`, `both` or `none`; an old `mn.navKeys: false` reads as `none`), through `html.nav-keys` / `html.nav-counts`. Keys are boxed (`.nav-key`) and never show on touch screens or in the mini sidebar; counts are plain numbers (`.nav-count`: live notes, a main category including its subs, as its view shows), with pinned ones in brackets, `5 (2)` (`.nav-pins`, setting `mn.navPins`, default on, `html.nav-pins-on`; the tooltip always names them). Both sit in one `.nav-meta` slot with a tight gap, count first. A "Find category" field under Notes (`#navFind`, `navFind`, not saved; hidden in the mini sidebar and with no categories) filters the list by name: a main shows if it or a sub matches, matching subs show under it whether folded or not, empty ones show (`#navCats.filtering`). Enter opens the first match and clears the field, Esc clears it, ↓ moves to the list. A category with no live notes (a main counting its subs) is faded (`.nav-empty`); "Hide empty categories in the sidebar" (`mn.hideEmpty`, per device, default on, `html.hide-empty`) hides them, except the category being viewed and its main (`.nav-keep`) and while notes are dragged (`body.note-drag`), so they can take a drop.

**Arrays are copied** (`copyArrays`, covering `items` and `files`) on every create, update and editor load. The editor's working copy and the stored note must never share an array, or in-place edits bypass `updatedAt`. Callers always replace an array, never change it in place; the shallow Undo snapshots depend on that.

**Attachments** (design: `docs/designs/file_attachments.md`).
- Upload first, then add the reference (`attachTo`). A note never points at bytes the server doesn't have. Uploads find their note through `draftNotes` (draftKey -> note id), so closing the editor or Ctrl+Enter mid-upload doesn't split the note.
- `hasContent` counts `files`, so image-only notes are real notes. Tombstones clear `files`, so the cleanup can free them.
- The server decides the type from the first bytes (JPEG, PNG, GIF, WebP, PDF only) and serves files with `nosniff` and a sandbox CSP. Uploads need the `X-Mynotes: 1` header, which a page on another site can't send without a preflight the server never approves.
- Cleanup counts from `unreferenced_since`, not upload time. Archived and trashed notes count as references. Run it on demand with `python3 files.py --scan`; set `MYNOTES_FILE_GRACE_DAYS=0` in tests.
- Deleting forever frees files fast:
  - When a tombstone replaces a live note, `sync()` passes the old copy's file ids to `files.mark_purged`. That sets `purge_at = now + MYNOTES_PURGE_MINUTES` (default 10, which covers Undo) and arms a timer scan.
  - A scan that finds the file referenced again clears `purge_at`.
  - The 30-day grace stays for references dropped by edits, which is the last-write-wins risk.
  - The loop scans hourly as a fallback for timers lost to a restart. Set `MYNOTES_PURGE_MINUTES=0` in tests.
- `public/files.js` loads before `app.js` and holds declarations only, so the startup `render()` can call `renderGallery`. Put event wiring in `app.js`.
- Accepted risk: last-write-wins can drop an attachment reference silently.
- Never roll back past the attachments release: old `hasContent` deletes image-only notes.

**Themes and settings.**
- A theme is a generated SVG background (`public/themes.js`, declarations only, loads before `app.js`). No AI and no network. A keyword table maps known words to a hue range and motifs; unknown words hash to their own. The note stores `theme: {term, seed}`, but `applyTheme()` always draws seed 0: every note of a category looks the same, on every device. The stored seed is unused (older notes have random ones). Removing a category clears `theme` on every note that has it, archived and trashed included. One Undo restores the category and each theme.
- Categories are `{term, h, s, v, c}`: a hue shift, saturation (0–4: up to 2 a factor on the term's own saturation, 2–4 a blend to full saturation), a brightness shift and intensity (0–1, pulls the background to 50% lightness in both schemes, so a vivid colour like pure yellow is reachable), applied to every note of that term at draw time. The first release stored plain strings, and `categories()` still reads them. Brightness moves lightness by only a few points so text stays readable. The default adjustment (`NO_ADJ`) is 200% saturation and +100 brightness. It applies to new categories, to Reset, to values never saved and to themes whose category is gone.
- Settings sliders repaint only their own row on `input` and save on `change`. A render never rebuilds the list mid-drag (`catDrag`), and after a save it puts focus back on the slider so arrow keys keep working.
- Sub-categories, one level (`{..., parent: '<main term>'}`):
  - `catParent()` ignores a parent that is missing, is the category itself or has a parent of its own, so bad or old data reads as a main category.
  - Key and name: `term` is the key (unique across all levels; notes, views, `parent`, `catCustom`, `navOpen` and `collapsed` use it). The UI shows `catName()` / `nameOf()`: `name` if set, else the term. Names are unique among the mains and among one main's subs, so "Misc" can sit under AI and under Shopping (`findChild(name, parent)`). A new category takes its name as key if free, else `<main name>/<name>` (names can't contain "/"), else a `~2` suffix (`uniqueKey()`); `withName()` drops `name` when it equals the key. Old records have no `name`.
  - `addCategory(input, parent)` is the one way to add: `main/sub` typed in the palette or Settings, the "Under …" select next to the add field (Settings, and the palette in the note view, `palParent`), or + on a main Settings row. The name is looked up only where it would go (that main's subs, or the mains) and reused if found; otherwise a new category is made, even if the name exists elsewhere. In `main/sub` the main is found by name among the mains, else the one sub of that name (its main is used), else created.
  - Look: a sub draws its parent's pattern (`drawTerm()`, used by `paint()` and the Settings previews) with its own adjustment, which starts as the parent's plus a hue shift (`subAdj`). `saveAdj()` on a main moves its subs by the same delta.
  - A main category's view, search and group include its subs' notes (`catFamily()`, `mainTerm()`); a sub's view shows only its own. With "Group by category" on, a main category's view that has subs groups by sub-category (`groupByCat === 'sub'`): its own notes first under its name, then one section per sub in Settings order, no card tags. Otherwise sub notes keep their card tag there. Labels read `travel › lisbon` (`catLabel()`): view title, search chip, card tag and the editor label.
  - Sidebar: mains with subs get a fold button (`.nav-fold`); open ones are per device (`mn.navOpen`), and viewing a sub keeps its parent open. Opening a main category with subs (`setView`: click, shortcut key, Alt+arrows) adds it to `navOpen`, so it stays open until folded by hand. While notes are dragged every main shows its subs (`renderNavCats` opens all while `dragIds` is set) and hidden empty categories show, so every category is a drop target; `endNoteDrag()` folds back. Holding over a closed main entry (or its arrow) for 0.5 s also opens it (`springAt()`, `dragOpen`), now mostly redundant. Shortcut digits go to the first ten main categories only.
  - Palette: a main category with subs is one box (`.pal-group`): its tile across the top, its subs as smaller tiles below behind a left rule (`.pal-subs`). Every category is a full-width row (`.pal-themes` is a list that scrolls, max 360px; the add form and "Edit categories" stay below it), subs slightly narrower; mains without subs are plain rows. Opening scrolls the note's category to the middle. With a mouse, opening also focuses the "New category" field (not on touch, where the keyboard would cover the list).
  - Order: subs follow their main, in the same category order as the mains (A–Z, Date created or Custom).
  - Rename (pencil in Settings, `renameCategory()`): changes only `name`; the key stays, so notes, views and local state need no update. A name a sibling has, or a "/", is refused; a case-only change is allowed. One Undo. Moving a category (Place) under a main where a sibling has its name is refused; removing a main renames a promoted sub whose name a main already has to `Name (Main)`. Older renames changed the key and kept the look in `look` (`drawTerm()`), which still applies. The rename field is kept through sync renders while it has focus; `endRename()` blurs it before rendering.
  - Settings: subs are indented under their main; the open row has a Place select to move a category without subs under a main or back. Removing a main makes its subs main categories (one Undo). Custom order moves a row among its siblings.
- Category order (Settings, synced): `settings.catOrder` is `alpha` (default), `created` (the order of `settings.categories`, which only appends) or `custom` (`settings.catCustom`, a list of terms; missing ones follow in created order). `orderedCats()` applies it to the sidebar, the palette, the Settings list and the category sort/groups; mutations still go through `categories()`. Custom shows up/down buttons per Settings row; switching to custom the first time starts from the order shown.
- Each category gets a sidebar entry. Its view is `'cat:<term>'` and shows the live notes with that theme. A search typed there finds only that category's notes (archived included); elsewhere it searches every note outside Trash. The search box shows the category as a chip (`#searchChip`, `updateSearchChip()` from `render()`); its × or Backspace in an empty box goes to Notes and keeps the typed text, so the search widens to every note. The chip is a per-device setting (`mn.catChip`, default on); off hides it, and a category view still searches only its notes. A draft started there gets the theme: `draftTheme()` in `Editor.start`/`close`, and `setView` re-themes an untouched composer draft. If the category is removed, `render()` falls back to Notes.
- Colours are retired: no sidebar swatches, no colour views and no colour section in Settings. Existing note colours (and `settings.colors`) still render, but nothing sets them any more: the palette offers only "None" (clears theme and colour) and the categories. A stored `color:<name>` view falls back to Notes.
- Picking "None" clears the theme and colour; picking a category applies it. Either closes the palette. UI text says "category" everywhere; "theme" is only the code and data name (`note.theme`, themes.js). The palette has a "New category" field, with a Main category / Under … select above it that starts at the note's category, else the category view, else Main category (always the main one of a sub; a mixed selection has no note category): it adds the category (reusing an existing one with the same name), applies it to the selected note(s) or the open editor and closes the palette.
- Settings (the category list) is one synced record with the fixed id `settings` (`kind: 'settings'`). It rides the note sync with last-write-wins on the whole record. Every loop over `notes` that shows notes must skip it (`isSettings`).
- The settings panel is built once and kept, so a sync-triggered `render()` never wipes text being typed in it. It has three tabs (`SET_TABS`: General, Categories, Import; `showSetTab()`), one shown at a time; the last tab is remembered per device (`mn.setTab`). Arrow keys move between tabs. Import is a tab, not a view: a stored `import` view opens Settings on the Import tab.
- `.editor` must not set `--note` itself. The rule would override `[data-color]` and `[data-themed]` (same specificity, later in the file), and the editor would always draw white.
- `.card` and `.editor` set `background-color`, not the `background` shorthand, or they would reset the theme image.

**Masonry on CSS grid.** Rows are 4px tall and each card gets `grid-row-end: span N`.
- `layout()` reads every height in one pass, then writes every span in a second pass. Two forced layouts total, never one per card.
- Section labels are grid items too and must be spanned. `getBoundingClientRect` excludes margins, so the label gets +8px in JS instead of a CSS margin.
- Re-run `layout()` after anything that changes a card's size.
- `layout(els)` takes a subset (the cards a batch just added); without it, it does every `.grid > *`.

**Rendering cost** (measured on the real 1,600-note data, phone-speed CPU: a search keystroke went from 1.5 s to under 0.1 s).
- The board is built in batches (`fillBoard`, `BATCH` = 24). `render()` adds the first batch and `#boardMore`, a marker below the board, pulls in the next ones through an IntersectionObserver (1500px margin) and `pumpBoard()`, a frame at a time. Never render every card again.
- When `render()` runs for the same view, query, sort and grouping (`page.key`: a sync, an edit, closing a note) it re-adds at least as many cards as were shown, so `restoreScroll()` finds its anchor. Anything else starts at one batch.
- Built cards are reused (`cardCache`, id -> element) while `updatedAt` and `cardCtx()` (settings record's `updatedAt`, grouping, category view, mouse/touch) are unchanged; only `.sel` is reapplied. Anything new that a card shows must change one of those, or reused cards go stale.
- Code that looks for a card in the DOM must allow for it not being built yet (`toggleSel` does). Band selection only sees built cards.
- Search: `matches()` keeps each note's lower-cased text (`hayCache`, keyed on `updatedAt` and the settings record's, since it includes the category label), and the search input renders at most once per animation frame.
- Rebuilding the grid collapses the page until `layout()` runs, and the browser clamps the scroll to the top. `render()` therefore records the cards in view (`scrollAnchor()`) and scrolls the first one still shown back to its screen position (`restoreScroll()`). `setView` still scrolls to the top on purpose. A ResizeObserver handles width changes.

**Formatting** (`public/format.js`, declarations only, loads before `files.js`). A text note's body stays plain text with a small Markdown subset: `**bold**`, `_italic_` (`*italic*` also reads), `++underline++`, `~~strike~~`, `# ` / `## ` headings at a line start, `\` escapes a mark. Marks never cross a line; `_` inside a word (`snake_case`) and a lone ` * ` stay text, and marks inside a URL are ignored. The title and list items are never formatted. Cards render it (`mdNodes()`, links included); sort labels strip it (`mdPlain()`); search matches the raw text.
- Two editors over the same text, a per-device setting "Note editor" (`mn.editMode`: `rich` default, `md`; `editMode`, `Editor.bodyEl`). Markdown: the `.ed-body` textarea shows the marks; shortcuts insert them through `execCommand('insertText')` so Undo works (`taToggleMark`, `taSetHeading`). Rich: a contenteditable `.ed-rich` (one `<div>` per line, headings as `.md-h1`/`.md-h2`) is filled from the text (`mdToRich()`) and written back on every input (`richToMd()`, which escapes only what could read as a mark). It takes pasted text as plain text. Switching the setting re-fills both editors.
- Shortcuts in the note text: Ctrl/⌘+B, I, U, Ctrl/⌘+Shift+X strikethrough, Ctrl/⌘+Shift+1/2 headings, +0 normal text (not Ctrl+Alt: AltGr types characters on some layouts). Buttons (`.ed-fmt`) show only in the phone modal for text notes outside Trash; `pointerdown` is cancelled so the selection survives the tap. The sidebar shortcuts list has two tabs (`.nav-hint-tabs`, last one per device in `mn.hintTab`): Shortcuts, and a formatting tab named after the editor in use ("Rich text" / "Markdown", `renderHintFmt()`), which in Markdown also shows the marks.
- Keep imports and old notes with `*`, `_` or `#` in them may now render formatted.

**Links.** `findLinks()` finds `http(s)://` URLs (any host, so LAN names like `http://nas:5000` work) and `www.<name>.<tld>`; it drops trailing punctuation except a `)` that closes a `(` in the URL, and keeps only what `new URL()` parses as http(s). Cards linkify the title, body and list items (`linkify()`). The editor's fields are textareas, which can't hold links, so `Editor.renderLinks()` lists the note's links below the text (`.ed-links`), rebuilt from `chrome()` only when the set of links changes. A card link opens in a new tab without opening the note; in select mode it toggles the card like any click.

**Remote updates to the open note** are applied only if the editor doesn't have focus (`refreshFromStore`). An open editor never has its text yanked away mid-typing.

**Select mode.**
- `selected` (a Set of ids) drives everything:
  - Cards get `.sel` and a `.c-sel` circle at the top left: on hover on desktop, always while selecting. On touch, a long press starts selecting.
  - The `#selbar` is a popup at the bottom: Pin, Colour & theme, Archive, Delete (Restore and Delete forever in Trash), and Exit select mode. On phones it covers the bottom bar and shows icons only.
- While anything is selected, a click anywhere on a card toggles it; it doesn't open the note, follow a link or tick a checkbox.
- `render()` drops ids that are no longer shown, and `setView` clears the selection.
- Bulk actions go through `bulk()`, with one Undo for all notes. Every bulk action except Pin ends select mode, setting a category included.
- After a long press, the click that follows is swallowed (`lpFired`), so it doesn't toggle the card back.
- Mouse drag from empty space draws a box (`.band`) that adds the cards it touches to the selection. Card rects are read once per drag, in page coordinates.
- Drag and drop to a category: with a fine pointer (`mqMouse`), live cards are `draggable`. Dropping on a sidebar category entry gives the dragged note, or the whole selection if the card is selected, that category's theme, with one Undo. The drop re-renders only after `dragend` (250 ms fallback): removing the dragged card inside the drop handler left Chrome's drag hanging until the next click. The drag carries only `application/x-mynotes-notes`, so a drop on a text field inserts nothing and the file-drop handlers (`'Files'` only) ignore it. Touch has no note drag; long press selects.
- Escape ends select mode from a capture-phase listener. Otherwise the composer, focused on load, swallows the key.
- Phone sidebar: swipe right opens it and swipe left closes it, decided at touchend. `ptrDy` is reset per touch so a pull isn't read as a swipe. `overscroll-behavior: none` on phones also stops the browser's swipe-back from leaving the app.
- Headless Chromium reports `hover: none`, so hover-only UI (`.c-sel`, `.c-actions`) never shows in screenshots.

**Card tag.** A small label at the bottom left shows the note's category, else its colour name (`cardTag()`). It is left out in that category's or colour's own view. On desktop it shares a grid cell with `.c-actions` and fades out while they show on hover. The editor footer shows the same label (`.ed-theme`, set in `Editor.chrome()`) after the toolbar icons, always, even in the category's own view; it is a `data-a=color` button that opens the palette, inert in Trash.

**Sort** is a per-device preference, not synced. There are three: one for all notes (Notes, Archive, Trash, Attachments, search outside a category; `mn.sort`, `mn.group`), one shared by every category view (`mn.catSort`, `mn.catGroup`) and one for Pinned (`mn.pinSort`, `mn.pinGroup`); the last two start as the all-notes one. `loadSort()` (from `render()`) swaps `sortBy`/`groupCats` when the view crosses between them; the sort menu writes to the current one (`sortKeys()`). "Last edited" sorts by `editedAt`, which `updateNote` moves only when a content field (title, body, items, files, kind) really changes; theme, pin, archive and drag-to-category writes keep a note in place. Missing `editedAt` falls back to `updatedAt`. It applies inside the Pinned and Others sections, in search results and in Trash. The title sort falls back to the body, then the list items; notes with no text sort last in both directions. "Group by category" is a separate toggle in the sort menu (`groupCats`, `mn.group`, per device, default on) that combines with any sort. A stored `mn.sort` of `'category'` (the old Category sort) becomes `created` with grouping on. Outside search and a category view, grouping splits the grid into one section per category in the Settings order plus "No category", pinned notes first inside each, the rest in the chosen sort, with no Pinned/Others split. A group's label toggles it; collapsed groups are per device (`mn.collapsed`, lower-cased term, `''` for "No category"). Card tags hide the category while grouped.

The Attachments view uses the same sort (`renderGallery` in files.js, `tileCmp`): the date sorts use the file's upload time (`f.at`), the others sort by the note with the newest file first inside it. Grouping applies to the tiles the same way and shares `collapsed` with the grid.

**Note colours** (legacy): `settings.colors = {name: {hex, name}}` from the removed Settings section still applies.
- `applyUserColors()` writes a `<style>` after app.css that overrides `--c-<name>`, used as is in light and dark mode, with the ink rule for readable text (see below).
- Custom names show through `colorName()` (card tags, palette titles).
- Text colour follows the note's own background (`inkFor()` in themes.js, WCAG contrast against the two inks `--ink-dark`/`--ink-light` in app.css). Custom colours get a generated rule in `applyUserColors()`; themes set `data-ink-l`/`data-ink-d` from their base colour in `applyTheme()`. The rules override `--text`, `--muted` and `--hover` on `.card`/`.editor` only. UI that sits on the page, not the note (`.c-sel`, the selection ring), uses `--base-text`/`--base-muted`.
- Settings writes go through `setSettings(patch)`. `setCategories` is a wrapper around it.

**Google Keep import** (`public/import.js`, declarations only, loads before `app.js`; the Import tab of Settings is in `app.js`).
- The user picks the Takeout `Keep` folder (`webkitdirectory`) or its files (phones). Only the `.json` files are read; the `.html` copies are ignored.
- Each note gets the theme of the `imported` category, which is created if missing. Keep's colour, pin, archive and trash state, created and edited times are kept. Labels become `#tags` at the end of the body, unless the text already has them. Keep `CERULEAN` maps to `blue` and `BLUE` to `indigo`.
- `keep` stores the Takeout file stem. Notes with that key that aren't deleted forever are skipped, so a re-import is a no-op, also across devices.
- Images are uploaded first (3 at a time, through `prepareFile`/`putFile`), then the note is created with them. Notes bypass `createNote` so the Keep timestamps survive.
- `sync()` sends at most 300 notes per request and loops until `dirty` is empty, which keeps a big import under the server's 10 MB body limit.

**History.** Views other than Notes sit on one history entry (`{view: true}`), so Back (the iOS Safari edge swipe, Android back) returns to Notes instead of leaving the app. The modal pushes its own entry on top; `popstate` closes the modal first.

**Zoom and layout preferences** live in localStorage per device, like sort; they are not synced.
- Zoom has its own top-bar button and popup (`#zoomBtn`, `#zoomMenu`), next to sort. Zoom is hidden in Attachments and Settings; sort only in Settings. Desktop sets the card width, 160–400px (`--card-w`). Phones set 1–3 cards per row (`--cols`, plus `html[data-cols]` for tighter 3-column cards); there a tap on `#zoomBtn` cycles 3 → 2 → 1 → 3 with no popup, because a 3-step slider was hard to hit with a finger (`zoomBtnLabel()` keeps its title in step). The desktop slider always means "right = bigger cards".
- Sidebar width (desktop, not mini): drag `.side-resize` on its right edge, 180–440px, saved as `mn.sideW` and applied as an inline `--side-w` on `html` (removed on phones); double-click resets. `layout()` runs once per frame while dragging.
- Zoom changes card heights without changing the board width, so `applyZoom()` calls `layout()` itself; the ResizeObserver doesn't fire.
- Text size (Settings › General slider, `mn.textSize`, 70–120 %, default 100) scales the sidebar and card text through `--ts` on `html`. A second slider, Spacing (`mn.navSpace`, 60–120 %, default 60), sets the sidebar entry height through `--sp`. It applies on `input` and re-runs `layout()` once per frame, since card heights change.
- Phone search at the bottom is a Settings checkbox (`mn.searchBottom`, default on), shown through `html.search-bottom`. It is positioned from `--vvt`/`--vvh`, so while focused it sits above the iOS keyboard.

**No confirm dialogs.** Destructive actions show a toast with Undo (Ctrl+Z works too). Notes in Trash open read-only.

**Notifications** (toasts) are a per-device Settings preference (`mn.toast` = `{on, pos, secs}`), default on, bottom right, 6 s. `pos` is `tl`, `tr`, `c`, `bl` or `br`, applied through `html[data-toast-pos]`; the rules sit at the end of app.css so they win over the phone bottom offsets (bottom bar, selbar, search bar), which bottom positions keep. Off hides the toast, but Ctrl/⌘+Z still undoes for the duration.

## Browser gotchas (solved)

- **Maybe not a secure context.** The NAS setup is HTTPS through `tailscale serve`, but the app must keep working over plain HTTP on a LAN or Tailscale IP, where `crypto.randomUUID`, service workers and `navigator.clipboard` are unavailable. IDs come from `crypto.getRandomValues` (`uid()`). There is no offline service worker; the localStorage cache gives instant load instead.
- **iOS keyboard.** `focus()` opens the keyboard only if it runs synchronously inside the tap handler. `openNew()` therefore shows the modal and focuses the editor before anything else, with nothing async before the `focus()` call.
- **iOS keyboard covers fixed bottom toolbars.** The full-screen phone editor is sized from `visualViewport` (`--vvh` / `--vvt` CSS vars), not from `100vh`.
- **iOS zoom.** Inputs need a font-size of at least 16px on phones, or Safari zooms in on focus.
- **apple-touch-icon must be a PNG.** SVG is ignored. The PNGs were generated with a pure-Python zlib script; PIL isn't installed.
- **Outside-click to close the composer:**
  - Use `click`, not `pointerdown`. Closing re-renders the grid, and on `pointerdown` that detaches the card under the cursor, so its `click` never fires.
  - Use `e.composedPath()`, not `target.closest()`. Handlers like item delete remove the clicked node before the document listener runs; `composedPath()` still lists it.
- **Auto-growing textareas** measure 0px while hidden, which happens in a collapsed composer or a modal not yet shown. Call `sizeAll()` after making the editor visible. `autosize()` saves and restores the scroll container's `scrollTop`, or the modal jumps while you type.
- **Pull to refresh.**
  - The home-screen app has no built-in pull-to-refresh, and in the browser the built-in one reloads the page.
  - On phones `html { overscroll-behavior-y: none }` switches the browser's off. Our own touch handler (`ptr`) runs `syncNow()` instead, capped at 10 s.
  - The page is also locked while the editor is open (`html.modal-open`), so a pull in the editor never reloads.
- **Back gesture.** Opening the modal pushes a history entry; `popstate` closes it. On phones an image in the editor opens in the in-app viewer (`openViewer`, `#viewer`), not a new tab, which in the home-screen app opens with no UI. The viewer pushes its own entry on top of the modal's; Back (top left) returns to the note, Close (top right) closes the note too, and `popstate` closes the viewer before the modal. PDFs and desktop still open a new tab. Always close through `closeModal()`, never by setting `hidden` directly, or the history gets out of step.
- **Pinned card with no title.** The pin icon overlapped the body text. Fixed with `.c-pin.on + :not(.c-media) { margin-right }`. An image block follows the pin and is exempt; the pin sits on the image.
- **File input on iOS.** `input.click()` opens the picker only when it runs synchronously in the tap handler, the same rule as `focus()`.
- **Paste with files and text.** A paste that carries `text/plain` stays a text paste even if it also has files (word processors put both on the clipboard). See `clipFiles()`.

## Dev environment quirks

- No test suite. Demo data for screenshots: `tools/seed_demo.py` fills an empty server, `tools/screenshots.mjs` writes `docs/screenshots/` (see README). Never point either at the real server. Run the server locally with `MYNOTES_DB=/tmp/x.db PORT=8765 python3 server.py`. Start it with the Bash tool's `run_in_background`. A trailing `&` inside a normal Bash call hangs the tool.
- `pkill -f server.py` matches the tool's own shell command line and kills it (exit 144). Stop the server with TaskStop or by PID.
- A `python3 - <<'EOF'` heredoc hung once. Write the script to a file and run it instead.
- UI checks: Playwright and Puppeteer aren't installed. Drive `chromium --headless=new --remote-debugging-port=…` over the Chrome DevTools Protocol with Node's built-in `WebSocket`. Test 1280×820 desktop and 390×844 mobile with touch emulation, in light and dark mode.
  - A headless window has no focus, so autofocus-on-load can't be asserted.
  - Synthetic key presses typed while the composer has focus become text, by design: shortcuts are ignored while typing.
- Other sessions may commit in this repo at the same time. Check `git log` and `git status` before assuming what is uncommitted.

## Deploy and ops

- Deploy: push, then run `deploy.sh` in the NAS clone (pull `--ff-only` + `docker compose up -d --build --remove-orphans`; `docs/deploy-synology.md`; this setup's real host, IPs and remote are in the git-ignored `docs/local.md`). Never edit the NAS clone.
- `compose.yaml` publishes port 8090 on `127.0.0.1` only (`KEE_BIND` in `.env` overrides). On the NAS, `tailscale serve` proxies HTTPS on the tailnet to it, and Tailscale ACLs limit the NAS to the owner's devices. `MYNOTES_HOSTS` in `.env` (git-ignored) holds the `ts.net` name. There is no auth: anyone who reaches the port can read and write notes.
- The SQLite database lives in `./data` next to the NAS clone. It is git-ignored and must be backed up separately.
- `GET /api/notes?since=0` dumps every note, tombstones included. Use it for export and debugging.

## Lessons

- The app runs behind `tailscale serve`, so the page is `https://`. Never compare `Origin` with a hard-coded scheme; one place checks it (`origin_allowed` in `Handler.parse_request`). Test write paths with `Origin: https://<host>` too: the upload bug looked like an iPhone problem but broke every device on the HTTPS address.
- The Settings panel is built when Settings first opens. A test that reads or clicks its controls must `setView('settings')` (and the tab) first, or `querySelector` returns null and clicks don't save.
- Don't reuse a generic class name on a new element: `.empty` (the board's empty state, `display: grid`) made the empty rich field 220px tall. Prefix state classes (`is-empty`).
- `.nav-count` text includes the pinned suffix (`5 (2)`); read the number from its first text node.
- Per-device defaults only reach devices that never saved the setting. Say so when changing a default.
- The scratchpad can be cleared between sessions, taking test scripts and the 8765 test server's database with it. Don't rely on either surviving.
- Everything in the tree is published to GitHub. Never put real hosts, IPs, user names or emails in tracked files; they go in the git-ignored `docs/local.md`.
