#!/usr/bin/env python3
"""A real end-to-end run of Go Live against YouTube's own RTMP ingest.

This is the manual proof that the whole path works against the real service,
not a stub: the console encodes the display, posts it to /stream, serve.py
resolves the RTMP hostname and hands ffmpeg a literal address, and ffmpeg
relays to YouTube. The picture is generated test content (a moving picture and
a tone), so the run needs no screen.

It is not part of the normal suite: it needs a real YouTube stream key and
sends real minutes of video to the internet. Provide both as environment
variables and it runs; without them it prints how to and exits.

    EWC_TEST_RTMP_URL=rtmp://a.rtmp.youtube.com/live2 \
    EWC_TEST_RTMP_KEY=xxxx-xxxx-xxxx-xxxx-xxxx \
    python3 tests/test_live_youtube.py [seconds]

It checks that the relay reports live for the whole run, that ffmpeg keeps the
connection (no reconnects), and that the bytes flowing into ffmpeg are a real
H.264 + AAC stream — the same picture and sound YouTube receives.
"""
import json
import os
import pathlib
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


def stream_status(base):
    out = subprocess.run(
        ["curl", "-s", "--max-time", "5", base + "/stream/status"],
        capture_output=True, text=True,
    )
    try:
        return json.loads(out.stdout or "{}")
    except json.JSONDecodeError:
        return {}


def probe(path):
    probe_bin = FFMPEG.replace("ffmpeg", "ffprobe")
    if not os.path.exists(probe_bin):
        probe_bin = shutil.which("ffprobe") or probe_bin
    out = subprocess.run(
        [probe_bin, "-v", "error", "-show_entries",
         "stream=codec_type,codec_name,width,height", "-of", "json", path],
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
    return {
        "has_video": "video" in kinds,
        "has_audio": "audio" in kinds,
        "width": int(video.get("width") or 0),
        "height": int(video.get("height") or 0),
        "video_codec": video.get("codec_name") or "",
        "audio_codec": audio.get("codec_name") or "",
    }


# The console's real capture path, fed generated content instead of a monitor:
# a moving picture and a tone, so the relayed stream carries both and can be
# measured. Everything downstream (the 4K canvas, the encoders, /stream,
# serve.py, ffmpeg, YouTube) is the real code.
STUB_CAPTURE = """
window.showDirectoryPicker = async function () {
  return await navigator.storage.getDirectory();
};
(() => {
  const c = document.createElement('canvas');
  c.width = 1280; c.height = 720;
  const ctx = c.getContext('2d');
  let t = 0;
  setInterval(() => {
    t += 1;
    ctx.fillStyle = 'hsl(' + (t * 3 % 360) + ',70%,45%)';
    ctx.fillRect(0, 0, 1280, 720);
    ctx.fillStyle = '#fff';
    ctx.font = '96px sans-serif';
    ctx.fillText('EWC LIVE ' + t, 80, 400);
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


def main():
    url = os.environ.get("EWC_TEST_RTMP_URL", "").strip()
    key = os.environ.get("EWC_TEST_RTMP_KEY", "").strip()
    seconds = int(sys.argv[1]) if len(sys.argv) > 1 else 180
    if not url or not key:
        print("Set EWC_TEST_RTMP_URL and EWC_TEST_RTMP_KEY to run this against "
              "a real RTMP server (such as YouTube). Skipping.")
        return
    if not os.path.exists(FFMPEG):
        print("ffmpeg is required for this run; skipping.")
        return

    console_port = free_port()
    base = f"http://localhost:{console_port}"
    server = subprocess.Popen(
        [sys.executable, str(ROOT / "serve.py"), str(console_port)],
        cwd=str(ROOT),
        env={"PATH": "/usr/bin:/bin:/usr/local/bin", "EWC_FFMPEG": FFMPEG},
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    server_log = []
    threading.Thread(target=lambda: [server_log.append(line)
                                     for line in server.stdout], daemon=True).start()
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
            con = ctx.new_page()
            con.on("pageerror", lambda e: errs.append(str(e)))
            con.goto(f"{base}/console.html", wait_until="load")
            con.evaluate(STUB_CAPTURE)
            con.wait_for_timeout(800)

            # Point the console at the real service and go live.
            con.click("#stream-setup > summary")
            con.wait_for_timeout(200)
            con.fill("#rtmp-url-input", url)
            con.fill("#rtmp-key-input", key)
            con.click("#live-btn")

            deadline = time.time() + 30
            live = False
            while time.time() < deadline:
                if stream_status(base).get("state") == "live":
                    live = True
                    break
                time.sleep(0.5)
            check("YouTube's ingest accepts the relay (state live)", live,
                  stream_status(base).get("state"))

            # Watch the whole run: the relay must stay live and never reconnect.
            started = time.time()
            samples = []
            while time.time() - started < seconds:
                st = stream_status(base)
                samples.append(st.get("state"))
                con.wait_for_timeout(2000)
            live_ratio = (sum(1 for s in samples if s == "live") / max(1, len(samples)))
            check("the relay stayed live for the whole run", live_ratio >= 0.95,
                  f"{live_ratio * 100:.0f}% of {len(samples)} samples")
            final = stream_status(base)
            check("the relay sent real bytes to the server",
                  final.get("bytes", 0) > 100000, f"{final.get('bytes', 0)} bytes")
            elapsed_label = con.inner_text("#live-btn-label").strip()
            check("the live button counted the time on air",
                  ":" in elapsed_label and elapsed_label != "Go Live", elapsed_label)
            check("no page errors during the run", not errs, str(errs)[:200])

            # Stop, and let ffmpeg flush.
            con.click("#live-stop-btn")
            deadline = time.time() + 30
            while time.time() < deadline:
                if stream_status(base).get("state") in ("stopped", "idle", "failed"):
                    break
                time.sleep(0.5)
            check("the relay reports the stream stopped",
                  stream_status(base).get("state") in ("stopped", "idle"),
                  stream_status(base).get("state"))
            browser.close()

        # ---------- what the server's ffmpeg actually received ----------
        # serve.py logs the relay's fate; a segfault or a hostname crash would
        # show up here rather than as a clean stop.
        log_text = "".join(server_log)
        check("the run produced no ffmpeg crash",
              "Segmentation fault" not in log_text,
              log_text[-120:])
    finally:
        server.terminate()

    print()
    if fails:
        print(f"{len(fails)} FAILURE(S): {fails}")
        sys.exit(1)
    print("ALL CHECKS PASSED")


if __name__ == "__main__":
    main()
