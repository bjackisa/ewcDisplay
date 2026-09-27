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
- **`IndexedDB`** (`ewc-display-media`) — the background photo. A camera JPEG is
  far too big for `localStorage`, and an object URL would not cross windows.
  The console bakes the photo down to a sane size before storing it. This is a
  live change: the backdrop goes straight to the screen, never launched.
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
