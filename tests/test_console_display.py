#!/usr/bin/env python3
"""End-to-end checks for the console/display split."""
import pathlib
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent

PORT = 12400
BASE = f"http://localhost:{PORT}"
fails = []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail else ""))
    if not ok:
        fails.append(label)


def box(page, sel):
    return page.evaluate(
        "(function(s){var r=document.querySelector(s).getBoundingClientRect();"
        "return {x:r.x,y:r.y,w:r.width,h:r.height};})('%s')" % sel)


def main():
    server = subprocess.Popen([sys.executable, str(ROOT / "serve.py"), str(PORT)], cwd=str(ROOT))
    time.sleep(1.2)
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            ctx = browser.new_context(viewport={"width": 1440, "height": 900})
            errs = []

            def watch(p):
                p.on("pageerror", lambda e: errs.append(str(e)))

            # ---------- landing page ------------------------------------------
            land = ctx.new_page()
            watch(land)
            land.goto(f"{BASE}/index.html", wait_until="load")
            land.wait_for_timeout(1200)
            check("landing links to the console",
                  land.get_attribute("a.primary", "href") == "console.html")
            check("landing links to the display",
                  land.get_attribute("a[href='display.html']", "href") == "display.html")

            # ---------- display alone ------------------------------------------
            display = ctx.new_page()
            watch(display)
            display.goto(f"{BASE}/display.html", wait_until="load")
            display.wait_for_timeout(1200)
            check("display has no settings gear", display.locator("#settings-btn").count() == 0)
            check("display has no settings panel", display.locator("#settings-panel").count() == 0)
            check("display has no launch button", display.locator("#launch-btn").count() == 0)

            # ---------- console -------------------------------------------------
            console = ctx.new_page()
            watch(console)
            console.goto(f"{BASE}/console.html", wait_until="load")
            console.wait_for_timeout(3200)
            check("console sees the display over the bus",
                  console.get_attribute("#link-status", "data-state") == "ok",
                  console.get_attribute("#link-status", "data-state"))
            # The display was opened fresh and has launched nothing, so the
            # console must not claim anything is live.
            check("console knows nothing has launched yet",
                  "Nothing launched yet" in console.inner_text("#preview-note"),
                  console.inner_text("#preview-note"))

            # ---------- timer ---------------------------------------------------
            console.click('button[data-mode="timer"]')
            console.fill("#event-name-input", "Sunday Service")
            console.click("#launch-btn")
            console.wait_for_timeout(600)
            check("timer reaches the screen",
                  display.evaluate("getComputedStyle(document.getElementById('timer-view')).display") == "flex")
            check("launch note reports live",
                  "Live on the church screen" in console.inner_text("#preview-note"),
                  console.inner_text("#preview-note"))

            # Editing a *live* mode's own fields is the "edited" case. Checked
            # here, while the timer is the live thing.
            console.fill("#event-name-input", "Evening Service")
            console.wait_for_timeout(300)
            check("editing a live mode flips the note to 'edited'",
                  "Preview edited" in console.inner_text("#preview-note"),
                  console.inner_text("#preview-note"))
            check("the edit does not leak to the screen before launch",
                  "Evening Service" not in display.evaluate("document.body.innerText"))
            console.click("#launch-btn")
            console.wait_for_timeout(600)
            check("the edited title lands on launch",
                  "Evening Service" in display.evaluate("document.body.innerText"))
            check("re-reading the note after relaunch reads live again",
                  "Live on the church screen" in console.inner_text("#preview-note"),
                  console.inner_text("#preview-note"))

            # ---------- clock ---------------------------------------------------
            console.click('button[data-mode="clock"]')
            console.wait_for_timeout(300)
            check("switching mode flips the note to 'not launched'",
                  "Not launched" in console.inner_text("#preview-note"),
                  console.inner_text("#preview-note"))
            check("clock not on screen until launched",
                  display.evaluate("getComputedStyle(document.getElementById('clock-view')).display") == "none")
            console.click("#launch-btn")
            console.wait_for_timeout(600)
            check("clock reaches the screen after launch",
                  display.evaluate("getComputedStyle(document.getElementById('clock-view')).display") != "none")

            # ---------- scripture ------------------------------------------------
            console.wait_for_timeout(4500)  # bible-data.js
            check("console loaded the Bible",
                  console.evaluate("document.getElementById('scripture-book-select').disabled === false"))
            console.click('button[data-mode="scripture"]')
            console.select_option("#scripture-book-select", "42")  # John
            console.fill("#scripture-chapter-input", "3")
            console.fill("#scripture-verse-input", "16")
            console.click("#scripture-go-btn")
            console.wait_for_timeout(700)
            pv = lambda sel: console.evaluate(
                "document.getElementById('preview').contentWindow.document.getElementById('%s').textContent" % sel)
            lv = lambda sel: display.evaluate(
                "document.getElementById('%s').textContent" % sel)
            check("preview shows the reviewed verse", "God so loved" in pv("scripture-text"), pv("scripture-text")[:50])
            check("screen unchanged before launch", "God so loved" not in lv("scripture-text"))
            console.click("#launch-btn")
            console.wait_for_timeout(700)
            check("launch puts the verse on the screen", "God so loved" in lv("scripture-text"), lv("scripture-text")[:50])
            check("reference reaches the screen", "John 3:16" in lv("scripture-reference"), lv("scripture-reference"))

            # Stepping a verse is live once scripture is already on the screen:
            # the congregation follows along without a relaunch.
            console.evaluate("document.activeElement && document.activeElement.blur()")
            console.keyboard.press("ArrowRight")
            console.wait_for_timeout(600)
            check("ArrowRight steps the live verse on the screen",
                  "John 3:17" in lv("scripture-reference"), lv("scripture-reference"))
            check("ArrowRight advanced the preview too",
                  "John 3:17" in pv("scripture-reference"), pv("scripture-reference"))
            check("the step did not need a launch",
                  "Live on the church screen" in console.inner_text("#preview-note"),
                  console.inner_text("#preview-note"))
            console.keyboard.press("ArrowLeft")
            console.wait_for_timeout(600)
            check("ArrowLeft steps the live verse back on the screen",
                  "John 3:16" in lv("scripture-reference"), lv("scripture-reference"))
            check("ArrowLeft moves the preview back",
                  "John 3:16" in pv("scripture-reference"), pv("scripture-reference"))

            # Choosing a *new* reference is not a step: it stays launch-gated.
            console.select_option("#scripture-book-select", "43")  # Acts
            console.fill("#scripture-chapter-input", "2")
            console.fill("#scripture-verse-input", "1")
            console.click("#scripture-go-btn")
            console.wait_for_timeout(600)
            check("a new reference waits for launch",
                  "John 3:16" in lv("scripture-reference"), lv("scripture-reference"))
            check("the new reference is previewed",
                  "Acts 2:1" in pv("scripture-reference"), pv("scripture-reference"))
            console.click("#launch-btn")
            console.wait_for_timeout(700)
            check("launching puts the new reference on the screen",
                  "Acts 2:1" in lv("scripture-reference"), lv("scripture-reference"))

            # Stepping a preview that has already drifted must not blast the
            # unlaunched reference to the screen — it still waits for Launch.
            console.select_option("#scripture-book-select", "44")  # Romans
            console.fill("#scripture-chapter-input", "1")
            console.fill("#scripture-verse-input", "1")
            console.click("#scripture-go-btn")
            console.wait_for_timeout(500)
            console.evaluate("document.activeElement && document.activeElement.blur()")
            console.keyboard.press("ArrowRight")
            console.wait_for_timeout(600)
            check("a step on a drifted preview stays off the screen",
                  "Acts 2:1" in lv("scripture-reference"), lv("scripture-reference"))
            check("the drifted step still advanced the preview",
                  "Romans 1:2" in pv("scripture-reference"), pv("scripture-reference"))

            # ---------- lyrics ----------------------------------------------------
            console.click('button[data-mode="lyrics"]')
            console.fill("#song-title-input", "Amazing Grace")
            console.fill("#song-lyrics-input", "Amazing grace how sweet the sound\nThat saved a wretch like me\nI once was lost but now am found\nWas blind but now I see")
            console.click("#song-save-btn")
            console.wait_for_timeout(800)
            console.click("#launch-btn")
            console.wait_for_timeout(900)
            check("lyrics reach the screen", display.evaluate("document.getElementById('lyrics-title').textContent") == "Amazing Grace")
            idx = lambda: display.evaluate(
                "Array.from(document.querySelectorAll('#lyrics-track .lyric-line')).findIndex(function(n){return n.classList.contains('is-active')})")
            check("lyrics render four lines",
                  display.evaluate("document.querySelectorAll('#lyrics-track .lyric-line').length") == 4)
            check("first lyric line is active", idx() == 0, str(idx()))
            # Stepping a lyric line is live once lyrics are already on screen.
            console.keyboard.press("ArrowDown")
            console.wait_for_timeout(600)
            check("ArrowDown steps the live lyric line on the screen", idx() == 1, str(idx()))
            console.keyboard.press("ArrowUp")
            console.wait_for_timeout(600)
            check("ArrowUp steps the live lyric line back", idx() == 0, str(idx()))

            # Saving a song is the edit exemption: it goes live at once.
            console.fill("#song-title-input", "Great Is Thy Faithfulness")
            console.fill("#song-lyrics-input", "Great is thy faithfulness\nMorning by morning new mercies I see")
            console.click("#song-save-btn")
            console.wait_for_timeout(800)
            check("saving a song puts it on the screen",
                  display.evaluate("document.getElementById('lyrics-title').textContent") == "Great Is Thy Faithfulness")

            # Picking a *different* song from the list is not a step, so it
            # waits for launch like any other new content.
            console.evaluate(
                "Array.from(document.querySelectorAll('#song-list .song-item'))"
                ".find(function(r){return r.textContent.indexOf('Amazing Grace')!==-1})"
                ".querySelector('.song-load').click()")
            console.wait_for_timeout(600)
            check("picking a song from the list waits for launch",
                  display.evaluate("document.getElementById('lyrics-title').textContent") == "Great Is Thy Faithfulness")
            check("the picked song is previewed",
                  console.evaluate("document.getElementById('preview').contentWindow.document"
                                   ".getElementById('lyrics-title').textContent") == "Amazing Grace")
            console.click("#launch-btn")
            console.wait_for_timeout(700)
            check("launching puts the picked song on the screen",
                  display.evaluate("document.getElementById('lyrics-title').textContent") == "Amazing Grace")

            # ---------- console reload keeps driving -------------------------------
            console.reload(wait_until="load")
            console.wait_for_timeout(4200)
            check("console reconnects after reload",
                  console.get_attribute("#link-status", "data-state") == "ok")
            check("console adopts what is already live",
                  "Live on the church screen" in console.inner_text("#preview-note"),
                  console.inner_text("#preview-note"))
            # A launch straight after the reload must not be swallowed as stale.
            console.click('button[data-mode="clock"]')
            console.wait_for_timeout(300)
            console.click("#launch-btn")
            console.wait_for_timeout(700)
            check("a launch right after a console reload still lands",
                  display.evaluate("getComputedStyle(document.getElementById('clock-view')).display") != "none")

            # ---------- second display window --------------------------------------
            display2 = ctx.new_page()
            watch(display2)
            display2.goto(f"{BASE}/display.html", wait_until="load")
            display2.wait_for_timeout(4200)
            check("a second display window also connects",
                  console.get_attribute("#link-status", "data-state") == "ok")
            console.click('button[data-mode="timer"]')
            console.wait_for_timeout(300)
            console.click("#launch-btn")
            console.wait_for_timeout(800)
            check("both screens get the launch",
                  display.evaluate("getComputedStyle(document.getElementById('timer-view')).display") == "flex"
                  and display2.evaluate("getComputedStyle(document.getElementById('timer-view')).display") == "flex")

            # ---------- layout ------------------------------------------------------
            prev = box(console, ".preview-frame")
            rail = box(console, "#settings-panel")
            stage = console.evaluate(
                "(function(){var r=document.getElementById('preview').contentDocument"
                ".getElementById('stage').getBoundingClientRect();return {w:r.width,h:r.height};})()")
            check("preview stage keeps 16:9", abs(stage["w"] / stage["h"] - 16 / 9) < 0.02,
                  f"{stage['w']/stage['h']:.3f}")
            check("preview fits the viewport", prev["x"] + prev["w"] <= 1441 and prev["y"] + prev["h"] <= 901)
            check("rail sits left of the preview", prev["x"] >= rail["x"] + rail["w"] - 1)

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
