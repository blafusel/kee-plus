#!/usr/bin/env python3
"""Kee+ attachments: file storage, upload/download handlers, cleanup.

Bytes live on disk in FILES_DIR as <id> (main file) and <id>.thumb (JPEG
thumbnail made by the client). Metadata lives in the `files` table of the
notes database. Notes refer to files through their `files` array; the
server never reads that array during sync, only in the cleanup scan.

Rules:
- The client uploads first and adds the reference only after a 2xx, so a
  stored note never points at bytes the server does not have.
- The type is decided from the file's first bytes, never from the name or
  the client's Content-Type. Only JPEG, PNG, GIF, WebP and PDF are stored.
- A file is deleted once no live note has referenced it for GRACE_MS.
  The clock starts when the scan first sees it unreferenced. This long
  grace covers references lost to a sync conflict (last write wins).
- A note deleted forever (a tombstone) frees its files sooner: sync marks
  them with purge_at = now + PURGE_MS (long enough for Undo), and a timer
  scan deletes them then, unless some note refers to them again.

Run `python3 files.py --scan` for one cleanup pass (tests, manual cleanup).
Never import `server` from here: it would run server.py a second time.
"""

import json
import os
import re
import secrets
import shutil
import sqlite3
import sys
import threading
import time
from urllib.parse import quote, unquote

ID_RE = re.compile(r"^[0-9a-f]{24}$")
CHUNK = 64 * 1024
SCAN_EVERY = 3600  # also catches purges whose timer a restart dropped
# PDFs download by default. Switch to "inline" (served with a sandbox CSP)
# only after checking that Chrome and iOS Safari still render them.
PDF_DISPOSITION = "attachment"

db = None
lock = None
FILES_DIR = MAX_FILE = QUOTA = GRACE_MS = PURGE_MS = FREE_FLOOR = None
_purge_timer = None


def log(msg):
    print(msg, flush=True)


def now_ms():
    return int(time.time() * 1000)


def init(conn, db_lock, db_path):
    """Store the shared connection and lock, read config, create storage."""
    global db, lock, FILES_DIR, MAX_FILE, QUOTA, GRACE_MS, PURGE_MS, FREE_FLOOR
    db, lock = conn, db_lock
    env = os.environ.get
    FILES_DIR = env("MYNOTES_FILES") or os.path.join(os.path.dirname(db_path) or ".", "files")
    MAX_FILE = int(env("MYNOTES_MAX_FILE_MB") or 20) * 2**20
    QUOTA = int(env("MYNOTES_QUOTA_MB") or 4096) * 2**20
    GRACE_MS = int(env("MYNOTES_FILE_GRACE_DAYS") or 30) * 86_400_000
    PURGE_MS = int(env("MYNOTES_PURGE_MINUTES") or 10) * 60_000
    FREE_FLOOR = 2**30
    os.makedirs(FILES_DIR, exist_ok=True)
    with lock:
        db.execute(
            "CREATE TABLE IF NOT EXISTS files ("
            " id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,"
            " size INTEGER NOT NULL, thumb_size INTEGER NOT NULL DEFAULT 0,"
            " created_at INTEGER NOT NULL, unreferenced_since INTEGER)"
        )
        cols = {r[1] for r in db.execute("PRAGMA table_info(files)")}
        if "purge_at" not in cols:  # added after the attachments release
            db.execute("ALTER TABLE files ADD COLUMN purge_at INTEGER")
        db.commit()


def sniff(head):
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head.startswith(b"%PDF-"):
        return "application/pdf"
    return None


def path_of(fid, variant):
    return os.path.join(FILES_DIR, fid + (".thumb" if variant == "thumb" else ""))


def drain(handler, n):
    """Read and discard the rest of a request body, so closing the socket
    doesn't reset the connection before the browser reads our status."""
    while n > 0:
        chunk = handler.rfile.read(min(CHUNK, n))
        if not chunk:
            break
        n -= len(chunk)


def handle_put(handler, fid, variant):
    length = None
    unread = 0  # body bytes not yet consumed; drained before an early reply

    def reply(code, obj, reason=None):
        if unread and length is not None and length <= MAX_FILE:
            drain(handler, unread)
        if reason:
            log(f"reject {fid[:32]} {code} {reason}")
        handler.send_json(obj, code)

    raw_len = handler.headers.get("Content-Length")
    if raw_len is not None:
        try:
            length = int(raw_len)
            unread = max(length, 0)
        except ValueError:
            length = None
    if not ID_RE.match(fid):
        return reply(400, {"error": "bad id"}, "bad id")
    if handler.headers.get("X-Mynotes") != "1":
        return reply(403, {"error": "forbidden"}, "missing X-Mynotes")
    origin = handler.headers.get("Origin")
    if origin and origin != "http://" + (handler.headers.get("Host") or ""):
        return reply(403, {"error": "forbidden"}, "origin " + origin)
    if raw_len is None:
        return reply(411, {"error": "length required"}, "no length")
    if length is None or length <= 0:
        return reply(400, {"error": "bad length"}, "bad length")
    if length > MAX_FILE:
        unread = 0  # never read an oversize body; just close
        return reply(413, {"error": "too large"}, f"too large {length}")

    name = None
    if variant == "main":
        name = "".join(c for c in unquote(handler.headers.get("X-Filename") or "") if c >= " " and c != "\x7f").strip()
        if not name or len(name) > 200:
            return reply(400, {"error": "bad name"}, "bad name")

    with lock:
        row = db.execute("SELECT size, thumb_size, type FROM files WHERE id = ?", (fid,)).fetchone()
        if variant == "main" and row:
            if row[0] == length:
                return reply(200, {"id": fid, "type": row[2], "size": row[0]})
            return reply(409, {"error": "id exists"}, "id exists")
        if variant == "thumb":
            if not row:
                return reply(404, {"error": "no main file"}, "thumb before main")
            if row[1] > 0:
                return reply(200, {"id": fid, "thumb_size": row[1]})
        used = db.execute("SELECT COALESCE(SUM(size + thumb_size), 0) FROM files").fetchone()[0]
        if used + length > QUOTA or shutil.disk_usage(FILES_DIR).free - length < FREE_FLOOR:
            return reply(507, {"error": "storage full"}, "quota")

    tmp = os.path.join(FILES_DIR, f"{fid}.{secrets.token_hex(4)}.tmp")
    ftype = None
    try:
        with open(tmp, "wb") as out:
            first = True
            while unread > 0:
                chunk = handler.rfile.read(min(CHUNK, unread))
                if not chunk:
                    break
                unread -= len(chunk)
                if first:
                    first = False
                    ftype = sniff(chunk)
                    if ftype is None or (variant == "thumb" and ftype != "image/jpeg"):
                        out.close()
                        os.unlink(tmp)
                        return reply(415, {"error": "type not allowed"}, "type")
                out.write(chunk)
            if unread > 0:
                out.close()
                os.unlink(tmp)
                unread = 0
                return reply(400, {"error": "short body"}, "short body")
            out.flush()
            os.fsync(out.fileno())
        with lock:
            # Rename and row together, so the scan never sees one without the other.
            if variant == "main":
                db.execute(
                    "INSERT OR IGNORE INTO files (id, name, type, size, created_at)"
                    " VALUES (?, ?, ?, ?, ?)", (fid, name, ftype, length, now_ms()))
                row = db.execute("SELECT size FROM files WHERE id = ?", (fid,)).fetchone()
                if row[0] != length:
                    os.unlink(tmp)
                    db.commit()
                    return reply(409, {"error": "id exists"}, "id exists (race)")
                os.replace(tmp, path_of(fid, "main"))
            else:
                os.replace(tmp, path_of(fid, "thumb"))
                db.execute("UPDATE files SET thumb_size = ? WHERE id = ?", (length, fid))
            db.commit()
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    log(f"upload {fid} {variant} {ftype} {length}")
    if variant == "main":
        return handler.send_json({"id": fid, "type": ftype, "size": length}, 201)
    return handler.send_json({"id": fid, "thumb_size": length}, 201)


def handle_get(handler, fid, variant):
    if not ID_RE.match(fid):
        return handler.send_json({"error": "bad id"}, 400)
    with lock:
        row = db.execute("SELECT name, type, size, thumb_size FROM files WHERE id = ?", (fid,)).fetchone()
    if not row or (variant == "thumb" and row[3] == 0):
        return handler.send_json({"error": "not found"}, 404)
    name, ftype, size, thumb_size = row
    path = path_of(fid, variant)
    try:
        f = open(path, "rb")
    except FileNotFoundError:
        return handler.send_json({"error": "not found"}, 404)
    with f:
        ctype = "image/jpeg" if variant == "thumb" else ftype
        disposition = PDF_DISPOSITION if ctype == "application/pdf" else "inline"
        if ctype == "application/pdf":
            csp = "sandbox" if disposition == "inline" else "default-src 'none'; sandbox"
        else:
            csp = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox"
        ascii_name = "".join(c if 32 <= ord(c) < 127 and c not in '"\\' else "_" for c in name)
        handler.send_response(200)
        handler.send_header("Content-Type", ctype)
        handler.send_header("Content-Length", str(thumb_size if variant == "thumb" else size))
        handler.send_header("X-Content-Type-Options", "nosniff")
        handler.send_header("Cache-Control", "private, max-age=31536000, immutable")
        handler.send_header("Content-Security-Policy", csp)
        handler.send_header(
            "Content-Disposition",
            f"{disposition}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name, safe='')}")
        handler.end_headers()
        if handler.command != "HEAD":
            shutil.copyfileobj(f, handler.wfile)


def handle_list(handler):
    with lock:
        rows = db.execute(
            "SELECT id, name, type, size, thumb_size, created_at, unreferenced_since, purge_at"
            " FROM files ORDER BY created_at").fetchall()
    keys = ("id", "name", "type", "size", "thumb_size", "created_at", "unreferenced_since", "purge_at")
    handler.send_json([dict(zip(keys, r)) for r in rows])


def file_ids(note):
    """File ids in one note's `files` array."""
    files = note.get("files") if isinstance(note, dict) else None
    if not isinstance(files, list):
        return []
    return [f["id"] for f in files if isinstance(f, dict) and isinstance(f.get("id"), str)]


def mark_purged(ids):
    """Files of notes just deleted forever: free them after PURGE_MS.
    The caller holds the lock and commits."""
    global _purge_timer
    if not ids:
        return
    at = now_ms() + PURGE_MS
    db.executemany("UPDATE files SET purge_at = ? WHERE id = ? AND purge_at IS NULL", [(at, i) for i in set(ids)])
    # One pending timer, pushed to the latest deadline; it covers every
    # earlier mark too. The hourly loop is the fallback.
    if _purge_timer:
        _purge_timer.cancel()
    _purge_timer = threading.Timer(PURGE_MS / 1000 + 2, _safe_scan)
    _purge_timer.daemon = True
    _purge_timer.start()


def _safe_scan():
    try:
        scan()
    except Exception as e:  # cleanup must never take the server down
        log(f"cleanup failed: {e!r}")


def referenced_ids():
    """Ids in the `files` array of every live note (archived and trashed
    count; tombstones don't). Malformed values are skipped."""
    ids = set()
    for (data,) in db.execute("SELECT data FROM notes"):
        try:
            note = json.loads(data)
        except ValueError:
            continue
        if not isinstance(note, dict) or note.get("deleted"):
            continue
        ids.update(file_ids(note))
    return ids


def scan():
    t = now_ms()
    stats = {"scanned": 0, "unreferenced": 0, "deleted": 0, "freed": 0, "stray": 0}
    with lock:
        refs = referenced_ids()
        rows = db.execute("SELECT id, size, thumb_size, unreferenced_since, purge_at FROM files").fetchall()
        for fid, size, thumb_size, since, purge_at in rows:
            stats["scanned"] += 1
            if fid in refs:  # in use (again, e.g. after Undo): keep, forget any deadline
                if since is not None or purge_at is not None:
                    db.execute("UPDATE files SET unreferenced_since = NULL, purge_at = NULL WHERE id = ?", (fid,))
            elif (purge_at is not None and t >= purge_at) or (since is not None and t - since >= GRACE_MS):
                for v in ("main", "thumb"):
                    try:
                        os.unlink(path_of(fid, v))
                    except FileNotFoundError:
                        pass
                db.execute("DELETE FROM files WHERE id = ?", (fid,))
                stats["deleted"] += 1
                stats["freed"] += size + thumb_size
            elif since is None:
                db.execute("UPDATE files SET unreferenced_since = ? WHERE id = ?", (t, fid))
                stats["unreferenced"] += 1
        db.commit()
        known = {r[0] for r in db.execute("SELECT id FROM files")}
        # Temp files and files with no row: only once they are an hour old,
        # so an upload in progress is never touched.
        for entry in os.scandir(FILES_DIR):
            if not entry.is_file():
                continue
            base = entry.name.split(".", 1)[0]
            stray = entry.name.endswith(".tmp") or base not in known
            if stray and t - entry.stat().st_mtime * 1000 > 3_600_000:
                os.unlink(entry.path)
                stats["stray"] += 1
    log("cleanup " + " ".join(f"{k}={v}" for k, v in stats.items()))
    return stats


def start_cleanup():
    _safe_scan()  # never stop startup over cleanup

    def loop():
        while True:
            time.sleep(SCAN_EVERY)
            _safe_scan()

    threading.Thread(target=loop, daemon=True, name="files-cleanup").start()


if __name__ == "__main__":
    if sys.argv[1:] != ["--scan"]:
        sys.exit("usage: python3 files.py --scan")
    db_path = os.environ.get("MYNOTES_DB", "/data/notes.db")
    conn = sqlite3.connect(db_path)
    init(conn, threading.Lock(), db_path)
    print(json.dumps(scan()))
