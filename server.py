#!/usr/bin/env python3
"""Kee+ server: serves the static app and a small JSON sync API.

Notes live in one SQLite table. Every write gets a new, increasing
revision number (rev), so a client asks "what changed since rev N?"
and gets only the delta. Conflicts are resolved last-write-wins on the
client's updatedAt timestamp. Deleted notes stay as tombstones
(deleted: true) so the deletion reaches every device.

Standard library only.
"""

import hashlib
import ipaddress
import json
import os
import re
import sqlite3
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import files

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")
DB_PATH = os.environ.get("MYNOTES_DB", "/data/notes.db")
PORT = int(os.environ.get("PORT", "8080"))
MAX_BODY = 10 * 1024 * 1024
# Host names the server answers to, besides IP addresses and localhost
# (comma-separated, lower case, no port), e.g. "nas.tail1234.ts.net".
EXTRA_HOSTS = {h.strip().lower().rstrip(".")
               for h in os.environ.get("MYNOTES_HOSTS", "").split(",") if h.strip()}


def host_name(value):
    """The host part of a Host header or an Origin's netloc, lower case."""
    value = (value or "").strip().lower()
    if value.startswith("["):  # [::1]:8090
        return value[1:value.find("]")] if "]" in value else ""
    return value.rsplit(":", 1)[0] if value.count(":") == 1 else value


def host_allowed(host):
    """DNS rebinding guard: a page on an attacker's domain that re-resolves
    to this server still sends its own name as Host. IP literals can't be
    rebound, so they and localhost are always allowed; other names only if
    listed in MYNOTES_HOSTS."""
    name = host_name(host).rstrip(".")
    if not name:
        return False
    if name == "localhost" or name in EXTRA_HOSTS:
        return True
    try:
        ipaddress.ip_address(name)
        return True
    except ValueError:
        return False


def origin_allowed(origin, host):
    """CSRF guard for writes: a browser sends Origin on every POST and PUT,
    same-origin ones included (sendBeacon too). It must name this server.
    No Origin at all means a non-browser client (curl, tools/)."""
    if origin is None:
        return True
    u = urlparse(origin)
    return u.scheme in ("http", "https") and u.netloc.lower() == (host or "").strip().lower()


def app_version():
    """Hash of the client files. Sent with every sync; a client that sees
    it change reloads, so no device keeps running old code after a deploy."""
    h = hashlib.sha256()
    for name in sorted(os.listdir(ROOT)):
        if name.endswith((".html", ".js", ".css", ".webmanifest")):
            with open(os.path.join(ROOT, name), "rb") as f:
                h.update(f.read())
    return h.hexdigest()[:12]


APP_V = app_version()

os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
db = sqlite3.connect(DB_PATH, check_same_thread=False)
db.execute("PRAGMA journal_mode=WAL")
db.execute(
    "CREATE TABLE IF NOT EXISTS notes ("
    " id TEXT PRIMARY KEY, rev INTEGER NOT NULL,"
    " updated_at INTEGER NOT NULL, data TEXT NOT NULL)"
)
db.execute("CREATE INDEX IF NOT EXISTS notes_rev ON notes(rev)")
db.commit()
lock = threading.Lock()
files.init(db, lock, DB_PATH)
FILE_ROUTE = re.compile(r"^/api/files/([^/]+)(/thumb)?$")


def sync(changes, since):
    """Apply the client's changes, then return everything newer than `since`."""
    with lock:
        rev = db.execute("SELECT COALESCE(MAX(rev), 0) FROM notes").fetchone()[0]
        rejected = []
        purged = []  # file ids of notes deleted forever in this request
        for note in changes:
            if not isinstance(note, dict):
                continue
            nid, upd = note.get("id"), note.get("updatedAt")
            if not isinstance(nid, str) or not 0 < len(nid) <= 64:
                continue
            if not isinstance(upd, (int, float)):
                continue
            row = db.execute(
                "SELECT updated_at, data FROM notes WHERE id = ?", (nid,)
            ).fetchone()
            if row and row[0] > upd:
                # The server copy is newer; send it back so the client adopts it.
                rejected.append(nid)
                continue
            if note.get("deleted") and row:
                # The tombstone has no files; the copy it replaces may.
                prev = json.loads(row[1])
                if not prev.get("deleted"):
                    purged.extend(files.file_ids(prev))
            rev += 1
            db.execute(
                "INSERT INTO notes (id, rev, updated_at, data) VALUES (?, ?, ?, ?)"
                " ON CONFLICT(id) DO UPDATE SET rev = excluded.rev,"
                " updated_at = excluded.updated_at, data = excluded.data",
                (nid, rev, int(upd), json.dumps(note, separators=(",", ":"))),
            )
        files.mark_purged(purged)
        db.commit()
        rows = db.execute(
            "SELECT data FROM notes WHERE rev > ? ORDER BY rev", (since,)
        ).fetchall()
        out = [json.loads(r[0]) for r in rows]
        seen = {n["id"] for n in out}
        for nid in rejected:
            if nid not in seen:
                r = db.execute("SELECT data FROM notes WHERE id = ?", (nid,)).fetchone()
                out.append(json.loads(r[0]))
        return {"rev": rev, "v": APP_V, "notes": out}


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".webmanifest": "application/manifest+json",
    }

    timeout = 60  # a stalled client can't hold a thread forever

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        if not self.path.startswith("/api/"):
            # Small files on a private network: always revalidate (304s are cheap).
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def parse_request(self):
        """Reject a foreign Host (every method) and a foreign Origin (writes)
        before any handler runs."""
        if not super().parse_request():
            return False
        host = self.headers.get("Host")
        if not host_allowed(host):
            self.log_message("reject host %r", host)
            self.send_json({"error": "unknown host"}, 421)
            return False
        if self.command not in ("GET", "HEAD") and not origin_allowed(self.headers.get("Origin"), host):
            self.log_message("reject origin %r for host %r", self.headers.get("Origin"), host)
            self.send_json({"error": "forbidden"}, 403)
            return False
        return True

    def list_directory(self, path):
        self.send_error(404)
        return None

    def send_json(self, obj, code=200):
        body = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/api/notes":
            # Full export / debugging: GET /api/notes?since=0
            try:
                since = int(parse_qs(url.query).get("since", ["0"])[0])
            except ValueError:
                since = 0
            return self.send_json(sync([], since))
        if url.path == "/api/files":
            return files.handle_list(self)
        m = FILE_ROUTE.match(url.path)
        if m:
            return files.handle_get(self, m[1], "thumb" if m[2] else "main")
        if url.path.startswith("/api/"):
            return self.send_json({"error": "not found"}, 404)
        return super().do_GET()

    def do_PUT(self):
        m = FILE_ROUTE.match(urlparse(self.path).path)
        if not m:
            return self.send_json({"error": "not found"}, 404)
        files.handle_put(self, m[1], "thumb" if m[2] else "main")

    def do_POST(self):
        if urlparse(self.path).path != "/api/sync":
            return self.send_json({"error": "not found"}, 404)
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            return self.send_json({"error": "too large"}, 413)
        try:
            # Content type is not checked: navigator.sendBeacon posts text/plain.
            payload = json.loads(self.rfile.read(length) or b"{}")
            changes = payload.get("changes") or []
            since = int(payload.get("since") or 0)
            if not isinstance(changes, list):
                raise ValueError
        except (ValueError, AttributeError, TypeError):
            return self.send_json({"error": "bad request"}, 400)
        self.send_json(sync(changes, since))

    def log_request(self, code="-", size="-"):
        # Quiet: log only failed requests (errors still go through log_error).
        try:
            failed = int(code) >= 400
        except (TypeError, ValueError):
            failed = True
        if failed:
            super().log_request(code, size)


if __name__ == "__main__":
    print(f"Kee+ on :{PORT}, db {DB_PATH}, files {files.FILES_DIR}", flush=True)
    files.start_cleanup()
    ThreadingHTTPServer(("", PORT), Handler).serve_forever()
