#!/usr/bin/env python3
"""Stream the REAL display (the actual tool) to an RTMP server and check that
the relayed picture moves.

This is the test the earlier suites were missing: test_streaming.py stubs
getDisplayMedia with a synthetic canvas, so it proves the pipeline carries
*some* picture but says nothing about whether the real projection screen —
the bible verse, the lyrics, the countdown — actually reaches the relay and
keeps moving.

Here nothing about the screen is stubbed. A headed Chromium runs under Xvfb,
the operator shares the whole screen through the real picker, the display page
is the real display.html, and the operator steps bible verses on air. The RTMP
server's copy is then decoded frame by frame; a stream stuck on its first
frame (the reported failure) shows as a run of identical frames.

Run:  python3 tests/test_real_stream_display.py
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
    return {
        "has_video": "video" in kinds,
        "has_audio": "audio" in kinds,
        "width": int(video.get("width") or 0),
        "height": int(video.get("height") or 0),
        "audio_codec": audio.get("codec_name") or "",
        "duration": float(data.get("format", {}).get("duration") or 0),
    }


def per_second_frames(path):
    """Decode 1 fps and return a crude signature per frame. Identical adjacent
    signatures mean the picture did not change."""
    out = subprocess.run(
        [FFMPEG, "-v", "error", "-i", path, "-vf", "fps=1,scale=32:18",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        capture_output=True)
    data = out.stdout
    fb = 32 * 18 * 3
    sigs = []
    for i in range(0, len(data) - fb + 1, fb):
        chunk = data[i:i + fb]
        sigs.append(round(sum(chunk) / len(chunk), 1))
    return sigs


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
    out_path = "/tmp/ewc_real_stream.flv"
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

            # Put a real bible verse on the real display.
            con.click('button[data-mode="scripture"]')
            con.select_option("#scripture-book-select", "42")  # John
            con.fill("#scripture-chapter-input", "3")
            con.fill("#scripture-verse-input", "16")
            con.click("#scripture-go-btn")
            con.wait_for_timeout(400)
            con.click("#launch-btn")
            con.wait_for_timeout(1000)

            live_ref = disp.inner_text("#scripture-reference") if disp.query_selector("#scripture-reference") else ""
            check("the real display shows the launched verse",
                  "John 3:16" in live_ref, live_ref)

            # The display page must be the visible tab so the screen share sees it.
            disp.bring_to_front()
            con.wait_for_timeout(300)

            # Go live to the local RTMP server.
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

            # Step verses on air so the real screen visibly changes.
            con.bring_to_front()
            for v in range(17, 24):
                con.fill("#scripture-verse-input", str(v))
                con.click("#scripture-go-btn")
                con.wait_for_timeout(200)
                disp.bring_to_front()
                con.wait_for_timeout(900)
                con.bring_to_front()
                con.wait_for_timeout(900)

            con.wait_for_timeout(1500)
            con.click("#live-stop-btn")
            deadline = time.time() + 20
            while time.time() < deadline and stream_status(base).get("state") not in ("stopped", "idle", "failed"):
                time.sleep(0.5)

            check("no page errors during the run", not errs, str(errs)[:200])
            browser.close()
    finally:
        server.terminate()
        ingest.stop()
        time.sleep(1.0)

    info = probe(out_path)
    print("received:", info)
    check("the RTMP server received video", info["has_video"], f"{info['duration']:.1f}s")
    check("the RTMP server received audio", info["has_audio"])
    check("the picture is 1080p", (info["width"], info["height"]) == (1920, 1080),
          f"{info['width']}x{info['height']}")

    sigs = per_second_frames(out_path)
    print("per-second signatures:", sigs)
    distinct = len(set(sigs))
    check("the relayed picture keeps moving (not stuck on the first frame)",
          len(sigs) >= 3 and distinct >= max(3, len(sigs) // 2),
          f"{distinct} distinct of {len(sigs)}")

    xvfb.terminate()

    print()
    if fails:
        print(f"{len(fails)} FAILURE(S): {fails}")
        sys.exit(1)
    print("ALL CHECKS PASSED")


if __name__ == "__main__":
    main()
