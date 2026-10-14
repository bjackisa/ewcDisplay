/* ============================================================================
   EXPLOITS WORSHIP CENTRE — CONTROL ROOM (CONSOLE)

   The operator's window. It owns every control, previews what it will show in
   an iframe of display.html, and drives the church screen over a
   BroadcastChannel.

   Two distinct ideas live here, and keeping them apart is the whole point:

     * PREVIEW — the operator's working state. Changing a field updates the
       iframe immediately but touches nothing else. This is the "review before
       you launch" half.

     * LIVE — the last thing that was launched. The projection screen only
       ever shows this.

   Two exemptions let an already-live panel follow along without a relaunch:

     * stepping a verse or a lyric line while that panel is on the screen — the
       verse/line being moved off is already up there, so re-launching after
       every line would be unusable; and
     * editing the words of a song that is already live, for the same reason.

   Everything else — every panel mode, choosing a *new* book/chapter/song, and
   "No Panel" — waits for Launch.

   State lives in three places, on purpose:
     * preview  — in this window (and mirrored into the iframe)
     * live     — in this window, so a console refresh can repaint the screen
     * localStorage — text settings and songs, so both windows survive a
       restart. The background photo is far too big for that; it lives in a
       shared IndexedDB store (see display-common.js).
   ========================================================================== */
(function () {
  'use strict';

  var EWC = window.EWC;
  var previewFrame = document.getElementById('preview');
  var previewWindow = null;

  /* ==========================================================================
     1. STATE
     ========================================================================== */

  var SETTINGS_KEY = EWC.SETTINGS_KEY;
  var SONGS_KEY = EWC.SONGS_KEY;

  var preview = {
    mode: 'timer',
    /* "No Panel" removes the glass entirely. It is the only non-panel state. */
    panelHidden: false,
    eventName: 'Sunday Service',
    targetISO: EWC.nextSunday9am().toISOString(),
    scriptureBookIndex: 0,
    scriptureChapter: 2,
    scriptureVerse: 4,
    activeSongId: null,
    lyricLineIndex: 0,
    text: { body: '', title: '' },
    media: null, // {kind, mime, name, url} of the stored media to show, or null
    /* The webpage shown inside the panel frame, or null. */
    webpageUrl: '',
    /* Which physical camera to open, by deviceId. Null means "let the display
       choose" — which is the right thing when the machine has one camera, or
       when the list has not been read yet. */
    cameraDeviceId: null
  };

  /** The last thing launched. `null` mode means nothing has been launched.
   *  `panelHidden` is the launched "No Panel" state. */
  var live = { mode: null, content: null, panelHidden: false };

  var bibleData = null;
  var songs = [];
  var editingSongId = null; // non-null while a song is loaded into the form
  var revision = 0;
  var sessionId = 'session-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);

  /** Serialised snapshot of what is on the screen, for comparing against the
   *  preview to tell whether the operator has edited what was launched. */
  function fingerprint(mode, content, panelHidden) {
    if (mode === null) return '';
    return mode + '|' + JSON.stringify(content || null) + '|' + (panelHidden ? 'nopanel' : 'panel');
  }

  /* ==========================================================================
     2. DOM REFERENCES
     ========================================================================== */

  var el = {
    linkStatus: document.getElementById('link-status'),
    linkStatusText: document.getElementById('link-status-text'),
    openDisplayBtn: document.getElementById('open-display-btn'),
    launchBtn: document.getElementById('launch-btn'),

    recordBtn: document.getElementById('record-btn'),
    recPanel: document.getElementById('rec-panel'),
    recDot: document.getElementById('rec-dot'),
    recTime: document.getElementById('rec-time'),
    recLeft: document.getElementById('rec-left'),
    recWhere: document.getElementById('rec-where'),
    recPauseBtn: document.getElementById('rec-pause-btn'),
    recStopBtn: document.getElementById('rec-stop-btn'),
    recStatus: document.getElementById('rec-status'),

    previewNote: document.getElementById('preview-note'),
    previewProxy: document.getElementById('preview-proxy'),
    previewInteractiveHint: document.getElementById('preview-interactive-hint'),
    prevBtn: document.getElementById('prev-btn'),
    nextBtn: document.getElementById('next-btn'),

    settingsPanel: document.getElementById('settings-panel'),
    modeToggleGroup: document.getElementById('mode-toggle-group'),
    modeFields: document.getElementById('mode-fields'),
    modeFieldsNote: document.getElementById('mode-fields-note'),
    noPanelToggle: document.getElementById('no-panel-toggle'),
    textBodyInput: document.getElementById('text-body-input'),
    textTitleInput: document.getElementById('text-title-input'),
    mediaChooseBtn: document.getElementById('media-choose-btn'),
    mediaFileInput: document.getElementById('media-file-input'),
    mediaClearBtn: document.getElementById('media-clear-btn'),
    mediaStatus: document.getElementById('media-status'),
    cameraStopBtn: document.getElementById('camera-stop-btn'),
    cameraStatusConsole: document.getElementById('camera-status-console'),
    cameraDeviceSelect: document.getElementById('camera-device-select'),
    cameraDeviceHint: document.getElementById('camera-device-hint'),
    eventNameInput: document.getElementById('event-name-input'),
    targetDatetimeInput: document.getElementById('target-datetime-input'),
    nextSundayBtn: document.getElementById('next-sunday-btn'),

    scriptureBookSelect: document.getElementById('scripture-book-select'),
    scriptureChapterInput: document.getElementById('scripture-chapter-input'),
    scriptureVerseInput: document.getElementById('scripture-verse-input'),
    scriptureGoBtn: document.getElementById('scripture-go-btn'),
    scriptureStatus: document.getElementById('scripture-status'),
    chooseScriptureFileBtn: document.getElementById('choose-scripture-file-btn'),
    scriptureFileInput: document.getElementById('scripture-file-input'),

    aiKeyInput: document.getElementById('ai-key-input'),
    aiKeyStatus: document.getElementById('ai-key-status'),
    scriptureAiInput: document.getElementById('scripture-ai-input'),
    scriptureAiBtn: document.getElementById('scripture-ai-btn'),
    scriptureAiStatus: document.getElementById('scripture-ai-status'),
    textPolishBtn: document.getElementById('text-polish-btn'),
    textPolishStatus: document.getElementById('text-polish-status'),
    mediaYoutubeInput: document.getElementById('media-youtube-input'),
    mediaYoutubeBtn: document.getElementById('media-youtube-btn'),
    mediaAiPrompt: document.getElementById('media-ai-prompt'),
    mediaAiBtn: document.getElementById('media-ai-btn'),
    bgAiPrompt: document.getElementById('bg-ai-prompt'),
    bgAiBtn: document.getElementById('bg-ai-btn'),
    bgAiStatus: document.getElementById('bg-ai-status'),
    webpageUrlInput: document.getElementById('webpage-url-input'),
    webpageGoBtn: document.getElementById('webpage-go-btn'),
    webpageStatus: document.getElementById('webpage-status'),

    songSearchInput: document.getElementById('song-search-input'),
    songList: document.getElementById('song-list'),
    songTitleInput: document.getElementById('song-title-input'),
    songLyricsInput: document.getElementById('song-lyrics-input'),
    songSaveBtn: document.getElementById('song-save-btn'),
    songStatus: document.getElementById('song-status'),

    chooseImageBtn: document.getElementById('choose-image-btn'),
    clearImageBtn: document.getElementById('clear-image-btn'),
    bgFileInput: document.getElementById('bg-file-input')
  };

  /* ==========================================================================
     3. PERSISTENCE
     ========================================================================== */

  function loadPersisted() {
    try {
      var saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      if (saved) preview = Object.assign(preview, saved);
    } catch (err) {
      console.warn('Could not load saved settings:', err);
    }
  }

  function savePersisted() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        mode: preview.mode,
        panelHidden: preview.panelHidden,
        eventName: preview.eventName,
        targetISO: preview.targetISO,
        scriptureBookIndex: preview.scriptureBookIndex,
        scriptureChapter: preview.scriptureChapter,
        scriptureVerse: preview.scriptureVerse,
        activeSongId: preview.activeSongId,
        lyricLineIndex: preview.lyricLineIndex,
        text: preview.text,
        media: preview.media,
        webpageUrl: preview.webpageUrl,
        cameraDeviceId: preview.cameraDeviceId
      }));
    } catch (err) {
      console.warn('Could not save settings:', err);
    }
  }

  /* ==========================================================================
     4. BUILDING THE CONTENT FOR EACH MODE
     ========================================================================== */

  function getActiveSong() {
    return songs.find(function (song) { return song.id === preview.activeSongId; }) || null;
  }

  /** Human-readable label for a mode + its content, used in the launch note. */
  function describe(mode, content) {
    content = content || {};
    if (mode === 'timer') return 'the countdown to ' + (content.eventName || 'Sunday Service');
    if (mode === 'clock') return 'the clock';
    if (mode === 'scripture') return content.reference || 'scripture';
    if (mode === 'lyrics') return content.title ? 'lyrics — ' + content.title : 'lyrics';
    if (mode === 'text') return 'the displayed text';
    if (mode === 'media') return content.name ? 'media — ' + content.name : 'media';
    if (mode === 'camera') return 'the camera feed';
    if (mode === 'webpage') return content.url ? 'the webpage — ' + content.url : 'the webpage';
    return mode;
  }

  /** Turns the preview state into the `content` payload the display applies. */
  function buildContent(state) {
    if (state.mode === 'timer') {
      return { eventName: state.eventName, targetISO: state.targetISO };
    }
    if (state.mode === 'scripture') {
      if (!bibleData) {
        return { text: 'Scripture unavailable', reference: 'The Bible has not loaded.' };
      }
      var book = bibleData[state.scriptureBookIndex];
      var chapter = book.chapters[state.scriptureChapter - 1] || [];
      var text = chapter[state.scriptureVerse - 1] || '';
      return {
        text: text,
        reference: EWC.bookName(bibleData, state.scriptureBookIndex) + ' ' + state.scriptureChapter + ':' + state.scriptureVerse
      };
    }
    if (state.mode === 'lyrics') {
      var song = getActiveSong();
      if (!song) {
        return {
          title: 'Lyrics',
          lines: null,
          emptyMessage: songs.length
            ? 'Pick a song in the console to show its lyrics.'
            : 'No songs saved yet — add one in the console.'
        };
      }
      return { title: song.title, lines: song.lines, index: state.lyricLineIndex };
    }
    if (state.mode === 'text') {
      return { body: state.text.body, title: state.text.title };
    }
    if (state.mode === 'webpage') {
      return { url: state.webpageUrl || '' };
    }
    return {};
  }

  function pushMessage(state, revisionNumber) {
    return {
      type: 'push',
      session: sessionId,
      revision: revisionNumber,
      mode: state.mode,
      content: buildContent(state),
      panelHidden: state.panelHidden,
      // The media descriptor rides on every push. It names the file but
      // carries no bytes — the display reads those from the shared store, so a
      // 200 MB video never crosses the bus. A YouTube descriptor carries only
      // its URL (kind:'youtube'), so nothing large crosses either.
      media: state.mode === 'media' ? state.media : null,
      // The webpage URL rides on every push like the media descriptor.
      webpageUrl: state.mode === 'webpage' ? (state.webpageUrl || '') : '',
      // Which camera to open, by deviceId. Only a string crosses the bus; the
      // display opens the device itself. Null lets the display pick its own.
      cameraDeviceId: state.mode === 'camera' ? (state.cameraDeviceId || null) : null
    };
  }

  /* ==========================================================================
     5. PREVIEW → IFRAME
     The iframe is display.html itself, so there is exactly one renderer to
     keep working. It both explains the preview and guarantees the operator
     reviews the real thing.
     ========================================================================== */

  var previewReady = false;

  /** Called once (and again if the iframe navigates) to wire up the preview. */
  function onPreviewReady() {
    previewWindow = previewFrame.contentWindow;
    previewReady = !!(previewWindow && previewWindow.__ewcPreview);
    if (!previewReady) return;
    renderPreview();
    primePreviewBackground();
  }

  previewFrame.addEventListener('load', onPreviewReady);

  /** Mirrors the current preview state into the iframe. */
  function renderPreview() {
    if (!previewReady || !previewWindow) return;
    // A locally-generated revision keeps the iframe's own out-of-order guard
    // happy without disturbing the live revision counter.
    previewWindow.__ewcPreview.apply({
      revision: Date.now(),
      mode: preview.mode,
      content: buildContent(preview),
      panelHidden: preview.panelHidden,
      media: preview.mode === 'media' ? preview.media : null,
      webpageUrl: preview.mode === 'webpage' ? (preview.webpageUrl || '') : '',
      cameraDeviceId: preview.mode === 'camera' ? (preview.cameraDeviceId || null) : null
    });
  }

  /** Applies the current preview after a state change, and shows the
   *  "not launched" note when the preview has drifted from what is live. */
  function afterPreviewChange() {
    renderPreview();
    updateLaunchNote();
    savePersisted();
  }

  function updateLaunchNote() {
    if (previewProxySync) previewProxySync();
    if (live.mode === null) {
      el.previewNote.textContent = 'Nothing launched yet — the church screen has not been set.';
      el.previewNote.dataset.state = 'idle';
      return;
    }
    if (live.panelHidden && !preview.panelHidden) {
      el.previewNote.textContent = 'Not launched — “No Panel” is still on the screen.';
      el.previewNote.dataset.state = 'idle';
      return;
    }
    if (live.mode !== preview.mode) {
      el.previewNote.textContent = 'Not launched — ' + describe(live.mode, live.content) + ' is still on the screen.';
      el.previewNote.dataset.state = 'idle';
      return;
    }
    if (fingerprint(live.mode, live.content, live.panelHidden) !==
        fingerprint(preview.mode, buildContent(preview), preview.panelHidden)) {
      el.previewNote.textContent = 'Preview edited — press Launch to put it on the screen.';
      el.previewNote.dataset.state = 'idle';
      return;
    }
    el.previewNote.textContent = preview.panelHidden
      ? 'Live on the church screen: no panel — the background only.'
      : 'Live on the church screen: ' + describe(live.mode, live.content) + '.';
    el.previewNote.dataset.state = 'live';
  }

  /** Runs after every launch-note refresh so the interactive preview sheet is
   *  armed exactly when the framed page it sits over is the live one. Defined
   *  with the other preview helpers but wired to updateLaunchNote below, once
   *  the webpage relay it belongs to exists. */
  var previewProxySync = null;

  /* ==========================================================================
     6. THE BUS — console end
     ========================================================================== */

  var bus = null;
  try {
    if ('BroadcastChannel' in window) bus = new BroadcastChannel('ewc-display-bus');
  } catch (err) {
    console.warn('BroadcastChannel unavailable — the display window cannot be driven:', err);
  }

  var displayClients = Object.create(null); // clientId → last hello time

  function send(message) {
    if (!bus) return;
    try { bus.postMessage(message); } catch (err) { console.warn('Could not post to bus:', err); }
  }

  /** Asks the display(s) to identify themselves. */
  function ping() { send({ type: 'ping' }); }

  bus && (bus.onmessage = function (event) {
    var message = event.data;
    if (!message || !message.type) return;

    if (message.type === 'hello') {
      var first = !displayClients[message.from];
      displayClients[message.from] = Date.now();
      setLinkState('ok', 'Display connected');
      // The first time we meet a display that is already showing something
      // (a page refresh on the operator's side, or a screen opened before the
      // console), adopt it so the launch note tells the truth and a later
      // launch is not silently discarded as stale.
      if (first && message.mode && live.mode === null) {
        live = { mode: message.mode, content: buildContent(preview), panelHidden: false };
        revision = Math.max(revision, typeof message.revision === 'number' ? message.revision : 0);
        updateLaunchNote();
      }
    } else if (message.type === 'bye') {
      delete displayClients[message.from];
      if (!Object.keys(displayClients).length) setLinkState('lost', 'Display disconnected');
    } else if (message.type === 'status') {
      console.warn('Display reported:', message.text);
    }
  });

  function setLinkState(state, text) {
    el.linkStatus.dataset.state = state;
    el.linkStatusText.textContent = text;
  }

  /** Polls for the display, and marks it lost if it has gone quiet. */
  setInterval(function () {
    ping();
    var now = Date.now();
    var seen = false;
    Object.keys(displayClients).forEach(function (id) {
      if (now - displayClients[id] < 6000) seen = true; else delete displayClients[id];
    });
    if (!seen) setLinkState('waiting', 'Looking for the display…');
  }, 2500);

  /* ==========================================================================
     7. LAUNCHING
     ========================================================================== */

  function pushLive(backgroundChanged) {
    revision += 1;
    live = { mode: preview.mode, content: buildContent(preview), panelHidden: preview.panelHidden };
    var message = pushMessage(preview, revision);
    if (backgroundChanged) message.backgroundChanged = true;
    send(message);

    renderPreview();   // the iframe and the screen now agree
    updateLaunchNote();
  }

  el.launchBtn.addEventListener('click', function () { pushLive(false); });

  el.openDisplayBtn.addEventListener('click', function () {
    window.open('display.html', 'ewc-display', 'width=1280,height=720,menubar=no,toolbar=no');
    // The new window will say hello on its own; give it a moment, then look.
    setTimeout(ping, 400);
  });

  /* ==========================================================================
     8. STEPPING VERSE / LYRIC
     The ‹ › buttons and the arrow keys move to the next verse or lyric line.

     Stepping is a *live* move once that panel is already on the screen: the
     verse or line the operator is moving off is already up there, and the
     congregation should follow along without the operator re-launching after
     every line. Choosing a *new* item — a different book or chapter from the
     picker, a different song from the list — is not a step, so it stays
     launch-gated like everything else.
     ========================================================================== */

  /** True when the named panel is the one currently on the screen. */
  function liveMatchesMode(mode) { return live.mode === mode; }

  /** True when the preview *right now* is exactly what is on the screen. A step
   *  only goes live in that case: the verse/line being moved off is the one the
   *  congregation is looking at. If the operator has already picked a new
   *  book/chapter or a new song, the preview has drifted, so stepping it must
   *  still wait for Launch like any other new content. */
  function previewIsLive(mode) {
    return liveMatchesMode(mode) &&
      fingerprint(live.mode, live.content, live.panelHidden) ===
      fingerprint(preview.mode, buildContent(preview), preview.panelHidden);
  }

  /** Applies a step. `wasLive` says whether the preview was the live view
   *  *before* the step — if so the screen moves with it, otherwise the step
   *  waits for Launch like any other edit. */
  function commitStep(wasLive) {
    afterPreviewChange();       // preview, saved state, launch note
    if (wasLive) pushLive(false); // was already on screen → step it too
  }

  function stepScripture(direction) {
    if (!bibleData) return;
    var wasLive = previewIsLive('scripture');
    var bookIndex = preview.scriptureBookIndex;
    var chapter = preview.scriptureChapter;
    var verse = preview.scriptureVerse;
    var versesInChapter = bibleData[bookIndex].chapters[chapter - 1].length;
    verse += direction;

    if (direction > 0 && verse > versesInChapter) {
      chapter += 1;
      verse = 1;
      if (chapter > bibleData[bookIndex].chapters.length) {
        bookIndex = (bookIndex + 1) % bibleData.length;
        chapter = 1;
      }
    } else if (direction < 0 && verse < 1) {
      chapter -= 1;
      if (chapter < 1) {
        bookIndex = (bookIndex - 1 + bibleData.length) % bibleData.length;
        chapter = bibleData[bookIndex].chapters.length;
      }
      verse = bibleData[bookIndex].chapters[chapter - 1].length;
    }

    preview.scriptureBookIndex = bookIndex;
    preview.scriptureChapter = chapter;
    preview.scriptureVerse = verse;
    renderScripture();
    commitStep(wasLive);
  }

  function stepLyric(direction) {
    var song = getActiveSong();
    if (!song) return;
    var next = preview.lyricLineIndex + direction;
    if (next < 0 || next >= song.lines.length) return; // deliberately no wrap
    var wasLive = previewIsLive('lyrics');
    preview.lyricLineIndex = next;
    commitStep(wasLive);
  }

  el.prevBtn.addEventListener('click', function () { stepFocused(-1); });
  el.nextBtn.addEventListener('click', function () { stepFocused(1); });

  function stepFocused(direction) {
    if (preview.mode === 'scripture') stepScripture(direction);
    else if (preview.mode === 'lyrics') stepLyric(direction);
  }

  /* ==========================================================================
     9. SCRIPTURE
     ========================================================================== */

  function clampScriptureReference() {
    if (!bibleData) return;
    preview.scriptureBookIndex = Math.min(Math.max(preview.scriptureBookIndex, 0), bibleData.length - 1);
    var book = bibleData[preview.scriptureBookIndex];
    preview.scriptureChapter = Math.min(Math.max(preview.scriptureChapter, 1), book.chapters.length);
    var verseCount = book.chapters[preview.scriptureChapter - 1].length;
    preview.scriptureVerse = Math.min(Math.max(preview.scriptureVerse, 1), verseCount);
  }

  function setScriptureStatus(message) {
    el.scriptureStatus.textContent = message || '';
    el.scriptureStatus.style.display = message ? 'block' : 'none';
  }

  function populateScriptureBookSelect() {
    el.scriptureBookSelect.innerHTML = '';
    bibleData.forEach(function (entry, i) {
      var option = document.createElement('option');
      option.value = String(i);
      option.textContent = EWC.bookName(bibleData, i);
      el.scriptureBookSelect.appendChild(option);
    });
    el.scriptureBookSelect.disabled = false;
  }

  /** Keeps the panel fields in step with the preview's reference. */
  function renderScripture() {
    if (!bibleData) return;
    el.scriptureBookSelect.value = String(preview.scriptureBookIndex);
    el.scriptureChapterInput.value = preview.scriptureChapter;
    el.scriptureVerseInput.value = preview.scriptureVerse;
  }

  function installBible(data) {
    bibleData = data;
    populateScriptureBookSelect();
    clampScriptureReference();
    renderScripture();
    setScriptureStatus('');
    afterPreviewChange();
  }

  EWC.loadBibleData()
    .then(function (data) { installBible(data); })
    .catch(function (err) {
      console.warn('Could not load the Bible:', err);
      setScriptureStatus('Pick en_kjv.json to load the Bible (or serve this folder over http).');
      renderPreview();
    })
    .finally(function () {
      if (!bibleData) el.scriptureBookSelect.innerHTML = '<option>Choose a file…</option>';
    });

  el.scriptureGoBtn.addEventListener('click', function () {
    if (!bibleData) return;
    preview.scriptureBookIndex = parseInt(el.scriptureBookSelect.value, 10) || 0;
    preview.scriptureChapter = parseInt(el.scriptureChapterInput.value, 10) || 1;
    preview.scriptureVerse = parseInt(el.scriptureVerseInput.value, 10) || 1;
    clampScriptureReference();
    renderScripture();
    afterPreviewChange();
  });

  [el.scriptureChapterInput, el.scriptureVerseInput].forEach(function (input) {
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') el.scriptureGoBtn.click();
    });
  });

  el.chooseScriptureFileBtn.addEventListener('click', function () { el.scriptureFileInput.click(); });

  el.scriptureFileInput.addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    file.text().then(function (text) {
      var data = EWC.setManualBible(EWC.parseBibleJSON(text));
      if (!data) throw new Error('Unexpected file format');
      installBible(data);
    }).catch(function (err) {
      console.warn('Could not read the chosen Bible file:', err);
      setScriptureStatus("Could not read " + file.name + " — it doesn't look like the bible JSON format.");
    }).finally(function () { el.scriptureFileInput.value = ''; });
  });

  /* ==========================================================================
     9b. AI — verse search, text polish and image generation

     One Google Gemini API key powers all three. The key is entered by the
     operator and kept only in this browser's localStorage; it is sent to
     Google's endpoint and nowhere else. Nothing here is required for the rest
     of the console to work — every AI button degrades to a clear message when
     no key is set or the request fails.
     ========================================================================== */

  var AI_KEY_STORAGE = 'ewc-display-gemini-key-v1';
  var AI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';
  var AI_TEXT_MODEL = 'gemini-flash-latest';
  // Image generation is a separate, quota-billed model. Kept overridable in
  // one place because Google renames these as the previews graduate.
  var AI_IMAGE_MODEL = 'gemini-2.5-flash-image';
  var AI_TIMEOUT_MS = 60000;

  function getAiKey() {
    try { return localStorage.getItem(AI_KEY_STORAGE) || ''; } catch (err) { return ''; }
  }

  function setAiKeyStatus(message, isError) {
    el.aiKeyStatus.textContent = message || '';
    el.aiKeyStatus.style.color = isError ? 'var(--sunrise-orange)' : '';
  }

  /** Reports the saved key back to the operator (masked) without ever logging
   *  or displaying it in full. */
  function reflectAiKey() {
    var key = getAiKey();
    el.aiKeyInput.value = key;
    setAiKeyStatus(key ? 'A key is saved on this browser.' : 'No key saved yet — AI features are off.');
  }

  /** One Gemini generateContent attempt. Rejects with an Error carrying a
   *  `retryable` flag for the transient failures worth another try. */
  function aiAttempt(model, key, body) {
    var controller = window.AbortController ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, AI_TIMEOUT_MS) : null;

    return fetch(AI_ENDPOINT + model + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-goog-api-key': key },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) {
          var detail = data && data.error && data.error.message ? data.error.message : ('HTTP ' + response.status);
          var err = new Error(response.status === 429
            ? 'The AI service is out of quota right now. ' + detail
            : detail);
          // 503 "high demand" and 500 are worth retrying; quota is not.
          err.retryable = response.status === 500 || response.status === 503 || response.status === 504;
          throw err;
        }
        return data;
      });
    }).catch(function (err) {
      // A network failure or an aborted request is worth one more try too.
      if (!err.retryable && (err.name === 'AbortError' || err.name === 'TypeError')) err.retryable = true;
      throw err;
    }).finally(function () {
      if (timer) clearTimeout(timer);
    });
  }

  /** Runs one Gemini generateContent call, retrying the transient "high demand"
   *  failures the free endpoint throws often. Resolves with the parsed JSON
   *  body; rejects with a short, human-readable Error for the console to show. */
  function aiGenerate(model, body) {
    var key = getAiKey();
    if (!key) return Promise.reject(new Error('Add your Gemini API key in AI settings first.'));
    if (!window.fetch) return Promise.reject(new Error('This browser cannot reach the AI service.'));

    var attempts = 3;
    function run(n) {
      return aiAttempt(model, key, body).catch(function (err) {
        if (n + 1 < attempts && err.retryable) {
          return new Promise(function (resolve) { setTimeout(resolve, 1200 * (n + 1)); })
            .then(function () { return run(n + 1); });
        }
        throw err;
      });
    }
    return run(0);
  }

  /** Pulls the first text part out of a Gemini response. */
  function aiFirstText(data) {
    var parts = (data && data.candidates && data.candidates[0]
      && data.candidates[0].content && data.candidates[0].content.parts) || [];
    for (var i = 0; i < parts.length; i++) {
      if (typeof parts[i].text === 'string' && parts[i].text) return parts[i].text;
    }
    return '';
  }

  /** Pulls the first inline image (base64 + mime) out of a Gemini response. */
  function aiFirstImage(data) {
    var parts = (data && data.candidates && data.candidates[0]
      && data.candidates[0].content && data.candidates[0].content.parts) || [];
    for (var i = 0; i < parts.length; i++) {
      var inline = parts[i].inlineData || parts[i].inline_data;
      if (inline && inline.data) {
        return { mime: inline.mimeType || inline.mime_type || 'image/png', data: inline.data };
      }
    }
    return null;
  }

  /** Decodes a base64 image part into a Blob. */
  function aiImageBlob(image) {
    var binary = atob(image.data);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: image.mime });
  }

  /* -- The API key field ---------------------------------------------------- */

  el.aiKeyInput.addEventListener('change', function () {
    var key = el.aiKeyInput.value.trim();
    try {
      if (key) localStorage.setItem(AI_KEY_STORAGE, key);
      else localStorage.removeItem(AI_KEY_STORAGE);
    } catch (err) { console.warn('Could not save the AI key:', err); }
    reflectAiKey();
  });

  /* -- 9b(i) Verse search ---------------------------------------------------
     The operator types whatever they remember — a phrase, a reference, a
     story — and Gemini resolves it to a book/chapter/verse. The resolved
     reference is then loaded from the *local* KJV text, so the verse that
     reaches the screen is the same KJV text every other verse uses, never
     something the model retyped. */

  var AI_VERSE_SCHEMA = {
    type: 'object',
    properties: {
      book: { type: 'string', description: 'Full King James Version book name, e.g. "John", "1 Corinthians".' },
      chapter: { type: 'integer' },
      verse: { type: 'integer' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      note: { type: 'string', description: 'A short explanation of the choice.' }
    },
    required: ['book', 'chapter', 'verse']
  };

  function setScriptureAiStatus(message, isError) {
    el.scriptureAiStatus.textContent = message || '';
    el.scriptureAiStatus.style.color = isError ? 'var(--sunrise-orange)' : '';
  }

  /** Finds a book index by name, tolerating case, punctuation and the common
   *  numbered forms ("1 Corinthians", "I Corinthians", "1Corinthians"). */
  function findBookIndex(name) {
    if (!bibleData || !name) return -1;
    var wanted = String(name).toLowerCase()
      .replace(/\b(i|ii|iii)\b/g, function (m) { return { i: '1', ii: '2', iii: '3' }[m]; })
      .replace(/[^a-z0-9]/g, '');
    for (var i = 0; i < bibleData.length; i++) {
      var canonical = String(EWC.bookName(bibleData, i)).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (canonical === wanted) return i;
    }
    // Fall back to a starts-with match so "Psalm" still finds "Psalms".
    for (var j = 0; j < bibleData.length; j++) {
      var short = String(EWC.bookName(bibleData, j)).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (short && (short.indexOf(wanted) === 0 || wanted.indexOf(short) === 0)) return j;
    }
    return -1;
  }

  /** Loads an AI-resolved reference into the preview. Clamps to the real text,
   *  fills the picker, and previews it — still launch-gated like any new
   *  reference, so the operator reviews before it goes up. */
  function applyFoundVerse(reference) {
    var bookIndex = findBookIndex(reference.book);
    if (bookIndex < 0) {
      setScriptureAiStatus('Found “' + reference.book + '” but it is not in this Bible text.', true);
      return false;
    }
    var book = bibleData[bookIndex];
    var chapter = Math.min(Math.max(reference.chapter || 1, 1), book.chapters.length);
    var verses = book.chapters[chapter - 1];
    var verse = Math.min(Math.max(reference.verse || 1, 1), verses.length);

    preview.scriptureBookIndex = bookIndex;
    preview.scriptureChapter = chapter;
    preview.scriptureVerse = verse;
    renderScripture();
    setMode('scripture');
    afterPreviewChange();

    var label = EWC.bookName(bibleData, bookIndex) + ' ' + chapter + ':' + verse;
    setScriptureAiStatus('Found ' + label + ' — review it, then press Launch.' +
      (reference.note ? ' ' + reference.note : ''));
    return true;
  }

  function searchVerseWithAi() {
    var query = el.scriptureAiInput.value.trim();
    if (!query) { setScriptureAiStatus('Type what you remember about the verse first.', true); return; }
    if (!bibleData) { setScriptureAiStatus('The Bible text is still loading.', true); return; }

    el.scriptureAiBtn.disabled = true;
    setScriptureAiStatus('Searching…');
    aiGenerate(AI_TEXT_MODEL, {
      contents: [{
        parts: [{
          text: 'You identify Bible verses from the King James Version. A church operator is looking for one ' +
            'exact verse. They may give a phrase, a partial quote, a reference like "Esther 8:9", or describe ' +
            'the story. Return the single best matching verse as JSON with the full KJV book name, chapter and ' +
            'verse as integers. If only a book and chapter are given, choose verse 1. Query: ' + query
        }]
      }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: AI_VERSE_SCHEMA }
    }).then(function (data) {
      var text = aiFirstText(data);
      var reference;
      try { reference = JSON.parse(text); } catch (err) { reference = null; }
      if (!reference || !reference.book) {
        setScriptureAiStatus('The AI could not identify a verse from that. Try rephrasing.', true);
        return;
      }
      applyFoundVerse(reference);
    }).catch(function (err) {
      setScriptureAiStatus('Verse search failed: ' + err.message, true);
    }).finally(function () {
      el.scriptureAiBtn.disabled = false;
    });
  }

  el.scriptureAiBtn.addEventListener('click', searchVerseWithAi);
  el.scriptureAiInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); searchVerseWithAi(); }
  });

  /* -- 9b(ii) Text polish ---------------------------------------------------
     Tidies the typed text without changing its meaning. Em dashes are banned
     outright (both the literal character and the "--" substitute) because they
     read badly on the projection. */

  function setTextPolishStatus(message, isError) {
    el.textPolishStatus.textContent = message || '';
    el.textPolishStatus.style.color = isError ? 'var(--sunrise-orange)' : '';
  }

  function stripEmDashes(text) {
    return text
      .replace(/\s*[\u2014\u2013]\s*/g, ', ')   // em dash / en dash → comma
      .replace(/\s*--\s*/g, ', ')               // the typed "--" substitute
      .replace(/,\s*,/g, ',')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function polishTextWithAi() {
    var raw = el.textBodyInput.value.trim();
    if (!raw) { setTextPolishStatus('Type some text first, then polish it.', true); return; }

    el.textPolishBtn.disabled = true;
    setTextPolishStatus('Polishing…');
    aiGenerate(AI_TEXT_MODEL, {
      contents: [{
        parts: [{
          text: 'Polish the following text for display on a church projection screen. Fix spelling, grammar ' +
            'and punctuation, and make it read smoothly, but keep the meaning and the wording as close to the ' +
            'original as possible. Do not add quotation marks or commentary. Do not use em dashes or en dashes ' +
            'anywhere; use commas or full stops instead. Return only the polished text.\n\n' + raw
        }]
      }]
    }).then(function (data) {
      var polished = stripEmDashes(aiFirstText(data));
      if (!polished) { setTextPolishStatus('The AI returned nothing to use.', true); return; }
      el.textBodyInput.value = polished;
      preview.text.body = polished;
      afterPreviewChange();
      setTextPolishStatus('Polished — review it, then Launch.');
    }).catch(function (err) {
      setTextPolishStatus('Polish failed: ' + err.message, true);
    }).finally(function () {
      el.textPolishBtn.disabled = false;
    });
  }

  el.textPolishBtn.addEventListener('click', polishTextWithAi);

  /* -- 9b(iii) AI image generation -----------------------------------------
     Used both for the background photo and for the Media panel. The generated
     image is stored through exactly the same paths as an uploaded file, so the
     display cannot tell the difference. */

  /** Prompts for an image and resolves with a Blob, or rejects. */
  function generateImage(prompt) {
    return aiGenerate(AI_IMAGE_MODEL, {
      contents: [{ parts: [{ text: prompt + '. Do not include any text, letters or watermarks in the image.' }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
    }).then(function (data) {
      var image = aiFirstImage(data);
      if (!image) throw new Error('the AI did not return an image (this model may be out of quota)');
      return aiImageBlob(image);
    });
  }

  function setBgAiStatus(message, isError) {
    el.bgAiStatus.textContent = message || '';
    el.bgAiStatus.style.color = isError ? 'var(--sunrise-orange)' : '';
  }

  function generateBackgroundWithAi() {
    var prompt = el.bgAiPrompt.value.trim();
    if (!prompt) { setBgAiStatus('Describe the background you want first.', true); return; }

    el.bgAiBtn.disabled = true;
    setBgAiStatus('Generating…');
    generateImage(prompt).then(function (blob) {
      return bakeBackground(blob).then(function (buffer) {
        if (buffer.byteLength > MAX_BG_BYTES) throw new Error('the generated image is too large');
        return EWC.putBackgroundImage(buffer).then(function () {
          send({ type: 'background', buffer: buffer });
          if (previewReady && previewWindow) previewWindow.__ewcPreview.backgroundBuffer(buffer);
        });
      });
    }).then(function () {
      setBgAiStatus('Background generated and applied.');
    }).catch(function (err) {
      setBgAiStatus('Image generation failed: ' + err.message, true);
    }).finally(function () {
      el.bgAiBtn.disabled = false;
    });
  }

  el.bgAiBtn.addEventListener('click', generateBackgroundWithAi);
  el.bgAiPrompt.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); generateBackgroundWithAi(); }
  });

  function generateMediaWithAi() {
    var prompt = el.mediaAiPrompt.value.trim();
    if (!prompt) { setMediaStatus('Describe the image you want first.'); return; }

    el.mediaAiBtn.disabled = true;
    setMediaStatus('Generating an image…');
    generateImage(prompt).then(function (blob) {
      var name = 'AI image — ' + prompt.slice(0, 40);
      return EWC.putForegroundMedia({ kind: 'image', mime: blob.type || 'image/png', name: name, blob: blob })
        .then(function () {
          preview.media = { kind: 'image', mime: blob.type || 'image/png', name: name };
          setMediaStatus('Generated — press Launch to show it.');
          setMode('media');
        });
    }).catch(function (err) {
      setMediaStatus('Image generation failed: ' + err.message);
    }).finally(function () {
      el.mediaAiBtn.disabled = false;
    });
  }

  el.mediaAiBtn.addEventListener('click', generateMediaWithAi);
  el.mediaAiPrompt.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); generateMediaWithAi(); }
  });

  /* ==========================================================================
     10. SONGS
     ========================================================================== */

  function loadSongs() {
    songs = EWC.getSongs(SONGS_KEY);
  }

  function saveSongs() {
    try {
      localStorage.setItem(SONGS_KEY, JSON.stringify(songs));
      return true;
    } catch (err) {
      console.warn('Could not save songs:', err);
      setSongStatus('Could not save — this browser’s storage is full.');
      return false;
    }
  }

  function setSongStatus(message) {
    el.songStatus.textContent = message || '';
    el.songStatus.style.display = message ? 'block' : 'none';
  }

  function makeSongId() {
    return 'song-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  function renderSongList() {
    var query = el.songSearchInput.value.trim().toLowerCase();
    var matches = query
      ? songs.filter(function (song) { return song.title.toLowerCase().indexOf(query) !== -1; })
      : songs.slice();
    matches.sort(function (a, b) { return a.title.localeCompare(b.title); });

    el.songList.innerHTML = '';

    if (!matches.length) {
      var empty = document.createElement('p');
      empty.className = 'song-empty';
      empty.textContent = songs.length
        ? 'No songs match “' + el.songSearchInput.value.trim() + '”.'
        : 'No songs saved yet — add one below.';
      el.songList.appendChild(empty);
      return;
    }

    matches.forEach(function (song) {
      var row = document.createElement('div');
      row.className = 'song-item' + (song.id === preview.activeSongId ? ' is-active' : '');

      var load = document.createElement('button');
      load.type = 'button';
      load.className = 'song-load';
      load.textContent = song.title;
      load.title = 'Preview ' + song.title;
      load.addEventListener('click', function () { showSong(song.id); });

      var edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'song-edit';
      edit.textContent = '\u270E';
      edit.title = 'Edit ' + song.title;
      edit.setAttribute('aria-label', 'Edit ' + song.title);
      edit.addEventListener('click', function () { startEditingSong(song.id); });

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'song-delete';
      remove.textContent = '\u00d7';
      remove.title = 'Delete ' + song.title;
      remove.setAttribute('aria-label', 'Delete ' + song.title);
      remove.addEventListener('click', function () { deleteSong(song.id); });

      row.appendChild(load);
      row.appendChild(edit);
      row.appendChild(remove);
      el.songList.appendChild(row);
    });
  }

  /** Loads a song into the form for editing and remembers which one it is, so
   *  "Save song" updates it in place rather than matching on the title. */
  function startEditingSong(id) {
    var song = songs.find(function (s) { return s.id === id; });
    if (!song) return;
    editingSongId = id;
    el.songTitleInput.value = song.title;
    el.songLyricsInput.value = song.lines.join('\n');
    el.songSaveBtn.textContent = 'Update song';
    setSongStatus('Editing “' + song.title + '”. Save to keep your changes.');
    el.songTitleInput.focus();
    el.songLyricsInput.scrollIntoView({ block: 'nearest' });
  }

  /** Leaves edit mode and clears the form. */
  function resetSongForm() {
    editingSongId = null;
    el.songTitleInput.value = '';
    el.songLyricsInput.value = '';
    el.songSaveBtn.textContent = 'Save song';
  }

  function saveSongFromForm() {
    var title = el.songTitleInput.value.trim();
    var lines = EWC.splitLyricLines(el.songLyricsInput.value);

    if (!title) {
      setSongStatus('Give the song a title first.');
      el.songTitleInput.focus();
      return;
    }
    if (!lines.length) {
      setSongStatus('Add at least one line of lyrics.');
      el.songLyricsInput.focus();
      return;
    }

    // Editing an existing song updates it in place. Otherwise the same title
    // means an edit too, so re-saving updates rather than duplicating.
    var existing = editingSongId
      ? songs.find(function (song) { return song.id === editingSongId; })
      : songs.find(function (song) { return song.title.toLowerCase() === title.toLowerCase(); });
    var song = existing || { id: makeSongId(), title: title, lines: [], updatedAt: 0 };
    var wasEdit = !!existing;
    song.title = title;
    song.lines = lines;
    song.updatedAt = Date.now();
    if (!existing) songs.push(song);
    if (!saveSongs()) return;

    resetSongForm();
    setSongStatus(wasEdit ? 'Updated “' + title + '”.' : 'Saved “' + title + '”.');

    showSong(song.id);
    setMode('lyrics');
    // Exempted from the launch gate: editing the words of a song that is
    // already live updates the screen at once. The operator is looking at the
    // lyric they are fixing, so re-launching every correction is unusable.
    if (liveMatchesMode('lyrics')) pushLive(false);
  }

  function deleteSong(id) {
    songs = songs.filter(function (song) { return song.id !== id; });
    if (preview.activeSongId === id) {
      preview.activeSongId = null;
      preview.lyricLineIndex = 0;
    }
    if (editingSongId === id) resetSongForm();
    saveSongs();
    renderSongList();
    afterPreviewChange();
  }

  /** Makes a song the previewed one, back at its first line. */
  function showSong(id) {
    if (!songs.some(function (song) { return song.id === id; })) return;
    preview.activeSongId = id;
    preview.lyricLineIndex = 0;
    renderSongList();
    setMode('lyrics');
  }

  el.songSearchInput.addEventListener('input', renderSongList);
  el.songSaveBtn.addEventListener('click', saveSongFromForm);
  el.songLyricsInput.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      saveSongFromForm();
    }
  });

  /* ==========================================================================
     11. BACKGROUND IMAGE
     The photo is baked down (so a 12 MP camera JPEG doesn't land in IndexedDB
     and on every wire message) then stored in the shared store and announced.
     This is a live change — the backdrop is immediate, never "launched".
     ========================================================================== */

  var MAX_BG_EDGE = 2560;
  var MAX_BG_BYTES = 5 * 1024 * 1024;

  /** Redraws the file at a sane size and re-encodes it as JPEG/PNG. */
  function bakeBackground(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var image = new Image();
      image.onload = function () {
        URL.revokeObjectURL(url);
        var scale = Math.min(1, MAX_BG_EDGE / Math.max(image.width, image.height));
        var width = Math.max(1, Math.round(image.width * scale));
        var height = Math.max(1, Math.round(image.height * scale));
        var canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        var ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(image, 0, 0, width, height);
        var mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        canvas.toBlob(function (blob) {
          if (!blob) { reject(new Error('Could not encode the image')); return; }
          blob.arrayBuffer().then(resolve, reject);
        }, mime, 0.85);
      };
      image.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Could not read the image'));
      };
      image.src = url;
    });
  }

  el.bgFileInput.addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    el.bgFileInput.value = '';
    if (!file || file.type.indexOf('image/') !== 0) return;

    bakeBackground(file).then(function (buffer) {
      if (buffer.byteLength > MAX_BG_BYTES) {
        throw new Error('that image is still ' + Math.round(buffer.byteLength / 1048576) + ' MB — try a smaller one');
      }
      return EWC.putBackgroundImage(buffer).then(function () {
        var message = { type: 'background', buffer: buffer };
        send(message);
        // The preview iframe is same-origin and is bypassed by the bus, so it
        // gets the bytes directly.
        if (previewReady && previewWindow) previewWindow.__ewcPreview.backgroundBuffer(buffer);
      });
    }).catch(function (err) {
      console.warn('Could not set the background image:', err);
      setSongStatus('Background image: ' + err.message);
    });
  });

  el.chooseImageBtn.addEventListener('click', function () { el.bgFileInput.click(); });

  el.clearImageBtn.addEventListener('click', function () {
    EWC.putBackgroundImage(null).then(function () {
      send({ type: 'background', image: null });
      if (previewReady && previewWindow) previewWindow.__ewcPreview.backgroundBuffer(null);
    }).catch(function (err) { console.warn('Could not clear the background:', err); });
  });

  /** On load, hand the preview whatever backdrop is stored. */
  function primePreviewBackground() {
    EWC.getBackgroundImage().then(function (data) {
      if (data && previewReady && previewWindow) previewWindow.__ewcPreview.backgroundBuffer(data);
    }).catch(function () {});
  }

  /* ==========================================================================
     11b. PANEL CONTENT — text, media and camera
     Every one of these is a panel mode like scripture or lyrics: choosing it
     only updates the preview. Nothing reaches the church screen until Launch
     is pressed, so the operator always reviews it first. Media bytes are
     copied into the shared IndexedDB store and only a descriptor is announced;
     the display reads the bytes back. The camera is a live device stream on
     the display side, so only the mode is announced.
     ========================================================================== */

  var MAX_MEDIA_BYTES = 512 * 1024 * 1024;

  function setMediaStatus(message) {
    el.mediaStatus.textContent = message || '';
    el.mediaStatus.style.display = message ? 'block' : 'none';
  }

  function setCameraStatus(message) {
    el.cameraStatusConsole.textContent = message || '';
  }

  /** Maps a file's MIME type to the display's own media kinds. */
  function mediaKindFor(file) {
    if (file.type.indexOf('image/') === 0) return 'image';
    if (file.type.indexOf('video/') === 0) return 'video';
    if (file.type.indexOf('audio/') === 0) return 'audio';
    return null;
  }

  el.mediaChooseBtn.addEventListener('click', function () { el.mediaFileInput.click(); });

  el.mediaFileInput.addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    el.mediaFileInput.value = '';
    if (!file) return;
    var kind = mediaKindFor(file);
    if (!kind) { setMediaStatus('That file type is not supported — choose an image, video or audio file.'); return; }
    if (file.size > MAX_MEDIA_BYTES) { setMediaStatus('That file is too large to display.'); return; }

    EWC.putForegroundMedia({ kind: kind, mime: file.type, name: file.name, blob: file })
      .then(function () {
        preview.media = { kind: kind, mime: file.type, name: file.name };
        setMediaStatus('Ready — press Launch to show ' + file.name + '.');
        setMode('media'); // preview only; the screen changes on Launch
      })
      .catch(function (err) {
        console.warn('Could not store the media:', err);
        setMediaStatus('Could not store that file on this device.');
      });
  });

  el.mediaClearBtn.addEventListener('click', function () {
    EWC.putForegroundMedia(null).catch(function () {});
    preview.media = null;
    setMediaStatus('Media removed.');
    if (preview.mode === 'media') setMode('timer');
  });

  /* --------------------------------------------------------------------------
     YouTube embed

     A pasted YouTube link becomes a descriptor that carries only the video id,
     so nothing large crosses the bus — the display builds the embed itself.
     Accepts the usual shapes: watch?v=, youtu.be/, /embed/, /shorts/, /live/.
     -------------------------------------------------------------------------- */

  /** Extracts an 11-character YouTube video id from a pasted URL, or null. */
  function parseYouTubeId(url) {
    if (!url) return null;
    var match = String(url).trim().match(
      /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    if (match) return match[1];
    // A bare id is accepted too, so the operator can paste just the code.
    return /^[A-Za-z0-9_-]{11}$/.test(String(url).trim()) ? String(url).trim() : null;
  }

  el.mediaYoutubeBtn.addEventListener('click', function () {
    var id = parseYouTubeId(el.mediaYoutubeInput.value);
    if (!id) { setMediaStatus('That does not look like a YouTube link.'); return; }
    // YouTube is streamed by the display from the id, so no bytes are stored.
    EWC.putForegroundMedia(null).catch(function () {});
    preview.media = { kind: 'youtube', id: id, name: 'YouTube video' };
    el.mediaYoutubeInput.value = '';
    setMediaStatus('YouTube video ready — press Launch to play it.');
    setMode('media');
  });

  el.mediaYoutubeInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); el.mediaYoutubeBtn.click(); }
  });

  /* --------------------------------------------------------------------------
     Camera picker

     A machine can have several cameras (a built-in webcam, a USB capture card,
     an HDMI feed). The console lists them and sends only the chosen deviceId;
     the display opens that device. With exactly one camera there is nothing to
     choose, so it is selected silently; with several, none is chosen until the
     operator picks one, rather than quietly defaulting to the first.

     Real hardware only reveals device names (and stable ids) once camera
     permission has been granted, so entering Camera mode asks for it once — a
     single prompt, not one per launch — then re-lists with proper names.
     -------------------------------------------------------------------------- */

  var cameraDevices = [];

  /** Describes a camera for the picker; falls back to a positional label when
   *  the browser has not revealed the real name (no permission yet). */
  function cameraLabel(device, index) {
    return device.label || 'Camera ' + (index + 1);
  }

  function setCameraDeviceHint(message) {
    el.cameraDeviceHint.textContent = message;
  }

  /** Fills the picker from the current camera list, preserving the operator's
   *  choice where the device is still present. */
  function renderCameraOptions() {
    var select = el.cameraDeviceSelect;
    select.innerHTML = '';

    if (!cameraDevices.length) {
      var none = document.createElement('option');
      none.value = '';
      none.textContent = 'No camera found';
      select.appendChild(none);
      select.disabled = true;
      setCameraDeviceHint('No camera was found on this device. Plug one in and re-open the Camera panel.');
      return;
    }

    if (cameraDevices.length === 1) {
      // Nothing to choose: adopt the only camera so the display opens it.
      var only = cameraDevices[0];
      preview.cameraDeviceId = only.deviceId || null;
      var onlyOption = document.createElement('option');
      onlyOption.value = only.deviceId || '';
      onlyOption.textContent = cameraLabel(only, 0);
      select.appendChild(onlyOption);
      select.disabled = true;
      setCameraDeviceHint('One camera found — it will be used automatically.');
      return;
    }

    // Several cameras: offer a blank default plus each device. A blank value
    // means "let the display decide", which is the honest starting point.
    var auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'Default camera';
    select.appendChild(auto);

    cameraDevices.forEach(function (device, i) {
      var option = document.createElement('option');
      option.value = device.deviceId || '';
      option.textContent = cameraLabel(device, i);
      select.appendChild(option);
    });

    // Keep the operator's choice if that camera is still connected.
    var stillThere = cameraDevices.some(function (d) { return d.deviceId === preview.cameraDeviceId; });
    if (!stillThere) preview.cameraDeviceId = null;
    select.value = preview.cameraDeviceId || '';
    select.disabled = false;
    setCameraDeviceHint(cameraDevices.length + ' cameras found — choose the one to show, then Launch.');
  }

  /** Reads the connected cameras and refreshes the picker. */
  function refreshCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      el.cameraDeviceSelect.innerHTML = '<option>Camera not available</option>';
      el.cameraDeviceSelect.disabled = true;
      setCameraDeviceHint('This browser cannot list cameras.');
      return Promise.resolve();
    }
    return navigator.mediaDevices.enumerateDevices().then(function (devices) {
      cameraDevices = devices.filter(function (d) { return d.kind === 'videoinput'; });
      renderCameraOptions();
      // The list can settle asynchronously (the first enumerate may precede
      // permission), so persist and repaint any choice it just adopted.
      savePersisted();
      renderPreview();
    }).catch(function (err) {
      console.warn('Could not list cameras:', err);
      setCameraDeviceHint('Could not read the camera list.');
    });
  }

  /** Asks for camera permission once so the device names become available,
   *  then re-lists. The stream is stopped immediately — the display opens the
   *  camera for real when the panel is launched. */
  function primeCameraNames() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    // Only worth prompting when there is actually a choice to present: with
    // one camera (or none) the picker needs no names.
    if (cameraDevices.length <= 1) return;
    if (cameraDevices.every(function (d) { return d.label; })) return;
    navigator.mediaDevices.getUserMedia({ video: true }).then(function (stream) {
      stream.getTracks().forEach(function (track) { track.stop(); });
      return refreshCameras();
    }).catch(function () {
      // Refused: the ids are still usable, so leave whatever the picker has.
    });
  }

  el.cameraDeviceSelect.addEventListener('change', function () {
    preview.cameraDeviceId = el.cameraDeviceSelect.value || null;
    savePersisted();
    // Switching camera is live once the feed is on the screen — the operator
    // wants the other camera up now, not after another Launch.
    if (liveMatchesMode('camera')) pushLive(false);
  });

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', function () {
      refreshCameras().then(primeCameraNames);
    });
  }

  el.cameraStopBtn.addEventListener('click', function () { setMode('timer'); });

  /* --------------------------------------------------------------------------
     Webpage panel

     The operator types a URL and the display frames it inside the glass panel.
     Only the URL crosses the bus.

     A browser will not frame a page whose server sends X-Frame-Options or a
     frame-ancestors CSP, and most of the web sends one — which is why the
     panel used to come up blank. So the display fetches the page through this
     project's own server (/proxy), which drops those headers and hands the
     page back from our origin; relative links still resolve to the real site
     thanks to a <base> the server injects. The URL bar keeps the address the
     operator typed.
     -------------------------------------------------------------------------- */

  function setWebpageStatus(message, isError) {
    el.webpageStatus.textContent = message || '';
    el.webpageStatus.style.color = isError ? 'var(--sunrise-orange)' : '';
  }

  /** Adds a scheme to a bare host and rejects anything that is not http(s). */
  function normalizeWebpageUrl(raw) {
    var url = String(raw || '').trim();
    if (!url) return null;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try {
      var parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      return parsed.href;
    } catch (err) { return null; }
  }

  function loadWebpage() {
    var url = normalizeWebpageUrl(el.webpageUrlInput.value);
    if (!url) { setWebpageStatus('Enter a web address like https://example.com', true); return; }
    el.webpageUrlInput.value = url;
    preview.webpageUrl = url;
    setWebpageStatus('Loaded into the preview — press Launch to show it.');
    setMode('webpage');
  }

  el.webpageGoBtn.addEventListener('click', loadWebpage);
  el.webpageUrlInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); loadWebpage(); }
  });

  /* --------------------------------------------------------------------------
     Driving the framed page from the preview

     The panel is a live page, and the operator wants to scroll it and click
     things in it — a hymn sheet, a YouTube queue, a live score. The console
     puts a transparent sheet over the preview's frame while the webpage panel
     is both previewed and live, catches the scroll and click there, and
     relays each one to the display, which applies it to its own frame. The
     two frames then show the same page at the same place.

     Scroll deltas go as a fraction of the framed viewport so both screens move
     by the same visual amount; a click goes as the clicked element's path from
     the page root, which is size-independent. It only arms when the preview
     *is* what is live, so a preview of a page that has not been launched never
     drives the screen by accident.
     -------------------------------------------------------------------------- */

  function previewCanDriveWebpage() {
    return preview.mode === 'webpage' && !!preview.webpageUrl &&
      live.mode === 'webpage' && !!live.content && !!live.content.url &&
      live.content.url === preview.webpageUrl;
  }

  function syncPreviewProxy() {
    var armed = previewCanDriveWebpage();
    el.previewProxy.hidden = !armed;
    el.previewProxy.classList.toggle('is-armed', armed);
    el.previewInteractiveHint.hidden = !armed;
  }

  // updateLaunchNote runs on every state change and calls this, so the sheet
  // arms and disarms with the launch note rather than on a separate path.
  previewProxySync = syncPreviewProxy;

  /** Sends one preview interaction to the display(s) and to the preview's own
   *  frame, so both move together. */
  function sendWebpageControl(message) {
    message.type = 'webpage-control';
    message.from = sessionId;
    send(message);
    if (previewReady && previewWindow && previewWindow.__ewcPreview) {
      previewWindow.__ewcPreview.control(message);
    }
  }

  el.previewProxy.addEventListener('wheel', function (e) {
    if (!previewCanDriveWebpage()) return;
    e.preventDefault();
    var rect = el.previewProxy.getBoundingClientRect();
    sendWebpageControl({
      action: 'scroll',
      dnx: e.deltaX / (rect.width || 1),
      dny: e.deltaY / (rect.height || 1)
    });
  }, { passive: false });

  /** The element under the operator's pointer inside the preview's framed
   *  page, as a path from the page's root. The proxied page is same-origin, so
   *  the console can identify the exact element; sending that path rather than
   *  a screen position means the event lands on the same element even though
   *  the preview and the projection size the panel differently. */
  function previewFrameHit(clientX, clientY) {
    if (!previewFrame.contentDocument) return null;
    // The event is in the console's coordinates; the preview's own document is
    // a separate coordinate system, so translate across the iframe boundary
    // first, then across the framed page's box inside that document.
    var iframeRect = previewFrame.getBoundingClientRect();
    if (!iframeRect.width || !iframeRect.height) return null;
    var inX = (clientX - iframeRect.left) / iframeRect.width * previewFrame.clientWidth;
    var inY = (clientY - iframeRect.top) / iframeRect.height * previewFrame.clientHeight;
    var frame = previewFrame.contentDocument.getElementById('webpage-frame');
    if (!frame || !frame.contentDocument) return null;
    var rect = frame.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    var localX = (inX - rect.left) / rect.width * frame.clientWidth;
    var localY = (inY - rect.top) / rect.height * frame.clientHeight;
    var node = frame.contentDocument.elementFromPoint(localX, localY);
    var path = [];
    while (node && node.nodeType === 1 && path.length < 64) {
      var parent = node.parentNode;
      if (!parent) break;
      path.unshift(Array.prototype.indexOf.call(parent.children, node));
      node = parent;
    }
    return path.length ? path : null;
  }

  /* A real page reacts to more than a click: menus open on pointerdown, drag
     handles listen for mousedown, hover styles track pointermove. So the sheet
     relays the whole pointer sequence — down, up and move — each addressed to
     the element under the pointer, rather than a lone synthetic click that
     only the simplest buttons would notice. */
  function relayPointer(action, e) {
    if (!previewCanDriveWebpage()) return;
    var path = previewFrameHit(e.clientX, e.clientY);
    if (!path) return;
    sendWebpageControl({ action: action, path: path, button: e.button || 0 });
  }

  el.previewProxy.addEventListener('pointerdown', function (e) { relayPointer('pointerdown', e); });
  el.previewProxy.addEventListener('pointerup', function (e) { relayPointer('pointerup', e); });
  el.previewProxy.addEventListener('click', function (e) { relayPointer('click', e); });

  // Hover moves arrive in a torrent; coalesce them to one relay per frame so
  // the bus carries the position, not every intermediate sample.
  var hoverFrame = null;
  var hoverPoint = null;
  el.previewProxy.addEventListener('pointermove', function (e) {
    if (!previewCanDriveWebpage()) return;
    hoverPoint = { x: e.clientX, y: e.clientY };
    if (hoverFrame) return;
    hoverFrame = requestAnimationFrame(function () {
      hoverFrame = null;
      var p = hoverPoint;
      if (!p || !previewCanDriveWebpage()) return;
      var path = previewFrameHit(p.x, p.y);
      if (!path) return;
      sendWebpageControl({ action: 'pointermove', path: path });
    });
  });

  /* ==========================================================================
     12. MODE SWITCHING + TIMER FIELDS
     ========================================================================== */

  function setMode(mode) {
    preview.mode = mode;

    // Only the chosen panel's own controls are shown — no hunting down a long
    // rail for the fields that happen to matter right now.
    ['timer', 'clock', 'scripture', 'lyrics', 'text', 'media', 'camera', 'webpage'].forEach(function (m) {
      var group = document.getElementById(m + '-fields');
      if (group) group.hidden = m !== mode;
    });

    el.modeToggleGroup.querySelectorAll('button').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    // Camera: list the connected cameras and, the first time, ask for
    // permission so their real names appear. Nothing reaches the screen until
    // Launch is pressed.
    if (mode === 'camera') {
      setCameraStatus('Camera panel selected — press Launch to open the chosen camera on the display.');
      refreshCameras().then(primeCameraNames);
    }

    afterPreviewChange();
  }

  el.modeToggleGroup.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-mode]');
    if (btn) setMode(btn.dataset.mode);
  });

  /** "No Panel" removes the glass entirely. It is a launch-gated change like
   *  any panel mode. */
  function setPanelHidden(hidden) {
    preview.panelHidden = hidden;
    el.noPanelToggle.classList.toggle('is-on', hidden);
    el.noPanelToggle.setAttribute('aria-checked', hidden ? 'true' : 'false');
    // With no panel there is nothing to configure, so the panel controls go.
    el.modeFields.hidden = hidden;
    el.modeFieldsNote.hidden = !hidden;
    afterPreviewChange();
  }

  el.noPanelToggle.addEventListener('click', function () { setPanelHidden(!preview.panelHidden); });

  el.textBodyInput.addEventListener('input', function () {
    preview.text.body = el.textBodyInput.value.trim();
    afterPreviewChange();
  });

  el.textTitleInput.addEventListener('input', function () {
    preview.text.title = el.textTitleInput.value.trim();
    afterPreviewChange();
  });

  el.eventNameInput.addEventListener('input', function (e) {
    preview.eventName = e.target.value.trim() || 'Sunday Service';
    afterPreviewChange();
  });

  el.targetDatetimeInput.addEventListener('change', function (e) {
    if (!e.target.value) return;
    preview.targetISO = new Date(e.target.value).toISOString();
    afterPreviewChange();
  });

  el.nextSundayBtn.addEventListener('click', function () {
    var target = EWC.nextSunday9am();
    preview.targetISO = target.toISOString();
    el.targetDatetimeInput.value = EWC.toDatetimeLocalValue(target);
    afterPreviewChange();
  });

  /* ==========================================================================
     13. RECORDING THE LIVE DISPLAY

     A plain browser tool, so it has to work on Windows, macOS and Linux the
     same way. The church screen is a browser page, so there is no OS capture
     API to call: the console asks the browser for the screen with
     getDisplayMedia (the operator picks the monitor the projector is on), and
     MediaRecorder writes it to an MP4 with sound.

     The file goes into a folder the operator picks with the File System Access
     API — showDirectoryPicker — named DD-MM-YYYY-{5 letters}. Recording in
     chunks straight to the chosen folder, rather than holding a two-hour
     service in memory, is what makes a long recording survivable; it also
     means the drive's free space is known, so the console can say how much
     time is left.

     Nothing about this appears on the live display: the indicator and the
     pause/resume/stop controls live on the console only.
     ========================================================================== */

  /* MediaRecorder fallback types, best first. This path is only taken when
     the browser has no WebCodecs encoder to build a proper MP4 with; it writes
     a fragmented MP4 (or WebM) that many players cannot seek. */
  var RECORD_CANDIDATES = [
    { mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', ext: 'mp4' },
    { mime: 'video/mp4;codecs=avc1.4d002a,mp4a.40.2', ext: 'mp4' },
    { mime: 'video/mp4;codecs=h264,aac', ext: 'mp4' },
    { mime: 'video/mp4;codecs=vp9,opus', ext: 'mp4' },
    { mime: 'video/mp4', ext: 'mp4' },
    { mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
    { mime: 'video/webm', ext: 'webm' }
  ];

  /* WebCodecs video codecs, best first. H.264/AAC is the universally playable
     pairing; VP9 is the open-codec stand-in in Chromium builds that lack the
     H.264 encoder (both mux into a standards-compliant MP4). */
  var WC_VIDEO_CODECS = [
    { codec: 'avc1.42E01E', muxer: 'avc' },
    { codec: 'avc1.4d002a', muxer: 'avc' },
    { codec: 'vp09.00.10.08', muxer: 'vp9' }
  ];
  var WC_AUDIO_CODECS = [
    { codec: 'mp4a.40.2', muxer: 'aac' },
    { codec: 'opus', muxer: 'opus' }
  ];

  // Bits per second used to estimate the file size, hence how long the drive
  // will last. Matched to a quality, 1080p-ish capture of a mostly static
  // screen with audio.
  var REC_VIDEO_BPS = 12000000;
  var REC_AUDIO_BPS = 192000;

  var rec = null;

  function formatClock(totalSeconds) {
    totalSeconds = Math.max(0, Math.floor(totalSeconds));
    var h = Math.floor(totalSeconds / 3600);
    var m = Math.floor((totalSeconds % 3600) / 60);
    var s = totalSeconds % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function formatDuration(totalSeconds) {
    totalSeconds = Math.max(0, Math.floor(totalSeconds));
    var h = Math.floor(totalSeconds / 3600);
    var m = Math.floor((totalSeconds % 3600) / 60);
    var s = totalSeconds % 60;
    if (h) return h + 'h ' + (m < 10 ? '0' : '') + m + 'm';
    if (m) return m + 'm ' + (s < 10 ? '0' : '') + s + 's';
    return s + 's';
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 MB';
    if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  }

  /** The first MediaRecorder type this browser can write, used only when
   *  WebCodecs is unavailable. */
  function pickRecorderType() {
    if (typeof MediaRecorder === 'undefined') return null;
    for (var i = 0; i < RECORD_CANDIDATES.length; i += 1) {
      var candidate = RECORD_CANDIDATES[i];
      try {
        if (MediaRecorder.isTypeSupported(candidate.mime)) return candidate;
      } catch (err) { /* some builds throw instead of answering */ }
    }
    return null;
  }

  function canUseWebCodecs() {
    return typeof window.VideoEncoder === 'function' &&
      typeof window.AudioEncoder === 'function' &&
      typeof window.MediaStreamTrackProcessor === 'function' &&
      typeof window.VideoFrame === 'function' &&
      typeof window.Mp4Muxer === 'object';
  }

  /** True when every candidate resolves to something this browser can encode.
   *  Used to tell "the browser has no H.264 encoder" from "there is no encoder
   *  at all", so the operator gets a useful note rather than a bare failure. */
  function webCodecsUnavailableError() {
    var e = new Error('This browser has no usable video encoder for recording.');
    e.name = 'NotSupportedError';
    return e;
  }

  /** Picks the capture size and frame rate, kept even for the encoder. */
  function pickVideoConfig(track) {
    var settings = (track && track.getSettings) ? track.getSettings() : {};
    var width = settings.width || 1280;
    var height = settings.height || 720;
    var frameRate = Math.min(30, Math.round(settings.frameRate || 30));
    // Encoders dislike odd dimensions; keep the capture's aspect but even.
    width -= width % 2;
    height -= height % 2;
    return { width: width, height: height, frameRate: frameRate };
  }

  /** Picks a video encoder + muxer codec pair the browser supports, together
   *  with the capture size. H.264 is preferred where present; VP9 is the
   *  fallback, and both mux into a standard MP4. */
  function chooseWebCodecsConfig(track) {
    if (typeof window.VideoEncoder === 'undefined' || typeof window.VideoEncoder.isConfigSupported !== 'function') {
      return Promise.reject(webCodecsUnavailableError());
    }
    var size = pickVideoConfig(track);
    var attempts = WC_VIDEO_CODECS.map(function (video) {
      return VideoEncoder.isConfigSupported({
        codec: video.codec,
        width: size.width,
        height: size.height,
        bitrate: REC_VIDEO_BPS,
        framerate: size.frameRate
      }).then(function (res) {
        return res && res.supported ? { video: video, config: res.config } : null;
      }).catch(function () { return null; });
    });
    return Promise.all(attempts).then(function (results) {
      var found = null;
      for (var i = 0; i < results.length; i += 1) { if (results[i]) { found = results[i]; break; } }
      if (!found) throw webCodecsUnavailableError();
      found.width = size.width;
      found.height = size.height;
      found.frameRate = size.frameRate;
      return found;
    });
  }

  /** A usable audio encoder + muxer codec pair, or null for a silent
   *  recording. The channel count and sample rate are taken from the captured
   *  track: an encoder configured for more channels than the AudioData carries
   *  refuses every buffer ("incompatible with codec parameters"), which would
   *  leave a silent audio track. Never rejects: losing the audio must not lose
   *  the video. */
  function chooseAudioCodec(track) {
    if (typeof window.AudioEncoder === 'undefined' || typeof window.AudioEncoder.isConfigSupported !== 'function') {
      return Promise.resolve(null);
    }
    var settings = (track && track.getSettings) ? track.getSettings() : {};
    var channels = settings.channelCount || 2;
    var sampleRate = settings.sampleRate || 48000;
    var attempts = WC_AUDIO_CODECS.map(function (audio) {
      return AudioEncoder.isConfigSupported({
        codec: audio.codec, sampleRate: sampleRate, numberOfChannels: channels, bitrate: 128000
      }).then(function (res) {
        return res && res.supported
          ? { audio: audio, config: res.config, channels: channels, sampleRate: sampleRate }
          : null;
      }).catch(function () { return null; });
    });
    return Promise.all(attempts).then(function (results) {
      for (var i = 0; i < results.length; i += 1) { if (results[i]) return results[i]; }
      return null;
    });
  }

  /** "DD-MM-YYYY-abcde" — the day the recording started, plus five random
   *  letters so two recordings in a day never collide. */
  function recordingFolderName(when) {
    var d = when.getDate();
    var m = when.getMonth() + 1;
    var letters = 'abcdefghijklmnopqrstuvwxyz';
    var suffix = '';
    for (var i = 0; i < 5; i += 1) suffix += letters.charAt(Math.floor(Math.random() * 26));
    return (d < 10 ? '0' : '') + d + '-' + (m < 10 ? '0' : '') + m + '-' + when.getFullYear() + '-' + suffix;
  }

  function recordingFileName(when, ext) {
    var d = when.getDate();
    var m = when.getMonth() + 1;
    var hh = when.getHours();
    var mm = when.getMinutes();
    var ss = when.getSeconds();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return 'display-' + when.getFullYear() + '-' + p(m) + '-' + p(d) + '_' + p(hh) + p(mm) + p(ss) + '.' + ext;
  }

  function setRecStatus(message, isError) {
    if (!el.recStatus) return;
    el.recStatus.textContent = message || '';
    el.recStatus.hidden = !message;
    el.recStatus.dataset.state = isError ? 'error' : 'info';
  }

  function setRecordButton(active, paused) {
    if (!el.recordBtn) return;
    el.recordBtn.classList.toggle('is-recording', !!active);
    el.recordBtn.textContent = active ? (paused ? '❙❙ Recording paused' : '● Recording…') : '● Record';
  }

  function setRecTransport(state) {
    if (!el.recPanel) return;
    el.recPanel.hidden = !state;
    if (!state) { el.recWhere.textContent = ''; return; }
    el.recPanel.dataset.state = state === 'paused' ? 'paused' : 'recording';
    el.recPauseBtn.textContent = state === 'paused' ? 'Resume' : 'Pause';
  }

  /** Free space left for the recording, and how long that is at the current
   *  bitrate. The directory handle itself does not report the drive's free
   *  space, so the browser's own estimate for this origin stands in for it —
   *  it is the space the recording actually has to live in. */
  function updateRecRemaining() {
    if (!rec || !el.recLeft) return;
    if (!rec.freeBytes) { el.recLeft.textContent = 'Space left: unknown'; return; }
    var bytesPerSecond = (REC_VIDEO_BPS + REC_AUDIO_BPS) / 8;
    el.recLeft.textContent = 'Space left: about ' + formatDuration(rec.freeBytes / bytesPerSecond) +
      ' (' + formatBytes(rec.freeBytes) + ')';
  }

  function refreshFreeSpace() {
    if (!rec || !navigator.storage || !navigator.storage.estimate) return Promise.resolve();
    return navigator.storage.estimate().then(function (estimate) {
      if (!rec) return;
      rec.freeBytes = Math.max(0, (estimate.quota || 0) - (estimate.usage || 0));
      updateRecRemaining();
      updateStorageWarning();
    }).catch(function () {});
  }

  function startRecTicker() {
    stopRecTicker();
    rec.tick = setInterval(function () {
      if (!rec) return;
      el.recTime.textContent = formatClock((Date.now() - rec.startedAt - rec.pausedTotal) / 1000);
      if (rec.state === 'recording') refreshFreeSpace();
    }, 1000);
  }

  function stopRecTicker() {
    if (rec && rec.tick) { clearInterval(rec.tick); rec.tick = null; }
  }

  function updateStorageWarning() {
    if (!rec) return;
    var bytesPerSecond = (REC_VIDEO_BPS + REC_AUDIO_BPS) / 8;
    var seconds = rec.freeBytes ? rec.freeBytes / bytesPerSecond : 0;
    if (seconds && seconds < 300) {
      setRecStatus('Low on space — about ' + formatDuration(seconds) + ' of recording left on the chosen drive.', true);
    } else {
      setRecStatus(rec.note || '');
    }
  }

  function recordFailure(err) {
    stopRecTicker();
    if (rec && rec.mode === 'mediarecorder' && rec.recorder && rec.recorder.state !== 'inactive') {
      try { rec.recorder.stop(); } catch (stopErr) { /* already gone */ }
    }
    if (rec && rec.mode === 'webcodecs') {
      // Release the encoders and the file rather than leaving them half-open.
      [rec.videoEncoder, rec.audioEncoder].forEach(function (enc) {
        if (enc && enc.state !== 'closed') { try { enc.close(); } catch (e) {} }
      });
      if (rec.writer) { try { rec.writer.close(); } catch (e) {} }
    }
    if (rec && rec.stream) rec.stream.getTracks().forEach(function (t) { t.stop(); });
    var name = err && err.name;
    if (name === 'NotAllowedError') {
      setRecStatus('Recording was cancelled — no screen was shared.', true);
    } else if (name === 'NotSupportedError') {
      setRecStatus('This browser cannot record the screen.', true);
    } else if (name === 'AbortError') {
      setRecStatus('The folder picker was dismissed — recording was not started.', true);
    } else {
      setRecStatus('Could not start recording: ' + ((err && err.message) || err), true);
    }
    rec = null;
    setRecTransport(null);
    setRecordButton(false, false);
  }

  function startRecording() {
    if (rec) return; // already running; the Stop button is how you end it

    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      setRecStatus('This browser cannot capture the screen. Chrome, Edge, Firefox or Safari on a desktop can.', true);
      return;
    }
    if (typeof window.showDirectoryPicker !== 'function') {
      setRecStatus('Saving straight to a folder needs the File System Access API — open this console in Chrome or ' +
        'Edge on a desktop. (Safari and Firefox can play the display but cannot record it to a folder.)', true);
      return;
    }
    // WebCodecs lets us write a *proper* MP4: a single moov with a real
    // duration and a sample index, which every player can seek. MediaRecorder
    // (the fallback) writes a live fragmented MP4 that many players refuse to
    // seek. Prefer the former wherever the browser can do it.
    var useWebCodecs = canUseWebCodecs();
    if (!useWebCodecs && !pickRecorderType()) {
      setRecStatus('This browser cannot record video at all.', true);
      return;
    }

    // Both the folder picker and the screen picker need a user gesture. Ask
    // for the folder first — that is the choice the operator made — then for
    // the screen. A rejection at either step cancels cleanly.
    window.showDirectoryPicker({ mode: 'readwrite', id: 'ewc-display-recordings' })
      .then(function (dir) { return openRecording(dir, useWebCodecs); })
      .catch(recordFailure);
  }

  function openRecording(dir, useWebCodecs) {
    var startedAt = new Date();
    var run = {
      startedAt: startedAt,
      folderName: recordingFolderName(startedAt),
      fileName: recordingFileName(startedAt, 'mp4'),
      dir: dir, folder: null, written: 0,
      freeBytes: null, pausedTotal: 0, pausedAt: null, state: 'starting',
      stream: null, tick: null, note: '',
      stopRequested: false, finished: false,
      mode: useWebCodecs ? 'webcodecs' : 'mediarecorder',
      // WebCodecs pipeline
      muxer: null, writer: null, videoEncoder: null, audioEncoder: null,
      videoReader: null, audioReader: null, videoDone: null, audioDone: null,
      hasAudio: false, pausedMicros: 0, pauseWallAt: null, forceKeyFrame: false,
      lastVideoTs: -1, lastAudioTs: -1,
      // MediaRecorder fallback
      type: null, recorder: null, chunks: [], persistedBytes: 0, flushPromise: null
    };
    rec = run;

    // Create the dated folder inside the one the operator chose, then start
    // capturing. Every step reports its own failure so a refused screen share
    // is not reported as a folder problem, and vice versa.
    return dir.getDirectoryHandle(run.folderName, { create: true })
      .then(function (folder) {
        run.folder = folder;
        return navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 30 },
          audio: true,
          // Ask for the whole screen, so the projector's monitor is captured
          // full screen rather than one window.
          preferCurrentTab: false,
          selfBrowserSurface: 'exclude',
          surfaceSwitching: 'include',
          systemAudio: 'include'
        });
      })
      .then(function (stream) {
        if (!rec) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        run.stream = stream;
        // The operator can also stop sharing from the browser's own bar; that
        // ends the recording exactly as the Stop button does.
        stream.getVideoTracks().forEach(function (track) {
          track.addEventListener('ended', function () { if (rec) stopRecording(); });
        });
        return beginCapture(run);
      })
      .catch(recordFailure);
  }

  /** Starts whichever pipeline the run was set up for. If WebCodecs turns out
   *  to have no usable encoder after all, fall back to MediaRecorder on the
   *  same stream rather than failing the recording outright. */
  function beginCapture(run) {
    if (run.mode !== 'webcodecs') return startMediaRecorder(run);
    return startWebCodecs(run).catch(function (err) {
      if (rec !== run || run.started) throw err;
      return startMediaRecorder(run);
    });
  }

  function markRecordingStarted(run, note) {
    run.state = 'recording';
    run.started = true;
    run.note = note;
    el.recWhere.textContent = run.folderName + '/' + run.fileName;
    setRecTransport('recording');
    setRecordButton(true, false);
    setRecStatus(note);
    startRecTicker();
    refreshFreeSpace();
  }

  /* ---------------------------------------------------------------- WebCodecs

     The screen's video and audio frames are pulled with
     MediaStreamTrackProcessor and fed to a VideoEncoder / AudioEncoder. The
     encoded chunks are muxed into a plain MP4 with mp4-muxer, which writes a
     single moov carrying the real duration and the full sample table — the
     seekable file MediaRecorder cannot produce. Slices are flushed to the
     chosen folder as they are made, so memory stays flat for a long service. */

  function startWebCodecs(run) {
    var videoTrack = run.stream.getVideoTracks()[0];
    if (!videoTrack) throw webCodecsUnavailableError();
    return chooseWebCodecsConfig(videoTrack).then(function (cfg) {
      if (rec !== run) return;
      return chooseAudioCodec(run.stream.getAudioTracks()[0]).then(function (audioChoice) {
        if (rec !== run) return;
        return buildWebCodecsPipeline(run, cfg, audioChoice);
      });
    });
  }

  function buildWebCodecsPipeline(run, cfg, audioChoice) {
    var audioTrack = run.stream.getAudioTracks()[0];
    if (!audioChoice || !audioTrack) audioChoice = null;

    var video = { codec: cfg.video.muxer, width: cfg.width, height: cfg.height, frameRate: cfg.frameRate };
    var audio = audioChoice
      ? { codec: audioChoice.audio.muxer, numberOfChannels: audioChoice.channels, sampleRate: audioChoice.sampleRate }
      : undefined;

    return run.folder.getFileHandle(run.fileName, { create: true })
      .then(function (handle) { return handle.createWritable(); })
      .then(function (writable) {
        if (rec !== run) { try { writable.close(); } catch (e) {} return; }
        run.writer = writable;
        run.muxer = new window.Mp4Muxer.Muxer({
          target: new window.Mp4Muxer.FileSystemWritableFileStreamTarget(writable, { chunkSize: 8 * 1024 * 1024 }),
          video: video,
          audio: audio,
          // A plain (non-fragmented) MP4 with the sample index in one moov.
          // MediaRecorder's fragments have no duration and no seek index, which
          // is why players refused to scrub. The moov is written at the end
          // here: every slice streams to the chosen folder as it is made, so a
          // two-hour service never piles up in memory, and a local player reads
          // the moov from the end of the file to seek.
          fastStart: false,
          // Each track is offset independently so its own first sample is zero.
          // The screen's video timestamps and the audio's come from different
          // clocks, so a shared (cross-track) offset would yank one track's
          // second sample seconds away from its first and stretch the file.
          firstTimestampBehavior: 'offset'
        });

        run.videoEncoder = new VideoEncoder({
          output: function (chunk, meta) { onWebCodecsChunk(run, chunk, meta, true); },
          error: function (e) { recordFailure(e); }
        });
        run.videoEncoder.configure(cfg.config);

        if (audio) {
          run.audioEncoder = new AudioEncoder({
            output: function (chunk, meta) { onWebCodecsChunk(run, chunk, meta, false); },
            // An audio glitch must never take the video down with it.
            error: function () { run.hasAudio = false; }
          });
          run.audioEncoder.configure(audioChoice.config);
          run.hasAudio = true;
        }

        startCapturePumps(run);
        markRecordingStarted(run, 'Recording the live display. Keep this console window open, and do not close the browser.');
      });
  }

  function onWebCodecsChunk(run, chunk, meta, isVideo) {
    if (!run.muxer) return;
    // Rebase against the wall-clock time spent paused, so the file has no gap.
    // The encoder re-times its output, so the chunk's own timestamp is already
    // monotonic in the capture clock and needs no input-to-output lookup.
    var rebased = chunk.timestamp - run.pausedMicros;
    // A chunk the encoder buffered before a pause can surface after it with a
    // timestamp now behind the one already written; skip it rather than throw.
    if (isVideo) {
      if (rebased <= run.lastVideoTs) return;
      run.lastVideoTs = rebased;
    } else {
      if (rebased <= run.lastAudioTs) return;
      run.lastAudioTs = rebased;
    }
    run.written += chunk.byteLength || 0;
    try {
      if (isVideo) run.muxer.addVideoChunk(chunk, meta, rebased);
      else run.muxer.addAudioChunk(chunk, meta, rebased);
    } catch (err) { /* finalize raced the last chunk */ }
  }

  function startCapturePumps(run) {
    var vproc = new MediaStreamTrackProcessor({ track: run.stream.getVideoTracks()[0] });
    run.videoReader = vproc.readable.getReader();
    run.videoDone = pumpVideo(run);
    if (run.hasAudio) {
      var aproc = new MediaStreamTrackProcessor({ track: run.stream.getAudioTracks()[0] });
      run.audioReader = aproc.readable.getReader();
      run.audioDone = pumpAudio(run);
    }
  }

  /** Reads one video frame at a time and encodes it, never letting the encoder
   *  queue run away. Frames that arrive while paused are dropped, so the pause
   *  leaves no frozen stretch in the file. */
  function pumpVideo(run) {
    var first = true;
    function loop() {
      return run.videoReader.read().then(function (res) {
        if (res.done) return;
        var frame = res.value;
        if (run.state === 'paused' || !run.videoEncoder || run.videoEncoder.state === 'closed') {
          frame.close();
          return loop();
        }
        try { run.videoEncoder.encode(frame, { keyFrame: first || run.forceKeyFrame }); } catch (err) { /* closed */ }
        first = false;
        run.forceKeyFrame = false;
        frame.close();
        if (run.videoEncoder.encodeQueueSize > 8) {
          return new Promise(function (r) { setTimeout(r, 4); }).then(loop);
        }
        return loop();
      }).catch(function () { /* track ended or reader released */ });
    }
    return loop();
  }

  function pumpAudio(run) {
    function loop() {
      return run.audioReader.read().then(function (res) {
        if (res.done) return;
        var data = res.value;
        if (run.state === 'paused' || !run.audioEncoder || run.audioEncoder.state === 'closed') {
          data.close();
          return loop();
        }
        try { run.audioEncoder.encode(data); } catch (err) { /* closed */ }
        data.close();
        if (run.audioEncoder.encodeQueueSize > 16) {
          return new Promise(function (r) { setTimeout(r, 4); }).then(loop);
        }
        return loop();
      }).catch(function () { /* track ended or reader released */ });
    }
    return loop();
  }

  /** Ends a WebCodecs run: stop capture, let the pumps finish, flush the
   *  encoders, write the final moov and close the file. */
  function finishWebCodecs(run) {
    stopRecTicker();
    run.state = 'finishing';
    if (run.stream) run.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    var videoDone = run.videoDone || Promise.resolve();
    var audioDone = run.audioDone || Promise.resolve();
    Promise.all([videoDone, audioDone])
      .then(function () {
        if (run.videoEncoder && run.videoEncoder.state === 'configured') return run.videoEncoder.flush();
      })
      .then(function () {
        if (run.audioEncoder && run.audioEncoder.state === 'configured') return run.audioEncoder.flush();
      })
      .then(function () {
        if (run.muxer) run.muxer.finalize();
        return run.writer ? run.writer.close() : null;
      })
      .then(function () {
        if (rec !== run) return;
        var where = run.folderName + '/' + run.fileName;
        rec = null;
        setRecTransport(null);
        setRecordButton(false, false);
        setRecStatus('Saved ' + where + ' (' + formatBytes(run.written) + ').', false);
      })
      .catch(function (err) { if (rec === run) recordFailure(err); });
  }

  /* ------------------------------------------------- MediaRecorder fallback */

  function startMediaRecorder(run) {
    var type = pickRecorderType();
    if (!type) throw webCodecsUnavailableError();
    run.type = type;
    run.fileName = recordingFileName(run.startedAt, type.ext);
    run.recorder = new MediaRecorder(run.stream, {
      mimeType: type.mime,
      videoBitsPerSecond: REC_VIDEO_BPS,
      audioBitsPerSecond: REC_AUDIO_BPS
    });
    run.recorder.ondataavailable = onRecData;
    run.recorder.onerror = function (e) { recordFailure(e.error || e); };
    run.recorder.onstop = onRecStop;
    // 2s slices: small enough to land on disk steadily, large enough not to
    // grind. Each one is written to the file as it arrives (see onRecData), so
    // a long service never piles up in memory.
    run.recorder.start(2000);
    markRecordingStarted(run, 'Recording the live display. Keep this console window open, and do not close the browser.');
  }

  function onRecData(event) {
    if (!rec || !event.data || !event.data.size) return;
    rec.chunks.push(event.data);
    rec.written += event.data.size;
    flushChunks(); // straight to disk, so a crash loses at most one slice
  }

  /** Pushes everything buffered so far to the chosen folder. Chunks are
   *  written in order, then dropped, so memory never grows with the recording.
   *  A flush in progress is shared rather than started twice — and, because
   *  the drain loops until the buffer is empty, a slice that arrives while a
   *  write is in flight (including the recorder's final one at Stop) is still
   *  written before the returned promise settles. */
  function flushChunks() {
    var run = rec;
    if (!run || !run.folder) return Promise.resolve();
    if (run.flushPromise) return run.flushPromise;

    var drain = function () {
      if (!run.chunks.length) return Promise.resolve();
      var pending = run.chunks;
      run.chunks = [];
      var offset = run.persistedBytes;
      return run.folder.getFileHandle(run.fileName, { create: true })
        .then(function (handle) { return handle.createWritable({ keepExistingData: true }); })
        .then(function (writable) {
          var writeNext = function (i) {
            if (i >= pending.length) return writable.close();
            return writable.write(pending[i]).then(function () {
              offset += pending[i].size;
              run.persistedBytes = offset;
              return writeNext(i + 1);
            });
          };
          return writable.seek(offset).then(function () { return writeNext(0); });
        })
        .then(drain); // pick up anything that arrived while this write ran
    };

    run.flushPromise = drain()
      .catch(function (err) {
        // Writing failed (drive removed, permission revoked, disk full). Stop
        // cleanly and say why rather than pretending the file is safe.
        if (rec === run) recordFailure(err);
      })
      .then(function () { run.flushPromise = null; });
    return run.flushPromise;
  }

  function onRecStop() {
    if (!rec || rec.finished) return;
    rec.finished = true;
    stopRecTicker();
    if (rec.stream) rec.stream.getTracks().forEach(function (t) { t.stop(); });
    var run = rec;
    // The final blob is delivered just before onstop; flush it, then report.
    flushChunks().then(function () {
      if (rec !== run) return;
      var where = run.folderName + '/' + run.fileName;
      rec = null;
      setRecTransport(null);
      setRecordButton(false, false);
      if (run.type.ext !== 'mp4') {
        setRecStatus('Saved ' + where + ' as WebM — this browser has no MP4 encoder, so the extension is honest ' +
          'rather than mislabelled.', true);
      } else {
        setRecStatus('Saved ' + where + ' (' + formatBytes(run.written) + ').', false);
      }
    });
  }

  function pauseRecording() {
    if (!rec || rec.state !== 'recording') return;
    rec.state = 'paused';
    rec.pausedAt = Date.now();
    if (rec.mode === 'mediarecorder') {
      rec.recorder.pause();
    } else {
      rec.pauseWallAt = performance.now();
      // Drain the encoders so their buffered output lands before the pause
      // offset moves; otherwise it surfaces afterwards with a stale timestamp.
      if (rec.videoEncoder && rec.videoEncoder.state === 'configured') rec.videoEncoder.flush().catch(function () {});
      if (rec.audioEncoder && rec.audioEncoder.state === 'configured') rec.audioEncoder.flush().catch(function () {});
    }
    setRecTransport('paused');
    setRecordButton(true, true);
    setRecStatus('Recording paused — the file on disk so far is kept. Resume when you are ready.');
  }

  function resumeRecording() {
    if (!rec || rec.state !== 'paused') return;
    rec.pausedTotal += Date.now() - rec.pausedAt;
    rec.pausedAt = null;
    if (rec.mode === 'mediarecorder') {
      rec.recorder.resume();
    } else {
      // The frames captured while paused were dropped, so shift the timeline
      // back by the wall-clock time spent paused: the gap vanishes instead of
      // leaving a frozen stretch in the file. The first frame back is a fresh
      // keyframe, so seeking into the join stays clean.
      rec.pausedMicros += Math.round((performance.now() - rec.pauseWallAt) * 1000);
      rec.pauseWallAt = null;
      rec.forceKeyFrame = true;
    }
    rec.state = 'recording';
    setRecTransport('recording');
    setRecordButton(true, false);
    setRecStatus('Recording again.');
  }

  function stopRecording() {
    if (!rec || rec.stopRequested) return;
    rec.stopRequested = true;
    if (rec.mode === 'webcodecs') {
      setRecStatus('Finishing the file…', false);
      finishWebCodecs(rec);
      return;
    }
    // A paused recorder still fires onstop (with the final data) when stopped.
    if (rec.recorder && rec.recorder.state !== 'inactive') {
      rec.recorder.stop();
      setRecStatus('Finishing the file…', false);
    } else {
      onRecStop();
    }
  }

  el.recordBtn.addEventListener('click', function () {
    if (rec) { stopRecording(); return; }
    startRecording();
  });
  el.recPauseBtn.addEventListener('click', function () {
    if (!rec) return;
    if (rec.state === 'paused') resumeRecording(); else pauseRecording();
  });
  el.recStopBtn.addEventListener('click', function () { stopRecording(); });

  // Leaving the page tears the capture down; the recorder flushes what it has
  // as the page unloads, so the file is not left empty.
  window.addEventListener('beforeunload', function () {
    if (rec && rec.mode === 'mediarecorder' && rec.recorder && rec.recorder.state !== 'inactive') {
      try { rec.recorder.stop(); } catch (err) {}
    }
  });

  /* ==========================================================================
     15. KEYBOARD SHORTCUTS
     Anything typed into a field is left alone; otherwise ←/→ step verses,
     ↑/↓ step lyric lines, Space launches, and the ‹ › buttons mirror these.
     ========================================================================== */

  document.addEventListener('keydown', function (e) {
    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    if (e.key === 'ArrowLeft' && preview.mode === 'scripture') { e.preventDefault(); stepScripture(-1); }
    else if (e.key === 'ArrowRight' && preview.mode === 'scripture') { e.preventDefault(); stepScripture(1); }
    else if (e.key === 'ArrowUp' && preview.mode === 'lyrics') { e.preventDefault(); stepLyric(-1); }
    else if (e.key === 'ArrowDown' && preview.mode === 'lyrics') { e.preventDefault(); stepLyric(1); }
    else if (e.key === ' ') { e.preventDefault(); pushLive(false); }
  });

  /* ==========================================================================
     16. INIT
     ========================================================================== */

  function init() {
    loadPersisted();
    loadSongs();

    el.eventNameInput.value = preview.eventName;
    el.targetDatetimeInput.value = EWC.toDatetimeLocalValue(new Date(preview.targetISO));
    el.scriptureChapterInput.value = preview.scriptureChapter;
    el.scriptureVerseInput.value = preview.scriptureVerse;
    renderSongList();

    // Panel controls: reflect the restored panel state.
    el.textBodyInput.value = preview.text.body || '';
    el.textTitleInput.value = preview.text.title || '';
    el.noPanelToggle.classList.toggle('is-on', !!preview.panelHidden);
    el.noPanelToggle.setAttribute('aria-checked', preview.panelHidden ? 'true' : 'false');
    el.modeFields.hidden = !!preview.panelHidden;
    el.modeFieldsNote.hidden = !preview.panelHidden;
    if (preview.media && preview.media.name) {
      setMediaStatus('Ready — press Launch to show ' + preview.media.name + '.');
    }
    if (preview.webpageUrl) el.webpageUrlInput.value = preview.webpageUrl;

    // Report the saved AI key (masked) and whether the features are on.
    reflectAiKey();

    // Read the camera list up front so the picker is ready the moment the
    // operator switches to Camera. Permission is only requested when they
    // actually open that panel (setMode), not on every console load.
    refreshCameras();

    // Paint the iframe. It may already be loaded when this runs (cache), in
    // which case the `load` event will never fire again.
    if (previewFrame.contentDocument && previewFrame.contentDocument.readyState === 'complete') {
      onPreviewReady();
    }

    el.modeToggleGroup.querySelectorAll('button').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.mode === preview.mode);
    });
    setMode(preview.mode);
    updateLaunchNote();
    ping();
  }

  init();
})();
