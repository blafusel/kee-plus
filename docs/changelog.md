# Changelog

Newest first. Each entry: what changed, why, and how to revert it. "Revert"
means `git revert <commit>` unless it says otherwise. Per-device settings
live in each browser's localStorage, so reverting code never touches notes.

## 2026-11-25

- **New per-device defaults** (wrap-up commit). Spacing slider 60 %, the
  sidebar Shortcuts list off, "Start new notes with the title" on.
  Why: the owner's preferred setup on every new device. Only devices that
  never saved the setting change. Revert: `NAV_SPACE.def` back to 100,
  `navHidden()` fallback back to `[]`, `readLS(K.titleFirst, false) === true`
  in `public/app.js`.
- **Pinned has its own sort** (wrap-up commit). `mn.pinSort` / `mn.pinGroup`,
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
