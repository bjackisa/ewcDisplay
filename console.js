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

    previewNote: document.getElementById('preview-note'),
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
     Only the URL crosses the bus. A page that forbids framing (an
     X-Frame-Options / frame-ancestors header) cannot be shown and will stay
     blank; the hint in the console says so.
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
    setWebpageStatus('Loaded into the preview — press Launch to show it. If it stays blank, that site blocks embedding.');
    setMode('webpage');
  }

  el.webpageGoBtn.addEventListener('click', loadWebpage);
  el.webpageUrlInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); loadWebpage(); }
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
     13. KEYBOARD SHORTCUTS
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
     14. INIT
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
