#!/usr/bin/env python3
"""Record AND stream the REAL display at the same time, with the actual tool
on screen, and prove both outputs keep moving.

This is the combination the console must support: one screen capture, two
sinks. A recording and a live stream run together, the operator steps bible
verses on air, and both the recorded MP4 and the relayed RTMP copy are
inspected frame by frame.

Nothing about the screen is stubbed: a headed Chromium runs under Xvfb, the
whole screen is shared through the real picker, and display.html is the real
projection page. Only the folder picker (to the Origin Private File System)
and the RTMP target (a local ffmpeg listener) are arranged.

Run:  python3 tests/test_real_record_stream.py
"""
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
FFMPEG = str(ROOT / "bin" / "ffmpeg")
if not os.path.exists(FFMPEG):
    FFMPEG = shutil.which("ffmpeg") or FFMPEG
FFPROBE = FFMPEG.replace("ffmpeg", "ffprobe")
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


def stream_status(base):
    out = subprocess.run(["curl", "-s", "--max-time", "5", base + "/stream/status"],
                         capture_output=True, text=True)
    try:
        return json.loads(out.stdout or "{}")
    except json.JSONDecodeError:
        return {}


class RtmpIngest:
    def __init__(self, port, out_path):
        self.port = port
        self.out_path = out_path
        self.proc = None

    def start(self):
        if os.path.exists(self.out_path):
            os.unlink(self.out_path)
        self.proc = subprocess.Popen(
            [FFMPEG, "-y", "-hide_banner", "-loglevel", "warning",
             "-listen", "1", "-f", "flv", "-i", f"rtmp://127.0.0.1:{self.port}/live/test",
             "-c", "copy", "-f", "flv", self.out_path],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1.0)

    def stop(self):
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


def per_second_sigs(path):
    out = subprocess.run(
        [FFMPEG, "-v", "error", "-i", path, "-vf", "fps=1,scale=32:18",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        capture_output=True)
    data = out.stdout
    fb = 32 * 18 * 3
    return [round(sum(data[i:i + fb]) / fb, 1)
            for i in range(0, len(data) - fb + 1, fb)]


def probe(path):
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries",
         "stream=codec_type,codec_name,width,height", "-show_entries",
         "format=duration", "-of", "json", path],
        capture_output=True, text=True)
    try:
        data = json.loads(out.stdout or "{}")
    except json.JSONDecodeError:
        data = {}
    streams = data.get("streams", [])
    kinds = {s.get("codec_type") for s in streams}
    video = next((s for s in streams if s.get("codec_type") == "video"), {})
    audio = next((s for s in streams if s.get("codec_type") == "audio"), {})
    return {"has_video": "video" in kinds, "has_audio": "audio" in kinds,
            "width": int(video.get("width") or 0), "height": int(video.get("height") or 0),
            "audio_codec": audio.get("codec_name") or "",
            "duration": float(data.get("format", {}).get("duration") or 0)}


DUMP_OPFS = r"""
async () => {
  const root = await navigator.storage.getDirectory();
  const out = {};
  async function walk(dir, prefix) {
    for await (const [name, handle] of dir.entries()) {
      const path = prefix ? prefix + '/' + name : name;
      if (handle.kind === 'file') { out[path] = (await handle.getFile()).size; }
      else { await walk(handle, path); }
    }
  }
  await walk(root, '');
  return out;
}
"""

FETCH_OPFS = r"""
async (path) => {
  const root = await navigator.storage.getDirectory();
  const parts = path.split('/');
  let dir = root;
  for (let i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i]);
  const fh = await dir.getFileHandle(parts[parts.length - 1]);
  const buf = await (await fh.getFile()).arrayBuffer();
  return Array.from(new Uint8Array(buf));
}
"""


def main():
    if not os.path.exists(FFMPEG):
        print("ffmpeg is required for this suite; skipping.")
        return

    xvfb = subprocess.Popen(["Xvfb", ":99", "-screen", "0", "1600x900x24"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.0)
    os.environ["DISPLAY"] = ":99"

    console_port = free_port()
    ingest_port = free_port()
    base = f"http://localhost:{console_port}"
    out_path = "/tmp/ewc_real_rs.flv"
    ingest = RtmpIngest(ingest_port, out_path)
    ingest.start()

    server = subprocess.Popen(
        [sys.executable, str(ROOT / "serve.py"), str(console_port)],
        cwd=str(ROOT), env={**os.environ, "EWC_FFMPEG": FFMPEG},
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.2)

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                headless=False,
                args=[
                    "--use-fake-ui-for-media-stream",
                    "--use-fake-device-for-media-stream",
                    "--auto-select-desktop-capture-source=Entire screen",
                    "--window-size=1600,900",
                ])
            ctx = browser.new_context(viewport={"width": 1600, "height": 900})
            errs = []

            disp = ctx.new_page()
            disp.goto(f"{base}/display.html", wait_until="load")

            con = ctx.new_page()
            con.on("pageerror", lambda e: errs.append(str(e)))
            con.goto(f"{base}/console.html", wait_until="load")
            con.evaluate("""window.showDirectoryPicker = async function () {
                return await navigator.storage.getDirectory(); };""")
            con.wait_for_timeout(500)

            con.click('button[data-mode="scripture"]')
            con.select_option("#scripture-book-select", "42")
            con.fill("#scripture-chapter-input", "3")
            con.fill("#scripture-verse-input", "16")
            con.click("#scripture-go-btn")
            con.wait_for_timeout(400)
            con.click("#launch-btn")
            con.wait_for_timeout(1000)

            ref = disp.inner_text("#scripture-reference") if disp.query_selector("#scripture-reference") else ""
            check("the real display shows the launched verse", "John 3:16" in ref, ref)

            # Go live to the local RTMP server, then start recording too.
            con.click("#stream-setup > summary")
            con.wait_for_timeout(200)
            con.fill("#rtmp-url-input", f"rtmp://127.0.0.1:{ingest_port}/live")
            con.fill("#rtmp-key-input", "test")
            con.click("#live-btn")

            deadline = time.time() + 30
            while time.time() < deadline and stream_status(base).get("state") != "live":
                time.sleep(0.5)
            check("the relay reports the stream live",
                  stream_status(base).get("state") == "live",
                  stream_status(base).get("state"))

            con.click("#record-btn")
            con.wait_for_timeout(2000)
            check("a recording runs alongside the stream",
                  con.evaluate("!document.getElementById('rec-stop-btn').hidden") is True)

            # The projection screen is the visible tab; step verses on air.
            disp.bring_to_front()
            con.wait_for_timeout(500)
            for v in range(17, 25):
                con.bring_to_front()
                con.fill("#scripture-verse-input", str(v))
                con.click("#scripture-go-btn")
                con.wait_for_timeout(200)
                disp.bring_to_front()
                con.wait_for_timeout(1400)

            con.bring_to_front()
            con.click("#rec-stop-btn")
            con.wait_for_timeout(6000)
            con.click("#live-stop-btn")
            deadline = time.time() + 20
            while time.time() < deadline and stream_status(base).get("state") not in ("stopped", "idle", "failed"):
                time.sleep(0.5)

            check("the stream stayed live through the recording",
                  stream_status(base).get("state") in ("stopped", "idle"),
                  stream_status(base).get("state"))
            check("no page errors during the run", not errs, str(errs)[:200])

            # Pull the recorded file out of OPFS.
            files = con.evaluate(DUMP_OPFS)
            mp4s = [k for k in files if k.endswith(".mp4") and files[k] > 0]
            check("a recording landed on disk", bool(mp4s), str(files))
            if mp4s:
                data = con.evaluate(FETCH_OPFS, mp4s[0])
                with open("/tmp/ewc_real_rs.mp4", "wb") as f:
                    f.write(bytes(data))
            browser.close()
    finally:
        server.terminate()
        ingest.stop()
        time.sleep(1.0)

    # ---------- the recording ----------
    if os.path.exists("/tmp/ewc_real_rs.mp4"):
        info = probe("/tmp/ewc_real_rs.mp4")
        print("recorded:", info)
        check("the recording is 4K", (info["width"], info["height"]) == (3840, 2160),
              f"{info['width']}x{info['height']}")
        check("the recording carries audio", info["has_audio"])
        sigs = per_second_sigs("/tmp/ewc_real_rs.mp4")
        print("recording sigs:", sigs)
        check("the recording keeps moving",
              len(sigs) >= 3 and len(set(sigs)) >= max(3, len(sigs) // 2),
              f"{len(set(sigs))} distinct of {len(sigs)}")

    # ---------- the stream ----------
    info = probe(out_path)
    print("relayed:", info)
    check("the RTMP server received video", info["has_video"], f"{info['duration']:.1f}s")
    check("the relayed picture is 1080p",
          (info["width"], info["height"]) == (1920, 1080),
          f"{info['width']}x{info['height']}")
    check("the relayed stream carries audio", info["has_audio"])
    sigs = per_second_sigs(out_path)
    print("stream sigs:", sigs)
    check("the relayed stream keeps moving (not stuck on the first frame)",
          len(sigs) >= 3 and len(set(sigs)) >= max(3, len(sigs) // 2),
          f"{len(set(sigs))} distinct of {len(sigs)}")
    check("the relayed stream runs nearly as long as the recording",
          info["duration"] >= 12,
          f"{info['duration']:.1f}s of ~20s")

    xvfb.terminate()

    print()
    if fails:
        print(f"{len(fails)} FAILURE(S): {fails}")
        sys.exit(1)
    print("ALL CHECKS PASSED")


if __name__ == "__main__":
    main()
