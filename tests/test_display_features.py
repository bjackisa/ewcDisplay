#!/usr/bin/env python3
"""Checks for the enlarged type and the four foreground features.

Covers: bigger lyrics/scripture/clock/timer type with no overflow, the removal
of the scripture quotation marks, foreground media (image, audio, camera),
foreground text, "No Display", and editing a song's lyrics.
"""
import pathlib
import struct
import subprocess
import sys
import time
import zlib

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent

PORT = 12420
BASE = f"http://localhost:{PORT}"
fails = []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail else ""))
    if not ok:
        fails.append(label)


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


def wav_bytes():
    n = 1600
    data = b"\x80" * n
    return (b"RIFF" + struct.pack("<I", 36 + n) + b"WAVEfmt " +
            struct.pack("<IHHIIHH", 16, 1, 1, 8000, 8000, 1, 8) +
            b"data" + struct.pack("<I", n) + data)


def main():
    server = subprocess.Popen([sys.executable, str(ROOT / "serve.py"), str(PORT)], cwd=str(ROOT))
    time.sleep(1.2)
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=[
                "--use-fake-ui-for-media-stream",
                "--use-fake-device-for-media-stream",
            ])
            ctx = browser.new_context(viewport={"width": 1600, "height": 900}, permissions=["camera"])
            errs = []
            watch = lambda p: p.on("pageerror", lambda e: errs.append(str(e)))

            disp = ctx.new_page(); watch(disp)
            disp.goto(f"{BASE}/display.html", wait_until="load")
            disp.wait_for_timeout(1500)

            # ---- type sizes and the removed scripture quotes -----------------
            fs = lambda sel: float(disp.evaluate(
                "parseFloat(getComputedStyle(document.querySelector('%s')).fontSize)" % sel))
            check("timer digits are large", fs(".digit-group") >= 150, str(fs(".digit-group")))
            before = disp.evaluate("getComputedStyle(document.getElementById('scripture-text'),'::before').content")
            after = disp.evaluate("getComputedStyle(document.getElementById('scripture-text'),'::after').content")
            check("scripture has no opening quote mark", before in ("none", "normal", '""'), str(before))
            check("scripture has no closing quote mark", after in ("none", "normal", '""'), str(after))

            con = ctx.new_page(); watch(con)
            con.goto(f"{BASE}/console.html", wait_until="load")
            con.wait_for_timeout(8000)

            # ---- scripture: bigger, and never spilling ----------------------
            con.select_option("#scripture-book-select", "42")  # John
            con.fill("#scripture-chapter-input", "3")
            con.fill("#scripture-verse-input", "16")
            con.click("#scripture-go-btn")
            con.click('button[data-mode="scripture"]')
            con.click("#launch-btn")
            con.wait_for_timeout(1000)
            check("scripture text enlarged", fs(".scripture-text") >= 48, str(fs(".scripture-text")))
            over = disp.evaluate(
                "(function(){var t=document.getElementById('scripture-text');"
                "var v=document.getElementById('scripture-view');return t.scrollHeight-v.clientHeight;})()")
            check("verse does not overflow its panel", over <= 1, str(over))
            # The longest verse in the KJV still has to fit.
            con.select_option("#scripture-book-select", "17")  # Esther
            con.fill("#scripture-chapter-input", "8")
            con.fill("#scripture-verse-input", "9")
            con.click("#scripture-go-btn")
            con.wait_for_timeout(900)
            over2 = disp.evaluate(
                "(function(){var t=document.getElementById('scripture-text');"
                "var v=document.getElementById('scripture-view');return t.scrollHeight-v.clientHeight;})()")
            check("the longest verse fits without spilling", over2 <= 1, str(over2))

            # ---- lyrics: bigger, wrapping, never clipped ---------------------
            con.click('button[data-mode="lyrics"]')
            con.fill("#song-title-input", "How Great Thou Art")
            con.fill("#song-lyrics-input",
                     "Then sings my soul my Saviour God to thee how great thou art how great thou art\n"
                     "And when I think that God his Son not sparing\n"
                     "Sent him to die I scarce can take it in")
            con.click("#song-save-btn")
            con.wait_for_timeout(700)
            con.click("#launch-btn")
            con.wait_for_timeout(900)
            check("lyric line font enlarged", fs(".lyric-line") >= 48, str(fs(".lyric-line")))
            check("lyrics title enlarged", fs(".lyrics-title") >= 20, str(fs(".lyrics-title")))
            wrapped = disp.evaluate(
                "document.querySelector('.lyric-line').scrollHeight > "
                "parseFloat(getComputedStyle(document.querySelector('.lyric-line')).lineHeight)*1.4")
            check("a long lyric wraps instead of shrinking", wrapped, str(wrapped))
            clipped = disp.evaluate(
                "(function(){var s=document.getElementById('lyrics-scrollport');"
                "var a=document.querySelector('.lyric-line.is-active');"
                "var sr=s.getBoundingClientRect(),ar=a.getBoundingClientRect();"
                "return (ar.top<sr.top-1)||(ar.bottom>sr.bottom+1);})()")
            check("the active lyric line is inside the scrollport", not clipped, str(clipped))

            # ---- clock and timer slightly larger -----------------------------
            con.click('button[data-mode="clock"]')
            con.click("#launch-btn")
            con.wait_for_timeout(800)
            check("clock readout enlarged", fs(".clock-readout") >= 40, str(fs(".clock-readout")))
            check("clock frame enlarged",
                  float(disp.evaluate("parseFloat(getComputedStyle(document.querySelector('.clock-frame')).width)")) >= 430)

            # ---- foreground media: image -------------------------------------
            con.set_input_files("#fg-media-input", {
                "name": "slide.png", "mimeType": "image/png", "buffer": png_bytes(10, 200, 90)})
            con.wait_for_timeout(1500)
            check("media foreground is live immediately",
                  disp.evaluate("document.getElementById('fg-layer').hidden === false"))
            check("the image mounts on the screen",
                  disp.evaluate("!!document.querySelector('#fg-media img')"))
            check("the panel is hidden while media is foreground",
                  disp.evaluate("getComputedStyle(document.getElementById('clock-view')).display") == "none")
            disp.reload(wait_until="load")
            disp.wait_for_timeout(2500)
            check("foreground image survives a display reload",
                  disp.evaluate("!!document.querySelector('#fg-media img')"))

            # ---- foreground media: audio -------------------------------------
            con.set_input_files("#fg-media-input", {
                "name": "tune.wav", "mimeType": "audio/wav", "buffer": wav_bytes()})
            con.wait_for_timeout(1500)
            check("audio foreground mounts a player",
                  disp.evaluate("!!document.querySelector('#fg-media audio')"))

            # A silent lyric step must not restart the media.
            disp.evaluate("document.querySelector('#fg-media audio').__marker='kept'")
            con.click('button[data-mode="lyrics"]')
            con.wait_for_timeout(400)
            con.click("#launch-btn")
            con.wait_for_timeout(700)
            con.evaluate("document.activeElement && document.activeElement.blur()")
            con.keyboard.press("ArrowDown")
            con.wait_for_timeout(700)
            check("a silent step does not remount the foreground media",
                  disp.evaluate("document.querySelector('#fg-media audio').__marker") == "kept")

            # ---- foreground media: camera ------------------------------------
            con.click("#fg-camera-btn")
            con.wait_for_timeout(2500)
            check("camera foreground mounts a live video",
                  disp.evaluate("!!document.querySelector('#fg-media video.is-mirrored')"))

            # ---- foreground text ---------------------------------------------
            con.fill("#fg-text-input", "The Lord is my shepherd; I shall not want.")
            con.fill("#fg-attribution-input", "Psalm 23:1")
            con.click("#foreground-toggle-group button[data-fg='text']")
            con.wait_for_timeout(900)
            check("the quote reaches the screen",
                  "shepherd" in disp.evaluate("document.getElementById('fg-quote').textContent"))
            check("the attribution reaches the screen",
                  "Psalm 23:1" in disp.evaluate("document.getElementById('fg-attribution').textContent"))
            check("the camera is released when leaving media",
                  disp.evaluate("!document.querySelector('#fg-media video')"))

            # ---- no display ---------------------------------------------------
            con.click("#foreground-toggle-group button[data-fg='none']")
            con.wait_for_timeout(700)
            check("No Display hides every panel",
                  disp.evaluate("getComputedStyle(document.getElementById('display')).display") == "none")
            check("No Display leaves the background visible",
                  disp.evaluate("getComputedStyle(document.getElementById('bg-layer')).display") != "none")
            disp.reload(wait_until="load")
            disp.wait_for_timeout(2500)
            check("No Display survives a display reload",
                  disp.evaluate("document.body.classList.contains('no-foreground')"))
            con.click("#foreground-toggle-group button[data-fg='panel']")
            con.wait_for_timeout(700)
            check("returning to Panel shows a panel again",
                  disp.evaluate("getComputedStyle(document.getElementById('display')).display") != "none")

            # ---- edit song lyrics ---------------------------------------------
            con.click('button[data-mode="lyrics"]')
            con.wait_for_timeout(400)
            con.click("#launch-btn")
            con.wait_for_timeout(700)
            con.click("#song-list .song-item .song-edit")
            con.wait_for_timeout(300)
            check("edit loads the song into the form",
                  con.input_value("#song-title-input") == "How Great Thou Art")
            check("the save button says Update", "Update" in con.inner_text("#song-save-btn"))
            con.fill("#song-lyrics-input", "Great is thy faithfulness\nMorning by morning new mercies I see")
            con.click("#song-save-btn")
            con.wait_for_timeout(1200)
            check("edited lyrics reach the live screen without a relaunch",
                  "faithfulness" in disp.evaluate(
                      "Array.from(document.querySelectorAll('#lyrics-track .lyric-line'))"
                      ".map(function(n){return n.textContent}).join(' | ')"))
            check("editing did not duplicate the song",
                  con.evaluate("document.querySelectorAll('#song-list .song-item').length") == 1)

            print()
            print("page errors:", errs)
            check("no page errors anywhere", not errs)
            browser.close()
    finally:
        server.terminate()

    print()
    if fails:
        print(f"{len(fails)} FAILURE(S): {fails}")
        sys.exit(1)
    print("ALL CHECKS PASSED")


if __name__ == "__main__":
    main()
