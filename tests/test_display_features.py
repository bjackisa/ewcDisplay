#!/usr/bin/env python3
"""Checks for the enlarged type and the on-panel media/text/camera features.

Covers: bigger lyrics/scripture/clock/timer type with no overflow, the removal
of the scripture quotation marks, the text panel (dressed like scripture), the
media panel (image, audio), the separate camera panel, the "No Panel" switch,
and editing a song's lyrics. Every one of these is launch-gated: choosing it
only changes the preview until Launch is pressed.
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

            # ---- only the chosen mode's controls are shown -------------------
            def visible_groups():
                return con.evaluate(
                    "Array.from(document.querySelectorAll('#mode-fields > div'))"
                    ".filter(function(d){return !d.hidden}).map(function(d){return d.id})")
            for mode in ["timer", "clock", "scripture", "lyrics", "text", "media", "camera"]:
                con.click('button[data-mode="%s"]' % mode)
                con.wait_for_timeout(250)
                check("only the %s controls are shown" % mode,
                      visible_groups() == ["%s-fields" % mode], str(visible_groups()))
            con.click("#no-panel-toggle")
            con.wait_for_timeout(250)
            check("No Panel hides the mode controls",
                  con.evaluate("document.getElementById('mode-fields').hidden"))
            con.click("#no-panel-toggle")
            con.wait_for_timeout(250)

            # ---- scripture: bigger, and never spilling ----------------------
            con.click('button[data-mode="scripture"]')  # shows the scripture fields
            con.select_option("#scripture-book-select", "42")  # John
            con.fill("#scripture-chapter-input", "3")
            con.fill("#scripture-verse-input", "16")
            con.click("#scripture-go-btn")
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
            check("lyric line font enlarged", fs(".lyric-line") >= 72, str(fs(".lyric-line")))
            check("lyrics title enlarged", fs(".lyrics-title") >= 32, str(fs(".lyrics-title")))
            wrapped = disp.evaluate(
                "document.querySelector('.lyric-line').scrollHeight > "
                "parseFloat(getComputedStyle(document.querySelector('.lyric-line')).lineHeight)*1.4")
            check("a long lyric wraps instead of shrinking", wrapped, str(wrapped))
            clipped = disp.evaluate(
                "(function(){var s=document.getElementById('lyrics-scrollport');"
                "var a=document.querySelector('.lyric-line.is-active');"
                "var sr=s.getBoundingClientRect(),ar=a.getBoundingClientRect();"
                "return !((ar.top<sr.top-1)||(ar.bottom>sr.bottom+1));})()")
            check("the active lyric line is inside the scrollport", clipped, str(clipped))

            # ---- clock and timer slightly larger -----------------------------
            con.click('button[data-mode="clock"]')
            con.click("#launch-btn")
            con.wait_for_timeout(800)
            check("clock readout enlarged", fs(".clock-readout") >= 40, str(fs(".clock-readout")))
            check("clock frame enlarged",
                  float(disp.evaluate("parseFloat(getComputedStyle(document.querySelector('.clock-frame')).width)")) >= 430)

            # ---- media panel: image, and it is launch-gated ------------------
            con.set_input_files("#media-file-input", {
                "name": "slide.png", "mimeType": "image/png", "buffer": png_bytes(10, 200, 90)})
            con.wait_for_timeout(1500)
            check("choosing media only changes the preview",
                  disp.evaluate("!document.querySelector('#media-mount img')"))
            check("media is previewed in the iframe",
                  con.evaluate("!!document.querySelector('#preview').contentWindow.document"
                               ".querySelector('#media-mount img')"))
            con.click("#launch-btn")
            con.wait_for_timeout(1200)
            check("the image mounts in the panel on the screen",
                  disp.evaluate("!!document.querySelector('#media-mount img')"))
            check("the media panel is enlarged",
                  float(disp.evaluate("parseFloat(getComputedStyle(document.getElementById('media-view')).width)")) >= 1000)
            disp.reload(wait_until="load")
            disp.wait_for_timeout(2500)
            check("the media panel survives a display reload",
                  disp.evaluate("!!document.querySelector('#media-mount img')"))

            # ---- media panel: audio ------------------------------------------
            con.set_input_files("#media-file-input", {
                "name": "tune.wav", "mimeType": "audio/wav", "buffer": wav_bytes()})
            con.wait_for_timeout(1200)
            con.click("#launch-btn")
            con.wait_for_timeout(1200)
            check("audio mounts a player in the panel",
                  disp.evaluate("!!document.querySelector('#media-mount audio')"))

            # A step is preview-only, and re-launching the same media must not
            # remount (and restart) it.
            disp.evaluate("document.querySelector('#media-mount audio').__marker='kept'")
            con.click("#launch-btn")
            con.wait_for_timeout(700)
            check("re-launching the same media does not remount it",
                  disp.evaluate("document.querySelector('#media-mount audio').__marker") == "kept")

            # ---- stepping a live lyric goes straight to the screen -----------
            con.click('button[data-mode="lyrics"]')
            con.wait_for_timeout(400)
            con.click("#launch-btn")
            con.wait_for_timeout(700)
            live_line = disp.evaluate("document.querySelector('#lyrics-track .lyric-line.is-active').textContent")
            con.evaluate("document.activeElement && document.activeElement.blur()")
            con.keyboard.press("ArrowDown")
            con.wait_for_timeout(700)
            check("a live lyric step reaches the screen without a launch",
                  disp.evaluate("document.querySelector('#lyrics-track .lyric-line.is-active').textContent") != live_line)
            check("the preview followed the live step",
                  con.evaluate("!!document.querySelector('#preview').contentWindow.document"
                               ".querySelector('#lyrics-track .lyric-line.is-active')"))
            check("the launch note still reads live after a step",
                  "Live on the church screen" in con.inner_text("#preview-note"),
                  con.inner_text("#preview-note"))

            # ---- camera panel, separate from media ---------------------------
            con.click('button[data-mode="camera"]')
            con.wait_for_timeout(600)
            check("camera is its own mode, not media",
                  con.evaluate("document.querySelector('button[data-mode=\\'camera\\']').classList.contains('active')"))
            # The picker lists cameras; the fake device offers exactly one, so
            # it is adopted silently and the picker reports that.
            check("the camera picker is present",
                  con.evaluate("!!document.getElementById('camera-device-select')"))
            check("a single camera is selected automatically",
                  "One camera" in con.inner_text("#camera-device-hint"), con.inner_text("#camera-device-hint"))
            con.click("#launch-btn")
            con.wait_for_timeout(2500)
            check("camera panel mounts a live video",
                  disp.evaluate("!!document.querySelector('#camera-video') && "
                                "!!document.getElementById('camera-video').srcObject"))
            check("the camera panel is enlarged",
                  float(disp.evaluate("parseFloat(getComputedStyle(document.getElementById('camera-view')).width)")) >= 1000)
            con.click('button[data-mode="timer"]')
            con.click("#launch-btn")
            con.wait_for_timeout(1200)
            check("leaving the camera stops the stream",
                  disp.evaluate("!document.getElementById('camera-video').srcObject"))

            # ---- camera picker with several cameras --------------------------
            # The fake device only offers one camera, so stub enumerateDevices
            # to prove the picker's own decision: with more than one camera
            # nothing is chosen until the operator does.
            ctx2 = browser.new_context(
                viewport={"width": 1600, "height": 900}, permissions=["camera"])
            ctx2.add_init_script("""
                Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
                  configurable: true,
                  value: async () => ([
                    {kind:'videoinput', deviceId:'cam-front', label:'Built-in webcam', groupId:'g1'},
                    {kind:'videoinput', deviceId:'cam-usb',   label:'USB Capture Card', groupId:'g2'},
                  ]),
                });
            """)
            errs2 = []
            disp2 = ctx2.new_page(); disp2.on("pageerror", lambda e: errs2.append(str(e)))
            disp2.add_init_script("""
                window.__camCalls = [];
                var real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
                navigator.mediaDevices.getUserMedia = function (c) {
                  window.__camCalls.push(JSON.stringify(c));
                  return real(c);
                };
            """)
            disp2.goto(f"{BASE}/display.html", wait_until="load")
            con2 = ctx2.new_page(); con2.on("pageerror", lambda e: errs2.append(str(e)))
            con2.goto(f"{BASE}/console.html", wait_until="load")
            con2.wait_for_timeout(3200)
            con2.click('button[data-mode="camera"]')
            con2.wait_for_timeout(700)
            opts = con2.evaluate(
                "Array.from(document.querySelectorAll('#camera-device-select option'))"
                ".map(function(o){return {v:o.value,t:o.textContent}})")
            check("the picker lists every camera", len(opts) == 3, str(opts))
            check("the picker offers a default alongside the cameras",
                  opts[0]["v"] == "" and "Default" in opts[0]["t"], str(opts))
            check("no camera is auto-chosen when there are several",
                  con2.input_value("#camera-device-select") == "",
                  con2.input_value("#camera-device-select"))
            check("the picker is enabled when there is a choice",
                  con2.evaluate("!document.getElementById('camera-device-select').disabled"))

            con2.select_option("#camera-device-select", "cam-usb")
            con2.click("#launch-btn")
            con2.wait_for_timeout(2500)
            calls = disp2.evaluate("window.__camCalls")
            check("the chosen camera id is what the display opens",
                  any("cam-usb" in c for c in calls), str(calls))
            check("the second display got a live feed",
                  disp2.evaluate("!!document.getElementById('camera-video').srcObject"))
            errs.extend(errs2)
            ctx2.close()

            # ---- text panel, dressed like scripture --------------------------
            con.click('button[data-mode="text"]')
            con.wait_for_timeout(400)
            check("text is launch-gated too",
                  disp.evaluate("!document.getElementById('text-body').textContent"))
            con.fill("#text-body-input", "The Lord is my shepherd; I shall not want.")
            con.fill("#text-title-input", "Psalm 23:1")
            con.click("#launch-btn")
            con.wait_for_timeout(900)
            check("the text body reaches the screen",
                  "shepherd" in disp.evaluate("document.getElementById('text-body').textContent"))
            check("the text title reaches the screen",
                  "Psalm 23:1" in disp.evaluate("document.getElementById('text-title').textContent"))
            check("the text body is styled like scripture",
                  disp.evaluate("getComputedStyle(document.getElementById('text-body')).fontFamily") ==
                  disp.evaluate("getComputedStyle(document.getElementById('scripture-text')).fontFamily"))
            check("the text title is styled like the scripture reference",
                  disp.evaluate("getComputedStyle(document.getElementById('text-title')).fontFamily") ==
                  disp.evaluate("getComputedStyle(document.getElementById('scripture-reference')).fontFamily"))

            # A long passage must stretch and shrink inside the glass, never
            # spill off the top/bottom/left/right of the projection.
            long_body = " ".join([
                "The Lord is my shepherd I shall not want he maketh me to lie down "
                "in green pastures he leadeth me beside the still waters"] * 10)
            con.fill("#text-body-input", long_body)
            con.fill("#text-title-input", "A long announcement heading that keeps going")
            con.click("#launch-btn")
            con.wait_for_timeout(900)
            spill = disp.evaluate(
                "(function(){var p=document.getElementById('text-view');var b=document.getElementById('text-body');"
                "var pr=p.getBoundingClientRect(),br=b.getBoundingClientRect();"
                "return {panelTop:pr.top,panelBottom:pr.bottom,panelLeft:pr.left,panelRight:pr.right,"
                "bodyTop:br.top,bodyBottom:br.bottom,bodyLeft:br.left,bodyRight:br.right,"
                "vw:window.innerWidth,vh:window.innerHeight};})()")
            check("a long text panel stays on the stage vertically",
                  0 <= spill["panelTop"] and spill["panelBottom"] <= spill["vh"] + 1, str(spill))
            check("a long text panel stays on the stage horizontally",
                  0 <= spill["panelLeft"] and spill["panelRight"] <= spill["vw"] + 1, str(spill))
            check("a long text body stays inside the panel",
                  spill["bodyTop"] >= spill["panelTop"] - 1 and spill["bodyBottom"] <= spill["panelBottom"] + 1,
                  str(spill))
            check("a long text shrinks rather than spilling",
                  fs("#text-body") < 89.6, str(fs("#text-body")))

            # ---- No Panel -----------------------------------------------------
            con.click("#no-panel-toggle")
            con.wait_for_timeout(400)
            check("No Panel is launch-gated",
                  disp.evaluate("getComputedStyle(document.getElementById('display')).display") != "none")
            con.click("#launch-btn")
            con.wait_for_timeout(700)
            check("No Panel hides every panel",
                  disp.evaluate("getComputedStyle(document.getElementById('display')).display") == "none")
            check("No Panel leaves the background visible",
                  disp.evaluate("getComputedStyle(document.getElementById('bg-layer')).display") != "none")
            disp.reload(wait_until="load")
            disp.wait_for_timeout(2500)
            check("No Panel survives a display reload",
                  disp.evaluate("document.body.classList.contains('no-panel')"))
            con.click("#no-panel-toggle")
            con.click("#launch-btn")
            con.wait_for_timeout(700)
            check("returning shows a panel again",
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
