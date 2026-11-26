# Changelog

Newest first. Each entry: what changed, why, and how to revert it. "Revert"
means `git revert <commit>` unless it says otherwise. Per-device settings
live in each browser's localStorage, so reverting code never touches notes.

## 2026-11-26

- **Online demo on GitHub Pages.** The app runs on a static host with a
  service worker as its server, seeded with the screenshot demo notes;
  `tools/build_demo.py`, `demo/`, `.github/workflows/demo.yml`. Why: let
  people try Kee+ without installing it. Revert: delete those files and
  the README link; turn off Pages in the GitHub repo settings.
- **Removed a real name** from the example text of Settings › Icons ›
  Your words (now "mia"). It is still in Gitea history (`f407ecc`), never
  on GitHub.

- **Category colours and icons.** One palette colour per main
  category, shared by its subs; notes are flat tinted cards with a colour
  strip on top; tags show the category's icon and own name. Settings ›
  Categories: "Icons" (default on) and "Background patterns" (the old
  generated patterns, now in the palette colour; default off). Each main
  category picks a swatch and can be fine-tuned; any category can pick an
  icon (Auto guesses from the name). Why: owner's mock-up; siblings were
  hard to tell apart by shifted hues. Revert: `git revert` the commit; the
  added `swatch`/`tune`/`icon` fields are then ignored and the old h/s/v/c
  values still apply.
- **Main category on card tags.** Settings › Categories ›
  "Show the main category on cards" (synced, default on): a sub's tag
  reads "AI › LLMs". Five more icons (person, cooking pot, cocktail, piggy
  bank, shapes) with name hints. Revert with the same commit.
- **Settings › Icons tab**. Lists every category's icon and
  why it got it, with a picker, and every available icon with its built-in
  words and your own words (synced `settings.iconWords`), so names like
  people's map to an icon without putting them in the public code.
  Revert: `git revert` the commit; stored words are then ignored.
- **Drag and drop in Settings › Categories**. Drag a row by
  its grip to reorder it, or onto a main category to make it a
  sub-category there; mouse and touch. Reordering switches the order to
  Custom. One Undo. Revert: `git revert` the commit.
- **Group by sub-category**. With "Group by category" on,
  each main category's section is split by its sub-categories. Sort menu
  › "Sub-categories too" (per device, default on). Revert: `git revert`
  the commit.
- **README and screenshots reworked**. All screenshots and
  GIFs in dark mode, regenerated from new demo data (sub-categories,
  palette colours, icon words, formatted notes). New sections: categories,
  colours/icons/patterns, icon words, sorting and grouping, formatting and
  shortcuts, Keep import. Revert: `git revert` the commit.

- **Note formatting, Markdown or rich editor** (GitHub v1.6.0). Bold, italic,
  underline, strikethrough and two heading levels in text notes, with
  Ctrl+B/I/U, Ctrl+Shift+X/1/2/0 and buttons in the phone editor. Stored as
  Markdown marks in `body`, so sync, search and older clients see text.
  Settings › General › Note editor picks rich text (default) or Markdown.
  The sidebar shortcuts list gets a second tab with the formatting keys,
  named after the editor in use.
  Why: owner request. Revert: `git revert` the commit; notes keep their
  marks as plain text.

## 2026-11-25

- **New per-device defaults** (`569bdd4`, GitHub v1.5.0). Spacing slider 60 %, the
  sidebar Shortcuts list off, "Start new notes with the title" on.
  Why: the owner's preferred setup on every new device. Only devices that
  never saved the setting change. Revert: `NAV_SPACE.def` back to 100,
  `navHidden()` fallback back to `[]`, `readLS(K.titleFirst, false) === true`
  in `public/app.js`.
- **Pinned has its own sort** (`569bdd4`, v1.5.0). `mn.pinSort` / `mn.pinGroup`,
  starting as the Notes sort. Why: pinned notes are read differently from
  the full list. Revert: drop the `pinned` entry from `SORT_KEYS` and
  `sortScopeOf()` in `public/app.js`; the stored keys are then ignored.
- **Uploads work over HTTPS** (`2ce9ecd`, GitHub v1.4.1). `files.py`
  compared Origin with `http://` + Host, so behind `tailscale serve` every
  attachment got 403 (looked like "pasting images doesn't work on the
  iPhone"). The duplicate check is gone; `Handler.parse_request` already
  checks Origin for every write, both schemes. Do not revert: it would
  break attachments on the Tailscale HTTPS address again.
- **Sticky shortcuts list** (`adbe837`, v1.4.0). A long sidebar scrolls
  behind the shortcuts, which have a top divider; "Shortcuts list" in Show
  in the sidebar hides both. Revert: `git revert adbe837`.
- **Find category field, Pinned view, configurable sidebar** (`59e791e`,
  v1.3.0). Find field under Notes (Shift+/), Pinned view across all
  categories, pinned counts `5 (2)`, dragging a note opens every sub and
  shows hidden categories, checkboxes to hide Find, Pinned, Attachments,
  Archive and Trash, General settings regrouped. Revert: `git revert
  59e791e` (revert `adbe837` first).
- **New-category field focused, selection cleared** (`cf297e1`, v1.2.0).
  The palette focuses "New category" with a mouse; setting a category on
  a multi-selection ends select mode. Revert: `git revert cf297e1`.
- **`deploy.sh`** (`2f4a2a4`, v1.1.0). Pull `--ff-only` and rebuild on the
  NAS. Revert: delete the script; deploy by hand as in
  `docs/deploy-synology.md`.
- **Category names scoped per level** (`15dd59b`, v1.1.0). `term` is the
  key, `name` the label; "Misc" can sit under two mains. Rename changes
  the name only. Why: a sub with a main's or another sub's name merged
  into it. Revert: not safe once categories with a `name` exist; they
  would show their keys (`Shopping/Misc`).

## 2026-11-24

- **Sidebar opens a main when viewed** (`8a26dd3`). Revert the commit.
- **Drag re-renders after `dragend`** (`259ca64`). Why: re-rendering in
  `drop` left Chrome's drag hanging until the next click. Do not revert.
- **Resizable sidebar** (`54766b9`). `mn.sideW`, 180–440px. Revert the
  commit.
- **Hide empty categories, size sliders, Alt+↑/↓** (`590e7b9`). Revert
  the commit.
- **Grouped list picker, spring-loaded sidebar** (`571c2f3`). Revert the
  commit.
- **Rename categories, subs sorted A–Z** (`f29362b`). Revert the commit
  (after `15dd59b`, which changed rename).
