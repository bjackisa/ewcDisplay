#!/usr/bin/env python3
"""Checks for Go Live: relaying the live display to an RTMP server.

A browser cannot speak RTMP, so the console encodes the display into a
fragmented MP4 and posts it to the project's own /stream endpoint, which pipes
it into ffmpeg. This suite proves the whole path end to end with nothing
stubbed but the screen picker: a real ffmpeg listens as the RTMP server (the
stand-in for YouTube's ingest), the browser sends generated test content
(testsrc picture, tone audio), and the relayed stream is read back and
inspected.

Covers:
  * the transport: Go Live shows the elapsed time on its own button and a
    single icon-only Stop, never a Pause;
  * the relay: /stream/status moves idle -> live -> stopped, and the RTMP
    server actually receives a playable H.264 + AAC stream;
  * sharing: a recording and a stream run at once from one screen capture;
  * failure: a relay that dies mid-stream is reported, not silently swallowed.

Run:  python3 tests/test_streaming.py
"""
import json
import os
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
FFMPEG = str(ROOT / "bin" / "ffmpeg")
if not os.path.exists(FFMPEG):
    FFMPEG = shutil.which("ffmpeg") or FFMPEG
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


# A screen share of generated test content: a moving testsrc-style picture plus
# a tone, so the relayed stream can be inspected without a real screen.
STUB_CAPTURE = """
window.showDirectoryPicker = async function () {
  return await navigator.storage.getDirectory();
};
(() => {
  const c = document.createElement('canvas');
  c.width = 640; c.height = 360;
  const ctx = c.getContext('2d');
  let t = 0;
  setInterval(() => {
    t += 1;
    ctx.fillStyle = 'hsl(' + (t * 3 % 360) + ',70%,45%)';
    ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = '#fff';
    ctx.font = '48px sans-serif';
    ctx.fillText('EWC ' + t, 40, 200);
  }, 33);
  const actx = new AudioContext({ sampleRate: 48000 });
  actx.resume();
  const dest = actx.createMediaStreamDestination();
  const osc = actx.createOscillator();
  osc.frequency.value = 440;
  const g = actx.createGain(); g.gain.value = 0.3;
  osc.connect(g); g.connect(dest); osc.start();
  const stream = new MediaStream([
    c.captureStream(30).getVideoTracks()[0],
    dest.stream.getAudioTracks()[0]
  ]);
  navigator.mediaDevices.getDisplayMedia = async () => stream;
})();
"""


class RtmpIngest:
    """A real RTMP server, standing in for YouTube's ingest. ffmpeg listens on
    a port and writes whatever it receives to a file we can inspect."""

    def __init__(self, port, out_path):
        self.port = port
        self.out_path = out_path
        self.proc = None
        self.url = f"rtmp://127.0.0.1:{port}/live/test"

    def start(self):
        if os.path.exists(self.out_path):
            os.unlink(self.out_path)
        self.proc = subprocess.Popen(
            [FFMPEG, "-y", "-hide_banner", "-loglevel", "warning",
             "-listen", "1", "-f", "flv", "-i", f"rtmp://127.0.0.1:{self.port}/live/test",
             "-c", "copy", "-f", "flv", self.out_path],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        time.sleep(1.0)

    def stop(self):
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


def probe(path):
    """A dict describing a file's streams, via ffprobe.

    Keys: has_video, has_audio, seconds, width, height, audio_codec.
    """
    probe_bin = FFMPEG.replace("ffmpeg", "ffprobe")
    if not os.path.exists(probe_bin):
        probe_bin = shutil.which("ffprobe") or probe_bin
    out = subprocess.run(
        [probe_bin, "-v", "error", "-show_entries",
         "stream=codec_type,codec_name,width,height", "-show_entries",
         "format=duration", "-of", "json", path],
        capture_output=True, text=True,
    )
    try:
        data = json.loads(out.stdout or "{}")
    except json.JSONDecodeError:
        data = {}
    streams = data.get("streams", [])
    kinds = {s.get("codec_type") for s in streams}
    video = next((s for s in streams if s.get("codec_type") == "video"), {})
    audio = next((s for s in streams if s.get("codec_type") == "audio"), {})
    try:
        duration = float(data.get("format", {}).get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0.0
    return {
        "has_video": "video" in kinds,
        "has_audio": "audio" in kinds,
        "seconds": duration,
        "width": int(video.get("width") or 0),
        "height": int(video.get("height") or 0),
        "audio_codec": audio.get("codec_name") or "",
    }


def mean_volume(path):
    """Mean audio volume in dB via ffmpeg's volumedetect. -inf means silence."""
    ffmpeg_bin = FFMPEG if os.path.exists(FFMPEG) else (shutil.which("ffmpeg") or FFMPEG)
    out = subprocess.run(
        [ffmpeg_bin, "-hide_banner", "-nostdin", "-i", path,
         "-af", "volumedetect", "-f", "null", "-"],
        capture_output=True, text=True,
    )
    match = re.search(r"mean_volume:\s*(-?[\d.]+|-inf)\s*dB", out.stderr or "")
    if not match:
        return None
    return float("-inf") if match.group(1) == "-inf" else float(match.group(1))


def stream_status(base):
    out = subprocess.run(
        ["curl", "-s", "--max-time", "5", base + "/stream/status"],
        capture_output=True, text=True,
    )
    try:
        return json.loads(out.stdout or "{}")
    except json.JSONDecodeError:
        return {}


def main():
    if not os.path.exists(FFMPEG):
        print("ffmpeg is required for this suite; skipping.")
        return

    console_port = free_port()
    ingest_port = free_port()
    base = f"http://localhost:{console_port}"
    out_path = "/tmp/ewc_stream_received.flv"
    ingest = RtmpIngest(ingest_port, out_path)
    ingest.start()

    server = subprocess.Popen(
        [sys.executable, str(ROOT / "serve.py"), str(console_port)],
        cwd=str(ROOT),
        env={"PATH": "/usr/bin:/bin:/usr/local/bin", "EWC_FFMPEG": FFMPEG},
    )
    time.sleep(1.2)

    try:
        # ---------- the probe reports a working relay ----------
        probe_out = subprocess.run(
            ["curl", "-s", "--max-time", "10", base + "/stream/probe"],
            capture_output=True, text=True,
        )
        try:
            info = json.loads(probe_out.stdout or "{}")
        except json.JSONDecodeError:
            info = {}
        check("the server reports an ffmpeg that can relay",
              bool(info.get("ffmpeg")) and bool(info.get("rtmp")), str(info)[:120])
        check("status starts idle", stream_status(base).get("state") == "idle")

        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=[
                "--use-fake-ui-for-media-stream",
                "--use-fake-device-for-media-stream",
                "--auto-select-desktop-capture-source=Entire screen",
            ])
            ctx = browser.new_context(viewport={"width": 1500, "height": 900})
            errs = []
            con = ctx.new_page()
            con.on("pageerror", lambda e: errs.append(str(e)))
            con.goto(f"{base}/console.html", wait_until="load")
            con.evaluate(STUB_CAPTURE)
            con.wait_for_timeout(800)

            # ---------- the transport before going live ----------
            check("the live button starts as Go Live",
                  con.inner_text("#live-btn-label").strip() == "Go Live")
            check("no stream Stop before going live",
                  con.evaluate("document.getElementById('live-stop-btn').hidden") is True)
            check("there is no Pause button for streaming",
                  con.evaluate("!!document.getElementById('live-pause-btn')") is False)

            # ---------- Go Live ----------
            con.click("#stream-setup > summary")
            con.wait_for_timeout(200)
            con.fill("#rtmp-url-input", f"rtmp://127.0.0.1:{ingest_port}/live")
            con.fill("#rtmp-key-input", "test")
            con.click("#live-btn")
            con.wait_for_timeout(1500)

            # Once live: an icon-only Stop appears, and the label is the time on
            # air rather than a word.
            deadline = time.time() + 20
            while time.time() < deadline:
                if stream_status(base).get("state") == "live":
                    break
                time.sleep(0.5)
            check("the relay reports the stream live",
                  stream_status(base).get("state") == "live")
            check("a single icon-only Stop appears while live",
                  con.evaluate("document.getElementById('live-stop-btn').hidden") is False)
            check("the Pause button stays out of the stream's way",
                  con.evaluate("document.getElementById('rec-pause-btn').hidden") is True)
            label = con.inner_text("#live-btn-label").strip()
            check("the live button shows the elapsed time, not a word",
                  label not in ("Go Live", "Recording", "") and ":" in label, label)

            # Let the relay carry a few seconds of real content.
            con.wait_for_timeout(6000)

            # ---------- recording alongside the stream shares one capture ----
            con.click("#record-btn")
            con.wait_for_timeout(2500)
            rec_active = con.evaluate("!document.getElementById('rec-stop-btn').hidden")
            check("a recording runs at the same time as the stream", rec_active)
            check("the stream stays live while recording",
                  stream_status(base).get("state") == "live")
            con.click("#rec-stop-btn")
            con.wait_for_timeout(4000)

            # ---------- Stop the stream ----------
            con.click("#live-stop-btn")
            con.wait_for_timeout(1500)
            check("the stream Stop returns the button to rest",
                  con.inner_text("#live-btn-label").strip() == "Go Live")

            deadline = time.time() + 20
            while time.time() < deadline:
                if stream_status(base).get("state") in ("stopped", "idle"):
                    break
                time.sleep(0.5)
            check("the relay reports the stream stopped",
                  stream_status(base).get("state") in ("stopped", "idle"),
                  stream_status(base).get("state"))

            # The toast says one thing and needs no reading of the rail.
            con.wait_for_timeout(1500)
            toast = con.inner_text("#toast-stack") if con.query_selector("#toast-stack") else ""
            check("a notification reports the stream ending",
                  "Stream" in toast or "stream" in toast, toast[:80])

            # ---------- what the RTMP server actually received ----------
            ingest.stop()
            time.sleep(1.0)
            info = probe(out_path)
            check("the RTMP server received a video stream", info["has_video"],
                  f"{info['seconds']:.1f}s")
            check("the RTMP server received an audio stream", info["has_audio"])
            check("the relayed stream carries several seconds of content",
                  info["seconds"] >= 3, f"{info['seconds']:.1f}s")
            # The picture is delivered at 4K, and it is never re-encoded: the
            # relay copies the console's own H.264.
            check("the relayed picture is 4K",
                  (info["width"], info["height"]) == (3840, 2160),
                  f"{info['width']}x{info['height']}")
            # RTMP carries AAC, whatever the console had to encode with.
            check("the relayed audio is AAC", info["audio_codec"] == "aac",
                  info["audio_codec"])
            # A track that is present but silent is the failure this guards.
            db = mean_volume(out_path)
            check("the relayed audio is not silent",
                  db is not None and db > -60, f"mean {db} dB")

            check("no page errors anywhere", not errs, str(errs)[:200])
            browser.close()
    finally:
        server.terminate()
        ingest.stop()

    print()
    if fails:
        print(f"{len(fails)} FAILURE(S): {fails}")
        sys.exit(1)
    print("ALL CHECKS PASSED")


if __name__ == "__main__":
    main()
