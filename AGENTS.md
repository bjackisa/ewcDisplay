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
3. **Silent live controls** — arrow keys step verses / lyric lines *without*
   launching, but **only if that mode is already live**. Launching every line
   mid-song is unusable, so these shortcuts deliberately skip the launch step.

The countdown timer is a live change too: it re-renders each second on both
screens so it stays accurate without being re-launched.

## The foreground

In front of the background there is a **foreground**, chosen on the console's
`#foreground-toggle-group`. Exactly one of four states is live:

| State | On screen |
| --- | --- |
| Panel | the mode's own glass panel (timer / clock / scripture / lyrics) |
| Media | `#fg-layer` — a photo, video, GIF, audio file or the display's camera |
| Text | `#text-layer` — a typed quote plus optional attribution |
| No Display | neither — the background shows alone (body gets `.no-foreground`) |

Media and text are **live changes** (like the backdrop): they go straight to
the screen without a launch, because the operator is looking at the item they
chose. The panel itself is launched as before.

Media bytes are never sent over the bus. The console writes the file into the
shared IndexedDB `foreground` store and pushes only a descriptor
(`{kind, mime, name}`); the display reads the record back. A camera feed is
the one exception: it is a live device stream, so the descriptor says
`camera` and the display opens its own `getUserMedia`. The descriptor rides on
every `push`, so it survives a console refresh.

## File map

| File | Notes |
| --- | --- |
| `display.html` / `display.js` | Projection renderer. No controls at all — no gear, no settings panel, and `cursor:none` + `pointer-events:none`. |
| `console.html` / `console.js` | Control room. All state lives here. |
| `display-common.js` | Shared helpers: storage keys, Bible loader, song library, background store. |
| `display.css` | Design tokens, base styles, and stage/panel/lyrics views — used by **both** pages. |
| `display-extra.css` | Display-only tweaks, including preview scaling. |
| `console.base.css` | The form controls carried over from the old settings drawer. |
| `console.css` | Control-room layout: top bar, controls rail, preview. |
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
- **`renderForeground()` must be idempotent.** It runs on every push, and a
  silent verse/lyric step re-pushes the state; remounting the media on each
  one would restart a playing video. It keys on the foreground descriptor and
  only rebuilds when that changes.
- **Media bytes never ride the bus.** The console stores the file in IndexedDB
  and pushes a descriptor; the display reads it back. A camera feed is opened
  by the display itself with `getUserMedia`.

## Testing

Playwright suites live in `tests/`, each starting its own `serve.py` and
driving real pages over a real `BroadcastChannel`:

```sh
pip install playwright && playwright install chromium
python3 tests/test_console_display.py   # the console/display split
python3 tests/test_persistence.py       # backdrop + song persistence
python3 tests/test_display_features.py  # type sizes + the foreground features
```

They cover: page errors, absence of controls on the display, launch vs preview
behaviour, silent arrow-key stepping, revision handling across a console
reload, a second display window, backdrop persistence across reloads, preview
16:9 geometry, the enlarged lyrics/scripture/clock/timer type, and all four
foreground states (media, text, No Display, plus editing a song's lyrics).
