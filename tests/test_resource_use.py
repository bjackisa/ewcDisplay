#!/usr/bin/env python3
"""Resource checks: the display, the camera and a recording must not creep.

Not a pass/fail gate on absolute numbers — machines differ — but a guard
against the failure modes that actually hurt: a heap that grows without bound
while a recording runs, or a camera track left open after its panel is gone.

Measures JS heap (CDP Performance.getMetrics) at intervals and reports the
growth, and asserts the camera's tracks are stopped once the panel leaves.
"""
import json
import pathlib
import socket
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
fails = []
# A ceiling on the display's own CPU, as a fraction of one core, measured while
# it renders. Software WebGL (headless) is far heavier than a real GPU, so this
# only guards against the render loop pegging a core; the numbers are printed
# for the record rather than tuned to one machine.
CPU_CEILING = 0.95


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail else ""))
    if not ok:
        fails.append(label)


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def heap_session(page):
    """A CDP session that reports the JS heap. One per page, enabled once."""
    cdp = page.context.new_cdp_session(page)
    cdp.send("Performance.enable")
    return cdp


def heap_mb(cdp):
    for m in cdp.send("Performance.getMetrics")["metrics"]:
        if m["name"] == "JSHeapUsedSize":
            return round(m["value"] / (1024 * 1024), 1)
    return 0.0


def sample(cdp, seconds, every=2.0):
    out = []
    end = time.time() + seconds
    while time.time() < end:
        out.append(heap_mb(cdp))
        time.sleep(every)
    return out


def cpu_fraction(cdp, seconds):
    """Main-thread time spent per second of wall clock (1.0 == one core)."""
    def tasks():
        return next(m["value"] for m in cdp.send("Performance.getMetrics")["metrics"]
                    if m["name"] == "TaskDuration")
    before = tasks(); t0 = time.time(); time.sleep(seconds); after = tasks()
    return round((after - before) / (time.time() - t0), 3)


STUB_PICKERS = """
window.showDirectoryPicker = async function () { return await navigator.storage.getDirectory(); };
"""


def main():
    port = free_port()
    base = f"http://localhost:{port}"
    server = subprocess.Popen([sys.executable, str(ROOT / "serve.py"), str(port)], cwd=str(ROOT))
    time.sleep(1.2)
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=[
                "--use-fake-ui-for-media-stream",
                "--use-fake-device-for-media-stream",
                "--auto-select-desktop-capture-source=Entire screen",
            ])
            ctx = browser.new_context(viewport={"width": 1500, "height": 900})

            # ---------- the display page, idle ----------
            disp = ctx.new_page()
            disp_cdp = heap_session(disp)
            disp.goto(f"{base}/display.html", wait_until="load")
            disp.wait_for_timeout(2000)
            idle = sample(disp_cdp, 20)
            print("display heap (MB):", idle)
            check("the display's heap is flat when idle",
                  max(idle) - min(idle) < 8, f"drift {round(max(idle)-min(idle),1)} MB")

            # ---------- the camera: open, then leave the panel ----------
            disp.evaluate("window.__ewcPreview.apply({mode:'camera', cameraDeviceId:null, session:'p', revision:1})")
            disp.wait_for_timeout(1500)
            live_tracks = disp.evaluate(
                "document.getElementById('camera-video').srcObject ? "
                "document.getElementById('camera-video').srcObject.getTracks().length : 0")
            check("the camera opens a live track on its panel", live_tracks == 1, live_tracks)
            # Hold the live track so its state can be read after the panel goes.
            disp.evaluate("window.__camTrack = document.getElementById('camera-video').srcObject.getVideoTracks()[0]")
            cam = sample(disp_cdp, 12)
            print("display heap with camera (MB):", cam)
            check("the camera feed does not creep",
                  max(cam) - min(cam) < 8, f"drift {round(max(cam)-min(cam),1)} MB")

            # Switching the panel away must release the device — the track
            # itself has to end, or the camera light stays on and the machine
            # keeps encoding frames for a panel nobody is showing.
            disp.evaluate("window.__ewcPreview.apply({mode:'timer', session:'p', revision:2})")
            disp.wait_for_timeout(800)
            state = disp.evaluate("window.__camTrack.readyState")
            check("leaving the camera panel stops the device track", state == "ended", state)
            check("the camera element is cleared",
                  disp.evaluate("document.getElementById('camera-video').srcObject === null"))

            # ---------- the render loop must not peg a core ----------
            # The 3D clock is the heaviest panel; the background-only view is
            # the baseline every other mode also carries (particles).
            for mode in ("clock", "timer"):
                disp.evaluate("window.__ewcPreview.apply({mode:'%s', session:'p', revision:%d})"
                              % (mode, 100 + len(mode)))
                disp.wait_for_timeout(1200)
                cpu = cpu_fraction(disp_cdp, 5)
                print(f"display CPU while {mode}: {cpu}")
                check(f"the {mode} panel does not peg the CPU", cpu < CPU_CEILING, cpu)

            # ---------- a recording, on the console ----------
            con = ctx.new_page()
            con_cdp = heap_session(con)
            con.goto(f"{base}/console.html", wait_until="load")
            con.evaluate(STUB_PICKERS)
            con.wait_for_timeout(1500)
            con.click("#record-btn")
            con.wait_for_timeout(2000)
            recording = sample(con_cdp, 20)
            print("console heap while recording (MB):", recording)
            # Chunks are written to disk as they arrive, so the heap must not
            # climb with elapsed time the way buffering the whole file would.
            check("the recording's heap does not climb",
                  recording[-1] - recording[0] < 10,
                  f"{recording[0]} -> {recording[-1]} MB")
            rec_cpu = cpu_fraction(con_cdp, 5)
            print(f"console CPU while recording: {rec_cpu}")
            check("recording does not peg the console's CPU", rec_cpu < CPU_CEILING, rec_cpu)
            con.click("#rec-stop-btn")
            con.wait_for_timeout(2500)
            after = sample(con_cdp, 6)
            print("console heap after stop (MB):", after)
            check("stopping a recording returns the memory",
                  after[-1] <= recording[-1] + 4, f"{recording[-1]} -> {after[-1]} MB")

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
