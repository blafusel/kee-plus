#!/usr/bin/env python3
"""Fill an empty Kee+ server with made-up demo notes, for screenshots.

Usage:
    MYNOTES_DB=/tmp/kee-demo/notes.db PORT=8765 python3 server.py   # other shell
    python3 tools/seed_demo.py http://localhost:8765

Refuses to touch a server that already has notes, so it can't mix demo
data into a real database. Standard library only. The output is the same
on every run (fixed random seed, times relative to now).
"""

import json
import math
import random
import struct
import sys
import time
import urllib.request
import zlib

DAY = 86_400_000
rng = random.Random(42)


def uid():
    return "".join(f"{rng.randrange(256):02x}" for _ in range(12))


def call(base, method, path, body=None, headers=None):
    req = urllib.request.Request(base + path, data=body, method=method, headers=headers or {})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"null")


def sync(base, changes, since=0):
    body = json.dumps({"since": since, "changes": changes}).encode()
    return call(base, "POST", "/api/sync", body, {"Content-Type": "application/json"})


# --- images: small pure-Python PNG scenes --------------------------------


def png(w, h, pixel):
    rows = bytearray()
    for y in range(h):
        rows.append(0)  # filter: none
        for x in range(w):
            rows.extend(pixel(x, y))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b"")


def mix(a, b, t):
    t = max(0.0, min(1.0, t))
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def sunset(w, h):
    sun = (w * 0.62, h * 0.55, h * 0.14)

    def px(x, y):
        sea = h * 0.62
        if y > sea:  # water with a reflection band
            c = mix((40, 60, 110), (15, 25, 60), (y - sea) / (h - sea))
            if abs(x - sun[0]) < sun[2] * (1.2 - (y - sea) / h) and (y // 4) % 2 == 0:
                c = mix(c, (255, 190, 110), 0.55)
            return c
        if (x - sun[0]) ** 2 + (y - sun[1]) ** 2 < sun[2] ** 2:
            return (255, 214, 140)
        return mix((255, 150, 90), (90, 70, 150), 1 - y / sea)

    return png(w, h, px)


def mountains(w, h):
    def ridge(x, base, amp, f):
        return base + amp * (math.sin(x * f) * 0.6 + math.sin(x * f * 2.7 + 1.3) * 0.3)

    def px(x, y):
        if y > ridge(x, h * 0.78, h * 0.05, 0.02):
            return (46, 88, 60)
        if y > ridge(x, h * 0.6, h * 0.1, 0.011):
            return (86, 120, 140)
        if y > ridge(x, h * 0.42, h * 0.14, 0.007):
            top = ridge(x, h * 0.42, h * 0.14, 0.007)
            return (235, 240, 245) if y < top + h * 0.04 else (120, 140, 170)
        return mix((180, 215, 240), (90, 150, 215), 1 - y / (h * 0.5))

    return png(w, h, px)


def tomatoes(w, h):
    centers = [(w * 0.3, h * 0.45, h * 0.2), (w * 0.62, h * 0.4, h * 0.24), (w * 0.48, h * 0.72, h * 0.18)]

    def px(x, y):
        for cx, cy, r in centers:
            d = math.hypot(x - cx, y - cy)
            if d < r:
                shade = 1 - d / r
                c = mix((150, 20, 20), (235, 70, 50), shade)
                if math.hypot(x - cx + r * 0.35, y - cy + r * 0.35) < r * 0.18:
                    c = mix(c, (255, 220, 210), 0.6)
                return c
        board = (200, 160, 110) if (x // 40) % 2 else (190, 150, 100)
        return board

    return png(w, h, px)


def sketch(w, h):
    def px(x, y):
        c = (250, 248, 240)
        if y % 24 == 0:
            c = (200, 215, 235)
        if x == 60:
            c = (235, 160, 160)
        boxes = [(120, 60, 300, 140), (380, 200, 560, 280), (120, 260, 300, 340)]
        for x0, y0, x1, y1 in boxes:
            on_edge = (x0 <= x <= x1 and y in (y0, y0 + 1, y1, y1 - 1)) or (y0 <= y <= y1 and x in (x0, x0 + 1, x1, x1 - 1))
            if on_edge:
                c = (40, 60, 110)
        if 300 < x < 380 and abs((y - 100) - (x - 300) * 1.4) < 2:
            c = (40, 60, 110)
        return c

    return png(w, h, px)


IMAGES = {
    "sunset.png": (sunset, 720, 480),
    "mountains.png": (mountains, 720, 480),
    "tomatoes.png": (tomatoes, 600, 600),
    "app-sketch.png": (sketch, 640, 400),
}


def upload_images(base, now):
    metas = {}
    for i, (name, (fn, w, h)) in enumerate(IMAGES.items()):
        data = fn(w, h)
        fid = uid()
        call(base, "PUT", f"/api/files/{fid}", data, {
            "X-Mynotes": "1", "X-Filename": name, "Content-Type": "application/octet-stream",
        })
        # No thumbnail: the client shows the main file when thumb is false.
        metas[name] = {"id": fid, "name": name, "type": "image/png", "size": len(data),
                       "at": now - (20 - i) * DAY, "w": w, "h": h, "thumb": False}
    return metas


# --- notes ----------------------------------------------------------------

# Main categories carry a palette colour (swatch); sub-categories share
# their main's colour and are told apart by their icon. Icons are guessed
# from the names; "Mia" and "Leo" get theirs from the owner's words below.
CATEGORIES = [
    {"term": "AI", "swatch": "violet"},
    {"term": "Books", "swatch": "red"},
    {"term": "Garden", "swatch": "green"},
    {"term": "Home lab", "swatch": "blue"},
    {"term": "Family", "swatch": "indigo"},
    {"term": "Recipes", "swatch": "orange"},
    {"term": "Shopping", "swatch": "pink"},
    {"term": "Travel", "swatch": "amber"},
    {"term": "Work", "swatch": "teal"},
    {"term": "ImageGen", "parent": "AI"},
    {"term": "LLMs", "parent": "AI"},
    {"term": "NAS", "parent": "Home lab"},
    {"term": "Network", "parent": "Home lab"},
    {"term": "Mia", "parent": "Family"},
    {"term": "Leo", "parent": "Family"},
    {"term": "Furniture", "parent": "Shopping"},
    {"term": "Lisbon", "parent": "Travel"},
    {"term": "Hiking", "parent": "Travel"},
    {"term": "Meetings", "parent": "Work"},
]
ICON_WORDS = {"user": "mia, leo"}


def items(*texts):
    out = []
    for t in texts:
        done = t.startswith("x ")
        out.append({"id": uid(), "text": t[2:] if done else t, "done": done})
    return out


def demo_notes(img):
    # (days ago, fields)
    return [
        (0.1, dict(kind="list", title="Groceries", theme="Shopping", pinned=True,
                   items=items("Oat milk", "Sourdough bread", "x Eggs", "Spinach", "x Lemons", "Parmesan", "Coffee beans"))),
        (0.4, dict(title="Wi-Fi for guests", pinned=True, body="Network: Treehouse\nPassword is on the fridge magnet 🙂")),
        (0.6, dict(title="Local LLM setup", theme="LLMs",
                   body="# Plan\n**Model:** a 14B quant fits in 16 GB.\nRun it behind the _home-lab_ proxy.\n~~Cloud API~~ only as a fallback.")),
        (0.8, dict(title="Poster prompts", theme="ImageGen",
                   body="Risograph style, two colours, lots of grain.\nTry **seed 42** again with a warmer palette.")),
        (1, dict(title="Lisbon in May", theme="Lisbon", files=[img["sunset.png"]],
                 body="Sunset at Miradouro da Senhora do Monte — go early.\nTram 28 before 9 am.\nPastéis de Belém: take-away line is faster.")),
        (1.5, dict(kind="list", title="Packing list", theme="Travel",
                   items=items("Passport", "x Charger + adapter", "Sunscreen", "x Rain jacket", "Hiking shoes", "Camera"))),
        (1.2, dict(title="Where to eat in Lisbon", theme="Lisbon",
                   body="Taberna da Rua das Flores: no bookings, be there at 7.\nTime Out Market for a quick lunch.\nTram times: https://www.carris.pt")),
        (1.8, dict(kind="list", title="NAS backup plan", theme="NAS",
                   items=items("x Nightly snapshot of /data", "Weekly copy to the USB disk", "Test a restore", "Off-site copy"))),
        (2.2, dict(title="Router firmware", theme="Network",
                   body="Update to **7.14** after the weekend.\nWrite down the VLAN settings first.")),
        (2, dict(title="Sprint review notes", theme="Meetings",
                 body="- Search is 3× faster after the index change\n- Mobile editor: keyboard no longer covers toolbar\n- Next: export to Markdown\n\nAction: Sam drafts release notes by Friday")),
        (3, dict(title="Tomato harvest", theme="Garden", files=[img["tomatoes.png"]],
                 body="Cherry tomatoes finally ripe. Next year: more basil between the rows.")),
        (3.2, dict(title="Swimming lessons", theme="Mia",
                   body="Tuesdays 16:30, pool on Park Road.\nBring goggles and a 1 € coin for the locker.")),
        (3.4, dict(title="Dentist", theme="Leo", body="Check-up on the 14th at 9:10. Ask about the loose tooth.")),
        (3.5, dict(title="Shakshuka", theme="Recipes",
                   body="Onion, 2 peppers, garlic → soft.\nCumin, paprika, chili.\n1 can tomatoes, simmer 10 min.\nMake wells, 4 eggs, lid on 6–8 min.\nFeta + parsley on top.")),
        (4, dict(kind="list", title="To read", theme="Books",
                 items=items("The Left Hand of Darkness", "x Piranesi", "Project Hail Mary", "x A Psalm for the Wild-Built", "The Overstory"))),
        (4.5, dict(title="Standing desk", theme="Furniture",
                   body="160 × 80 cm top, dual motor.\nCheck the height range: **at least 125 cm**.")),
        (5, dict(title="App idea", files=[img["app-sketch.png"]],
                 body="Shared shopping list that sorts items by the aisle order of _your_ store. #ideas")),
        (6, dict(body="“The best time to plant a tree was 20 years ago. The second best time is now.”")),
        (7, dict(title="Hike: Ridge loop", theme="Hiking", files=[img["mountains.png"]],
                 body="14 km, 900 m up. Start at the north parking lot. Water at the hut is seasonal.")),
        (8, dict(kind="list", title="Garden — spring", theme="Garden",
                 items=items("x Order seed potatoes", "Fix the rain barrel", "Sow peas", "Prune the apple tree", "x Compost the beds"))),
        (9, dict(title="1:1 with Alex", theme="Meetings",
                 body="Wants to own the onboarding docs.\nTalk about conference budget.\nFollow up on laptop refresh.")),
        (10, dict(title="Banana bread", theme="Recipes",
                  body="3 ripe bananas, 75 g melted butter, 150 g sugar, 1 egg, 1 tsp baking soda, 190 g flour. 175 °C, 55 min.")),
        (12, dict(title="Door code", body="Bike room: 4 7 1 9 then #")),
        (13, dict(kind="list", title="Birthday gift ideas", theme="Shopping",
                  items=items("Pottery class voucher", "Good chef's knife", "x Board game: Cascadia"))),
        (15, dict(title="Book club — Piranesi", theme="Books",
                  body="Questions:\n1. Is the House a prison or a refuge?\n2. What does the narrator lose by remembering?")),
        (18, dict(title="Car service", body="Due at 60 000 km. Ask about the squeaky rear brake.")),
        (21, dict(title="Quarterly goals", theme="Work",
                  body="Ship offline mode\nCut page load to under 1 s\nWrite the deploy guide")),
        (25, dict(title="Podcast recommendations", body="Search for episodes about urban gardening and slow travel.")),
        (30, dict(title="Old flat — handover", archived=True, body="Meter readings: 18 422 kWh, 731 m³.\nKeys: 3 front, 2 mailbox.")),
        (40, dict(kind="list", title="Moving checklist", archived=True,
                  items=items("x Change address", "x Cancel internet", "x Book van"))),
        (2.5, dict(title="Draft tweet", trashed=True, body="Hot take: notes apps should open in under 100 ms.")),
    ]


def build(now, img):
    out = []
    for days, f in demo_notes(img):
        t = int(now - days * DAY)
        theme = f.pop("theme", None)
        n = {
            "id": uid(), "kind": "text", "title": "", "body": "", "items": [], "files": [],
            "color": "default", "theme": {"term": theme, "seed": 0} if theme else None,
            "pinned": False, "archived": False, "trashed": False, "trashedAt": 0,
            "deleted": False, "createdAt": t - DAY, "updatedAt": t, "editedAt": t,
        }
        n.update(f)
        if n["trashed"]:
            n["trashedAt"] = t
        out.append(n)
    settings = {
        "id": "settings", "kind": "settings", "title": "", "body": "", "items": [], "files": [],
        "categories": CATEGORIES, "catOrder": "alpha", "iconWords": ICON_WORDS, "deleted": False,
        "createdAt": now - 60 * DAY, "updatedAt": now,
    }
    return out + [settings]


def main():
    base = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765").rstrip("/")
    existing = sync(base, [])["notes"]
    if existing:
        sys.exit(f"{base} already has {len(existing)} notes. Seed only an empty demo server.")
    now = int(time.time() * 1000)
    img = upload_images(base, now)
    notes = build(now, img)
    res = sync(base, notes)
    print(f"Seeded {len(notes) - 1} notes and {len(img)} images into {base} (rev {res['rev']}).")


if __name__ == "__main__":
    main()
