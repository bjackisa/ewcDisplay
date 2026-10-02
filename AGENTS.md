# AGENTS.md

Repository knowledge for future sessions. Keep this file current.

## What this is

`ewcDisplay` is the Exploits Worship Centre service display: a two-page
projection system. `console.html` is the operator's control room and
`display.html` is the church screen. They run from the same origin and talk
over a `BroadcastChannel` named `ewc-display-bus`. `index.html` is a small
launcher linking to both.

## Running it

```sh
python3 serve.py          # http://localhost:12000
```

Then open `/console.html` (operator) and `/display.html` (projector).

## The three-change model

This is the core design; understand it before touching either page.

1. **Preview** — any field edit re-renders the console's iframe of
   `display.html` and nothing else. The iframe is the real display page, so
   there is exactly one renderer and the preview cannot disagree with launch.
2. **Launch** (`#launch-btn` / <kbd>Space</kbd>) — posts a `push` message with
   the full state to the display. Only pushed state appears on the screen.
3. **Two exemptions** — changes that follow along on an *already-live* panel,
   because re-launching each time would be unusable:
   - **stepping** a verse (← / →) or a lyric line (↑ / ↓) while that panel is
     on the screen. The verse/line being moved off is already up there, so the
     screen moves with the preview; the launch note stays "live".
   - **saving an edit** to a song that is already live (mid-song corrections).

   Both exemptions require the preview to be *exactly* what is live
   (`previewIsLive()` compares fingerprints). Choosing a **new** item — a
   different book/chapter, a different song from the list — is not a step, so
   it stays launch-gated. A step on a preview that has already drifted (a new
   reference picked but not launched) also waits for Launch.

   Everything else — every mode, every new item, and "No Panel" — waits for
   Launch.

The countdown timer is a live change too: it re-renders each second on both
screens so it stays accurate without being re-launched. The background photo is
live as well (it is scenery, not content).

## The panel

The console has a **mode picker** (`#mode-toggle-group`) naming what goes on
the glass panel: timer, clock, scripture, lyrics, text, media, camera, webpage.
Only the chosen mode's own fields are shown: `#mode-fields` holds one
`#<mode>-fields` block per mode and `setMode()` hides all but the chosen one, so
the operator sees one mode's controls rather than every control at once.

The picker is **not in the rail**. It is a full-width `.console__modes` bar
along the bottom edge of the window, a sibling of the rail/preview row. Seven
labels cannot share one line inside the narrow rail, and pinning them to the
top of the rail (the old `position:sticky`) ate height the controls needed.
As a bottom bar they sit on one line, always visible, whatever the rail is
scrolled to.

| Mode | On screen |
| --- | --- |
| Timer / Clock / Scripture / Lyrics | the mode's own glass panel |
| Text | `#text-view` — a typed quote, dressed like scripture |
| Media | `#media-view` — a photo, video, GIF, audio file, or a YouTube embed |
| Camera | `#camera-view` — the display device's own live feed |
| Webpage | `#webpage-view` — an external page framed by the panel (`#webpage-frame`) |
| No Panel (`#no-panel-toggle`) | the glass is removed; background alone (body gets `.no-panel`) |

Media bytes are never sent over the bus. The console writes the file into the
shared IndexedDB `foreground` store and pushes only a descriptor
(`{kind, mime, name}`); the display reads the record back. The camera is a live
device stream on the display side, so only the mode is announced. The media
descriptor rides on every `push`, so it survives a console refresh.

**Camera choice.** A machine can have several cameras, so the console lists
them (`enumerateDevices`, filtered to `videoinput`) in `#camera-device-select`
and pushes only the chosen `cameraDeviceId`. Exactly one camera is adopted
silently; with several, none is chosen until the operator picks one (a blank
option means "let the display decide"). Real hardware only reveals device names
once permission is granted, so opening Camera mode asks once
(`primeCameraNames`) then re-lists — a single prompt, not one per launch. The
display opens `deviceId:{exact}` and falls back to the default if that camera
is gone (`OverconstrainedError`). Changing the camera is live while the feed is
on screen; the display reopens only when the device changes, never on a silent
re-push. `cameraDeviceId` also rides on every `push`, so a display reload
reopens the right camera.

Text and media are *modes*, not a separate foreground layer: they render inside
the same glass panel, so nothing competes with the background. The panel only
disappears for "No Panel".

**AI (Gemini).** One Google Gemini key, entered in the console's **AI settings**
(`#ai-key-input`) and kept in `localStorage` under `ewc-display-gemini-key-v1`,
powers three things, all in the console:
- **Verse search** (`#scripture-ai-input` / `#scripture-ai-btn`): the operator
  types anything they remember and Gemini resolves a book/chapter/verse via a
  `responseSchema`-constrained call. The resolved reference is then loaded from
  the *local* KJV text (`findBookIndex` + `applyFoundVerse`), so the screen gets
  the same KJV string every other verse uses, never text the model retyped. It
  lands in the preview and stays launch-gated like any new reference.
- **Text polish** (`#text-polish-btn`, the ✦ by the textarea): rewrites the
  typed text. Em/en dashes and `--` are stripped afterwards in `stripEmDashes`,
  because the prompt alone is not a guarantee.
- **Image generation** (`#bg-ai-btn`, `#media-ai-btn`): generates an image and
  feeds it through the *same* store path as an uploaded file (`bakeBackground` +
  `putBackgroundImage`, or `putForegroundMedia`), so the display cannot tell the
  difference.

All three go through `aiGenerate()`, which retries 500/503/504 and network
failures (the free endpoint throws "high demand" 503s often) and turns a 429
into a plain "out of quota" message. AI is never required: with no key every
button just says so.

**YouTube.** Pasting a link (`#media-youtube-btn`, parsed by `parseYouTubeId`)
sets a `{kind:'youtube', id}` descriptor. No bytes are stored or sent — the
display builds a `youtube-nocookie.com/embed/<id>` iframe in `mountYouTube`.
The media-key comparison in `applyMode()` still stops a silent re-push from
reloading it.

**Webpage.** `#webpage-url-input` / `#webpage-go-btn` normalizes to http(s) and
sends only the URL; the display frames it in `#webpage-frame`. A site that sends
`X-Frame-Options`/`frame-ancestors` cannot be framed and stays blank — there is
no reliable way to detect that, so the console hint says so instead. The iframe
is only re-pointed when the URL changes, so a verse step does not reload it.

## File map

| File | Notes |
| --- | --- |
| `display.html` / `display.js` | Projection renderer. No controls at all — no gear, no settings panel, and `cursor:none` + `pointer-events:none`. |
| `console.html` / `console.js` | Control room. All state lives here. |
| `display-common.js` | Shared helpers: storage keys, Bible loader, song library, background store. |
| `display.css` | Design tokens, base styles, and stage/panel/lyrics views — used by **both** pages. |
| `display-extra.css` | Display-only tweaks, including preview scaling. |
| `console.base.css` | The form controls carried over from the old settings drawer. |
| `console.css` | Control-room layout: top bar, controls rail, preview, the bottom panel picker. |
| `landing.css` | `index.html` launcher. |
| `serve.py` | Local http server. |
| `bible-data.js` | KJV text, generated from `en_kjv.json` by `build_bible_data.py`. Do not hand-edit. |

`index.bak.html` is the pre-split single-page version, kept for reference.

## State and storage

- `EWC.SETTINGS_KEY` (`ewc-display-settings-v1`) — `localStorage`, text
  settings. The **console is the only writer**; the display only reads.
- `EWC.SONGS_KEY` (`ewc-display-songs-v1`) — `localStorage`, song library.
- `CHOICE_KEY` (`ewc-display-bg-choice-v1`) — `localStorage`, whether a
  backdrop photo is set.
- `IndexedDB` database `ewc-display-media` — two object stores. `backgrounds`
  holds the backdrop photo bytes (the console downscales before storing);
  `foreground` holds the foreground media file plus its name/mime/kind. A
  camera JPEG is far too big for `localStorage` and a blob URL does not cross
  windows, so the bytes go here and the bus only carries the nudge.

## Gotchas learned the hard way

- **`#stage` is a flex item of `<body>`.** In preview mode it must keep
  `flex:none`, or the default `flex-shrink` squashes the 1600×900 layout box
  and the 16:9 frame breaks before the scale transform even runs.
- **Preview transform leaves the layout box at 1600×900**, so `body.is-preview`
  needs `overflow:hidden` or the iframe grows a phantom scrollbar.
- **Revisions are per console session.** A console refresh restarts its
  revision counter at 0; the display compares `message.session` first and
  resets `lastRevision` when the session changes. Without this, every launch
  after a console reload looks stale and is silently dropped.
- **A display must report `mode: null` in its `hello` until a console has
  actually pushed something.** Otherwise the console adopts the display's
  default view as "live" and the launch note lies.
- **`page.fill()` fires `input`, not blur.** So "edited" launch-note states are
  testable directly.
- Test the two pages as **separate browser pages in one context** — they need
  a shared origin for `BroadcastChannel` to work.
- **The lyric track rebuilds on title *and* lines, not the title alone.** An
  edited song keeps its title but rewrites its lines, so keying the rebuild on
  the title left the old words on screen after an edit.
- **`applyMode()` must be idempotent.** It runs on every push, and a step
  re-pushes the state; remounting the media on each one would restart a
  playing video. It keys on the media descriptor and only rebuilds when that
  changes — and the camera likewise keys on `cameraDeviceId`, so only a real
  device switch reopens the feed.
- **A step goes live only when the preview *is* the live view.** The step
  functions snapshot `previewIsLive()` *before* mutating, then `pushLive` after.
  Checking after the mutation, or keying only on `live.mode === mode`, would
  blast a new-but-unlaunched book/song to the screen the moment an arrow was
  pressed.
- **The scripture/text panel must cap its own height (`max-height:88%`) or the
  fitter has nothing to fit.** A centred flex panel with no height limit simply
  grows to the content and pushes its top and bottom off the 16:9 stage; the
  fitter reads `container.clientHeight`, so it needs a bounded box to measure
  against. `fitToPanel()` measures the panel's *content box* (minus padding and
  any sibling reference/title line) and binary-searches the largest font that
  fits, with `overflow:hidden` as the final backstop.
- **The fitter must count margins, not just `offsetHeight`.** The panel's
  children are `<p>` elements and there is no `p{margin:0}` reset, so each keeps
  the browser's default `1em` top/bottom margin. `offsetHeight` excludes
  margins, so summing it under-measured the stack by ~130px on a long verse: the
  fitter believed the verse fit while the reference below it had been pushed
  past the panel's `overflow:hidden` edge and vanished. `outerHeight()` adds the
  margins back; `.scripture-reference` / `.text-title` also carry `flex:none` so
  they can never be the flex item that gets squeezed off instead.
- **`.text-body`/`.scripture-text` need `min-width:0` + `overflow-wrap:anywhere`.**
  As flex items their min-content width is the longest word, so without both a
  stray long token widens the panel past the stage instead of wrapping.
- **`applyLyricFocus()` must decide `is-tight` before it measures.** The tight
  class shrinks every row, so measuring while it is applied lets the decision
  feed back on itself: the shrunk row looks like it fits, the class comes off,
  the row grows, and the track lands on a stale offset mid-oscillation. Remove
  the class, measure, then re-read `offsetTop`/`offsetHeight` for the offset.
- **Media bytes never ride the bus.** The console stores the file in IndexedDB
  and pushes a descriptor; the display reads it back. A camera feed is opened
  by the display itself with `getUserMedia`.
- **Media mode is selectable with nothing chosen.** It shows the empty panel
  rather than silently falling back to the timer, which would hide the media
  picker the operator just asked for.
- **The console preview is capped, the rail is not.** `.console__preview` is
  `flex:0 1 auto` with a definite width so `.preview-frame` can size itself to
  16:9 and stay at a normal video size; `#settings-panel` is `flex:1 1 auto`
  and takes the rest. Making the preview `flex:1` again hands it the whole row
  and squeezes the controls back into a scrollbox.
- **`.field-row` must wrap and its inputs must be shrinkable.** A
  `datetime-local` input has an intrinsic width it will not go below, so
  without `flex-wrap` plus `min-width:0` on the fields it spills out of the
  rail on a narrower window.
- **The bottom picker scales its labels instead of clipping them.** Seven
  names share one line in `.console__modes`; `white-space:nowrap` alone
  truncates them at ~900px, so the font size is clamped to the viewport width.

## Testing

Playwright suites live in `tests/`, each starting its own `serve.py` and
driving real pages over a real `BroadcastChannel`:

```sh
pip install playwright && playwright install chromium
python3 tests/test_console_display.py   # the console/display split
python3 tests/test_persistence.py       # backdrop + song persistence
python3 tests/test_display_features.py  # type sizes + the panel modes
python3 tests/test_ai_and_embeds.py     # AI, YouTube and the webpage panel
```

They cover: page errors, absence of controls on the display, launch vs preview
behaviour, live stepping (and the launch-gated new-book/new-song and
drifted-preview cases), revision handling across a console reload, a second
display window, backdrop persistence across reloads, preview 16:9 geometry,
the enlarged lyrics/scripture/clock/timer type, scripture/text never spilling
off the stage, per-mode control visibility, the camera picker (single camera
auto-selected, several cameras offered, the chosen id sent to the display), and
every panel mode (media, camera, text, No Panel, plus editing a song's lyrics).

`test_ai_and_embeds.py` stubs the Gemini endpoint with `page.route()` (so the
real request/response handling runs with no key or network) and checks the
longest-verse reference visibility, AI verse search (previewed, launch-gated),
the text polish (and its no-em-dash rule), AI images for the background and the
media panel, YouTube embedding, and the webpage panel.
