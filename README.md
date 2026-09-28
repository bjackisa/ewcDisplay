# Exploits Worship Centre — Service Display

A projection system for the church screen with the controls separated from what
the congregation sees.

## The two windows

| Page | Who sees it | What it does |
| --- | --- | --- |
| `console.html` | the operator | Every control, plus a live preview. Nothing reaches the screen until **Launch** is pressed. |
| `display.html` | the church screen | The projection, and nothing else. No controls, no settings, no pointer. |
| `index.html` | — | A small page linking to both. |

Start the server and open the two pages:

```sh
python3 serve.py
```

```
Control room  http://localhost:12000/console.html
Display       http://localhost:12000/display.html
```

Take the display window to the projector or extended screen and press <kbd>F11</kbd>.
The console's **Open display window** button opens it for you.

## How it works

The console owns every control. It previews what it will show in an iframe of
`display.html` — the same page that goes to the church screen — and drives that
screen over a `BroadcastChannel`. Keeping the preview an iframe of the real
display means there is only one renderer to keep working, and it is impossible
to approve something in the preview that then renders differently on launch.

Three kinds of change:

1. **Preview** — editing any field updates the iframe immediately and touches
   nothing else. This is the "review before you launch" half.
2. **Launch** — sends the previewed item to the display. Only launched items
   ever appear on the church screen.
3. **Silent live controls** — while scripture or lyrics are already live, the
   arrow keys step to the next verse or lyric line straight away. Re-launching
   every line mid-song would be unusable, so those shortcuts skip the launch
   step. They do nothing to the screen if that item is not live yet.

The countdown timer runs live on both screens, so it never needs launching to
stay accurate.

## The foreground

In front of the background sits a **foreground**, chosen in the console's
**Foreground** row. Exactly one of four things is on the screen:

| Foreground | What shows |
| --- | --- |
| **Panel** | the glass panel for the chosen mode — countdown, clock, scripture or lyrics |
| **Media** | a photo, video, GIF or audio file, or the display's own camera feed |
| **Text** | a typed quote, with an optional attribution line |
| **No Display** | nothing — just the background image |

Media and text go to the screen **straight away**, like the backdrop photo:
they are not launched, because the operator is looking at the item they chose.
The panel is still launched as before.

Media files are copied into the display's own store, so a photo, GIF or video
keeps playing even if the console window is closed. The camera feed is opened
on the display device itself, so the projector's webcam is the one that shows.

## Editing lyrics

Every song in the list has a pencil button. It loads the song into the form
(the save button reads **Update song**); saving changes it in place, so the
song is never duplicated and an already-live song updates on screen at once.

## Files

| File | Purpose |
| --- | --- |
| `display.html` / `display.js` | The projection page and its renderer |
| `console.html` / `console.js` | The control room |
| `display-common.js` | Shared helpers: state shape, the Bible loader, the song library, the background store |
| `display.css` | Design tokens, base styles, and the stage/panel/lyrics views (used by both pages) |
| `display-extra.css` | Preview scaling and display-only page tweaks |
| `console.base.css` | The form controls, carried over from the original settings drawer |
| `console.css` | The control-room layout: top bar, controls rail, preview |
| `landing.css` | The `index.html` launcher |
| `serve.py` | Local http server |
| `bible-data.js` | The KJV text, generated from `en_kjv.json` by `build_bible_data.py` |

## Where state lives

- **`localStorage`** — text settings and the song library, so both windows
  survive a restart. The console is the only writer of songs.
- **`IndexedDB`** (`ewc-display-media`) — two stores. `backgrounds` holds the
  backdrop photo (a camera JPEG is far too big for `localStorage`, and an
  object URL would not cross windows; the console bakes it down to a sane size
  first). `foreground` holds the foreground media file. Both are live changes
  that go straight to the screen, never launched.
- **`BroadcastChannel`** (`ewc-display-bus`) — messages between the two windows.

Both pages must be served from the same origin for the link between them to
work — they share the song library in `localStorage`, the backdrop photo in
`IndexedDB`, and message each other over a `BroadcastChannel`, none of which
crosses `file://` boundaries. Opened from disk, `display.html` still shows the
clock and countdown, but has no console to drive scripture or lyrics.

## Keyboard shortcuts (console)

| Key | Action |
| --- | --- |
| <kbd>→</kbd> / <kbd>←</kbd> | step to the next/previous verse (scripture mode) |
| <kbd>↓</kbd> / <kbd>↑</kbd> | step to the next/previous lyric line (lyrics mode) |
| <kbd>Space</kbd> | Launch |
| <kbd>Ctrl/⌘</kbd>+<kbd>Enter</kbd> | save a song |
