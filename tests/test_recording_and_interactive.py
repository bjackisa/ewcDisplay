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
import shutil
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

            # A page that acts on pointerdown, not click (menus, drag handles,
            # most real apps) must see the relayed pointer sequence too.
            con.evaluate("document.getElementById('preview').contentDocument"
                         ".getElementById('webpage-frame').contentWindow.scrollTo(0, 0)")
            disp.evaluate("document.getElementById('webpage-frame').contentWindow.scrollTo(0, 0)")
            con.wait_for_timeout(300)
            pgeom = con.evaluate("""(function(){
              var d = document.getElementById('preview').contentDocument;
              var fr = d.getElementById('webpage-frame');
              var b = fr.contentDocument.getElementById('pointer-target').getBoundingClientRect();
              var sr = d.getElementById('stage').getBoundingClientRect();
              var frr = fr.getBoundingClientRect();
              var ir = document.getElementById('preview').getBoundingClientRect();
              var nx = (frr.left - sr.left + (b.x + b.width / 2) / fr.clientWidth * frr.width) / sr.width;
              var ny = (frr.top - sr.top + (b.y + b.height / 2) / fr.clientHeight * frr.height) / sr.height;
              return { cx: ir.x + nx * ir.width, cy: ir.y + ny * ir.height };
            })()""")
            con.mouse.click(pgeom["cx"], pgeom["cy"])
            con.wait_for_timeout(400)
            check("a pointerdown on the preview reaches the live page",
                  "pointerdown 1" in disp.evaluate("document.getElementById('webpage-frame')"
                                                   ".contentDocument.getElementById('pointer-status').textContent"),
                  disp.evaluate("document.getElementById('webpage-frame').contentDocument"
                                ".getElementById('pointer-status').textContent"))

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
            # Pause and Stop live between Record and Launch, but stay hidden
            # until a recording is actually running.
            check("the transport sits between Record and Launch, hidden at rest",
                  con.evaluate("""(function(){
                    var r=document.getElementById('record-btn');
                    var p=document.getElementById('rec-pause-btn');
                    var s=document.getElementById('rec-stop-btn');
                    var l=document.getElementById('launch-btn');
                    var order = r.compareDocumentPosition(p)&Node.DOCUMENT_POSITION_FOLLOWING
                             && p.compareDocumentPosition(s)&Node.DOCUMENT_POSITION_FOLLOWING
                             && s.compareDocumentPosition(l)&Node.DOCUMENT_POSITION_FOLLOWING;
                    return order && p.hidden && s.hidden;
                  })()"""))
            con.click("#record-btn")
            con.wait_for_timeout(1800)

            state = con.evaluate("({pauseHidden: document.getElementById('rec-pause-btn').hidden,"
                                 "stopHidden: document.getElementById('rec-stop-btn').hidden,"
                                 "label: document.getElementById('record-btn-label').textContent,"
                                 "icons: [document.getElementById('rec-pause-btn').textContent.trim(),"
                                 "        document.getElementById('rec-stop-btn').textContent.trim()],"
                                 "dot: getComputedStyle(document.getElementById('record-btn')"
                                 "      .querySelector('.rec-btn__dot')).animationName,"
                                 "chrome: !!document.getElementById('rec-panel')"
                                 "        || !!document.getElementById('rec-status')})")
            check("Pause and Stop appear once recording starts",
                  not state["pauseHidden"] and not state["stopHidden"])
            check("both transport buttons are icon-only",
                  state["icons"] == ["", ""], state["icons"])
            check("the Record button counts recorded time against the estimate",
                  bool(re.match(r"^\d{2}:\d{2}/\d{1,2}:\d{2}(:\d{2})?$", state["label"])), state["label"])
            check("the Record button carries the recording dot",
                  state["dot"] == "rec-pulse", state["dot"])
            check("no recording panel or explanatory line is left in the console",
                  not state["chrome"])

            con.click("#rec-pause-btn")
            con.wait_for_timeout(300)
            check("pausing swaps the icon button to Resume",
                  con.get_attribute("#rec-pause-btn", "title") == "Resume")
            check("the paused button is visibly paused",
                  con.evaluate("document.getElementById('rec-pause-btn')"
                               ".classList.contains('is-paused')"))
            con.click("#rec-pause-btn")
            con.wait_for_timeout(300)
            check("resuming swaps it back to Pause",
                  con.get_attribute("#rec-pause-btn", "title") == "Pause")

            time.sleep(4)
            mid = con.evaluate(DUMP_OPFS)
            check("the recording is being written to the chosen folder",
                  any(k.endswith(".mp4") and re.match(r"^\d{2}-\d{2}-\d{4}-[a-z]{5}/", k) for k in mid), mid)

            con.click("#rec-stop-btn")
            con.wait_for_timeout(300)
            # The bar rests the instant Stop is pressed, even though the muxer
            # is still putting the file together in the background.
            check("stopping returns the transport to rest at once",
                  con.evaluate("document.getElementById('rec-pause-btn').hidden"
                               " && document.getElementById('rec-stop-btn').hidden"))
            check("the Record button rests at once too",
                  con.inner_text("#record-btn-label") == "Record")
            con.wait_for_timeout(3000)
            check("stopping hides the transport again",
                  con.evaluate("document.getElementById('rec-pause-btn').hidden"
                               " && document.getElementById('rec-stop-btn').hidden"))
            check("the Record button goes back to its resting label",
                  con.inner_text("#record-btn-label") == "Record")
            toast = con.evaluate("Array.from(document.querySelectorAll('.toast'))"
                                 ".map(t=>t.textContent).join(' | ')")
            check("a notification reports the saved file instead of a status line",
                  "Saved" in toast, toast)
            check("the notification names a dated folder and an .mp4",
                  bool(re.search(r"\d{2}-\d{2}-\d{4}-[a-z]{5}/\S+\.mp4", toast)), toast)

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

            # The file must be a *seekable* MP4: a real duration and a seekable
            # range, not the durationless fragmented MP4 MediaRecorder writes.
            seek = con.evaluate("""async () => {
              const root = await navigator.storage.getDirectory();
              async function mp4(dir){
                for await (const [name, h] of dir.entries()){
                  if (h.kind === 'directory'){ const r = await mp4(h); if (r) return r; }
                  else if (name.endsWith('.mp4')) { return await h.getFile(); }
                }
                return null;
              }
              const f = await mp4(root);
              const v = document.createElement('video');
              v.src = URL.createObjectURL(f);
              await new Promise(r=>{v.onloadedmetadata=r;v.onerror=r;setTimeout(r,4000);});
              const out = {duration: v.duration,
                           seekable: v.seekable.length ? v.seekable.end(0) : 0,
                           err: v.error && v.error.message};
              // Seek backwards to a mid-point as well as forwards to the end:
              // one keyframe at the start would pass a forward seek and still
              // leave everything before the target unreachable.
              try { v.currentTime = Math.max(0, (v.duration || 2) / 2);
                    await new Promise(r=>{v.onseeked=r;setTimeout(r,1500);});
                    out.seekedMid = v.currentTime;
                    v.currentTime = Math.max(0, (v.duration || 2) - 0.5);
                    await new Promise(r=>{v.onseeked=r;setTimeout(r,1500);});
                    out.seekedTo = v.currentTime; }
              catch(e){ out.seekedTo = 'err'; }
              return out;
            }""")
            check("the recorded MP4 has a real duration and is seekable",
                  seek["duration"] > 0 and seek["seekable"] > 0 and not seek["err"]
                  and isinstance(seek["seekedTo"], (int, float))
                  and isinstance(seek.get("seekedMid"), (int, float)),
                  seek)

            # The picture must be a true 4K one, and the file must carry an
            # audio track: the console mixes the microphone (and any captured
            # system sound) into a track of its own, and a file with no audio
            # makes an <audio> element fail to load.
            media = con.evaluate("""async () => {
              const root = await navigator.storage.getDirectory();
              async function mp4(dir){
                for await (const [name, h] of dir.entries()){
                  if (h.kind === 'directory'){ const r = await mp4(h); if (r) return r; }
                  else if (name.endsWith('.mp4')) { return await h.getFile(); }
                }
                return null;
              }
              const f = await mp4(root);
              const v = document.createElement('video');
              v.src = URL.createObjectURL(f);
              await new Promise(r=>{v.onloadedmetadata=r;v.onerror=r;setTimeout(r,4000);});
              const a = document.createElement('audio');
              a.src = URL.createObjectURL(f);
              await new Promise(r=>{a.onloadedmetadata=r;a.onerror=r;setTimeout(r,4000);});
              return {w: v.videoWidth, h: v.videoHeight,
                      audioDuration: a.duration, audioErr: a.error && a.error.message};
            }""")
            check("the recording is 3840x2160",
                  media["w"] == 3840 and media["h"] == 2160, media)
            check("the recording carries an audio track",
                  media["audioDuration"] > 0 and not media["audioErr"], media)

            # An audio *track* is not the same as audible sound: the bug that
            # shipped was a silent one — the pump never ended, so the mixed
            # track was never finalized and the file played with no voice. Ask
            # ffmpeg for the real level when it is available.
            if shutil.which("ffmpeg"):
                mp4_bytes = con.evaluate("""async () => {
                  const root = await navigator.storage.getDirectory();
                  async function mp4(dir){
                    for await (const [name, h] of dir.entries()){
                      if (h.kind === 'directory'){ const r = await mp4(h); if (r) return r; }
                      else if (name.endsWith('.mp4')) return await h.getFile();
                    }
                    return null;
                  }
                  const f = await mp4(root);
                  const buf = new Uint8Array(await f.arrayBuffer());
                  let s = '';
                  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
                  return btoa(s);
                }""")
                import base64, tempfile
                with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
                    tmp.write(base64.b64decode(mp4_bytes))
                    tmp_path = tmp.name
                level = subprocess.run(
                    ["ffmpeg", "-hide_banner", "-i", tmp_path, "-af", "volumedetect",
                     "-f", "null", "-"], capture_output=True, text=True).stderr
                pathlib.Path(tmp_path).unlink(missing_ok=True)
                m = re.search(r"mean_volume:\s*(-?\d+(?:\.\d+)?) dB", level)
                mean_db = float(m.group(1)) if m else None
                check("the recorded audio is actually audible, not silent",
                      mean_db is not None and mean_db > -60, f"{mean_db} dB mean")
            else:
                print("SKIP  ffmpeg not installed — audio level not measured")

            # The display must never show any recording chrome.
            check("nothing about recording appears on the live display",
                  disp.evaluate("document.querySelectorAll('#display [id*=\"rec\"], #display [class*=\"rec\"]')"
                                ".length") == 0)

            # ---- both sources: system audio and the microphone are summed ----
            # The other branch of the mix. A screen share that *does* carry its
            # own audio must still be summed with the microphone through the
            # Web Audio graph, and the result must be audible.
            con.evaluate("""() => {
              const actx = new AudioContext({ sampleRate: 48000 });
              actx.resume();
              const dest = actx.createMediaStreamDestination();
              const osc = actx.createOscillator();
              osc.frequency.value = 440;
              const g = actx.createGain(); g.gain.value = 0.4;
              osc.connect(g); g.connect(dest); osc.start();
              const v = document.createElement('canvas');
              v.width = 640; v.height = 360;
              v.getContext('2d').fillRect(0, 0, 640, 360);
              const stream = new MediaStream([
                v.captureStream(30).getVideoTracks()[0],
                dest.stream.getAudioTracks()[0]
              ]);
              navigator.mediaDevices.getDisplayMedia = async () => stream;
            }""")
            con.evaluate("""async () => {
              const root = await navigator.storage.getDirectory();
              for await (const [name] of root.entries()) {
                await root.removeEntry(name, { recursive: true });
              }
            }""")
            con.click("#record-btn")
            con.wait_for_timeout(7000)
            con.click("#rec-stop-btn")
            con.wait_for_timeout(6000)
            if shutil.which("ffmpeg"):
                mp4_bytes = con.evaluate("""async () => {
                  const root = await navigator.storage.getDirectory();
                  async function mp4(dir){
                    for await (const [name, h] of dir.entries()){
                      if (h.kind === 'directory'){ const r = await mp4(h); if (r) return r; }
                      else if (name.endsWith('.mp4')) return await h.getFile();
                    }
                    return null;
                  }
                  const f = await mp4(root);
                  const buf = new Uint8Array(await f.arrayBuffer());
                  let s = '';
                  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
                  return btoa(s);
                }""")
                import base64, tempfile
                with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
                    tmp.write(base64.b64decode(mp4_bytes))
                    tmp_path = tmp.name
                level = subprocess.run(
                    ["ffmpeg", "-hide_banner", "-i", tmp_path, "-af", "volumedetect",
                     "-f", "null", "-"], capture_output=True, text=True).stderr
                pathlib.Path(tmp_path).unlink(missing_ok=True)
                m = re.search(r"mean_volume:\s*(-?\d+(?:\.\d+)?) dB", level)
                mean_db = float(m.group(1)) if m else None
                check("system audio and the microphone are summed into one track",
                      mean_db is not None and mean_db > -60, f"{mean_db} dB mean")

            # ---- the real-world case: no system audio, suspended context ----
            # A machine sharing a screen over HDMI usually has no system-audio
            # track at all, so the microphone is the only source — and Chrome
            # may hold the AudioContext suspended because it was created after
            # the pickers awaited. A suspended context's MediaStreamDestination
            # emits nothing, so routing a lone microphone through it produced a
            # file with an audio track that played as silence. The microphone
            # must now reach the file either way.
            con.evaluate("""() => {
              // A screen share that carries no audio, as an HDMI share does.
              const fake = new MediaStream([(() => {
                const c = document.createElement('canvas');
                c.width = 640; c.height = 360;
                const ctx = c.getContext('2d');
                ctx.fillStyle = '#123'; ctx.fillRect(0, 0, 640, 360);
                return c.captureStream(30).getVideoTracks()[0];
              })()]);
              navigator.mediaDevices.getDisplayMedia = async () => fake;
              // A Web Audio graph that cannot run: the context is suspended
              // (no gesture can revive it) and its destination is a track that
              // never produces a single sample. This is what a suspended
              // context really does to a recording — the graph yields silence,
              // not an error — so a lone microphone routed through it would
              // reach the file as nothing at all.
              window.AudioContext = function () {
                return {
                  state: 'suspended',
                  resume: () => Promise.resolve(),
                  close: () => Promise.resolve(),
                  createMediaStreamDestination: () => ({
                    stream: new MediaStream([
                      new MediaStreamTrackGenerator({ kind: 'audio' })
                    ])
                  }),
                  createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
                  createGain: () => ({ gain: { value: 0 }, connect() {}, disconnect() {} })
                };
              };
            }""")
            # Clear the earlier recording out of the way so the measurement
            # below can only be of the recording this section makes.
            con.evaluate("""async () => {
              const root = await navigator.storage.getDirectory();
              for await (const [name] of root.entries()) {
                await root.removeEntry(name, { recursive: true });
              }
            }""")
            con.click("#record-btn")
            con.wait_for_timeout(7000)
            con.click("#rec-stop-btn")
            con.wait_for_timeout(6000)

            if shutil.which("ffmpeg"):
                mp4_bytes = con.evaluate("""async () => {
                  const root = await navigator.storage.getDirectory();
                  async function mp4(dir){
                    for await (const [name, h] of dir.entries()){
                      if (h.kind === 'directory'){ const r = await mp4(h); if (r) return r; }
                      else if (name.endsWith('.mp4')) return await h.getFile();
                    }
                    return null;
                  }
                  const f = await mp4(root);
                  const buf = new Uint8Array(await f.arrayBuffer());
                  let s = '';
                  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
                  return btoa(s);
                }""")
                import base64, tempfile
                with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
                    tmp.write(base64.b64decode(mp4_bytes))
                    tmp_path = tmp.name
                level = subprocess.run(
                    ["ffmpeg", "-hide_banner", "-i", tmp_path, "-af", "volumedetect",
                     "-f", "null", "-"], capture_output=True, text=True).stderr
                pathlib.Path(tmp_path).unlink(missing_ok=True)
                m = re.search(r"mean_volume:\s*(-?\d+(?:\.\d+)?) dB", level)
                mean_db = float(m.group(1)) if m else None
                check("a screen share with no system audio still records the mic",
                      mean_db is not None and mean_db > -60, f"{mean_db} dB mean")

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
