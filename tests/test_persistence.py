#!/usr/bin/env python3
"""Backdrop and song persistence across reloads."""
import pathlib
import struct
import subprocess
import sys
import time
import zlib

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent

PORT = 12410
BASE = f"http://localhost:{PORT}"


def png_bytes(r, g, b):
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
    w = h = 8
    raw = b"".join(b"\x00" + bytes([r, g, b]) * w for _ in range(h))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


fails = []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail else ""))
    if not ok:
        fails.append(label)


server = subprocess.Popen([sys.executable, str(ROOT / "serve.py"), str(PORT)], cwd=str(ROOT))
time.sleep(1.2)
try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        errs = []
        console = ctx.new_page()
        console.on("pageerror", lambda e: errs.append(str(e)))
        console.goto(f"{BASE}/console.html", wait_until="load")
        console.wait_for_timeout(3000)

        console.set_input_files("#bg-file-input", {
            "name": "bg.png", "mimeType": "image/png", "buffer": png_bytes(204, 51, 51)})
        console.wait_for_timeout(2000)
        pv = console.evaluate(
            "document.getElementById('preview').contentWindow.document.getElementById('bg-layer').style.backgroundImage")
        check("preview shows the chosen backdrop", "blob:" in pv, pv[:50])

        display = ctx.new_page()
        display.on("pageerror", lambda e: errs.append(str(e)))
        display.goto(f"{BASE}/display.html", wait_until="load")
        display.wait_for_timeout(3000)
        lv = display.evaluate("document.getElementById('bg-layer').style.backgroundImage")
        check("display picks the backdrop up live", "blob:" in lv, lv[:50])

        # Reload the display: the photo must come back from the durable store.
        display.reload(wait_until="load")
        display.wait_for_timeout(3000)
        lv2 = display.evaluate("document.getElementById('bg-layer').style.backgroundImage")
        check("backdrop survives a display reload", "blob:" in lv2, lv2[:50])

        # Clearing removes it everywhere.
        console.click("#clear-image-btn")
        console.wait_for_timeout(2000)
        check("clearing removes it from the screen",
              "blob:" not in display.evaluate("document.getElementById('bg-layer').style.backgroundImage"))
        display.reload(wait_until="load")
        display.wait_for_timeout(2500)
        check("cleared backdrop stays cleared after a reload",
              "blob:" not in display.evaluate("document.getElementById('bg-layer').style.backgroundImage"))

        # Songs persist across a console reload.
        console.reload(wait_until="load")
        console.wait_for_timeout(2500)
        console.fill("#song-title-input", "Great Is Thy Faithfulness")
        console.fill("#song-lyrics-input", "Great is thy faithfulness, O God my Father\nThere is no shadow of turning with thee")
        console.click("#song-save-btn")
        console.wait_for_timeout(1200)
        console.reload(wait_until="load")
        console.wait_for_timeout(3000)
        titles = console.evaluate(
            "Array.from(document.querySelectorAll('#song-list .song-item .song-load')).map(function(n){return n.textContent})")
        check("saved songs survive a console reload",
              any("Great Is Thy Faithfulness" in t for t in titles), str(titles)[:160])

        print()
        print("page errors:", errs)
        check("no page errors", not errs)
        browser.close()
finally:
    server.terminate()

print()
if fails:
    print(f"{len(fails)} FAILURE(S): {fails}")
    sys.exit(1)
print("ALL CHECKS PASSED")
