#!/usr/bin/env python3
"""Restore notes into an empty Kee+ server from a browser's cached copy.

Every client keeps all notes in localStorage (`mn.notes`). If the server
database is lost, that cache can be pushed back through /api/sync.

Usage:
    python3 tools/restore_notes.py SOURCE SERVER_URL [--dry-run] [--force]

SOURCE is one of:
  - a JSON file holding the `mn.notes` value (a list of notes)
  - a Firefox localStorage database: <profile>/storage/default/
    http+++<host>+<port>/ls/data.sqlite (copy it first; Firefox may
    rewrite it while running). Snappy-compressed values are decoded here.

Refuses to write to a server that already has notes unless --force is
given; with --force, last-write-wins on updatedAt still applies, so a newer
server copy is never overwritten. Attachment bytes are not in the cache:
the script lists file references the server doesn't have. Standard
library only.
"""

import argparse
import json
import sqlite3
import sys
import urllib.request

BATCH = 300  # same as the client; keeps each request far below MAX_BODY


def unsnappy(b):
    """Decode a raw (unframed) Snappy block, as Firefox stores LS values."""
    i = n = shift = 0
    while True:
        x = b[i]
        i += 1
        n |= (x & 0x7F) << shift
        shift += 7
        if x < 0x80:
            break
    out = bytearray()
    while i < len(b):
        tag = b[i]
        i += 1
        kind = tag & 3
        if kind == 0:  # literal
            ln = tag >> 2
            if ln >= 60:
                k = ln - 59
                ln = int.from_bytes(b[i:i + k], "little")
                i += k
            ln += 1
            out += b[i:i + ln]
            i += ln
            continue
        if kind == 1:
            ln = ((tag >> 2) & 7) + 4
            off = ((tag >> 5) << 8) | b[i]
            i += 1
        elif kind == 2:
            ln = (tag >> 2) + 1
            off = int.from_bytes(b[i:i + 2], "little")
            i += 2
        else:
            ln = (tag >> 2) + 1
            off = int.from_bytes(b[i:i + 4], "little")
            i += 4
        for _ in range(ln):  # byte by byte: copies may overlap
            out.append(out[-off])
    if len(out) != n:
        raise ValueError(f"snappy: got {len(out)} bytes, expected {n}")
    return bytes(out)


def load_notes(path):
    with open(path, "rb") as f:
        is_sqlite = f.read(16) == b"SQLite format 3\x00"
    if is_sqlite:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        row = conn.execute(
            "SELECT value, compression_type FROM data WHERE key = 'mn.notes'"
        ).fetchone()
        if not row:
            sys.exit(f"{path}: no mn.notes key")
        value, comp = row
        text = (unsnappy(value) if comp else value).decode("utf-8")
    else:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    notes = json.loads(text)
    if not isinstance(notes, list):
        sys.exit("mn.notes is not a list")
    return [n for n in notes if isinstance(n, dict) and isinstance(n.get("id"), str)
            and isinstance(n.get("updatedAt"), (int, float))]


def call(base, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("source")
    ap.add_argument("server", help="e.g. http://<lan-ip>:8090")
    ap.add_argument("--dry-run", action="store_true", help="read and check, send nothing")
    ap.add_argument("--force", action="store_true", help="allow a server that has notes")
    a = ap.parse_args()
    base = a.server.rstrip("/")

    notes = load_notes(a.source)
    live = [n for n in notes if not n.get("deleted") and n.get("kind") != "settings"]
    refs = {f["id"] for n in notes if not n.get("deleted")
            for f in (n.get("files") or []) if isinstance(f, dict) and isinstance(f.get("id"), str)}
    print(f"source: {len(notes)} notes ({len(live)} not deleted,"
          f" settings: {'yes' if any(n.get('kind') == 'settings' for n in notes) else 'no'}),"
          f" {len(refs)} file references")

    server = call(base, "GET", "/api/notes?since=0")
    print(f"server: {len(server['notes'])} notes, rev {server['rev']}")
    if server["notes"] and not a.force:
        sys.exit("server is not empty; refusing (use --force to merge)")

    have = {f["id"] for f in call(base, "GET", "/api/files")}
    missing = sorted(refs - have)
    print(f"attachments: {len(refs) - len(missing)} on server, {len(missing)} missing")

    if a.dry_run:
        print("dry run: nothing sent")
        return

    rejected = 0
    for i in range(0, len(notes), BATCH):
        batch = notes[i:i + BATCH]
        res = call(base, "POST", "/api/sync", {"since": 2**62, "changes": batch})
        rejected += len(res["notes"])  # with since huge, only rejected ones come back
        print(f"  sent {i + len(batch)}/{len(notes)}")

    after = call(base, "GET", "/api/notes?since=0")
    ids = {n["id"] for n in after["notes"]}
    lost = [n["id"] for n in notes if n["id"] not in ids]
    print(f"done: server has {len(after['notes'])} notes, rev {after['rev']};"
          f" {rejected} kept the newer server copy, {len(lost)} not stored")
    if missing:
        print(f"{len(missing)} referenced files are missing; those notes show broken attachments.")
    sys.exit(1 if lost else 0)


if __name__ == "__main__":
    main()
