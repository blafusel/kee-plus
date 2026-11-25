# File Attachments for mynotes

*   **Author:** blafusel
*   **Status:** Approved
*   **Date:** 2026-11-23

--------------------------------------------------------------------------------

## Overview

mynotes is a single-user notes app in the style of Google Keep. It runs as one
container on a Synology NAS and is used from an iPhone and a desktop browser
over the LAN or Tailscale. Notes hold a title plus text or a checklist. Each
note is stored as one JSON row in SQLite and synced by a revision-based
protocol (see `CLAUDE.md`).

This design adds file attachments. You can attach images (pasted screenshots,
phone photos) and PDFs to a note, by paste, by drag and drop, or with a
paperclip file picker. Before upload, the browser shrinks each image to about
2000 px on its long edge and also makes a thumbnail of about 400 px. The server
stores the bytes on disk next to the database, keeps a metadata table, and
deletes files that no note has referenced for 30 days. Cards show image
thumbnails and PDF name chips. A new sidebar view, "Attachments", shows every
file in a gallery, and tapping a tile opens its note.

Attaching a file needs a working connection to the NAS. Note text stays
offline-first as it is today.

## The Problem

There is no way to keep a screenshot, a photo or a PDF with a note today. The
author does not save them at all. A note can only say "see the screenshot",
and the screenshot lives somewhere else or nowhere.

The app is built around fast capture: open it, type, done. Attachments must
keep that property. A pasted screenshot has to become a saved note with no
extra steps. Otherwise the feature will not get used.

Adding files also brings risks that text notes do not have:

*   **Data loss.** The current rules treat a note with no title, body or list
    items as empty. An empty note is never created, and it is deleted when the
    editor closes. An image-only note would be lost unless those rules change.
    Clients still running old code would keep deleting such notes after the
    deploy.
*   **Disk use.** Text notes are a few KB each. Photos are megabytes. Without
    cleanup, deleted images would stay on the NAS forever.
*   **Security.** The app has no login, and anyone on the LAN or tailnet can
    use it. An upload endpoint lets any web page open in a browser on that
    network write to the NAS disk. An uploaded HTML or SVG file served from the
    app's origin could run script with full access to every note.

## Goals

*   **Fast capture.** On the iPhone, a screenshot is attached and saved within
    5 seconds. The start and stop points are fixed in Open Questions after the
    device check.
*   **Image-only notes are real notes.** A note whose only content is one or
    more files is created, synced, kept, shown in the grid and searchable by
    file name. It is never treated as empty.
*   **Every reference resolves.** A note never refers to a file that the server
    has not stored. The upload finishes before the reference is added.
*   **The masonry grid does not jump.** Card heights are known before any image
    loads, so `layout()` still runs at most two forced layouts per render.
*   **Uploads cannot run code.** The server accepts only JPEG, PNG, GIF, WebP and
    PDF, decided by the file's first bytes, never by the name or the browser's
    type. Files are served so that a browser will not run script from them on
    the app's origin.
*   **Uploads from other sites are refused.** An upload must carry a custom
    request header and a matching `Origin`. A page on another site cannot send
    that header without a CORS preflight, and the server never approves one.
*   **Disk use is bounded.** The server enforces a per-file size limit and a
    total quota. A file is deleted 30 days after the last note that referenced
    it stopped referencing it. Nothing is deleted while Undo, Trash or the
    grace period could still bring it back.
*   **Pages stay light on the phone.** Cards and the gallery load ~400 px
    thumbnails, not the 2000 px image.
*   **No new dependencies.** The server stays Python standard library only. The
    client stays vanilla JavaScript with no build step.
*   **Old clients cannot delete new notes.** A client running code from before
    this feature reloads itself before it can open, change or delete an
    image-only note.

## Non-Goals

*   **Offline uploads.** No upload queue in IndexedDB. If the NAS cannot be
    reached, the attach fails with a toast. The note text is unaffected.
*   **Keeping originals.** Only the downscaled image and its thumbnail are
    stored. EXIF data, including GPS location, is dropped by the re-encode.
*   **Images inside the note text**, reordering attachments, PDF previews or
    thumbnails, and image editing or annotation.
*   **Link previews.** Links stay plain text in the note body. They are already
    turned into clickable links.
*   **Merging attachments across devices.** Conflicts stay last-write-wins on
    the whole note, as today.
*   **Capture from the iOS share sheet.** A home-screen web app cannot register
    as a share target. An iOS Shortcut that posts straight to the server is a
    possible later addition, not part of this design.
*   **Multiple users, logins or per-file permissions.**
*   **Other file types** (Office documents, audio, video, archives).

## Open Questions

*   **iPhone paste.** Does iOS Safari put a pasted image into
    `clipboardData.files` for a `paste` event in a textarea, on plain HTTP?
    If not, on the phone only the paperclip button works. This decides
    the exact 5-second measure.
*   **5-second measure.** Start point (screenshot taken, app opened, or
    paste/pick), stop point (local preview shown, or server acknowledged), and
    network (home Wi-Fi or Tailscale over cellular). Proposed: from paste or
    pick to server acknowledged, on home Wi-Fi.
*   **PDF headers.** Does Chrome's PDF viewer, and iOS Safari, still show a PDF
    served with `Content-Security-Policy: sandbox`? Decides the PDF response
    headers.
*   **EXIF orientation and HEIC.** Do `createImageBitmap` or a decoded `<img>`
    on the iPhone apply EXIF rotation? Does the iOS picker turn HEIC photos
    into JPEG?

## Critical User Journeys (CUJs)

### CUJ 1: Screenshot to note on the iPhone

*   **Given**: mynotes is open on the iPhone home screen, and the NAS can be
    reached. A screenshot is on the clipboard or in Photos.
*   **When**: The user taps "Take a note…", then pastes into the text field or
    taps the paperclip and picks the screenshot.
*   **Then**: A preview appears in the editor at once, with an upload
    indicator. Within 5 seconds the upload is confirmed and the note exists,
    even if it has no text. Closing the editor shows the card with the
    thumbnail at the top. The desktop shows the same card after its next sync.

### CUJ 2: Paste a screenshot on the desktop

*   **Given**: The desktop composer is focused, and a screenshot is on the
    clipboard.
*   **When**: The user presses Ctrl+V, types a title, then presses
    Ctrl+Enter.
*   **Then**: The image is attached, the note is saved with title and image,
    and the composer starts the next note.

### CUJ 3: Attach a PDF by drag and drop

*   **Given**: A note is open in the desktop modal editor.
*   **When**: The user drops a PDF file onto the editor.
*   **Then**: A chip with the file name appears in the editor and on the card.
    Clicking the chip opens the PDF in a new tab. Dropping an unsupported
    file, or one over the size limit, shows a toast and attaches nothing. A
    drop that misses the editor never makes the browser leave the app.

### CUJ 4: Remove an attachment, then undo

*   **Given**: A note has two images.
*   **When**: The user clicks the x on one image in the editor.
*   **Then**: The image disappears, and a toast offers Undo. Undo, or
    Ctrl+Z, brings it back. Without Undo the file stays on the server for
    30 days, then the cleanup deletes it.

### CUJ 5: Browse attachments

*   **Given**: Several notes have images and PDFs.
*   **When**: The user opens "Attachments" in the sidebar.
*   **Then**: A gallery shows every file, newest first: image thumbnails and
    PDF tiles. Tapping a tile opens the note that holds it. The view works from
    data already on the device.

### CUJ 6: Upload fails

*   **Given**: The phone has no route to the NAS.
*   **When**: The user pastes or picks an image.
*   **Then**: A toast says the file could not be attached. The note text is
    still saved locally and synced later as today. No broken reference is left
    in the note.

### CUJ 7: An old client after the deploy

*   **Given**: The iPhone home-screen app has been in the background since
    before the deploy and still runs the old JavaScript.
*   **When**: The app comes back to the front and syncs.
*   **Then**: The server reports a newer app version, and the client reloads
    before the user can open any note. It never runs the old empty-note rule
    on an image-only note.

## Technical Plan (Architecture)

### Components and data flow

```text
 Browser (iPhone / desktop)                         NAS container
 ─────────────────────────────                      ─────────────────────────────
 paste / drop / paperclip
        │
        ▼
 files.js: check type ── decode ── canvas ──┐
          (2000 px main + 480 px thumbnail) │
        ▼                                   │
 pending strip in the editor                │
 (object-URL preview + spinner)             │
        │                                   ▼
        │  PUT /api/files/<id>        ───────────►  files.py: stream to .tmp,
        │  PUT /api/files/<id>/thumb  ───────────►  check first bytes, rename,
        │  (X-Mynotes: 1, raw body)   ◄── 201 ────  insert row in `files` table
        ▼
 app.js: updateNote(noteId, {files: [...old, meta]})
        │   (or createNote when the draft has no note yet)
        ▼
 dirty → POST /api/sync  ────────────────────────►  server.py sync(): note JSON
                                                    stored as today (files array
                                                    is just part of the JSON)

 card / gallery:  <img src="api/files/<id>/thumb">  ◄──  GET, immutable cache
 open full file:  api/files/<id>  (new tab)         ◄──  GET, nosniff + CSP

 daily + at startup:  cleanup scan  ── reads every notes.data row ── sets or
                      clears unreferenced_since ── deletes after 30 days
```

The server never looks inside a note during `sync()`. Notes keep their
existing protocol: whole-note last-write-wins on `updatedAt`. Only the
cleanup scan reads note JSON to learn which files are still referenced.

### Rollout: version check first

The danger is code that is already running. A client from before this feature
treats an image-only note as empty and deletes it when the note is opened and
closed. Code cannot fix a client that is already loaded, so rollout has two
deploys:

1.  **Deploy A, version check only.** At startup the server computes `v`, a
    short hash of the contents of every `*.html`, `*.js`, `*.css` and
    `*.webmanifest` file in `public/`. Every `/api/sync` response includes `v`. The client
    remembers the `v` of its first successful sync after page load. If a
    later response carries a different `v`, the client calls `persistNow()`
    and `location.reload()`. Nothing is bumped by hand. Since `public/` files
    are served with `Cache-Control: no-cache`, the page that loads is always
    the current one. After deploy A, reload the app once by hand on every
    device.
2.  **Deploy B, attachments.** Every client now runs the version check, so
    each one reloads into the new code on its next sync, before it can see an
    image-only note.

**No rollback past deploy B.** A rolled-back client would reload into code
that deletes image-only notes. Fix forward instead. The README states this.

### Data model

**Note JSON (client and sync).** Each note gets one new field:

```text
files: [
  { id:    "<24 hex chars, from uid()>",
    name:  "Pasted image 2026-11-23 14.05.png",
    type:  "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "application/pdf",
    size:  412345,          // bytes of the main file
    w: 1179, h: 2000,       // images only, after downscaling
    thumb: true,            // images only: a /thumb variant exists
    at:    1764000000000 }  // when it was attached (gallery sort)
]
```

Rules for the client store:

*   `blank()` includes `files: []`. Notes loaded from localStorage or a sync
    that have no `files` get `files = []` in a `normalize(n)` step. This only
    fills a missing default, so it does not touch `updatedAt`.
*   `copyItems` becomes `copyArrays(patch)`. It copies both `items` and `files`
    element by element in `createNote`, `updateNote` and `Editor.load`. The
    editor never shares an array with the store. Callers always replace
    `files` with a new array and never change it in place, so the shallow
    Undo snapshots stay safe.
*   `hasContent(n)` returns true when `n.files.length > 0`.
*   `removeNote` (tombstone) also sets `files: []`. A deleted note then stops
    referencing its files, and the cleanup can free them.
*   `matches()` (search) also searches file names.

**Server table** (in the same SQLite file):

```text
CREATE TABLE files (
  id                 TEXT PRIMARY KEY,   -- ^[0-9a-f]{24}$
  name               TEXT NOT NULL,
  type               TEXT NOT NULL,      -- decided from the first bytes
  size               INTEGER NOT NULL,
  thumb_size         INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,   -- ms
  unreferenced_since INTEGER             -- ms; NULL while some note refers to it
)
```

**Disk layout:** `MYNOTES_FILES` (default: a `files/` folder next to
`MYNOTES_DB`, so `/data/files` in the container). The main file is stored as
`<id>` and the thumbnail as `<id>.thumb`. Uploads in progress are written as
`<id>.<random>.tmp`. Ids are validated before any path is built, so a request
cannot reach a path outside this folder.

### HTTP API

All new routes live under `/api/files`, and `files.py` handles them.

| Method and path | Purpose | Success | Errors |
| --- | --- | --- | --- |
| `PUT /api/files/<id>` | Upload the main file. Raw body. Headers: `X-Mynotes: 1`, `Content-Length`, `X-Filename` (URL-encoded). | `201 {id,type,size}`. `200` if the same id with the same size already exists, so a retry is safe. | 400 bad id or name, 403 missing header or foreign `Origin`, 409 id exists with a different size, 411 no length, 413 over limit, 415 type not allowed, 507 quota or disk full |
| `PUT /api/files/<id>/thumb` | Upload the thumbnail. Same headers. The main file must already exist, and the thumbnail must be JPEG. | `201` | as above, plus 404 if the main file is missing |
| `GET /api/files/<id>` | The main file. | `200` with the headers below | 400, 404 |
| `GET /api/files/<id>/thumb` | The thumbnail. | `200` | 400, 404 |
| `GET /api/files` | Metadata of every stored file, for export and debugging. | `200 [rows]` | |

**Upload handling:**

*   Check the id, the headers and the length *before* reading the body.
*   Read the body in 64 KB chunks into a `.tmp` file. Check the first chunk
    against the allowed signatures and stop at once on a mismatch:
    *   JPEG `FF D8 FF`
    *   PNG `89 50 4E 47 0D 0A 1A 0A`
    *   GIF `GIF87a` / `GIF89a`
    *   WebP `RIFF....WEBP`
    *   PDF `%PDF-`
*   When the body is complete, `fsync` the file. Then, holding the global
    `lock`, `os.replace` it into place and insert the row, as one step, so
    the cleanup scan never sees a file without its row. The body is never
    read while the lock is held, so a slow upload over Tailscale does
    not block sync.
*   Limits, from environment variables:
    *   `MYNOTES_MAX_FILE_MB`, default 20, per file.
    *   `MYNOTES_QUOTA_MB`, default 4096, total of `size + thumb_size` over all
        rows.
    *   A fixed free-space floor of 1 GiB on the volume (`shutil.disk_usage`).
*   Before any error response, or an early 200 for a retried upload, the
    server reads and discards the rest of the body when `Content-Length` is
    at most the per-file limit. Closing a socket with unread data can make
    the browser see a connection reset instead of the status. For 413 it
    closes without reading.
*   The handler sets `timeout = 60` seconds on the socket, so a stalled client
    cannot hold a thread forever.
*   Uploads and rejections are logged with id, type, size and reason.

**Cross-site guard.** A `PUT` with a custom header can only come from another
site after a CORS preflight (`OPTIONS`). The server does not answer `OPTIONS`
with any CORS approval, so the browser blocks it. As a second check, if an
`Origin` header is present it must equal `http://<Host>`. `/api/sync` is not
changed.

**Response headers for `GET`:**

*   `Content-Type`: the type from the table.
*   `X-Content-Type-Options: nosniff`.
*   `Cache-Control: private, max-age=31536000, immutable`. Ids are written
    once and never change.
*   `Content-Disposition: inline; filename*=UTF-8''<percent-encoded name>`,
    with CR and LF removed from the name.
*   Images: `Content-Security-Policy: default-src 'none'; sandbox`.
*   PDFs: shipped with `Content-Disposition: attachment` (download, then
    open). They switch to `inline` with `Content-Security-Policy: sandbox`
    only if the device check shows that both Chrome and iOS Safari still
    render a PDF served that way.

`end_headers()` still adds `no-cache` only to paths outside `/api/`, so
these headers are not overwritten.

### Cleanup scan

`files.py` runs one scan at startup and then every 24 hours on a daemon
thread. The grace period comes from `MYNOTES_FILE_GRACE_DAYS`, default 30;
tests can set it to 0. Each scan:

1.  Under `lock`, read every row of `notes`, parse its JSON, and collect the
    `files[].id` values. Tombstones (`deleted: true`) do not count, and since
    they have `files: []` they add nothing anyway. Archived and trashed notes
    do count. Malformed `files` values are skipped. The parsing is done in
    Python, so it does not depend on SQLite's JSON functions.
2.  For each row in `files`:
    *   Referenced: set `unreferenced_since = NULL`.
    *   Not referenced and `unreferenced_since` is NULL: set it to now.
    *   Not referenced and older than the grace period: delete `<id>`,
        `<id>.thumb` and the row.
3.  Delete `.tmp` files older than one hour, and files on disk that have no
    row and are older than one hour.
4.  Log: files scanned, newly unreferenced, deleted, and bytes freed.

A file that is uploaded but whose note has not synced yet is unreferenced for
a few seconds. The 30-day clock covers that.

The longest a deleted note's image can stay on disk is up to 7 days in Trash,
plus up to 24 hours until the next scan, plus 30 days.

### Client: upload pipeline (`public/files.js`)

`attach(fileList, editor)` handles paste, drop and the picker the same way:

1.  **Pre-check.** Check the browser's type or file extension against the
    allowed list. Reject other files with a toast. The server's
    first-bytes check is the real defence; this check only avoids a pointless
    upload.
2.  **Target.** Record `{noteId: editor.id, draftKey: editor.draftKey}`.
    Each editor session has a `draftKey`. When a draft first becomes a note,
    `Editor.set()` records `draftKey -> note id` in a module-level
    `draftNotes` map. The target is never a reference to the editor itself.
3.  **Pending state.** Add a pending entry with an object-URL preview to the
    editor's `pending` list. This list is UI state outside `editor.d`, so it
    is never stored or synced.
4.  **Images.**
    *   Decode with `createImageBitmap(file, {imageOrientation: 'from-image'})`,
        falling back to an `<img>`.
    *   Scale so the long edge is at most 2000 px, and draw it with one
        `drawImage` call.
    *   Encode:
        *   PNG sources stay PNG when the result is at most 1.5 MB. Larger
            ones become JPEG, which keeps small screenshots sharp.
        *   Everything else becomes JPEG at quality 0.85, with a white
            background under any transparency.
        *   GIFs are uploaded unchanged, to keep the animation, if they are
            within the size limit.
    *   The thumbnail is drawn from the same bitmap at 480 px wide, at most
        1440 px tall, as JPEG at quality 0.8.
    *   If decoding fails (for example HEIC in desktop Chrome), show the toast
        "Can't read this image" and stop.
5.  **PDFs** are uploaded unchanged, with no thumbnail.
6.  **Upload.** `PUT` the main file, then the thumbnail, with `fetch`. On a
    network error or an error status, remove the pending entry and show a
    toast with the reason:
    *   "Couldn't attach: no connection"
    *   "File too large (max 20 MB)"
    *   "This file type isn't supported"
    *   "Storage on the NAS is full"
    *   "Couldn't attach this file" (any other error status)
7.  **Attach.** Build `meta`, then let `id = noteId ?? draftNotes.get(draftKey)`
    and check these cases in order:
    1.  `id` names a live note: `updateNote(id, {files: [...current.files, meta]})`.
        If `composer.id` or `modalEd.id` equals `id`, also add `meta` to that
        editor's `d.files` and call its `renderFiles()`. This case also
        covers a draft that got text and was then closed with Ctrl+Enter
        during the upload, so the title and the image stay in one note.
    2.  `id` names a tombstone: drop the result. The file stays on the server
        until the cleanup removes it.
    3.  No note yet, and `composer.draftKey` or `modalEd.draftKey` equals
        `draftKey`: call that editor's `set({files: [...d.files, meta]})`.
        This creates the note, because `hasContent` is now true.
    4.  Otherwise, the draft was closed before it had any content:
        `createNote({files: [meta]})`. The image is not lost, and it shows up
        as an image-only note.
8.  Remove the pending entry and revoke the object URL.

Pasted screenshots arrive named `image.png`, so they are renamed to
`Pasted image YYYY-MM-DD HH.MM.<ext>`. Re-encoding drops EXIF metadata,
including GPS. This is intended.

### Client: input surfaces

*   **Paste.** `Editor.onPaste` first checks `clipboardData.files`. If it holds
    files, it calls `preventDefault()` and `attach()`. This applies to the title,
    body and list fields of both editors. With no files, the paste goes
    through the existing text and list logic.
*   **Paste outside an editor.** On the desktop, pressing Ctrl+V with no text
    field focused and files on the clipboard calls `openNew('text')`, then
    `attach()` on the composer.
*   **Drag and drop.**
    *   At document level, `dragover` and `drop` call `preventDefault()` when
        `e.dataTransfer.types.includes('Files')`, so a missed file drop never
        navigates away from the app. Text drags are left alone.
    *   A drop on an open editor attaches to that editor.
    *   A drop anywhere else on the desktop opens the composer and attaches
        there.
    *   While dragging, the target editor gets a highlight class.
*   **Paperclip.**
    *   Each editor has a hidden
        `<input type="file" accept="image/*,application/pdf" multiple>`,
        without `capture`, so iOS also offers the photo library and Files.
    *   One paperclip button sits in `.ed-quick`, which stays visible while the
        composer is collapsed. Another sits in `.ed-foot`.
    *   On phones, the bottom bar gets a paperclip button. Its tap handler calls
        `openNew('text')` and then `input.click()` synchronously, which is the
        same iOS rule as `focus()`.
*   Notes in Trash are read-only. They hide the paperclip and remove buttons
    and ignore paste and drop.

### Client: rendering

**Card** (`card()` in `app.js`):

*   If the note has images, the first one is shown at the top of the card:
    *   An `<img src="api/files/<id>/thumb" loading="lazy">` with `width` and
        `height` attributes set from the stored `w` and `h`, and CSS
        `aspect-ratio`. The card's height is known before the image loads.
    *   `max-height: 360px` with `object-fit: cover; object-position: top`, so
        a tall phone screenshot does not fill a whole column.
    *   With more than one image, a "+N" badge sits on the corner.
*   PDFs show as chips below the text: a file icon plus the name, shortened
    with an ellipsis.
*   `onerror` on an image (deleted by cleanup, or offline with an empty cache)
    swaps in a grey placeholder of the same size. The card's height does not
    change, so `layout()` does not need to run again.
*   `.c-media` is inserted after the pin button. The pinned-card rule
    `.c-pin.on + *` becomes `.c-pin.on + :not(.c-media)`. Untitled pinned
    lists keep today's fix. When the image follows the pin, the pin sits on
    the image with a translucent background.
*   The empty-note label uses `hasContent`, so image-only cards do not say
    "Empty note".

**Editor:**

*   A `.ed-files` strip sits above the title and shows each file:
    *   images as 96 px thumbnails;
    *   PDFs as chips;
    *   pending uploads with their local preview and a spinner.
*   Clicking an image or a chip opens `api/files/<id>` in a new tab.
*   Each file has an x button. It takes a snapshot `snap = {...notes.get(id)}`,
    calls `set({files: without})` and shows a toast with Undo. Undo calls
    `updateNote(id, {...snap, files: [...snap.files]})`, which also brings
    the note back if it was tombstoned meanwhile. If the note is still open,
    it then reloads the editor's working copy.
*   If removing the last file leaves the note empty, closing the editor
    tombstones the note, as today. The Undo toast from the removal is still
    shown.
*   `sizeAll()` runs after the strip changes, because the strip moves the
    textareas.

**Attachments view:**

*   It is a new value of `view`, `'attachments'`, with a paperclip icon in
    the sidebar between Notes and Archive. `render()` gets an early branch for
    it, because it shows tiles, not note cards.
*   Tiles come from the in-memory `notes` Map. The view includes files in
    normal and archived notes, but not in trashed or deleted notes. It is
    sorted by `at`, newest first.
*   Search filters tiles by file name, note title or note text.
*   Tiles are fixed squares in a CSS grid
    (`repeat(auto-fill, minmax(140px, 1fr))`), so this view does not need the
    masonry `layout()`.
    *   Image tiles show the thumbnail with `object-fit: cover`.
    *   PDF tiles show an icon and the file name.
*   Tapping a tile calls `openModal(noteId)`. Closing the modal returns to the
    gallery.
*   The composer and the trash bar are hidden in this view. When the view is
    empty, it shows "Files you attach appear here".

### Code layout

*   **`files.py`** (new) holds storage, validation, upload and download
    handlers, response headers and the cleanup thread. `server.py` imports it,
    routes `/api/files` to it, and adds `v` to the sync response.
*   **`public/files.js`** (new) is a second `<script defer>` that loads
    *before* `app.js`. It contains only declarations: functions and
    constants, with no top-level code that reads `app.js` bindings or the
    DOM. Classic scripts share one global scope, so its functions can use
    `app.js` bindings when called. All event wiring lives in `app.js`. That
    way `app.js`'s startup `render()` can call `renderGallery` safely. It
    holds the image pipeline, the uploads, `attach()`, drop and
    paste wiring, and the gallery renderer. It changes notes only through
    `createNote` and `updateNote`, never through `notes` or `dirty` directly.
    Both scripts are classic scripts that share the global scope, so no build
    step is needed.

### Accepted risk: last-write-wins can drop an attachment

Decided by the author: accept and document.

**The scenario.**

1.  Device A attaches a file to a note.
2.  Device B still holds an older copy of that note, without the file, and
    edits it.
3.  B's write has the later `updatedAt`, so it replaces A's version. The file
    reference is gone.

**The result.** Nothing in the app shows the loss. After 30 days the cleanup
deletes the file. It can be found until then through `GET /api/files`, by
comparing it with the notes. This is the same rule that already applies to
text edits today, but here it can delete data that exists nowhere else. The
README and CLAUDE.md state this risk.

**Mitigation in use.** Sync runs 500 ms after each change and every
30 seconds, so two devices rarely edit the same note at the same time.

## Alternatives Considered

### Alternative A: Smaller first version (images only, no gallery, no table, no cleanup)

The zoom-out review proposed it. Note JSON is the only metadata, files sit on
disk as `<id>.<ext>`, and there is no Attachments view. There is either no
cleanup or a sweep at startup only, based on file modification time.

*   **Pros**:
    *   About half the code.
    *   No second table to keep in step with the notes.
    *   Gets the core capture flow out sooner.
*   **Cons**:
    *   No PDFs.
    *   No way to browse files.
    *   The NAS container rarely restarts, so a startup-only sweep almost
        never runs.
    *   A sweep based on modification time measures time since upload, not
        time since the file stopped being referenced. It would delete a file
        removed from its note on day 40 at once, so Undo restores an
        unrecoverable reference.
*   **Reason for Rejection**: Rejected by author: the gallery and PDFs are
    wanted in the first version, and the cleanup needs an "unreferenced
    since" clock to be safe.

### Alternative B: Offline upload queue in IndexedDB

The bytes wait in IndexedDB, the note references the file at once, and a
background task uploads it later. Other devices show a placeholder until the
upload lands.

*   **Pros**:
    *   Attaching works with no connection, matching how note text works.
*   **Cons**:
    *   A second sync channel.
    *   A "not uploaded yet" state that every device has to render.
    *   Retry logic.
    *   References to bytes that may never arrive, if the device is wiped
        before it uploads.
    *   Roughly doubles the client code for this feature.
*   **Reason for Rejection**: Rejected by author: the author is always online
    when attaching. The cost buys nothing in practice.

### Alternative C: Multipart form upload (`POST` with `multipart/form-data`)

*   **Pros**:
    *   The usual way to upload files from a web form.
    *   One request could carry the file, the thumbnail and the metadata.
*   **Cons**:
    *   Python 3.13 removed the `cgi` module, so the standard library has no
        multipart parser.
    *   Writing one by hand is error-prone. It also forces buffering, or a
        boundary scanner, before the type can be checked.
*   **Reason for Rejection**: Rejected by author: a raw-body `PUT` per file
    needs no parser, streams straight to disk, and is safe to retry because
    the client makes the id.

### Alternative D: Server-generated file ids

*   **Pros**:
    *   No chance of an id collision between clients.
*   **Cons**:
    *   The client must wait for the server before it has a stable id. A
        retried upload could store the same file twice.
*   **Reason for Rejection**: Rejected by author: client ids from `uid()`
    (96 random bits) make the upload idempotent. The server checks the id
    format and returns 409 if the same id arrives with a different size.

### Alternative E: Add the reference first, upload afterwards

*   **Pros**:
    *   The note shows the file at once, even before the upload finishes.
*   **Cons**:
    *   Other devices sync a reference to bytes that do not exist yet.
    *   A failed upload leaves a broken reference behind.
    *   It needs placeholder handling on every device, which is the queue
        problem from Alternative B again.
*   **Reason for Rejection**: Rejected by author: uploading first, then adding
    the reference after a 2xx, guarantees that every reference resolves. The
    local preview comes from UI state, not from the note.

### Alternative F: Handle last-write-wins loss with an "Unattached" section, or a per-file merge

*   **"Unattached" section**: an orphan list endpoint plus a gallery section
    with "Restore to new note". It also recovers files removed by mistake.
    It costs about 60–80 lines.
*   **Per-file merge**: the client merges `files` arrays and keeps per-file
    removal tombstones. This changes the core sync rule, which has no test
    suite.
*   **Reason for Rejection**: Rejected by author: accept the risk and document
    it. Conflicts are rare for a single user whose devices sync every
    30 seconds, and `GET /api/files` allows manual recovery within 30 days.

### Alternative G: No thumbnails; lower the main image size if the grid gets heavy

*   **Pros**:
    *   One file per image.
    *   Simpler upload and storage.
*   **Cons**:
    *   Cards and the gallery would load 300–600 KB per image. A gallery of
        200 files is 60–120 MB over Tailscale on a phone, plus memory pressure
        from decoding.
    *   Lowering the main size makes the full image worse to read.
*   **Reason for Rejection**: Rejected by author: thumbnails are part of the
    v1 safety additions. The server cannot resize images (no PIL), so the
    client makes the thumbnail in the same canvas pass.

### Alternative H: iOS Shortcut capture path (optionally on Back Tap)

An iOS Shortcut takes the latest screenshot and posts it to a server endpoint
that creates the note itself.

*   **Pros**:
    *   It skips opening the app. Estimated 2–3 seconds from screenshot to
        stored note.
*   **Cons**:
    *   A second write path in which the server creates notes. That breaks the
        rule that only clients write note JSON.
    *   The server would need to read image dimensions from JPEG and PNG
        headers itself.
*   **Reason for Rejection**: Deferred by author, not rejected outright. The
    `PUT /api/files` endpoint built here is the base it would need. It is
    listed under Future Improvements.

### Alternative I: Hand-bumped version number for the reload check

*   **Pros**:
    *   Explicit.
    *   It can skip reloads for server-only changes.
*   **Cons**:
    *   Forgetting to bump it silently disables the protection on the one
        deploy that needs it.
*   **Reason for Rejection**: Rejected by author: the server hashes the
    contents of `public/` at startup, so every client-visible change changes
    `v` with no manual step.

### Alternative J: Serve files from a second port (separate origin)

*   **Pros**:
    *   Uploaded content can never share the app's origin, whatever headers
        the browser honours.
*   **Cons**:
    *   One more published port in `compose.yaml`.
    *   A second server loop.
    *   Cross-origin image URLs, and a second URL to remember for LAN and
        Tailscale.
*   **Reason for Rejection**: Rejected by author for now: the first-bytes type
    allowlist keeps HTML and SVG off the disk, and `nosniff` plus a sandbox
    CSP are a second layer. It is kept as the fallback if the PDF device check
    shows that the headers cannot be made safe.

--------------------------------------------------------------------------------

## Non-Functional Requirements

*   **Security & privacy.**
    *   There is still no login. Anyone on the LAN or tailnet can read and add
        files, as with notes today.
    *   New protections:
        *   the first-bytes type allowlist;
        *   `nosniff` and a sandbox CSP on every file response;
        *   the `X-Mynotes` header plus an `Origin` check against uploads from
            other sites;
        *   the size limit, quota and free-space floor;
        *   the socket timeout.
    *   Re-encoding removes EXIF and GPS data from photos.
*   **Performance.**
    *   Upload: a 2000 px JPEG is about 300–600 KB, and encoding takes about
        200–400 ms on an iPhone. Uploading it on home Wi-Fi is well under
        1 second, which leaves room within the 5-second goal.
    *   Grid and gallery load ~30–50 KB thumbnails with `loading="lazy"`.
    *   File responses are cached as immutable, so an image seen once is not
        downloaded again.
    *   Sync is unchanged. Uploads never hold the global lock while reading
        the body.
*   **Storage.** At about 10 images a day, roughly 2 GB a year, well under the
    4 GB default quota for the first years. The quota is an env var.
*   **Rollout & rollback.**
    *   Two deploys: A (version check), then a manual reload of every device,
        then B (attachments).
    *   No rollback past B: fix forward.
    *   Backups must cover all of `./data`: `notes.db`, `notes.db-wal` and
        `files/`, taken at about the same time.

### Additional Resources

*   `CLAUDE.md`: sync protocol, drafts rule, masonry, iOS gotchas.
*   `README.md`: deploy and backup.
*   `concepts_brief.md`: brainstorm brief with all seven review lenses.

### Future Improvements

*   **iOS Shortcut capture.** A Shortcut, optionally on Back Tap, posts the
    latest screenshot to a capture endpoint, and the server creates the note.
    Reuses `PUT /api/files`.
*   **"Unattached" section** in the Attachments view, if last-write-wins loss
    ever happens in practice.
*   **PDF first-page thumbnails** (needs a renderer; the client cannot do it
    without a library).
*   **Reordering attachments**, and images inside the note text.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

Work is split into two commits, one per deploy. Deploy A must be live, and
every device reloaded, before deploy B.

### Phase A: version check (deploy A)

#### 1. `server.py` (Modify)

*   **Type / Scope**: Python HTTP server.
*   **Proposed Changes**:
    *   At startup, compute `APP_V`:
        *   Take every file in `public/` matching `*.html`, `*.js`, `*.css`
            or `*.webmanifest`, in sorted name order.
        *   Hash only the file contents, not the names, with SHA-256.
        *   Keep the first 12 hex characters.
    *   `sync()` returns `{"rev": rev, "v": APP_V, "notes": [...]}`.
    *   Nothing else changes in phase A.

#### 2. `public/app.js` (Modify)

*   **Type / Scope**: Client sync.
*   **Proposed Changes**:
    *   Add the module variable `let bootV = null`.
    *   In `sync()`, add the check after `rev = data.rev`, the merge loop and
        `persist()`, and before `render()`:
        *   If `bootV === null`, set `bootV = data.v`.
        *   Otherwise, if `data.v` exists and differs from `bootV`, call
            `persistNow()` (this writes notes, the dirty set and `rev`), then
            `location.reload()`, then `return`. `render()` and
            `refreshFromStore` are skipped.
    *   **Accepted limit:** a page loaded from the old server that makes its
        first sync to the new server takes the new `v` as its `bootV` and
        does not reload. Since `public/` is served `no-cache`, that page is
        only stale if it loaded in the seconds just before the restart.

#### 3. `README.md` (Modify)

*   **Type / Scope**: Docs.
*   **Proposed Changes**: In "Deploy to the NAS", add a note that clients
    reload themselves when `public/` changes. Also add a one-time step: after
    the first deploy with the version check, reload the app by hand on every
    device.

#### 4. `CLAUDE.md` (Modify)

*   **Type / Scope**: Project agent notes.
*   **Proposed Changes**: Under "Sync protocol", add one bullet:
    *   The server sends `v`, a hash of `public/`.
    *   A client running old code reloads at its next successful sync after a
        deploy that changes `public/`.

### Phase B: attachments (deploy B)

#### 5. `files.py` (Create)

*   **Type / Scope**: Python module, standard library only. `server.py`
    imports it. `files.py` never imports `server`, which would run
    `server.py` a second time, open a second DB connection and create a
    second lock.
*   **Proposed Changes**:
    *   `init(db, lock, db_path)` stores the shared connection and lock, then
        computes the configuration:
        *   `FILES_DIR = os.environ.get("MYNOTES_FILES") or join(dirname(db_path) or ".", "files")`.
        *   `MAX_FILE = int(env MYNOTES_MAX_FILE_MB or 20) * 2**20` bytes.
        *   `QUOTA = int(env MYNOTES_QUOTA_MB or 4096) * 2**20` bytes.
        *   `GRACE_MS = int(env MYNOTES_FILE_GRACE_DAYS or 30) * 86_400_000`.
        *   `FREE_FLOOR = 2**30` bytes (1 GiB).

        It then creates `FILES_DIR` and runs
        `CREATE TABLE IF NOT EXISTS files (...)` with the schema in the
        Technical Plan.
    *   `ID_RE = re.compile(r"^[0-9a-f]{24}$")`.
    *   `SIGNATURES`: a list of (prefix check, MIME) pairs for JPEG, PNG, GIF,
        WebP and PDF. `sniff(head: bytes) -> str | None`.
    *   `drain(handler, n)` reads and discards `n` body bytes in 64 KB
        chunks.
    *   **Response convention:** every `handle_*(handler, ...)` writes its own
        response and returns nothing.
        *   JSON goes through the existing `handler.send_json(obj, code)`.
        *   File bodies go through `send_response`, `send_header` and
            `end_headers`, then `shutil.copyfileobj`.
        *   Error bodies are `{"error": "<reason>"}`.
    *   `handle_put(handler, fid, variant)`, where `variant` is `"main"` or
        `"thumb"`. Order of checks, each with its response:
        1.  `ID_RE` matches the id, otherwise 400.
        2.  `X-Mynotes` equals `"1"`, otherwise 403.
        3.  `Origin`, if present, equals `"http://" + Host`, otherwise 403.
        4.  `Content-Length` is present, otherwise 411. It parses as an
            integer, otherwise 400. It is greater than 0, otherwise 400. It
            is at most `MAX_FILE`, otherwise 413, sent without draining.
        5.  For `main`, `X-Filename` is decoded with
            `urllib.parse.unquote`. Control characters (CR, LF and the rest
            of U+0000-U+001F) are removed, and this cleaned name is what gets
            stored. An empty name, or one over 200 characters, is rejected
            with 400.
        6.  Under `lock`, read the existing row:
            *   `main`: a row with the same size gives 200, a row with a
                different size gives 409.
            *   `thumb`: no main row gives 404. `thumb_size > 0` gives 200,
                and the stored thumbnail is not rewritten.
        7.  Under `lock`, check the quota and the disk: if
            `SUM(size + thumb_size) + Content-Length > QUOTA`, or
            `shutil.disk_usage(FILES_DIR).free - Content-Length < FREE_FLOOR`,
            return 507.
        8.  Without the lock, stream the body in 64 KB chunks to
            `<FILES_DIR>/<id>.<token_hex(4)>.tmp`. Sniff the first chunk. For
            `main` the type must be allowed, and for `thumb` it must be JPEG.
            Otherwise delete the temp file and return 415. If the body ends
            before `Content-Length` bytes, delete the temp file and return
            400.
        9.  `fsync` the temp file.
        10. Under `lock`, as one step:
            *   `os.replace` the temp file to `<id>` or `<id>.thumb`.
            *   For `main`: `INSERT OR IGNORE` the row (`created_at = now`,
                `unreferenced_since = NULL`), then re-read it. If a parallel
                PUT won with a different size, return 409.
            *   For `thumb`: `UPDATE` `thumb_size`.
        11. Respond:
            *   `main`: 201 `{"id", "type", "size"}`. The early 200 in step 6
                has the same body.
            *   `thumb`: 201 `{"id", "thumb_size"}`.
        12. Log one line: `upload <id> <variant> <type> <bytes>`. Rejections
            log `reject <id> <status> <reason>`.

        Every error or early 200 in steps 1-7 calls
        `drain(handler, Content-Length)` before responding, when the length
        is known and at most `MAX_FILE`. Steps 8-10 drain what is left of the
        body.
    *   `handle_get(handler, fid, variant)`:
        *   Check `ID_RE`, otherwise 400.
        *   Read the row under `lock`. Return 404 if it is missing, or if
            `variant == "thumb"` and `thumb_size == 0`.
        *   Send the file with the response headers from the Technical Plan.
            Thumbnails always use `image/jpeg`.
        *   PDFs use the module constant `PDF_DISPOSITION`, default
            `"attachment"`. Device check 2 switches it to `"inline"`, which
            sends `Content-Security-Policy: sandbox`, only if Chrome and iOS
            Safari both render a PDF served that way.
    *   `handle_list(handler)` sends all rows as JSON, for export.
    *   `scan()` runs the cleanup algorithm from the Technical Plan. Files on
        disk without a row are deleted only when their mtime is more than
        1 hour old. It returns a dict of counts and logs it.
    *   `start_cleanup()` runs `scan()` once inside try/except, logging any
        exception, so it never stops startup. It then starts a daemon thread
        that sleeps 24 hours and runs `scan()` in a loop. An exception there is
        also logged and does not stop the thread.
    *   **CLI.** `python3 files.py --scan`:
        *   opens its own connection to `MYNOTES_DB` (default
            `/data/notes.db`);
        *   calls `init(db, threading.Lock(), MYNOTES_DB)`;
        *   runs one `scan()`;
        *   prints the counts.

        It is used by tests and for manual cleanup.

#### 6. `server.py` (Modify)

*   **Type / Scope**: Python HTTP server.
*   **Proposed Changes**:
    *   `import files`. After the notes table is created, call
        `files.init(db, lock, DB_PATH)` and `files.start_cleanup()`.
    *   `APP_V` already covers `public/files.js` through `*.js`. No change.
    *   Add `timeout = 60` as a class attribute on `Handler`.
    *   Routing uses a regex `^/api/files/([^/]+)(/thumb)?$` on the URL path:
        *   `do_GET`: `/api/files` calls `files.handle_list(self)`. A match
            calls `files.handle_get(self, id, variant)`.
        *   New `do_PUT`: a match calls `files.handle_put(self, id, variant)`.
            Anything else returns 404.
        *   `do_POST`: no change.
    *   `send_json`: no change.
    *   `log_request`: no change. Rejections are logged twice, once here as a
        failed request and once by `files.py` with the reason. This is
        accepted.

#### 7. `Dockerfile` (Modify)

*   **Type / Scope**: Container build.
*   **Proposed Changes**: `COPY server.py files.py ./`.

#### 8. `compose.yaml` (Modify)

*   **Type / Scope**: Deployment config.
*   **Proposed Changes**: Extend the comment on the `./data` volume: it now
    holds `notes.db` and `files/`, and both must be backed up together. No
    functional change.

#### 9. `public/app.js` (Modify)

*   **Type / Scope**: Client store, editor, views.
*   **Proposed Changes**:
    *   **Store.**
        *   `blank()` adds `files: []`.
        *   New `normalize(n)` sets `n.files = []` when it is not an array. It
            is called on localStorage load and on every note received in
            `sync()`.
        *   `copyItems` is replaced by `copyArrays(obj)`. It returns a shallow
            copy of `obj` with `items` and `files` copied element by element
            when they are present. `createNote`, `updateNote` and
            `Editor.load` use it.
        *   `hasContent` also returns true when `n.files.length > 0`.
        *   `removeNote` adds `files: []` to its patch.
        *   `matches()` adds `n.files.map(f => f.name)` to the searched text.
        *   New module-level `const draftNotes = new Map()`, mapping a
            draftKey to a note id.
    *   **Editor.**
        *   `EDITOR_HTML` gains:
            *   a `.ed-files` strip above the title, outside the part that is
                hidden while the composer is collapsed, and shown whenever it
                has entries;
            *   a hidden `<input type="file" class="ed-fileinput" accept="image/*,application/pdf" multiple>`;
            *   paperclip buttons with `data-a="attach"`, one in `.ed-quick`
                and one in `.ed-foot` with class `not-trash`.
        *   Constructor: `this.fileInput = $('.ed-fileinput', root)`, and
            `this.pending = []`. `pending` holds
            `{key, target, name, url, type}` and is not persisted or synced.
        *   `this.draftKey = uid()` is set in the constructor, in `start()` and
            in `close()`. When `set()` creates a note, it records
            `draftNotes.set(this.draftKey, n.id)`.
        *   New `renderFiles()` draws `d.files`, plus the `pending` entries
            whose `target.noteId` equals `this.id` or whose `target.draftKey`
            equals `this.draftKey`, into the strip.
            *   Each tile is `.ef` with `data-fid`.
            *   The x button (`data-a="rmfile"`) is not rendered when
                `d.trashed`.
            *   It ends with `sizeAll()`.
            *   `fill()` calls it, so `load` and `refreshFromStore` also run it.
        *   `onClick`:
            *   `attach` calls `this.fileInput.click()` synchronously.
            *   `rmfile`:
                1.  Take `snap = {...notes.get(this.id)}`.
                2.  Call `set({files: d.files.filter(f => f.id !== fid)})`.
                3.  Call `renderFiles()`.
                4.  Show the toast "File removed". Its Undo runs
                    `updateNote(id, {...snap, files: [...snap.files]})`, then
                    `this.load(id)` if `this.id === id`.
            *   A click on a `.ef` tile outside its x opens `api/files/<id>`
                with `target=_blank rel=noopener`.
        *   `onChange` first checks `t === this.fileInput`. If so, it calls
            `attach(t.files, this, false)`, sets `t.value = ''` and returns.
            `attach` copies the list first (see item 10), so resetting the
            input is safe.
        *   `onPaste`, before the existing logic: if
            `e.clipboardData.files.length` and `!this.d.trashed`, call
            `preventDefault()` and `attach(e.clipboardData.files, this, true)`,
            then return.
    *   **Card.**
        *   When `n.files` holds images, insert a `.c-media` block right after
            the pin button. It holds an `<img class="c-img">` with:
            *   `src="api/files/<id>/thumb"`;
            *   `width` and `height` from the stored `w` and `h`;
            *   `loading="lazy"`;
            *   `alt` set to the file name;
            *   `style="aspect-ratio: w / h"`;
            *   an `onerror` that adds the `.missing` class.

            With more than one image, add a `.c-more-img` badge reading "+N".
        *   After the body or items, append a `.c-files` list of PDF chips.
    *   **Views.**
        *   The `view` whitelist adds `'attachments'`.
        *   The title map adds `attachments: 'Attachments'`. The empty-text
            map adds `attachments: 'Files you attach appear here'`. An empty
            search keeps "No matching notes".
        *   In `render()`, when `view === 'attachments'`:
            1.  Set `#viewTitle`, the active nav item,
                `composer.root.hidden = true` and `#trashBar.hidden = true`.
            2.  Call `renderGallery(q)` from `files.js`, and return.
        *   `layout()`: no change. In the gallery `.grid > *` is empty, so it
            returns early.
        *   `board`'s click handler gains a branch before the `.card` branch:
            a click on `.tile` calls `openModal(tile.dataset.id)`. The
            keydown handler also opens a focused `.tile` on Enter.
    *   **Bottom bar.** A `#mAttach` click handler calls `openNew('text')`, then
        `modalEd.fileInput.click()`, both synchronously in the tap handler.
    *   **Document-level handlers.**
        *   **`dragover`:** only when `e.dataTransfer.types.includes('Files')`,
            call `preventDefault()`.
        *   **`drop`:** only for file drags. Call `preventDefault()`, then
            route by `e.composedPath()`:
            1.  If the path includes `modalEd.root` and the modal is open,
                attach there.
            2.  Else, if the path includes `composer.root`, attach to the
                composer.
            3.  Else, if `!mqPhone.matches` and the modal is closed, call
                `openNew('text')` and attach to the composer.

            Each case calls `attach(e.dataTransfer.files, editor, false)`.
        *   **`paste`:** acts only when `!mqPhone.matches`, the modal is
            closed, `!isTyping(e.target)` and `e.clipboardData.files.length`.
            It then calls `openNew('text')` and
            `attach(e.clipboardData.files, composer, true)`.
        *   **`dragenter` / `dragleave`:** for file drags only, keep a
            `dragDepth` counter on the target editor's root, and toggle
            `.drop-target` while it is above 0. A counter is needed because
            `dragleave` fires on every child element.

#### 10. `public/files.js` (Create)

*   **Type / Scope**: Client module, a classic script loaded *before*
    `app.js`.
    *   It contains only `function` and `const` declarations, with no
        top-level statement that reads `app.js` bindings or the DOM.
    *   Its functions use `app.js` globals (`notes`, `createNote`,
        `updateNote`, `toast`, `h`, `icon`, `board`, `composer`, `modalEd`,
        `draftNotes`) only when called.
    *   All event wiring lives in `app.js`.
*   **Proposed Changes**:
    *   Constants:
        *   `ALLOWED` is
            `['image/jpeg','image/png','image/gif','image/webp','application/pdf']`.
            Extension fallbacks: `.jpg .jpeg .png .gif .webp .pdf .heic .heif`.
            HEIC is let through to the decode step, and its output is JPEG.
        *   `MAX_EDGE = 2000`, `THUMB_W = 480`, `THUMB_MAX_H = 1440`.
        *   `PNG_KEEP_MAX = 1.5 * 2**20`, `JPEG_Q = 0.85`, `THUMB_Q = 0.8`.
        *   `MAX_FILE = 20 * 2**20`. This is only a client-side hint, and
            the server's `MYNOTES_MAX_FILE_MB` decides.
    *   `async function prepare(file, pasted)` returns
        `{blob, type, w, h, thumb, name}` or throws a user-facing message:
        *   **Images:** decode, scale, encode and make the thumbnail by the
            rules in the Technical Plan. `thumb` is a Blob.
        *   **GIF:** uploaded unchanged. Over `MAX_FILE`, it throws "File too
            large (max 20 MB)". `w`, `h` and the thumbnail come from the first
            frame.
        *   **PDF:** unchanged, with `thumb = null`.
        *   **Name:** when `pasted` is true, the name is
            `Pasted image YYYY-MM-DD HH.MM.<ext>`. Otherwise it is the file's
            own name. A re-encoded file gets the extension of its output
            type.
    *   `async function put(id, blob, name, variant)`:
        *   Sends
            `fetch('api/files/' + id + (variant === 'thumb' ? '/thumb' : ''), {method: 'PUT', headers: {'X-Mynotes': '1', 'X-Filename': encodeURIComponent(name)}, body: blob})`.
        *   Maps the response to a toast text:
            *   413: "File too large (max 20 MB)".
            *   415: "This file type isn't supported".
            *   507: "Storage on the NAS is full".
            *   Any other non-2xx: "Couldn't attach this file".
            *   A network error: "Couldn't attach: upload failed".
    *   `async function attach(fileList, editor, pasted)`:
        *   Starts with `const list = Array.from(fileList)`, before any
            `await`.
        *   Returns at once if `editor.d.trashed`.
        *   Calls `editor.expand()`.
        *   Takes at most 10 files. Any extra files trigger the toast "Only
            10 files at a time".
        *   Records `target = {noteId: editor.id, draftKey: editor.draftKey}`
            once.
        *   For each file, in order: a pending entry with an object URL,
            then `prepare`, `put` main, `put` thumb (images only),
            `attachTo(target, meta)`, then the pending entry is removed and
            the object URL revoked. On an error it shows the toast and
            removes the pending entry. The uploads run one after another, so
            `files` keeps the order the files were picked in.
    *   `function attachTo(target, meta)` checks the four cases, in order, as
        in Technical Plan step 7:
        1.  A live note found by `target.noteId ?? draftNotes.get(target.draftKey)`:
            `updateNote`, plus updating the open editor.
        2.  A tombstone: drop the result.
        3.  An editor still holding `target.draftKey`: `editor.set(...)`.
        4.  Otherwise: `createNote({files: [meta]})`.
    *   `function renderGallery(q)`:
        *   Builds `.gallery` tiles from `notes`, using the filter and sort
            rules in the Technical Plan.
        *   Each tile is `<div class="tile" tabindex="0" data-id="<noteId>">`.
            Tiles do not use the `.card` class.
        *   Calls `board.replaceChildren(...)` and sets `emptyEl`.

#### 11. `public/index.html` (Modify)

*   **Type / Scope**: Markup.
*   **Proposed Changes**:
    *   New SVG symbols: `i-clip` (paperclip) and `i-file` (document).
    *   New sidebar `nav-item` with `data-view="attachments"`, the paperclip
        icon and the label "Attachments", between Notes and Archive.
    *   New bottom-bar button `#mAttach` with `aria-label="Attach file"`,
        between `#mNewList` and "Take a note…".
    *   `<script src="files.js" defer></script>` placed **before**
        `<script src="app.js" defer>`. Deferred scripts run in document
        order.
    *   The shortcut hint gains "Paste or drop files to attach".

#### 12. `public/app.css` (Modify)

*   **Type / Scope**: Styles.
*   **Proposed Changes**:
    *   **Cards:**
        *   `.c-media` spans the full card width, with negative margins to
            the card edges, and rounds the top corners.
        *   `.c-img`: `display: block; width: 100%; height: auto;
            max-height: 360px; object-fit: cover; object-position: top`.
        *   `.c-img.missing` gets a grey background, and its broken-image
            icon is hidden.
        *   `.c-more-img` is a small "+N" pill in the bottom-right corner.
        *   `.c-files` holds the file chips: one line each, ellipsis, file
            icon.
    *   **Pin:**
        *   The selector `.c-pin.on + *` becomes
            `.c-pin.on + :not(.c-media)`.
        *   New rule `.c-pin:has(+ .c-media)` gives the pin a translucent
            background, so it reads well on top of an image.
    *   **Editor:**
        *   `.ed-files` is a strip of 96 px tiles that wraps to new lines.
        *   Each `.ef` tile is positioned relative, with an x button in the
            corner.
        *   A `.ef.pending` tile is dimmed and shows a CSS spinner.
        *   A PDF `.ef` is 96 px wide, with the icon and a two-line name.
        *   The collapsed composer hides `.ed-files` only while it is empty.
    *   `.editor.drop-target` gets an outline in the accent color.
    *   **Gallery:**
        *   `.gallery` is a CSS grid, `repeat(auto-fill, minmax(140px, 1fr))`,
            with a 12 px gap.
        *   A `.tile` is square (`aspect-ratio: 1`), with its own border
            radius, background and focus ring. Its image uses
            `object-fit: cover`.
        *   A PDF tile is centered, with the icon above the name.
    *   Light and dark mode use the existing color tokens.

#### 13. `README.md` (Modify)

*   **Type / Scope**: Docs.
*   **Proposed Changes**:
    *   **"How it works"** (existing section): add attachments, the
        `/api/files` routes, and the env vars `MYNOTES_FILES`,
        `MYNOTES_MAX_FILE_MB`, `MYNOTES_QUOTA_MB` and
        `MYNOTES_FILE_GRACE_DAYS`. Also add `python3 files.py --scan`.
    *   **New sections**, added after "Deploy to the NAS":
        *   **`## Backup`:** copy all of `./data` (`notes.db`, `notes.db-wal`
            and `files/`) together.
        *   **`## Export`:** `GET /api/notes?since=0`, plus `GET /api/files`
            and the `files/` folder.
        *   **`## Risks`:**
            *   no rollback past the attachments release;
            *   the accepted last-write-wins attachment loss;
            *   no login, so anyone on the network can upload files, within
                the quota.

#### 14. `CLAUDE.md` (Modify)

*   **Type / Scope**: Project agent notes.
*   **Proposed Changes**:
    *   **Item copying:** the bullet about `copyItems` becomes `copyArrays`.
        It copies both `items` and `files`.
    *   **Pinned card with no title:** the gotcha's selector becomes
        `.c-pin.on + :not(.c-media)`.
    *   **New "Attachments" section:**
        *   Upload first, then add the reference.
        *   Uploads resolve their note through `draftNotes`.
        *   `files` is always replaced, never changed in place.
        *   `hasContent` counts files.
        *   Tombstones clear `files`.
        *   The cleanup counts from `unreferenced_since`. Run it on demand
            with `files.py --scan`.
        *   The server checks the type from the first bytes.
        *   `files.js` loads before `app.js` and contains only declarations.
        *   No rollback past deploy B.
        *   The accepted last-write-wins risk.
        *   On iOS, `input.click()` must run synchronously in the tap
            handler.
        *   The answers to the device-check Open Questions, once known.

### Verification Plan

There is no build step, test suite or linter in this repo. Checks:

*   **Device checks (before deploy B is merged):**
    1.  On the iPhone, paste a screenshot into the existing editor. Record
        whether `clipboardData.files` is filled. Then record the 5-second
        measure in Open Questions.
    2.  In Chrome desktop and iOS Safari, open a PDF served with
        `Content-Security-Policy: sandbox`. If it renders in both, set
        `PDF_DISPOSITION = "inline"`. Otherwise keep `"attachment"`.
    3.  On the iPhone, pick a rotated photo and a HEIC photo. Confirm the
        stored image is upright and is JPEG.
*   **Server, with curl.** Start
    `MYNOTES_DB=<scratch>/x.db PORT=8765 MYNOTES_FILE_GRACE_DAYS=0 MYNOTES_MAX_FILE_MB=1 python3 server.py`
    in the background:
    *   PUT a PNG and get 201. PUT it again and get 200. PUT the same id
        with other bytes and get 409.
    *   PUT a JPEG thumb: 201. PUT it again: 200. A thumb for an unknown id:
        404.
    *   Errors:
        *   no `X-Mynotes`: 403;
        *   `Origin: http://evil`: 403;
        *   an HTML body: 415;
        *   an SVG body: 415;
        *   a body over 1 MB: 413;
        *   `PUT /api/files/ZZZ`: 400;
        *   `curl --path-as-is .../api/files/../x`: 404;
        *   `Content-Length: abc`: 400;
        *   a request with no `Content-Length`, sent over a raw socket with
            Python `socket`: 411.
    *   Restart the server with `MYNOTES_QUOTA_MB=0`, then PUT any file:
        507.
    *   GET the file. Check `Content-Type`, `nosniff`, CSP, `Cache-Control`
        and `Content-Disposition`. Try a name with a newline and with
        non-ASCII characters. A PDF comes back with `attachment`.
    *   Cleanup, run with
        `MYNOTES_DB=<scratch>/x.db MYNOTES_FILE_GRACE_DAYS=0 python3 files.py --scan`
        while the server runs:
        1.  Sync a note that references the file, then scan: the file is
            kept.
        2.  Tombstone the note through `/api/sync`, then scan:
            `unreferenced_since` is set.
        3.  Scan again: the file and its thumbnail are deleted.
        4.  Put a row-less file in `files/` with a current mtime, then scan:
            it is kept. Set its mtime 2 hours back, then scan: it is
            deleted.
    *   A slow upload, sent by trickling the body, must not block a parallel
        `/api/sync`.
    *   `/api/sync` returns `v`. Edit a file in `public/` and restart the
        server: `v` changes.
*   **Client UI**, by headless Chromium over the Chrome DevTools Protocol, as
    in CLAUDE.md, at 1280×820 desktop and 390×844 mobile with touch emulation,
    in light and dark mode:
    *   Attach an image through the file input (`DOM.setFileInputFiles`) in
        the composer while it has no text. Close it: the image-only card
        exists, shows the thumbnail, and does not say "Empty note".
    *   Send a synthetic paste event with a `DataTransfer` holding a PNG:
        in the title, in the body, in a list item, and in the collapsed
        composer (it expands and shows the strip).
    *   Drop on the board with no editor open: the composer opens with the
        file.
    *   Drag text from one list item into another: the text moves and nothing
        is attached.
    *   Remove a file, then Undo: the file is back.
    *   Remove the only file of an image-only note, close the editor, then
        Undo: the note is back with its file.
    *   Delay the PUT through CDP `Fetch.requestPaused`. Type a title, then
        press Ctrl+Enter before the PUT is released. Result: one note with
        both the title and the image.
    *   Close an empty draft during a delayed PUT: an image-only note is
        created.
    *   Tombstone the note during a delayed PUT: no note gets the file.
    *   Answer the PUT with 415 through CDP `Fetch.fulfillRequest`: the toast
        "This file type isn't supported" appears and the note gets no
        reference. Also run one real 415 against the server with a renamed
        `.txt` file, to confirm the browser sees the status and not a
        connection reset.
    *   Put legacy notes without `files` into localStorage before load, and
        return one from a stubbed sync: both render, with no errors.
    *   Start with `localStorage['mn.view'] = '"attachments"'`: the gallery
        renders and `sync()` runs.
    *   `grid-row-end` per card is unchanged before and after the images
        load.
    *   Attachments view: tiles render, search filters them, a click and
        Enter on a focused tile open the note.
    *   An untitled pinned list card and a pinned image card: the pin covers
        no text, and the image is not indented.
    *   Version check: edit a file in `public/` and restart the server. The
        client reloads, and its dirty notes are kept.
*   **Success measure:** on the iPhone, time five screenshot attachments on
    home Wi-Fi and five over Tailscale on cellular, using the measure
    recorded after device check 1. Target: all under 5 seconds.

*Drafted with EGM*
