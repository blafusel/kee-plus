#!/usr/bin/env python3
"""Build the static online demo (GitHub Pages) into a folder.

Usage:
    python3 tools/build_demo.py _site
    python3 -m http.server -d _site 8770     # try it: http://localhost:8770/

The demo is the unchanged app from public/ plus demo/sw.js, a service
worker that answers the API in the browser, and demo/demo.js, which loads
it first. The notes are the made-up ones from seed_demo.py (the same as the
screenshots), written to demo/data.json with their images. Nothing is read
from a real server or database. Standard library only.
"""

import json
import pathlib
import re
import shutil
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import seed_demo  # noqa: E402

# Words that must never reach the public demo: checked against every file
# the build writes. Generic patterns only; real names go in docs/local.md.
PRIVATE = re.compile(rb"192\.168\.|\.ts\.net|@gmail\.|@users\.noreply", re.I)


def main():
    out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "_site").resolve()
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(ROOT / "public", out)
    for name in ("sw.js", "demo.js"):
        shutil.copy(ROOT / "demo" / name, out / name)

    # The bootstrap runs before anything else; the manifest starts here, not at /.
    index = out / "index.html"
    html = index.read_text(encoding="utf-8")
    html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n  <script src="demo.js"></script>', 1)
    assert 'src="demo.js"' in html
    html = html.replace("<title>Kee+</title>", "<title>Kee+ demo</title>", 1)
    index.write_text(html, encoding="utf-8")
    manifest = out / "manifest.webmanifest"
    m = json.loads(manifest.read_text(encoding="utf-8"))
    m.update(start_url="./", scope="./", name="Kee+ demo")
    manifest.write_text(json.dumps(m, indent=2), encoding="utf-8")

    now = int(time.time() * 1000)
    metas, blobs = seed_demo.make_images(now)
    notes = seed_demo.build(now, metas)
    (out / "demo" / "files").mkdir(parents=True)
    for fid, data in blobs.items():
        (out / "demo" / "files" / f"{fid}.png").write_bytes(data)
    (out / "demo" / "data.json").write_text(
        json.dumps({"generatedAt": now, "notes": notes}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")
    (out / ".nojekyll").write_text("")

    bad = [str(p.relative_to(out)) for p in out.rglob("*") if p.is_file() and PRIVATE.search(p.read_bytes())]
    if bad:
        sys.exit("Private-looking data in: " + ", ".join(bad))
    print(f"Built the demo in {out}: {len(notes) - 1} notes, {len(blobs)} images.")


if __name__ == "__main__":
    main()
