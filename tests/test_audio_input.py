"""The audio input picker.

A phone running DroidCam and a mixing desk on the line-in jack are both just
`audioinput` devices to the browser, so the picker is what makes either one
usable: the operator chooses the input, the level check proves sound is
arriving, and a line-in is opened without the voice processing that a mixing
desk does not want. A chosen device that has since gone must fall back to the
default input rather than cost the recording its microphone.
"""
import pathlib
import socket
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
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


def main():
    port = free_port()
    base = f"http://localhost:{port}"
    server = subprocess.Popen([sys.executable, str(ROOT / "serve.py"), str(port)],
                              cwd=str(ROOT), stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL)
    time.sleep(1.2)
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=[
                "--use-fake-ui-for-media-stream",
                "--use-fake-device-for-media-stream",
                "--autoplay-policy=no-user-gesture-required",
            ])
            ctx = browser.new_context(viewport={"width": 1600, "height": 900},
                                      permissions=["microphone", "camera"])
            errs = []
            con = ctx.new_page()
            con.on("pageerror", lambda e: errs.append(str(e)))
            con.goto(f"{base}/console.html", wait_until="load")
            con.wait_for_timeout(1800)

            con.click("#audio-setup > summary")
            con.wait_for_timeout(300)
            check("the audio settings open",
                  con.evaluate("document.getElementById('audio-setup').open"))
            check("there is an input picker",
                  con.evaluate("!!document.getElementById('audio-device-select')"))
            check("the picker offers the default input",
                  con.eval_on_selector("#audio-device-select option", "e=>e.textContent")
                  == "Default input")

            # The level check is the operator's proof that the cable is live:
            # it must open the input, hear the fake device, and say so.
            con.evaluate("""() => {
              window.__opened = null;
              const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
              navigator.mediaDevices.getUserMedia = async (c) => {
                window.__opened = c;
                return real(c);
              };
            }""")
            con.click("#audio-test-btn")
            con.wait_for_timeout(3500)
            opened = con.evaluate("window.__opened")
            check("the level check opens an audio input",
                  bool(opened) and bool(opened.get("audio")), opened)
            check("a microphone keeps voice processing on",
                  opened["audio"].get("echoCancellation") is True, opened)
            hint = con.inner_text("#audio-device-hint")
            check("the level check reports what it heard",
                  "Sound" in hint or "No sound" in hint, hint)

            # A mixing desk on the line-in must not be processed: noise
            # suppression and auto-gain mangle music, and echo cancellation
            # ducks it every time the room speaks.
            con.click("#audio-linein-toggle")
            con.wait_for_timeout(200)
            check("the line-in switch turns on",
                  con.evaluate("document.getElementById('audio-linein-toggle')"
                               ".classList.contains('is-on')"))
            check("the switch reports its state to assistive tech",
                  con.get_attribute("#audio-linein-toggle", "aria-checked") == "true")
            con.evaluate("window.__opened = null")
            con.click("#audio-test-btn")
            con.wait_for_timeout(2500)
            audio = (con.evaluate("window.__opened") or {}).get("audio", {})
            check("a line-in is opened with echo cancellation off",
                  audio.get("echoCancellation") is False, audio)
            check("a line-in is opened with noise suppression off",
                  audio.get("noiseSuppression") is False, audio)
            check("a line-in is opened with auto-gain off",
                  audio.get("autoGainControl") is False, audio)

            con.reload(wait_until="load")
            con.wait_for_timeout(1500)
            con.click("#audio-setup > summary")
            con.wait_for_timeout(300)
            check("the line-in choice survives a reload",
                  con.evaluate("document.getElementById('audio-linein-toggle')"
                               ".classList.contains('is-on')"))

            # A phone that has dropped off the network is the everyday case:
            # the picker still names it, but opening it fails.
            con.evaluate("""() => {
              window.__calls = [];
              const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
              navigator.mediaDevices.getUserMedia = async (c) => {
                window.__calls.push(JSON.stringify(c));
                if (c && c.audio && c.audio.deviceId) {
                  const e = new Error('gone');
                  e.name = 'OverconstrainedError';
                  throw e;
                }
                return real(c);
              };
              const sel = document.getElementById('audio-device-select');
              const opt = document.createElement('option');
              opt.value = 'ghost-device';
              opt.textContent = 'DroidCam Audio (gone)';
              sel.appendChild(opt);
              sel.value = 'ghost-device';
              sel.dispatchEvent(new Event('change'));
            }""")
            con.wait_for_timeout(300)
            check("the picker keeps the chosen input",
                  con.evaluate("document.getElementById('audio-device-select').value")
                  == "ghost-device")
            con.click("#audio-test-btn")
            con.wait_for_timeout(2500)
            calls = con.evaluate("window.__calls")
            check("a missing input falls back to the default instead of failing",
                  len(calls) >= 2 and "ghost-device" in calls[0]
                  and "deviceId" not in calls[1], calls)

            check("no page errors", not errs, errs)
            browser.close()
    finally:
        server.terminate()

    print()
    if fails:
        print("FAILS:", fails)
        sys.exit(1)
    print("all audio-picker checks passed")


if __name__ == "__main__":
    main()
