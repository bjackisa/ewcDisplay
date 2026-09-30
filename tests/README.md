# Tests

Browser-driven checks for the console/display split. They start `serve.py` on
a spare port and drive it with Playwright, so they exercise the real pages
over a real `BroadcastChannel` rather than mocks.

## Setup

```sh
pip install playwright
playwright install chromium
```

## Run

```sh
python3 tests/test_console_display.py
python3 tests/test_persistence.py
python3 tests/test_display_features.py
```

Each prints a `PASS`/`FAIL` line per check and exits non-zero on failure. They
start their own server, so no other process needs to be running, and they can
be run from any directory.

## What is covered

`test_console_display.py`

- the landing page links to both pages
- the display carries no controls at all (no gear, no settings panel, no launch)
- the console finds the display over the bus, and reports "nothing launched yet"
- launch (timer, clock, scripture, lyrics) versus preview-only edits
- the launch note distinguishes idle / not-launched / edited / live
- arrow keys step the live verse and the live lyric line without launching
- a new book/chapter or a song picked from the list still waits for launch
- a step on a preview that has already drifted also waits for launch
- a console reload reconnects, adopts what is already live, and can still launch
- a second display window is driven as well
- the preview stage keeps its 16:9 geometry and fits the viewport

`test_persistence.py`

- the backdrop shows in preview and on the display, survives a display reload,
  and stays cleared once removed
- the song library survives a console reload

`test_display_features.py`

- enlarged lyrics/scripture/clock/timer type, and a long verse/text never
  spilling off the stage (top, bottom, left or right)
- the camera picker: a single camera is auto-selected, several cameras are all
  offered with nothing chosen up front, and the chosen deviceId is what the
  display opens
- per-mode control visibility and every panel mode (media, camera, text,
  No Panel, editing a song's lyrics)
