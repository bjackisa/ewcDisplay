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

1. **Preview** ŌĆö any field edit re-renders the console's iframe of
   `display.html` and nothing else. The iframe is the real display page, so
   there is exactly one renderer and the preview cannot disagree with launch.
2. **Launch** (`#launch-btn` / <kbd>Space</kbd>) ŌĆö posts a `push` message with
   the full state to the display. Only pushed state appears on the screen.
3. **Two exemptions** ŌĆö changes that follow along on an *already-live* panel,
   because re-launching each time would be unusable:
   - **stepping** a verse (ŌåÉ / ŌåÆ) or a lyric line (Ōåæ / Ōåō) while that panel is
     on the screen. The verse/line being moved off is already up there, so the
     screen moves with the preview; the launch note stays "live".
   - **saving an edit** to a song that is already live (mid-song corrections).

   Both exemptions require the preview to be *exactly* what is live
   (`previewIsLive()` compares fingerprints). Choosing a **new** item ŌĆö a
   different book/chapter, a different song from the list ŌĆö is not a step, so
   it stays launch-gated. A step on a preview that has already drifted (a new
   reference picked but not launched) also waits for Launch.

   Everything else ŌĆö every mode, every new item, and "No Panel" ŌĆö waits for
   Launch.

The preview toolbar carries one word of state and nothing more: `Live` when the
preview is exactly what is on the screen, `Not Launched` when it is not. There
is no "edited" wording and no explanation of what stepping does ŌĆö the controls
say it. The same rule holds across the whole console: status text is written by
JS into the element that exists for it, and a static line of prose explaining
the UI is a bug. The display's own badge reads `Exploits Worship Centre` with
`Live` beneath it.

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
| Text | `#text-view` ŌĆö a typed quote, dressed like scripture |
| Media | `#media-view` ŌĆö a photo, video, GIF, audio file, or a YouTube embed |
| Camera | `#camera-view` ŌĆö the display device's own live feed |
| Webpage | `#webpage-view` ŌĆö an external page framed by the panel (`#webpage-frame`) |
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
(`primeCameraNames`) then re-lists ŌĆö a single prompt, not one per launch. The
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
- **Text polish** (`#text-polish-btn`, the Ō£” by the textarea): rewrites the
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
sets a `{kind:'youtube', id}` descriptor. No bytes are stored or sent ŌĆö the
display builds a `youtube-nocookie.com/embed/<id>` iframe in `mountYouTube`.
The media-key comparison in `applyMode()` still stops a silent re-push from
reloading it.

**Webpage.** `#webpage-url-input` / `#webpage-go-btn` normalizes to http(s) and
sends only the URL; the display frames it in `#webpage-frame`. The frame does
**not** point at the site directly: it points at this project's own
`proxy?url=ŌĆ”`, because a browser refuses to frame a page whose server sends
`X-Frame-Options` or a `frame-ancestors` CSP ŌĆö which is most of the web, and the
reason the panel used to sit blank. `serve.py`'s `/proxy` fetches the URL,
drops those headers (and any matching `<meta>` tags), injects a `<base>` so the
page's own relative assets still resolve to the real site, and hands it back
from our origin. It refuses private/loopback addresses unless the server was
started with `EWC_PROXY_ALLOW_PRIVATE=1`. The iframe is only re-pointed when
the URL changes, so a verse step does not reload it.

Because the proxied page is served from our own origin it is *same-origin with
the console*, which is what makes the next part possible.

**Driving the page from the preview.** The operator can scroll and interact
with the framed page from the console's preview and the live panel follows.
While the webpage panel is both previewed and live (`previewCanDriveWebpage()`),
the console arms a transparent sheet (`#preview-proxy`) over the preview frame
and relays each interaction to the display as a `webpage-control` bus message;
the preview's own frame is driven directly through `__ewcPreview.control` so
both move together. Scroll deltas are sent as a fraction of the frame; a pointer
interaction is sent as the touched element's child-index path from the page
root, *not* a screen position ŌĆö the preview and the projection size the panel
differently (viewport-relative padding/gaps), so a point that hits a button in
the preview can miss it on the glass, while the element path cannot.

The sheet relays the whole pointer sequence ŌĆö `pointerdown`/`pointerup`/
`pointermove` (coalesced to one per animation frame) plus `click` ŌĆö and the
display re-dispatches each as a real `PointerEvent` *and* `MouseEvent` pair at
the element's centre. A lone synthetic `node.click()` is not enough: menus open
on `pointerdown`, drag handles listen for `mousedown`, and hover styles track
`pointermove`, so a real page ignores a bare click. It is live, not
launch-gated, and disarms the moment the preview drifts from what is live.

## Recording the live display

`#record-btn` in the console's top bar (next to Launch) starts a recording.
Pause and Stop (`#rec-pause-btn`, `#rec-stop-btn`) sit between it and Launch and
stay hidden until a recording is running; each is an icon with no word, because
the icon is the whole message. The Record button itself carries the dot and, in
place of its label, the elapsed time against the estimated time left ŌĆö
`00:42/1:57:00`. There is no transport panel, no file path and no status line
anywhere in the console: a finished recording reports itself with a toast
(`#toast-stack`) that leaves on its own. Nothing about recording appears on the
display. Pressing Stop returns the bar to rest at once — the flush, the index
and the close carry on in the background while the operator carries on with the
display — so `stopRecording()` clears the button itself before it hands the run
to `finishRecording()`, and `refreshRecordLabel()` refuses to repaint a run that
is no longer `recording`/`paused` (a late free-space estimate would otherwise
put the elapsed time back over the resting label).

The church screen is a browser page, so there is no OS capture API to call.
The console asks the browser for the screen with `getDisplayMedia` (the operator
picks the projector's monitor and shares its audio) and records it. That is what
makes it OS-independent: the same code path runs on Windows, macOS and Linux
because it is the browser, not the OS, doing the capture. The only hard
requirement is a Chromium-based desktop browser ŌĆö the File System Access API
(`showDirectoryPicker`) does not exist in Firefox or Safari, and the console
says so rather than half-working.

Every frame is composited onto a 3840×2160 canvas before encoding, so the file
is 4K whatever the operator's monitor is. Audio is a *mix*, not just the screen's
own sound: `buildAudioMix` sums the captured audio with the microphone
(`getUserMedia`, gained up) through one Web Audio graph, so the room's sound and
the preacher's voice are both in the file and losing either one does not lose the
recording.

Two traps make a file that carries an audio track and still plays as silence.
Both bite the real-world case — a screen shared over HDMI, where the share
carries no system audio and the microphone is the only source:

- **A single source must skip the graph.** With only the microphone (or only the
  screen) present, its own `MediaStreamTrack` goes straight to the encoder
  (`bareAudio`). Routing a lone track through a `MediaStreamDestination` is a
  needless dependency on an `AudioContext` — and a *suspended* context's
  destination emits nothing at all: no samples, no error, silence.
- **The graph's `AudioContext` must be created under a gesture.**
  `buildAudioMix` runs after `showDirectoryPicker` and `getDisplayMedia` have
  awaited, so by then there is no live user gesture and Chrome's autoplay policy
  can leave the context `suspended`; `resume()` cannot revive it without a
  gesture. `primeAudioContext()` therefore creates it synchronously in the
  Record click handler and `buildAudioMix` adopts it, building a fresh
  destination per run. If it is still not `running`, the graph is abandoned for
  the screen's own audio rather than trusted, because a mute track is worse than
  no track.

The recording is written through **WebCodecs** (`VideoEncoder`/`AudioEncoder` +
the vendored `vendor/mp4-muxer.js`, MIT). Screen frames and audio are pulled
with `MediaStreamTrackProcessor`, encoded, and muxed into a *plain* MP4 whose
single `moov` carries the real duration and the full sample table. That is the
whole point: `MediaRecorder` writes a *fragmented* MP4 with no duration and no
seek index, so players refuse to scrub or seek it. The muxer runs with
`fastStart: false`, so each ~1s chunk is written to the chosen folder as it
finalises (memory stays flat for a long service) and the `moov` lands at the
end, where a local player reads it to seek. `MediaRecorder` is kept only as a
fallback for a browser with no WebCodecs encoder (it then writes the fragmented
MP4, or WebM, and the console says so).

`REC_KEYFRAME_SECONDS` is what makes the file seekable: a keyframe a second
gives a player a clean cut point throughout, where one keyframe in the whole
file leaves a player that can only start at zero. `latencyMode: 'realtime'`
keeps the encoder to decode order = presentation order (no B-frames), so a
dropped frame leaves a gap rather than a hole in the reference chain.

The encode is allowed to lag the screen by design ŌĆö the compositor drops frames
when the encoder's queue is deep rather than queueing without bound ŌĆö so the
operator keeps working the display while the encoder catches up. On Stop the
pumps drain, the encoders flush, the `moov` is written and the file is closed;
that pause happens in the background and is why a stop is not instant.

`firstTimestampBehavior: 'offset'` (not `cross-track-offset`) is required: the
screen's video timestamps and the audio's come from different clocks, so a
shared offset would stretch one track's second sample seconds away from its
first. On Pause the encoders are flushed, the frames captured while paused are
dropped, and `run.pausedMicros` shifts the resumed timeline back so the gap
vanishes; the first frame after a resume is forced to a keyframe. The pause
offset is applied **once**, in `onChunk`, and the pumps hand the encoder the raw
capture timestamp ŌĆö rebasing in the pump as well would subtract it twice for any
chunk the encoder buffered across a pause, pushing that chunk behind the ones
already written and dropping a frame out of the reference chain (the
"reference picture missing during reorder" warning). Resume also waits for the
pause flush to land before moving the offset, so no pre-pause chunk can be
rebased with a post-resume value.

Both readers are **cancelled** on Stop rather than left to end with the capture.
The audio reader is on the *mixed* track, which is not part of the capture
stream, so it would go on producing silence for ever and the flush ŌĆö and so the
whole file ŌĆö would never happen. That was the "recording never finalises"
failure. Because the audio pump also stops a fraction of a second after the
video one, the tail is measured after the first flush and `holdLastFrame` holds
the final frame for that long, so the two tracks end together instead of the
video finishing short.

The file lands in a folder the operator picks, named `DD-MM-YYYY-{5 letters}`,
as `display-YYYY-MM-DD_HHMMSS.mp4`. The "time left" figure is the browser's own
free-space estimate for this origin (`navigator.storage.estimate`), divided by
the recording bitrate. A web page cannot read a drive's actual free space, but
this is the room the recording actually has to grow into.

## File map

| File | Notes |
| --- | --- |
| `display.html` / `display.js` | Projection renderer. No controls at all ŌĆö no gear, no settings panel, and `cursor:none` + `pointer-events:none`. |
| `console.html` / `console.js` | Control room. All state lives here. |
| `display-common.js` | Shared helpers: storage keys, Bible loader, song library, background store. |
| `display.css` | Design tokens, base styles, and stage/panel/lyrics views ŌĆö used by **both** pages. |
| `display-extra.css` | Display-only tweaks, including preview scaling. |
| `console.base.css` | The form controls carried over from the old settings drawer. |
| `console.css` | Control-room layout: top bar, controls rail, preview, the bottom panel picker. |
| `landing.css` | `index.html` launcher. |
| `serve.py` | Local http server, plus the `/proxy` the webpage panel needs. |
| `vendor/mp4-muxer.js` | Vendored mp4-muxer v5.2.1 (MIT) ŌĆö muxes WebCodecs chunks into the seekable MP4. Do not hand-edit. |
| `bible-data.js` | KJV text, generated from `en_kjv.json` by `build_bible_data.py`. Do not hand-edit. |

`index.bak.html` is the pre-split single-page version, kept for reference.

## State and storage

- `EWC.SETTINGS_KEY` (`ewc-display-settings-v1`) ŌĆö `localStorage`, text
  settings. The **console is the only writer**; the display only reads.
- `EWC.SONGS_KEY` (`ewc-display-songs-v1`) ŌĆö `localStorage`, song library.
- `CHOICE_KEY` (`ewc-display-bg-choice-v1`) ŌĆö `localStorage`, whether a
  backdrop photo is set.
- `IndexedDB` database `ewc-display-media` ŌĆö two object stores. `backgrounds`
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
- **`page.fill()` fires `input`, not blur.** So the "Not Launched" note after an
  edit is testable directly.
- Test the two pages as **separate browser pages in one context** ŌĆö they need
  a shared origin for `BroadcastChannel` to work.
- **The lyric track rebuilds on title *and* lines, not the title alone.** An
  edited song keeps its title but rewrites its lines, so keying the rebuild on
  the title left the old words on screen after an edit.
- **`applyMode()` must be idempotent.** It runs on every push, and a step
  re-pushes the state; remounting the media on each one would restart a
  playing video. It keys on the media descriptor and only rebuilds when that
  changes ŌĆö and the camera likewise keys on `cameraDeviceId`, so only a real
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
- **A lone synthetic `node.click()` does not drive a real page.** The preview
  relay must send the whole pointer sequence and the display must re-dispatch
  real `PointerEvent`/`MouseEvent` pairs; menus open on `pointerdown`, drag
  handles listen for `mousedown`, hover styles track `pointermove`.
- **`MediaRecorder` cannot write a seekable MP4.** It emits a fragmented MP4
  with no duration and no sample index, so players refuse to scrub it (the
  "900 KB, cannot skip forward" symptom). WebCodecs + mp4-muxer is what gives a
  real `moov`. `fastStart: 'in-memory'` would also produce a seekable file but
  buffers the *whole* recording in RAM ŌĆö never use it for a long service; the
  default (`fastStart: false`) streams to disk and still seeks.
- **`firstTimestampBehavior: 'cross-track-offset'` stretches a recording.**
  The screen's video and the audio start on different clocks; the shared
  offset yanks one track's second sample seconds away from its first. Use
  `'offset'` (per-track), and rebase encoder output on the monotonic guard
  rather than a fragile input-to-output timestamp map.
- **A reader on the mixed audio track never ends on its own.** When two sources
  are summed, `buildAudioMix` returns a *new* `MediaStream` from a
  `MediaStreamDestination`, so its audio track is not part of the capture stream
  and stopping the capture does not end it. The pump would produce silence for ever and `finishRecording` would wait
  on it until the tab closed ŌĆö the "recording never finalises, no file" symptom.
  Stop must `cancel()` both readers explicitly.
- **Rebase the pause offset exactly once.** `onChunk` subtracts `pausedMicros`
  from the chunk timestamp, and the pumps hand the encoder the *raw* capture
  timestamp. Subtracting in the pump as well double-rebases any chunk the
  encoder buffered across a pause, pushing it behind the samples already written
  ŌĆö the monotonic guard then drops it and the decoder reports "reference picture
  missing during reorder". Resume must also await the pause flush before moving
  the offset, or the same thing happens without a dropped frame being involved.
- **Frames closer together than one frame period must be dropped.** The muxer
  times the video track in units of `REC_FRAME_RATE` (`57600` for 30fps), so two
  frames inside one unit get the same decode timestamp and the file is invalid.
  A burst or the join after a pause can produce such a pair; `REC_MIN_STEP_MICROS`
  is the guard.
- **The two pumps stop at different instants, so the video track can finish
  short.** Audio is chunked in ~20ms slices and is often a fraction of a second
  ahead. Measure the tail *after* the first flush (that is the first point the
  last chunk of each track has been emitted) and `holdLastFrame` for that long.
- **The state must read `recording` before the pumps start.** Both pumps drop
  every frame whose state is not `recording`, so starting them first would throw
  away the opening frames of the recording.
- **`latencyMode: 'quality'` reorders frames.** It lets the encoder emit
  B-frames, so decode order stops matching presentation order and a frame
  dropped at the input leaves a hole in the reference chain. Screen capture
  wants `'realtime'`.
- **The console carries no explanatory prose, but it keeps its feedback.** The
  rule is about *static* text that only explains the UI ŌĆö a `<p class="hint">`
  that describes what a control does ŌĆö which belongs in the manual, not on the
  tool. Status text a handler writes into the element that exists for it
  (`*-status`, `*-hint`) stays: it reports what just happened or what is
  missing, and it is the operator's only confirmation the click landed. The
  keyboard shortcuts stay too (ŌåÉ/ŌåÆ verse, Ōåæ/Ōåō lyric line, Space launch) ŌĆö the
  arrows are the feature, and their explanation is the manual's job. Recording
  is the exception that reports itself through `#toast-stack` (a sandbar that
  leaves on its own) rather than a permanent line, and the preview note is
  exactly `Live` or `Not Launched`.

## Testing

Playwright suites live in `tests/`, each starting its own `serve.py` and
driving real pages over a real `BroadcastChannel`:

```sh
pip install playwright && playwright install chromium
python3 tests/test_console_display.py   # the console/display split
python3 tests/test_persistence.py       # backdrop + song persistence
python3 tests/test_display_features.py  # type sizes + the panel modes
python3 tests/test_ai_and_embeds.py     # AI, YouTube and the webpage panel
python3 tests/test_recording_and_interactive.py  # recording + preview control
python3 tests/test_resource_use.py      # heap/CPU stay bounded
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
media panel, YouTube embedding, and the webpage panel (framed through the proxy,
and really loading even when the site sends `X-Frame-Options`).

`test_recording_and_interactive.py` serves a throwaway "site" that sends
`X-Frame-Options: DENY` (so the proxy is exercised for real) and stubs the two
native pickers ŌĆö `showDirectoryPicker` resolves to the Origin Private File
System, and the fake screen-capture device stands in for the monitor ŌĆö then
checks that scrolling and clicking the console preview move the same page on the
display, that a `pointerdown` (not just a click) reaches it, and that the sheet
only arms while the preview is what is live.

Its recording section checks the cleaned-up console: Pause and Stop sit between
Record and Launch, are hidden at rest, are icon-only, and appear the moment a
recording starts; the Record button carries the pulsing dot and the
`mm:ss/h:mm:ss` elapsed-against-estimate label; there is no transport panel and
no status line anywhere. It then checks a stop returns the bar to rest at once,
before the muxer has finished, and reports through a toast, that a real MP4
(`ftyp` box) lands in the dated folder,
that the file has a real duration and a seekable range **and can be seeked both
backwards to the midpoint and forwards to the end** (one keyframe at the start
would pass a forward seek and still be unusable), that the picture is 3840×2160,
and that an audio track is present and loads. Where `ffmpeg` is on the PATH it
goes one step further and measures the track's real level with `volumedetect`,
because a track that exists is not the same as sound: the shipped bug was a
silent file, the audio pump never having ended so the mixed track was never
finalized.

`test_resource_use.py` guards the cost of the heavy features: it samples the
JS heap over time (a recording must not grow the heap ŌĆö slices go to disk as
they arrive ŌĆö and the display's heap must be flat while idle and while the
camera runs), asserts a camera track really *ends* when its panel leaves (or
the camera light stays on), and checks the render loop and a recording stay
well under one core. It prints the raw MB/CPU numbers; the gates are generous
because headless software WebGL is far heavier than a real GPU.
