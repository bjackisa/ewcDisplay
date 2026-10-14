#!/usr/bin/env python3
"""Checks for recording the live display, and for driving the framed webpage
from the console preview.

Covers:
  * the /proxy endpoint: a page that sends X-Frame-Options: DENY is still
    fetched and shown from our own origin (the fix for the blank panel);
  * the interactive preview: scrolling and clicking over the preview moves the
    same page on the live display, and only while the preview is what is live;
  * the Record button: a folder named DD-MM-YYYY-{5 letters} is created in the
    chosen location, an MP4 is written into it, and pause / resume / stop all
    work.

The browser's screen picker and folder picker are the only things stubbed —
the fake screen-capture device stands in for the monitor, and the folder
picker resolves to the Origin Private File System, a real directory handle we
can inspect. Everything else (the bus, the proxy, MediaRecorder, the file
writes) is the real code.
"""
import http.server
import pathlib
import re
import socket
import subprocess
import sys
import threading
import time

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures"
fails = []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail else ""))
    if not ok:
        fails.append(label)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class FramingSite(http.server.SimpleHTTPRequestHandler):
    """A stand-in "site" that refuses framing, to prove the proxy strips the
    header. Serves the interactive fixture with X-Frame-Options: DENY."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(FIXTURES), **kwargs)

    def end_headers(self):
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
        super().end_headers()

    def log_message(self, *args):
        pass


# Stub both native pickers. showDirectoryPicker resolves to the OPFS root; the
# fake screen-capture device answers getDisplayMedia automatically.
STUB_PICKERS = """
window.showDirectoryPicker = async function () {
  return await navigator.storage.getDirectory();
};
"""

DUMP_OPFS = """
async () => {
  const root = await navigator.storage.getDirectory();
  const out = {};
  async function walk(dir, prefix) {
    for await (const [name, handle] of dir.entries()) {
      const path = prefix + name;
      if (handle.kind === 'directory') { out[path + '/'] = null; await walk(handle, path + '/'); }
      else { const f = await handle.getFile(); out[path] = f.size; }
    }
  }
  await walk(root, '');
  return out;
}
"""


def main():
    console_port = free_port()
    site_port = free_port()
    base = f"http://localhost:{console_port}"

    server = subprocess.Popen(
        [sys.executable, str(ROOT / "serve.py"), str(console_port)],
        cwd=str(ROOT),
        env={"PATH": "/usr/bin:/bin:/usr/local/bin", "EWC_PROXY_ALLOW_PRIVATE": "1"},
    )
    site = http.server.ThreadingHTTPServer(("127.0.0.1", site_port), FramingSite)
    threading.Thread(target=site.serve_forever, daemon=True).start()
    time.sleep(1.2)

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=[
                "--use-fake-ui-for-media-stream",
                "--use-fake-device-for-media-stream",
                "--auto-select-desktop-capture-source=Entire screen",
            ])
            ctx = browser.new_context(viewport={"width": 1500, "height": 900})
            errs = []

            def watch(p):
                p.on("pageerror", lambda e: errs.append(str(e)))

            disp = ctx.new_page(); watch(disp)
            disp.goto(f"{base}/display.html", wait_until="load")
            disp.wait_for_timeout(800)

            con = ctx.new_page(); watch(con)
            con.goto(f"{base}/console.html", wait_until="load")
            con.evaluate(STUB_PICKERS)
            con.wait_for_timeout(1500)

            frame_url = f"http://127.0.0.1:{site_port}/interactive.html"

            # ---------- the proxy shows a frame-blocking page ---------------
            con.click('button[data-mode="webpage"]')
            con.fill("#webpage-url-input", frame_url)
            con.click("#webpage-go-btn")
            con.click("#launch-btn")
            disp.wait_for_timeout(2000)
            check("a frame-blocking page still loads on the screen",
                  disp.evaluate("(function(){try{var f=document.getElementById('webpage-frame');"
                                "return (f.contentDocument.title||'')==='Interactive Fixture';}"
                                "catch(e){return false;}})()"))
            check("the framed page is same-origin (drivable)",
                  disp.evaluate("(function(){try{return document.getElementById('webpage-frame')"
                                ".contentDocument.body.innerText.indexOf('Interactive Fixture')!==-1;}"
                                "catch(e){return false;}})()"))

            # ---------- the preview drives the live page --------------------
            check("the interactive sheet is armed while the page is live",
                  con.evaluate("!document.getElementById('preview-proxy').hidden"))

            # Scroll over the preview and see the live frame move.
            before = disp.evaluate("document.getElementById('webpage-frame').contentWindow.scrollY")
            box = con.evaluate("(function(){var r=document.getElementById('preview-proxy')"
                               ".getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()")
            con.mouse.move(box["x"] + box["w"] / 2, box["y"] + box["h"] / 2)
            con.mouse.wheel(0, 600)
            con.wait_for_timeout(400)
            after = disp.evaluate("document.getElementById('webpage-frame').contentWindow.scrollY")
            check("scrolling the preview scrolls the live page", after > before, f"{before} -> {after}")
            check("the preview's own frame scrolled too",
                  con.evaluate("document.getElementById('preview').contentDocument"
                               ".getElementById('webpage-frame').contentWindow.scrollY") > 0)

            # Click the fixture's button through the preview and see the live
            # page count it. The button is at the top of the page, so scroll
            # back to the top first — a click maps by position, and the button
            # must be under the pointer.
            con.evaluate("document.getElementById('preview').contentDocument"
                         ".getElementById('webpage-frame').contentWindow.scrollTo(0, 0)")
            disp.evaluate("document.getElementById('webpage-frame').contentWindow.scrollTo(0, 0)")
            con.wait_for_timeout(300)
            # The button's on-screen position. The preview is a scaled copy of
            # the stage, so map the button from the stage's own fraction of the
            # 16:9 box out to the preview iframe's screen rect — the same point
            # the console's handler derives from the real event.
            geom = con.evaluate("""(function(){
              var d = document.getElementById('preview').contentDocument;
              var fr = d.getElementById('webpage-frame');
              var b = fr.contentDocument.getElementById('counter').getBoundingClientRect();
              var sr = d.getElementById('stage').getBoundingClientRect();
              var frr = fr.getBoundingClientRect();
              var ir = document.getElementById('preview').getBoundingClientRect();
              var nx = (frr.left - sr.left + (b.x + b.width / 2) / fr.clientWidth * frr.width) / sr.width;
              var ny = (frr.top - sr.top + (b.y + b.height / 2) / fr.clientHeight * frr.height) / sr.height;
              return { cx: ir.x + nx * ir.width, cy: ir.y + ny * ir.height };
            })()""")
            hit = con.evaluate("(function(){var e=document.elementFromPoint(%f,%f);return e?(e.id||e.className||e.tagName):'none';})()" % (geom["cx"], geom["cy"]))
            check("the pointer lands on the interactive sheet", hit == "preview-proxy", hit)
            con.mouse.click(geom["cx"], geom["cy"])
            con.wait_for_timeout(400)
            check("clicking the preview clicks the live page",
                  "Clicked 1 times" in disp.evaluate("document.getElementById('webpage-frame')"
                                                     ".contentDocument.getElementById('counter').textContent"),
                  disp.evaluate("document.getElementById('webpage-frame').contentDocument"
                                ".getElementById('counter').textContent"))

            # ---------- the sheet disarms when the preview drifts -----------
            con.click('button[data-mode="timer"]')
            con.wait_for_timeout(200)
            check("the interactive sheet disarms for another mode",
                  con.evaluate("document.getElementById('preview-proxy').hidden"))
            con.click('button[data-mode="webpage"]')
            con.wait_for_timeout(200)
            check("the sheet is armed again once the page is previewed",
                  con.evaluate("!document.getElementById('preview-proxy').hidden"))

            # ---------- recording -------------------------------------------
            check("the Record button is in the top bar next to Launch",
                  con.evaluate("(function(){var b=document.getElementById('record-btn');"
                               "var l=document.getElementById('launch-btn');"
                               "return !!b && !!l && b.compareDocumentPosition(l)&Node.DOCUMENT_POSITION_FOLLOWING;})()"))
            con.click("#record-btn")
            con.wait_for_timeout(1800)

            state = con.evaluate("({panel: !document.getElementById('rec-panel').hidden,"
                                 "btn: document.getElementById('record-btn').textContent,"
                                 "where: document.getElementById('rec-where').textContent,"
                                 "left: document.getElementById('rec-left').textContent})")
            check("the recording panel appears on the console", state["panel"])
            check("the Record button shows it is recording", "Recording" in state["btn"], state["btn"])
            folder, _, filename = state["where"].partition("/")
            check("the folder is DD-MM-YYYY-{5 letters}",
                  bool(re.match(r"^\d{2}-\d{2}-\d{4}-[a-z]{5}$", folder)), folder)
            check("the file is an .mp4", filename.endswith(".mp4"), filename)
            check("it reports how much time is left", "Space left" in state["left"], state["left"])

            con.click("#rec-pause-btn")
            con.wait_for_timeout(300)
            check("pausing shows Resume", con.inner_text("#rec-pause-btn") == "Resume")
            check("pausing is reflected in the panel",
                  con.evaluate("document.getElementById('rec-panel').dataset.state") == "paused")
            con.click("#rec-pause-btn")
            con.wait_for_timeout(300)
            check("resuming shows Pause again", con.inner_text("#rec-pause-btn") == "Pause")

            time.sleep(4)
            mid = con.evaluate(DUMP_OPFS)
            check("the recording is being written to the chosen folder",
                  any(k.startswith(folder + "/") and k.endswith(".mp4") for k in mid), mid)

            con.click("#rec-stop-btn")
            con.wait_for_timeout(2000)
            check("stopping hides the recording panel",
                  con.evaluate("document.getElementById('rec-panel').hidden"))
            check("stopping reports the saved file",
                  "Saved" in con.inner_text("#rec-status"), con.inner_text("#rec-status"))

            final = con.evaluate(DUMP_OPFS)
            sizes = {k: v for k, v in final.items() if k.endswith(".mp4")}
            check("an MP4 of real size landed in the folder",
                  bool(sizes) and all(v > 1000 for v in sizes.values()), sizes)
            head = con.evaluate("""async () => {
              const root = await navigator.storage.getDirectory();
              async function first(dir){
                for await (const [name, h] of dir.entries()){
                  if (h.kind === 'directory'){ const r = await first(h); if (r) return r; }
                  else { const f = await h.getFile();
                         const b = new Uint8Array(await f.slice(0,12).arrayBuffer());
                         return Array.from(b).map(x=>x.toString(16).padStart(2,'0')).join(' '); }
                }
                return '';
              }
              return await first(root);
            }""")
            check("the file is a real MP4 (ftyp box)", "66 74 79 70" in head, head)

            # The display must never show any recording chrome.
            check("nothing about recording appears on the live display",
                  disp.evaluate("document.querySelectorAll('#display [id*=\"rec\"], #display [class*=\"rec\"]')"
                                ".length") == 0)

            print()
            print("page errors:", errs)
            check("no page errors anywhere", not errs)
            browser.close()
    finally:
        server.terminate()
        site.shutdown()

    print()
    if fails:
        print(f"{len(fails)} FAILURE(S): {fails}")
        sys.exit(1)
    print("ALL CHECKS PASSED")


if __name__ == "__main__":
    main()
