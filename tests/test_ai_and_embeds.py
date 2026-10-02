#!/usr/bin/env python3
"""End-to-end checks for the AI features and the new panel modes.

Covers:
  * the scripture reference staying visible for the longest verses (the fix
    for the reference disappearing off a long verse);
  * AI verse search — a natural-language query resolves to a book/chapter/verse
    and is previewed ready to launch, still launch-gated;
  * the AI text polish button, including the no-em-dash rule;
  * AI image generation for the background and for the media panel;
  * YouTube embedding in the media panel;
  * the Webpage panel mode.

The Gemini endpoint is stubbed with page.route() so the real request/response
handling in console.js runs, but no key or network is needed. Only the AI
service is stubbed — everything else (the Bible text, the bus, IndexedDB,
the panel rendering) is the real code.
"""
import base64
import json
import pathlib
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent

PORT = 12420
BASE = f"http://localhost:{PORT}"
GEMINI = "https://generativelanguage.googleapis.com/**"
fails = []

# A valid 1x1 PNG, used as the "generated" image the stubbed model returns.
PNG_1X1 = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk"
           "YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail else ""))
    if not ok:
        fails.append(label)


def install_gemini_stub(page):
    """Stubs the Gemini endpoint. Returns the prompt returned for verse search
    so the test can assert on it if needed."""
    def handler(route):
        body = route.request.post_data or ""
        if "responseSchema" in body:            # verse search
            text = json.dumps({"book": "John", "chapter": 3, "verse": 16,
                               "confidence": "high", "note": "A well-known verse."})
        elif "responseModalities" in body:      # image generation
            route.fulfill(
                headers={"Access-Control-Allow-Origin": "*"},
                json={"candidates": [{"content": {"parts": [
                    {"inlineData": {"mimeType": "image/png", "data": PNG_1X1}}
                ]}}]},
            )
            return
        elif "Polish" in body:                  # text polish (returns an em dash on purpose)
            text = "For God so loved the world, he gave his only Son."
        else:
            text = "ok"
        route.fulfill(
            headers={"Access-Control-Allow-Origin": "*"},
            json={"candidates": [{"content": {"parts": [{"text": text}]}}]},
        )

    page.route(GEMINI, handler)


def main():
    server = subprocess.Popen([sys.executable, str(ROOT / "serve.py"), str(PORT)], cwd=str(ROOT))
    time.sleep(1.2)
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            ctx = browser.new_context(viewport={"width": 1600, "height": 900})
            errs = []

            def watch(p):
                p.on("pageerror", lambda e: errs.append(str(e)))

            disp = ctx.new_page(); watch(disp)
            install_gemini_stub(disp)
            disp.goto(f"{BASE}/display.html", wait_until="load")
            disp.wait_for_timeout(1500)

            con = ctx.new_page(); watch(con)
            install_gemini_stub(con)
            con.goto(f"{BASE}/console.html", wait_until="load")
            con.wait_for_timeout(8000)

            # A key so the AI calls proceed (the endpoint itself is stubbed).
            con.evaluate("localStorage.setItem('ewc-display-gemini-key-v1','test-key')")

            def css(sel):
                return sel if sel[:1] in ("#", ".", "[") else "#" + sel

            def pv(sel):
                return con.evaluate(
                    "(function(){var d=document.getElementById('preview').contentDocument;"
                    "var e=d.querySelector('%s');return e?e.textContent:'';})()" % css(sel))

            def lv(sel):
                return disp.evaluate(
                    "(function(){var e=document.querySelector('%s');return e?e.textContent:'';})()" % css(sel))

            def book_index(name):
                return con.evaluate(
                    "(function(){var o=document.querySelector('#scripture-book-select');"
                    "for(var i=0;i<o.options.length;i++){if(o.options[i].textContent==='%s')return o.options[i].value;}"
                    "return '';})()" % name)

            # ---------- the reference stays visible on the longest verse ------
            # Esther 8:9 is the longest verse in the King James Version.
            esther = book_index("Esther")
            check("the Bible data has Esther", esther != "", esther)
            con.click('button[data-mode="scripture"]')
            con.select_option("#scripture-book-select", esther)
            con.fill("#scripture-chapter-input", "8")
            con.fill("#scripture-verse-input", "9")
            con.click("#scripture-go-btn")
            con.click("#launch-btn")
            disp.wait_for_timeout(1200)
            geo = disp.evaluate("""() => {
              var v = document.getElementById('scripture-view');
              var t = document.getElementById('scripture-text');
              var r = document.getElementById('scripture-reference');
              var vb = v.getBoundingClientRect(), rb = r.getBoundingClientRect(), tb = t.getBoundingClientRect();
              return {
                refInside: rb.bottom <= vb.bottom + 0.5 && rb.top >= vb.top - 0.5,
                noOverlap: tb.bottom <= rb.top + 0.5,
                refText: r.textContent, refOpacity: getComputedStyle(r).opacity,
                refH: rb.height, viewH: vb.height
              };
            }""")
            check("the reference is visible on the longest verse",
                  geo["refInside"] and geo["refText"] == "Esther 8:9" and geo["refOpacity"] == "1",
                  json.dumps(geo))
            check("the reference does not overlap the verse text", geo["noOverlap"], json.dumps(geo))

            # ---------- AI verse search ---------------------------------------
            con.click('button[data-mode="scripture"]')
            con.fill("#scripture-ai-input", "the verse about God so loved the world")
            con.click("#scripture-ai-btn")
            con.wait_for_timeout(1200)
            check("AI verse search previews the found reference",
                  "John 3:16" in pv("scripture-reference"), pv("scripture-reference"))
            check("AI verse search previews the real KJV text",
                  "God so loved" in pv("scripture-text"), pv("scripture-text")[:40])
            check("the found verse is still launch-gated",
                  "Esther 8:9" in lv("scripture-reference"), lv("scripture-reference"))
            con.click("#launch-btn")
            disp.wait_for_timeout(1000)
            check("launching shows the found verse",
                  "John 3:16" in lv("scripture-reference"), lv("scripture-reference"))

            # ---------- text polish (no em dashes) ----------------------------
            con.click('button[data-mode="text"]')
            con.fill("#text-body-input", "for god so loved the world he gave his only son")
            con.click("#text-polish-btn")
            con.wait_for_timeout(1200)
            polished = con.input_value("#text-body-input")
            check("the polish button rewrites the text", "God so loved" in polished, polished)
            check("the polished text has no em dash",
                  "\u2014" not in polished and "\u2013" not in polished and "--" not in polished, polished)

            # ---------- AI image for the media panel --------------------------
            con.click('button[data-mode="media"]')
            con.fill("#media-ai-prompt", "a calm sunrise over the sea")
            con.click("#media-ai-btn")
            con.wait_for_timeout(1500)
            check("AI image becomes the media preview",
                  "Generated" in con.evaluate("document.getElementById('media-status').textContent"),
                  con.evaluate("document.getElementById('media-status').textContent"))
            con.click("#launch-btn")
            disp.wait_for_timeout(1200)
            check("the generated image mounts in the media panel",
                  disp.evaluate("!!document.querySelector('#media-mount img')"))
            check("the media panel is shown for the generated image",
                  disp.evaluate("getComputedStyle(document.getElementById('media-view')).display") != "none")

            # ---------- AI image for the background ---------------------------
            con.fill("#bg-ai-prompt", "a warm abstract sunrise")
            con.click("#bg-ai-btn")
            con.wait_for_timeout(1500)
            check("AI background reports success",
                  "generated" in con.evaluate("document.getElementById('bg-ai-status').textContent").lower(),
                  con.evaluate("document.getElementById('bg-ai-status').textContent"))
            disp.wait_for_timeout(600)
            check("the generated background reaches the display",
                  "blob:" in disp.evaluate("document.getElementById('bg-layer').style.backgroundImage"),
                  disp.evaluate("document.getElementById('bg-layer').style.backgroundImage"))

            # ---------- YouTube embed -----------------------------------------
            con.click('button[data-mode="media"]')
            con.fill("#media-youtube-input", "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
            con.click("#media-youtube-btn")
            con.wait_for_timeout(500)
            check("a YouTube URL becomes the media preview",
                  "YouTube" in con.evaluate("document.getElementById('media-status').textContent"),
                  con.evaluate("document.getElementById('media-status').textContent"))
            check("the preview embeds the YouTube video",
                  con.evaluate("(function(){var d=document.getElementById('preview').contentDocument;"
                               "var f=d.querySelector('#media-mount iframe.fg-youtube');"
                               "return f?f.src:'';})()").find("dQw4w9WgXcQ") != -1)
            con.click("#launch-btn")
            disp.wait_for_timeout(1000)
            src = disp.evaluate("(function(){var f=document.querySelector('#media-mount iframe.fg-youtube');"
                                "return f?f.src:'';})()")
            check("the YouTube video embeds on the screen", "dQw4w9WgXcQ" in src, src)
            check("the YouTube embed uses the nocookie host", "youtube-nocookie.com" in src, src)

            # A bad link is rejected rather than embedded.
            con.fill("#media-youtube-input", "not a youtube link")
            con.click("#media-youtube-btn")
            con.wait_for_timeout(300)
            check("a non-YouTube link is refused",
                  "does not look like" in con.evaluate("document.getElementById('media-status').textContent"),
                  con.evaluate("document.getElementById('media-status').textContent"))

            # ---------- Webpage panel -----------------------------------------
            con.click('button[data-mode="webpage"]')
            con.fill("#webpage-url-input", "example.com")
            con.click("#webpage-go-btn")
            con.wait_for_timeout(600)
            check("a bare host is normalized to https",
                  con.input_value("#webpage-url-input") == "https://example.com/",
                  con.input_value("#webpage-url-input"))
            check("the preview frames the webpage",
                  con.evaluate("(function(){var d=document.getElementById('preview').contentDocument;"
                               "var f=d.querySelector('#webpage-frame');return f?f.getAttribute('src'):'';})()")
                  == "https://example.com/")
            check("the webpage is launch-gated",
                  disp.evaluate("document.getElementById('webpage-view').style.display") == "none")
            con.click("#launch-btn")
            disp.wait_for_timeout(1000)
            check("the webpage is framed on the screen",
                  disp.evaluate("document.getElementById('webpage-frame').getAttribute('src')") == "https://example.com/",
                  disp.evaluate("document.getElementById('webpage-frame').getAttribute('src')"))
            check("the webpage panel is shown",
                  disp.evaluate("getComputedStyle(document.getElementById('webpage-view')).display") != "none")

            # ---------- AI without a key degrades cleanly ---------------------
            con.evaluate("localStorage.removeItem('ewc-display-gemini-key-v1')")
            con.click('button[data-mode="scripture"]')
            con.fill("#scripture-ai-input", "anything")
            con.click("#scripture-ai-btn")
            con.wait_for_timeout(500)
            check("verse search without a key explains what to do",
                  "API key" in con.evaluate("document.getElementById('scripture-ai-status').textContent"),
                  con.evaluate("document.getElementById('scripture-ai-status').textContent"))

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
