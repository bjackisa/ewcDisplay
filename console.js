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
    cameraDeviceId: null,
    /* Which audio input the recording/stream takes. Null means the system
       default microphone. A DroidCam phone or a mixing desk on the line-in
       jack is just another audioinput here. */
    audioDeviceId: null,
    /* A mixing desk's output is already mixed, so the browser's voice
       processing (echo cancellation, noise suppression, auto-gain) must be off
       for it or it fights the desk. */
    audioLineIn: false
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
    recordBtnLabel: document.getElementById('record-btn-label'),
    recPauseBtn: document.getElementById('rec-pause-btn'),
    recStopBtn: document.getElementById('rec-stop-btn'),
    liveBtn: document.getElementById('live-btn'),
    liveBtnLabel: document.getElementById('live-btn-label'),
    liveStopBtn: document.getElementById('live-stop-btn'),
    rtmpUrlInput: document.getElementById('rtmp-url-input'),
    rtmpKeyInput: document.getElementById('rtmp-key-input'),
    rtmpBackupInput: document.getElementById('rtmp-backup-input'),
    rtmpStatus: document.getElementById('rtmp-status'),
    toastStack: document.getElementById('toast-stack'),

    previewNote: document.getElementById('preview-note'),
    previewProxy: document.getElementById('preview-proxy'),
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
    audioDeviceSelect: document.getElementById('audio-device-select'),
    audioDeviceHint: document.getElementById('audio-device-hint'),
    audioLineInToggle: document.getElementById('audio-linein-toggle'),
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
        cameraDeviceId: preview.cameraDeviceId,
        audioDeviceId: preview.audioDeviceId,
        audioLineIn: preview.audioLineIn
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

  /** Turns the preview state into the `content` payload the display applies. */
  function buildContent(state) {
    var mode = state.mode;
    // The combined views carry the same content as the panel they combine;
    // only the display's rendering differs.
    if (mode === 'scripture-camera') mode = 'scripture';
    else if (mode === 'lyrics-camera') mode = 'lyrics';
    if (mode === 'timer') {
      return { eventName: state.eventName, targetISO: state.targetISO };
    }
    if (mode === 'scripture') {
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
    if (mode === 'lyrics') {
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
      // The two combined views need a camera just as much as the camera panel.
      cameraDeviceId: modeNeedsCamera(state.mode) ? (state.cameraDeviceId || null) : null
    };
  }

  /** Modes that put the live camera on the glass: the camera panel and the two
   *  combined views. */
  function modeNeedsCamera(mode) {
    return mode === 'camera' || mode === 'lyrics-camera' || mode === 'scripture-camera';
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
      cameraDeviceId: modeNeedsCamera(preview.mode) ? (preview.cameraDeviceId || null) : null
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
    var isLive = live.mode !== null && !live.panelHidden && !preview.panelHidden &&
      live.mode === preview.mode &&
      fingerprint(live.mode, live.content, live.panelHidden) ===
        fingerprint(preview.mode, buildContent(preview), preview.panelHidden);
    el.previewNote.textContent = isLive ? 'Live' : 'Not Launched';
    el.previewNote.dataset.state = isLive ? 'live' : 'idle';
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
      setLinkState('ok', 'Display');
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
      if (!Object.keys(displayClients).length) setLinkState('lost', 'Display');
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
    if (!seen) setLinkState('waiting', 'Display');
  }, 2500);

  /* ==========================================================================
     6b. NOTIFICATIONS

     A sandbar that arrives, says one short thing, and leaves on its own. Used
     for the handful of events worth telling the operator about — a recording
     finished, a save failed, a folder was refused — so the design does not
     need a permanent line of prose for each one. Nothing here reaches the
     church screen.
     ========================================================================== */

  var TOAST_MS = 5200;

  function toast(message, isError) {
    if (!el.toastStack || !message) return;
    var node = document.createElement('div');
    node.className = 'toast';
    if (isError) node.dataset.state = 'error';
    node.textContent = message;
    el.toastStack.appendChild(node);
    setTimeout(function () {
      node.classList.add('is-leaving');
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 400);
    }, TOAST_MS);
  }

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
    return modeFamily(live.mode) === modeFamily(mode) &&
      fingerprint(live.mode, live.content, live.panelHidden) ===
      fingerprint(preview.mode, buildContent(preview), preview.panelHidden);
  }

  /** A panel and its combined view are the same family: stepping a verse while
   *  Scripture + Camera is on the glass is the same live move as stepping it on
   *  the plain scripture panel. */
  function modeFamily(mode) {
    if (mode === 'scripture-camera') return 'scripture';
    if (mode === 'lyrics-camera') return 'lyrics';
    return mode;
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
    var family = modeFamily(preview.mode);
    if (family === 'scripture') stepScripture(direction);
    else if (family === 'lyrics') stepLyric(direction);
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
    // Stay in whichever scripture view the operator is working in: finding a
    // verse while Scripture + Camera is on screen must not drop the camera.
    setMode(modeFamily(preview.mode) === 'scripture' ? preview.mode : 'scripture');
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
    // wants the other camera up now, not after another Launch. The combined
    // views show the same feed, so they follow it too.
    if (modeNeedsCamera(live.mode)) pushLive(false);
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

  /** Which control groups a mode needs. The two combined views show the panel
   *  they carry *and* the camera picker, because they need both. */
  function fieldGroupsForMode(mode) {
    if (mode === 'scripture-camera') return ['scripture', 'camera'];
    if (mode === 'lyrics-camera') return ['lyrics', 'camera'];
    return [mode];
  }

  function setMode(mode) {
    preview.mode = mode;

    // Only the chosen panel's own controls are shown — no hunting down a long
    // rail for the fields that happen to matter right now.
    var groups = fieldGroupsForMode(mode);
    ['timer', 'clock', 'scripture', 'lyrics', 'text', 'media', 'camera', 'webpage'].forEach(function (m) {
      var group = document.getElementById(m + '-fields');
      if (group) group.hidden = groups.indexOf(m) < 0;
    });

    el.modeToggleGroup.querySelectorAll('button').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    // Camera: list the connected cameras and, the first time, ask for
    // permission so their real names appear. Nothing reaches the screen until
    // Launch is pressed.
    if (modeNeedsCamera(mode)) {
      setCameraStatus(mode === 'camera'
        ? 'Camera panel selected — press Launch to open the chosen camera on the display.'
        : 'The camera fills the panel and the words sit across the bottom — press Launch to show it.');
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

/* --------------------------------------------------------------------------
   Audio input — the microphone, a phone acting as a wireless mic, or a mixing
   desk on the line-in jack.

   A DroidCam phone's audio arrives as an ordinary `audioinput` once its driver
   or app has registered a virtual device, so it needs no special handling: it
   is in the list and the operator picks it. A desk into the line-in jack is the
   same idea, except that the browser's voice processing must be switched off
   for it — echo cancellation, noise suppression and auto-gain are tuned for a
   laptop mic a metre from a mouth, and against a mixed desk feed they pump the
   level and thin the sound. That is what the Line-in switch does.

   Device names only appear once permission has been granted, so the picker is
   primed with one prompt the first time (the same trade the camera picker
   makes) and then re-listed.
   -------------------------------------------------------------------------- */

var AUDIO_INPUT_KEY = 'ewc-display-audio-input-v1';

function audioConstraints(deviceId, lineIn) {
  var audio = {
    echoCancellation: !lineIn,
    noiseSuppression: !lineIn,
    autoGainControl: !lineIn
  };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return audio;
}

function audioLabel(device, index) {
  return device.label || 'Input ' + (index + 1);
}

function setAudioDeviceHint(message) {
  el.audioDeviceHint.textContent = message;
}

/** Fills the audio picker from the current device list, keeping the operator's
 *  choice where the device is still present. */
function renderAudioOptions() {
  var select = el.audioDeviceSelect;
  if (!select) return;
  select.innerHTML = '';
  var auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'Default input';
  select.appendChild(auto);

  audioDevices.forEach(function (device, i) {
    var option = document.createElement('option');
    option.value = device.deviceId || '';
    option.textContent = audioLabel(device, i);
    select.appendChild(option);
  });

  var stillThere = !preview.audioDeviceId ||
    audioDevices.some(function (d) { return d.deviceId === preview.audioDeviceId; });
  if (!stillThere) preview.audioDeviceId = null;
  select.value = preview.audioDeviceId || '';
  select.disabled = false;

  if (!audioDevices.length) {
    setAudioDeviceHint('No audio input was found — the recording will carry the screen\'s own sound.');
  } else if (audioDevices.length === 1) {
    setAudioDeviceHint('One input found. Plug in a phone (DroidCam) or a mixer and it appears here.');
  } else {
    setAudioDeviceHint(audioDevices.length + ' inputs found — pick the microphone, phone or mixer to record.');
  }
}

function refreshAudioInputs() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    setAudioDeviceHint('This browser cannot list audio inputs.');
    return Promise.resolve();
  }
  return navigator.mediaDevices.enumerateDevices().then(function (devices) {
    audioDevices = devices.filter(function (d) { return d.kind === 'audioinput'; });
    renderAudioOptions();
  }).catch(function (err) {
    console.warn('Could not list audio inputs:', err);
    setAudioDeviceHint('Could not read the audio input list.');
  });
}

/** One prompt so real device names appear, then re-list. Stopped at once: the
 *  capture opens the real input when it starts. */
function primeAudioNames() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  if (audioDevices.length && audioDevices.every(function (d) { return d.label; })) return;
  navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
    stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    return refreshAudioInputs();
  }).catch(function () { /* refused: the ids are still usable */ });
}

function setAudioLineIn(on) {
  preview.audioLineIn = !!on;
  el.audioLineInToggle.classList.toggle('is-on', preview.audioLineIn);
  el.audioLineInToggle.setAttribute('aria-checked', preview.audioLineIn ? 'true' : 'false');
  savePersisted();
}

/** Plays the chosen input for a moment and moves a meter with its level, so
 *  the operator can prove the desk or phone is actually feeding sound before
 *  a service rather than after a silent recording. */
function checkAudioLevel() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setAudioDeviceHint('This browser cannot open an audio input.');
    return;
  }
  var meter = document.getElementById('audio-level-meter');
  var bar = meter && meter.querySelector('span');
  if (meter) meter.hidden = false;
  setAudioDeviceHint('Listening…');
  // The same opener the recording uses, so a device that has gone falls back
  // to the default input here too instead of failing only on the glass.
  requestMic().then(function (result) {
    if (!result) {
      if (meter) meter.hidden = true;
      setAudioDeviceHint('Could not open that input — check the device and its cable.');
      return;
    }
    var stream = result.stream;
    if (result.fellBack) setAudioDeviceHint('That input is gone — listening on the default.');
    var AudioCtor = window.AudioContext || window.webkitAudioContext;
    var context = new AudioCtor();
    var source = context.createMediaStreamSource(stream);
    var analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    var samples = new Uint8Array(analyser.fftSize);
    var peak = 0;
    var ticks = 0;
    var timer = setInterval(function () {
      analyser.getByteTimeDomainData(samples);
      var max = 0;
      for (var i = 0; i < samples.length; i++) {
        max = Math.max(max, Math.abs(samples[i] - 128));
      }
      var level = Math.min(1, max / 96);
      peak = Math.max(peak, level);
      if (bar) bar.style.width = Math.round(level * 100) + '%';
      ticks += 1;
      if (ticks >= 24) {
        clearInterval(timer);
        stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
        try { source.disconnect(); } catch (e) {}
        try { context.close(); } catch (e) {}
        if (bar) bar.style.width = '0%';
        setAudioDeviceHint(peak > 0.04
          ? 'Sound is arriving on this input.'
          : 'No sound arrived — check the device, its cable and its level.');
      }
    }, 100);
  }).catch(function (err) {
    if (meter) meter.hidden = true;
    setAudioDeviceHint('Could not open that input: ' + ((err && err.message) || err));
  });
}

el.audioDeviceSelect.addEventListener('change', function () {
  preview.audioDeviceId = el.audioDeviceSelect.value || null;
  savePersisted();
  // A device switch takes effect on the next recording or stream; an already
  // running one keeps the input it opened, because swapping the track
  // underneath a live encoder would break the file.
  if (rec || air) setAudioDeviceHint('Saved — it applies to the next recording or stream.');
});
el.audioLineInToggle.addEventListener('click', function () { setAudioLineIn(!preview.audioLineIn); });
document.getElementById('audio-test-btn').addEventListener('click', checkAudioLevel);
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', refreshAudioInputs);
}

  /* ==========================================================================
     13. RECORDING THE LIVE DISPLAY

   The church screen is a browser page, so there is no OS capture API to call:
   the console asks the browser for the screen with getDisplayMedia and records
   what comes back. That is what makes it OS-independent — the browser, not the
   operating system, does the capture, so the same code runs on Windows, macOS
   and Linux.

   Three things make the file worth keeping:

     * A 4K canvas. The captured monitor may be 1080p or 1440p, but every frame
       is composited onto a 3840x2160 canvas first, so the file is always the
       same delivery size whatever the operator's screen is.
     * Mixed audio. The microphone and the screen's own audio are summed through
       a Web Audio graph. Screen audio is what the room hears; the microphone is
       what the preacher says. Both matter, so both are in the file, and losing
       either one must not lose the recording.
     * Frequent keyframes. A seekable file needs somewhere to seek *to*. A
       keyframe every second gives a player a clean cut point throughout; one
       keyframe in the whole file — what an unconfigured encoder emits — leaves
       a player that can only start at zero.

   The encode is deliberately allowed to lag the screen: the compositor and
   encoder run behind the live picture by design, and the operator keeps working
   the display while they catch up. On Stop the pumps drain, the encoders flush,
   the sample index (moov) is written and the file is closed; that is the pause
   at the end, and it happens in the background.

   The file goes into a folder the operator picks with showDirectoryPicker,
   named DD-MM-YYYY-{5 letters}. Slices are written to that folder as they are
   made rather than held in memory, so a two-hour service is survivable. The
   moov is written last (fastStart: false), which keeps memory flat and still
   lets a local player seek.
   ========================================================================== */

/* The delivery size, then standard steps down, then whatever the screen offers.
   A build with no 4K encoder records the best size it does have. */
var REC_TARGET_SIZES = [[3840, 2160], [2560, 1440], [1920, 1080]];
var REC_FRAME_RATE = 30;
var REC_VIDEO_BPS = 26000000;
var REC_AUDIO_BPS = 192000;
/* Seconds between keyframes: this is the seek granularity of the finished file. */
var REC_KEYFRAME_SECONDS = 1;
/* The shortest gap between two encoded frames. The muxer times the video track
   in units of REC_FRAME_RATE, so anything closer than one frame period would be
   written with a duplicate decode timestamp. */
var REC_MIN_STEP_MICROS = Math.floor(1000000 / REC_FRAME_RATE);
/* One frame period, used as the duration of a chunk that does not carry one. */
var REC_FRAME_PERIOD_MICROS = Math.floor(1000000 / REC_FRAME_RATE);

/* Streaming. The RTMP relay lives on the server, because no browser can speak
   RTMP; the console encodes the same 4K picture it records and posts the
   fragmented MP4 to /stream, which pipes it into ffmpeg. YouTube takes 4K at
   30fps, so the same delivery size is used. The bitrate is lower than the
   recording's because this one crosses the church's uplink and a saturated
   uplink shows as a stutter to every viewer. */
var STREAM_VIDEO_BPS = 12000000;
var STREAM_AUDIO_BPS = 160000;
/* The stream is encoded at 1080p, not the recording's 4K. Both sinks encode
   the same canvas, and two concurrent 4K encodes saturate a software encoder:
   the shared audio reader is starved, the fragmented muxer's audio/video
   interleave stalls waiting for audio, and the stream freezes on the first
   frame while the recording carries on. 1080p is a quarter of the pixels and
   is more than a projection screen needs; the relay copies the picture
   unchanged. */
var STREAM_TARGET = [1920, 1080];
var STREAM_STATUS_PATH = '/stream/status';
var STREAM_STOP_PATH = '/stream/stop';
var STREAM_PROBE_PATH = '/stream/probe';
/* The relay's upload socket. A streamed `fetch` body needs HTTP/2 and the
   church server is HTTP/1.1, so the encoded MP4 travels in WebSocket frames. */
var STREAM_WS_PATH = '/stream/ws';
/* Fragments are cut at a keyframe this often, so ffmpeg is never more than a
   fragment behind and the relay's own RTMP flush has something to send. */
var STREAM_FRAGMENT_SECONDS = 1;
/* A weak uplink must never end the stream — it must lower the picture until
   it fits. The bitrate ladder is walked down as the relay's send buffer
   grows and back up when it drains, which is what every production encoder
   (OBS, vMix, Wirecast) does with its own adaptive-bitrate controller. The
   floor is deliberately low: a soft, blocky picture is still a service. */
var STREAM_BITRATE_STEPS = [12000000, 8000000, 5000000, 3200000, 2200000, 1500000];
var STREAM_ABR_SOFT_SECONDS = 2.5;   // buffered this far → step the bitrate down
var STREAM_ABR_HARD_SECONDS = 9;     // buffered this far → drop input frames
var STREAM_ABR_RECOVER_SECONDS = 6;  // buffered this low this long → step up
var STREAM_MAX_QUEUE_BYTES = Math.round(STREAM_VIDEO_BPS / 8 * STREAM_ABR_HARD_SECONDS);
/* How long the relay socket may stay closed mid-stream before the operator is
   told, and how many times it is reopened. A church uplink drops for seconds
   at a time; the stream should ride that out, not end. */
var STREAM_RECONNECT_ATTEMPTS = 12;
var STREAM_RECONNECT_MAX_MS = 8000;
/* How much of the fragmented MP4's opening bytes are kept so a reconnected
   relay can be handed the init segment again. ftyp + moov for a stream this
   size is a few kilobytes; the cap is generous and fixed. */
var STREAM_INIT_CAP = 512 * 1024;
var STREAM_KEY_STORAGE = 'ewc-display-rtmp-v1';
var STREAM_DEFAULT_URL = 'rtmp://a.rtmp.youtube.com/live2';
var STREAM_DEFAULT_BACKUP = 'rtmp://b.rtmp.youtube.com/live2?backup=1';

var rec = null;
var air = null;
/* The audio inputs the machine offers. Filled by refreshAudioInputs(). */
var audioDevices = [];
/* The capture both sinks share. One getDisplayMedia, one screen-picker
   prompt, and either sink may come or go without disturbing the other. */
var shared = null;

function formatCompact(totalSeconds) {
  totalSeconds = Math.max(0, Math.floor(totalSeconds));
  var h = Math.floor(totalSeconds / 3600);
  var m = Math.floor((totalSeconds % 3600) / 60);
  var s = totalSeconds % 60;
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return h ? h + ':' + p(m) + ':' + p(s) : p(m) + ':' + p(s);
}

/** "DD-MM-YYYY-abcde" — the day the recording started, plus five random letters
 *  so two recordings in a day never collide. */
function recordingFolderName(when) {
  var d = when.getDate();
  var m = when.getMonth() + 1;
  var letters = 'abcdefghijklmnopqrstuvwxyz';
  var suffix = '';
  for (var i = 0; i < 5; i += 1) suffix += letters.charAt(Math.floor(Math.random() * 26));
  return (d < 10 ? '0' : '') + d + '-' + (m < 10 ? '0' : '') + m + '-' + when.getFullYear() + '-' + suffix;
}

function recordingFileName(when) {
  var d = when.getDate();
  var m = when.getMonth() + 1;
  var hh = when.getHours();
  var mm = when.getMinutes();
  var ss = when.getSeconds();
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return 'display-' + when.getFullYear() + '-' + p(m) + '-' + p(d) + '_' + p(hh) + p(mm) + p(ss) + '.mp4';
}

/* ------------------------------------------------------------------- button

   The Record button is the whole recording UI: a dot, and — while a recording
   is open — the elapsed time over the estimated remaining time. Pause and Stop
   sit beside it as icons and exist only while it does. */

function setRecordButton(state) {
  if (!el.recordBtn) return;
  var active = !!state;
  el.recordBtn.classList.toggle('is-recording', active);
  el.recordBtn.classList.toggle('is-paused', active && state === 'paused');
  el.recPauseBtn.hidden = !active;
  el.recStopBtn.hidden = !active;
  el.recPauseBtn.classList.toggle('is-paused', active && state === 'paused');
  el.recPauseBtn.title = state === 'paused' ? 'Resume' : 'Pause';
  el.recPauseBtn.setAttribute('aria-label', state === 'paused' ? 'Resume recording' : 'Pause recording');
  if (!active) el.recordBtnLabel.textContent = 'Record';
}

/** Elapsed over estimated remaining — "00:42/1:57:00". Remaining is the
 *  browser's own free-space estimate for this origin divided by the encode
 *  bitrate. A page cannot read a drive's real free space, but this is the room
 *  the recording actually has to grow into. */
function refreshRecordLabel() {
  if (!rec || !el.recordBtnLabel) return;
  // A finishing run has already put the button back to rest; a late async
  // free-space estimate must not paint the elapsed time over it again.
  if (rec.state !== 'recording' && rec.state !== 'paused') return;
  var elapsed = (Date.now() - rec.startedAt - rec.pausedTotal) / 1000;
  var remaining = rec.freeBytes
    ? Math.max(0, rec.freeBytes / ((REC_VIDEO_BPS + REC_AUDIO_BPS) / 8))
    : null;
  el.recordBtnLabel.textContent = formatCompact(elapsed) + '/' +
    (remaining === null ? '--:--' : formatCompact(remaining));
  if (remaining !== null && remaining < 300 && !rec.warnedSpace) {
    rec.warnedSpace = true;
    toast('About ' + formatCompact(remaining) + ' of recording space left.', true);
  }
}

function refreshFreeSpace() {
  if (!rec || !navigator.storage || !navigator.storage.estimate) return Promise.resolve();
  return navigator.storage.estimate().then(function (estimate) {
    if (!rec) return;
    rec.freeBytes = Math.max(0, (estimate.quota || 0) - (estimate.usage || 0));
    refreshRecordLabel();
  }).catch(function () {});
}

function startRecTicker() {
  stopRecTicker();
  rec.tick = setInterval(function () {
    if (!rec) return;
    refreshRecordLabel();
    if (rec.state === 'recording') refreshFreeSpace();
  }, 1000);
}

function stopRecTicker() {
  if (rec && rec.tick) { clearInterval(rec.tick); rec.tick = null; }
}

/* --------------------------------------------------------------- capability */

function canUseWebCodecs() {
  return typeof window.VideoEncoder === 'function' &&
    typeof window.AudioEncoder === 'function' &&
    typeof window.MediaStreamTrackProcessor === 'function' &&
    typeof window.VideoFrame === 'function' &&
    typeof window.Mp4Muxer === 'object';
}

/** Which audio codec the console will actually send: 'aac' where the platform
 *  can encode it, otherwise 'opus'. The relay needs this *before* ffmpeg
 *  starts, because it decides whether the audio is copied or transcoded, and a
 *  stream cannot be re-planned once the socket is open. */
function probeStreamAudioCodec() {
  if (typeof window.AudioEncoder === 'undefined' ||
      typeof window.AudioEncoder.isConfigSupported !== 'function') {
    return Promise.resolve('opus');
  }
  return AudioEncoder.isConfigSupported({
    codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 160000
  }).then(function (res) {
    return (res && res.supported) ? 'aac' : 'opus';
  }).catch(function () { return 'opus'; });
}

/** Returns the first config the platform can encode, or null when none is.
 *  Tried in order so a build that predates an optional extension still works.
 *  Resolves with the config as it was written, not the one the browser echoes
 *  back, so an extension it accepted is the extension it is configured with. */
function tryConfigs(configs) {
  var i = 0;
  function next() {
    if (i >= configs.length) return Promise.resolve(null);
    var config = configs[i++];
    return AudioEncoder.isConfigSupported(config).then(function (res) {
      return (res && res.supported) ? config : next();
    }).catch(function () { return next(); });
  }
  return next();
}

/** The two-byte AudioSpecificConfig for AAC-LC, from the same sample rate and
 *  channel count the encoder is configured with. The muxer writes it into the
 *  track's `esds`; a missing or wrong description there is what makes an MP4
 *  that looks correct and plays silent. */
function buildAacAudioSpecificConfig(sampleRate, channels) {
  var rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
               16000, 12000, 11025, 8000, 7350];
  var index = rates.indexOf(sampleRate);
  if (index < 0) index = 4; // 44100, the MPEG-4 default frequency index
  var bits = '00010' // object type 2: AAC-LC
    + index.toString(2).padStart(4, '0')
    + (channels & 0x0f).toString(2).padStart(4, '0');
  bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
  var out = new Uint8Array(bits.length / 8);
  for (var i = 0; i < bits.length; i += 8) out[i / 8] = parseInt(bits.slice(i, i + 8), 2);
  return out;
}

/** The audio track's *measured* format, not the target its constraints asked
 *  for. `getSettings()` reports what was requested, and the spec allows it to
 *  differ from what is delivered; on Windows a mono microphone routinely hands
 *  over stereo samples once the echo-cancellation path has had them, and an
 *  encoder configured for one channel then rejects every frame — a track that
 *  is present and silent. One frame is read and the reader cancelled, which
 *  does not disturb a reader opened afterwards. Resolves null when the format
 *  cannot be measured, so the settings are used as before. */
function probeAudioFormat(track) {
  if (!track || typeof MediaStreamTrackProcessor !== 'function') {
    return Promise.resolve(null);
  }
  var reader;
  try {
    reader = new MediaStreamTrackProcessor({ track: track }).readable.getReader();
  } catch (err) { return Promise.resolve(null); }
  return new Promise(function (resolve) {
    var settled = false;
    function finish(format) {
      if (settled) return;
      settled = true;
      try { reader.cancel(); } catch (e) {}
      resolve(format);
    }
    // A track that never delivers a frame must not hold the recording up.
    setTimeout(function () { finish(null); }, 1500);
    reader.read().then(function (res) {
      if (res.done) { finish(null); return; }
      var frame = res.value;
      var format = { sampleRate: frame.sampleRate, channelCount: frame.numberOfChannels };
      frame.close();
      finish(format);
    }).catch(function () { finish(null); });
  });
}

/** The audio encoder + muxer codec pair, taken from the mixed track so the
 *  channel count and rate always match what will be fed in. Never rejects:
 *  losing the audio must not lose the video.
 *
 *  A recording may fall back to Opus, which every Chromium can encode. A
 *  stream is fixed by what the relay was told: where the platform can encode
 *  AAC the console sends it and the relay copies it; where it cannot, the
 *  console sends Opus and the relay transcodes that track to AAC. FLV itself
 *  has no Opus, so it is always AAC that leaves the server. */
function chooseAudioCodec(track, sink, hint, measured) {
  if (typeof window.AudioEncoder === 'undefined' ||
      typeof window.AudioEncoder.isConfigSupported !== 'function') {
    return Promise.resolve(null);
  }
  var settings = (track && track.getSettings) ? track.getSettings() : {};
  // Prefer the format the frames really carry over the one the track claims:
  // configuring the encoder for the claimed format is what makes it reject
  // every frame when the two disagree. The capture measures this once, before
  // its own reader takes over, and passes it here; a caller with no
  // measurement gets one taken now.
  var resolveFormat = measured
    ? Promise.resolve(measured)
    : probeAudioFormat(track);
  return resolveFormat.then(function (real) {
    var channels = (real && real.channelCount) || settings.channelCount || 2;
    var sampleRate = (real && real.sampleRate) || settings.sampleRate || 48000;
    return pickAudioCodec(sink, hint, channels, sampleRate);
  });
}

function pickAudioCodec(sink, hint, channels, sampleRate) {
  var candidates;
  if (sink === 'stream') {
    // The relay's plan was fixed when the socket opened, so this must match the
    // codec the server was told about: the video is always copied, and the
    // audio is copied for AAC but transcoded for Opus.
    candidates = hint === 'opus'
      ? [{ codec: 'opus', muxer: 'opus' }]
      : [{ codec: 'mp4a.40.2', muxer: 'aac' }];
  } else {
    candidates = [{ codec: 'mp4a.40.2', muxer: 'aac' }, { codec: 'opus', muxer: 'opus' }];
  }
  var attempts = candidates.map(function (audio) {
    var base = {
      codec: audio.codec, sampleRate: sampleRate, numberOfChannels: channels, bitrate: 160000
    };
    var wantsAac = audio.muxer === 'aac';
    // Ask for the raw-AAC bitstream (WebCodecs' documented default) rather than
    // ADTS: the muxer writes the AAC configuration into the track's `esds` and
    // treats every sample as a raw frame, so ADTS frames would be muxed with
    // their headers left in and play as noise or silence. Some builds that
    // predate the `aac` extension reject it outright, so that config is tried
    // first and the plain one is the fallback — losing audio entirely would be
    // worse than a description we replace anyway (see onChunk).
    var configs = wantsAac
      ? [Object.assign({ aac: { format: 'aac' } }, base), base]
      : [base];
    return tryConfigs(configs).then(function (config) {
      if (!config) return null;
      // A recording and a stream both write the same `esds`, so the description
      // is fixed here, from the same numbers the encoder is configured with,
      // rather than trusted from the encoder's chunk metadata. An AAC encoder
      // whose description is wrong or missing is what makes a file that looks
      // right and plays silent.
      return {
        audio: audio,
        config: config,
        channels: channels,
        sampleRate: sampleRate,
        description: wantsAac ? buildAacAudioSpecificConfig(sampleRate, channels) : null
      };
    });
  });
  return Promise.all(attempts).then(function (results) {
    for (var i = 0; i < results.length; i += 1) { if (results[i]) return results[i]; }
    return null;
  });
}

/* -------------------------------------------------------------------- audio

   One track: the screen's own audio (what the room hears) summed with the
   microphone (what the speaker says). Either may be missing and the recording
   still works, because the recording is worth more than its soundtrack.

   Two traps are avoided here, both of which produce a file that carries a track
   but plays as silence — which is exactly how a recording with no sound gets
   made even though the microphone was granted.

   1. A single source must still go through the graph. It is tempting to hand a
      lone track straight to the encoder, but the encoder is configured from
      `track.getSettings()`, and that is only the *target* the constraints asked
      for — the spec says it "may differ from measured performance". On Windows
      a mono microphone routinely delivers stereo samples once the
      echo-cancellation path has had them, so an encoder configured for one
      channel rejects every frame with "Input audio buffer is incompatible with
      codec parameters". The graph resamples both sources to the context's own
      rate and channel count, so the mix's settings and its samples always
      agree. (probeAudioFormat measures the real format as a second guard, for
      the fallback below.)

   2. When the context is not running the graph would emit silence, so the
      fallback is a single bare track — and *that* is the case the probe
      covers. The context is created after the folder and screen pickers have
      awaited, so there is no live user gesture by then and Chrome's autoplay
      policy can leave it 'suspended'. resume() cannot revive it without a
      gesture, so the graph is built inside the click handler instead
      (primeAudioContext) and adopted here; if even that failed, the graph is
      abandoned rather than trusted. */

function buildAudioMix(stream, primedContext) {
  var screenTrack = stream.getAudioTracks()[0] || null;
  var context = (primedContext && primedContext.state !== 'closed') ? primedContext : null;

  return requestMic().then(function (mic) {
    if (mic && mic.fellBack) {
      toast('The chosen audio input was not available — using the default microphone.', true);
    }
    var micTrack = mic && mic.stream ? mic.stream.getAudioTracks()[0] : null;

    // No source at all.
    if (!micTrack && !screenTrack) {
      if (mic) stopStream(mic.stream);
      return null;
    }

    // No running context to normalise through. Hand the best single source
    // over untouched rather than write a mute track; probeAudioFormat corrects
    // the encoder's configuration from the frames that actually arrive.
    if (!context) {
      if (screenTrack) {
        if (mic) stopStream(mic.stream);
        return bareAudio(null, screenTrack);
      }
      return bareAudio(mic, micTrack);
    }

    // One or two sources: the graph is what makes the encoder's configuration
    // and the samples agree, so both go through it. A fresh destination each
    // run, so one run stopping its track cannot disarm the shared context for
    // the next.
    var destination = context.createMediaStreamDestination();
    var sources = [];
    addSource(context, destination, screenTrack, 1, sources);
    addSource(context, destination, micTrack, 1.4, sources);
    return ensureRunning(context).then(function (ok) {
      if (!ok) {
        // Still suspended: the graph would emit silence. Fall back to one
        // source rather than write a mute track.
        sources.forEach(function (s) { try { s.source.disconnect(); } catch (e) {} });
        if (screenTrack) {
          if (mic) stopStream(mic.stream);
          return bareAudio(null, screenTrack);
        }
        return bareAudio(mic, micTrack);
      }
      return {
        context: context,
        destination: destination,
        stream: destination.stream,
        sources: sources,
        micStream: mic ? mic.stream : null,
        hasAny: true
      };
    });
  });
}

/** A mix that is a single source handed straight to the encoder. */
function bareAudio(mic, track) {
  return {
    context: null,
    destination: null,
    stream: new MediaStream([track]),
    sources: [],
    micStream: mic ? mic.stream : null,
    hasAny: true
  };
}

function addSource(context, destination, track, gainValue, into) {
  if (!track) return;
  try {
    var source = context.createMediaStreamSource(new MediaStream([track]));
    var gain = context.createGain();
    gain.gain.value = gainValue;
    source.connect(gain);
    gain.connect(destination);
    into.push({ source: source, gain: gain });
  } catch (err) { /* a track the graph cannot take is simply not mixed */ }
}

/** A context that was born suspended cannot be resumed without a gesture, so
 *  try once and report honestly whether it is running. */
function ensureRunning(context) {
  if (context.state === 'running') return Promise.resolve(true);
  var resume = context.resume ? context.resume().catch(function () {}) : Promise.resolve();
  return resume.then(function () { return context.state === 'running'; });
}

function stopStream(stream) {
  if (stream) stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
}

function teardownContext(context) {
  if (context && context.state !== 'closed') { try { context.close(); } catch (e) {} }
}

/** Asks for the chosen audio input — the microphone, a phone acting as a
 *  wireless mic, or a desk on the line-in jack — tolerating a refusal or an
 *  absent device. The operator's pick is in the console state, so the capture
 *  and the level check open the same input. */
function requestMic() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return Promise.resolve(null);
  }
  return navigator.mediaDevices.getUserMedia({
    audio: audioConstraints(preview.audioDeviceId, preview.audioLineIn)
  }).then(function (stream) { return { stream: stream }; })
    .catch(function (err) {
      // A chosen device that has gone (a phone that dropped off Wi-Fi, a desk
      // unplugged) must not cost the whole recording its microphone: fall back
      // to the default input and say so.
      if (preview.audioDeviceId && err && err.name === 'OverconstrainedError') {
        return navigator.mediaDevices.getUserMedia({
          audio: audioConstraints(null, preview.audioLineIn)
        }).then(function (stream) { return { stream: stream, fellBack: true }; })
          .catch(function () { return null; });
      }
      return null;
    });
}

/** Built inside the click handler, where a user gesture is live, so Chrome
 *  starts the context rather than suspending it. Adopted by buildAudioMix. */
function primeAudioContext() {
  var AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor) return null;
  try {
    var context = new AudioCtor({ sampleRate: 48000 });
    if (context.state === 'suspended' && context.resume) {
      context.resume().catch(function () {});
    }
    return context;
  } catch (err) { return null; }
}

function teardownAudioMix(mix) {
  if (!mix) return;
  mix.sources.forEach(function (entry) {
    try { entry.source.disconnect(); } catch (err) {}
    try { entry.gain.disconnect(); } catch (err) {}
  });
  if (mix.micStream) mix.micStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
  try { mix.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (err) {}
  // The AudioContext is primed once for the page and reused by every run, so a
  // run never closes it — closing it would silence the next recording.
}

/* ------------------------------------------------------------------- canvas

   Every captured frame is drawn onto a 4K canvas, letterboxed, and it is the
   canvas that is encoded. The monitor being recorded can be any size; the file
   is always the delivery size. */

function createCompositor(capture) {
  return {
    canvas: capture.canvas,
    draw: function (frame) {
      try {
        capture.ctx.drawImage(frame, capture.dx, capture.dy, capture.drawWidth, capture.drawHeight);
      } catch (err) { /* frame closed */ }
    }
  };
}

/** Builds the 4K canvas both sinks encode from, plus the letterbox geometry for
 *  the capture now in hand. One canvas means the picture recorded and the
 *  picture streamed are the same picture.
 *
 *  The context is a plain accelerated 2D canvas on purpose. `desynchronized:
 *  true` asks Chrome for a low-latency surface whose contents are handed to the
 *  compositor asynchronously, and a `VideoFrame` snapshotted from such a canvas
 *  in the same task as the `drawImage` that filled it comes back *black* on
 *  several GPU/driver combinations — a recording with a perfect audio track and
 *  a black picture. Nothing here needs low latency; the encode is allowed to
 *  lag. */
function createCaptureCanvas(captureWidth, captureHeight) {
  var canvas = document.createElement('canvas');
  canvas.width = REC_TARGET_SIZES[0][0];
  canvas.height = REC_TARGET_SIZES[0][1];
  var scale = Math.min(canvas.width / captureWidth, canvas.height / captureHeight);
  var drawWidth = Math.round(captureWidth * scale);
  var drawHeight = Math.round(captureHeight * scale);
  return {
    canvas: canvas,
    ctx: canvas.getContext('2d', { alpha: false }),
    dx: Math.round((canvas.width - drawWidth) / 2),
    dy: Math.round((canvas.height - drawHeight) / 2),
    drawWidth: drawWidth,
    drawHeight: drawHeight
  };
}

/* ---------------------------------------------------------------- pipeline */

function markRecordingStarted(run) {
  run.state = 'recording';
  run.started = true;
  setRecordButton('recording');
  startRecTicker();
  refreshRecordLabel();
  refreshFreeSpace();
}

/** The muxer target for this run: a file on the chosen drive, or the RTMP
 *  relay. Both take fragmented samples from the same encoders; only where the
 *  bytes land differs.
 *
 *  A recording is a plain MP4 with its moov written last, so a player can seek
 *  it and read its real duration. A stream is a *fragmented* MP4, because a
 *  relay cannot wait for the end of the file to learn what is in it — and it
 *  is handed straight to ffmpeg, which needs the fragments as they are made. */
function muxerTargetFor(run, audio) {
  if (run.sink === 'stream') {
    return {
      fastStart: 'fragmented',
      minFragmentDuration: STREAM_FRAGMENT_SECONDS,
      target: new window.Mp4Muxer.StreamTarget({
        onData: function (data, position) { sendStreamBytes(run, data, position); },
        chunkSize: 1024 * 1024
      })
    };
  }
  return {
    fastStart: false,
    minFragmentDuration: undefined,
    target: new window.Mp4Muxer.FileSystemWritableFileStreamTarget(run.writer, { chunkSize: 8 * 1024 * 1024 })
  };
}

function buildPipeline(run, audioMix) {
  // The recording is 4K; the stream is 1080p (see STREAM_TARGET). Both encode
  // the same 4K canvas — the stream's encoder scales it down as it encodes, so
  // the picture is still the record's picture, at half the width and a quarter
  // of the pixels.
  var target = run.sink === 'stream' ? STREAM_TARGET : REC_TARGET_SIZES[0];
  run.outWidth = target[0];
  run.outHeight = target[1];
  var video = {
    codec: 'avc',
    width: target[0],
    height: target[1],
    frameRate: REC_FRAME_RATE
  };
  var videoBps = run.sink === 'stream'
    ? STREAM_BITRATE_STEPS[0]
    : REC_VIDEO_BPS;
  var audioTrack = (audioMix && audioMix.hasAny) ? audioMix.stream.getAudioTracks()[0] : null;

  return chooseAudioCodec(audioTrack, run.sink, run.audioHint,
                          audioMix && audioMix.measuredFormat).then(function (audioChoice) {
    if (run !== rec && run !== air) return;
    if (!audioChoice || !audioTrack) audioChoice = null;

    var audio = audioChoice
      ? { codec: audioChoice.audio.muxer, numberOfChannels: audioChoice.channels, sampleRate: audioChoice.sampleRate }
      : undefined;
    // The muxer writes the AAC AudioSpecificConfig into the track's `esds`.
    // mp4-muxer seeds a correct guess at construction, but then overrides it
    // with whatever the encoder puts in the chunk metadata — and an AAC encoder
    // that omits or misreports that config yields an MP4 that looks right and
    // plays silent. Hand it our own config, built from the same rate and
    // channels the encoder is configured with, so the esds is right whatever
    // the encoder says. Opus is left to its own description: its `dOps` box
    // reads preskip and gain from it, which the muxer cannot reconstruct.
    run.audioMeta = (audioChoice && audioChoice.description)
      ? { decoderConfig: {
            codec: 'mp4a.40.2',
            sampleRate: audioChoice.sampleRate,
            numberOfChannels: audioChoice.channels,
            description: audioChoice.description
          } }
      : undefined;

    return openSink(run).then(function (ready) {
      if (!ready) return;
      if (run !== rec && run !== air) { closeSink(run); return; }

      var parts = muxerTargetFor(run, audio);
      run.muxer = new window.Mp4Muxer.Muxer({
        target: parts.target,
        video: video,
        audio: audio,
        fastStart: parts.fastStart,
        minFragmentDuration: parts.minFragmentDuration,
        // Each track is offset independently so its own first sample is zero.
        // The screen's video clock and the mixed audio clock are different
        // clocks, so a shared offset would yank one track's second sample
        // seconds away from its first and stretch the file.
        firstTimestampBehavior: 'offset'
      });

      run.videoEncoder = new VideoEncoder({
        output: function (chunk, meta) { onChunk(run, chunk, meta, true); },
        error: function (e) { sinkFailure(run, e); }
      });
      // The stream's bitrate is the ladder's top step and is re-configured at
      // run time as the uplink changes; the recording's is fixed.
      run.videoBps = videoBps;
      run.videoConfig = {
        codec: 'avc1.640033',
        width: video.width,
        height: video.height,
        bitrate: videoBps,
        framerate: REC_FRAME_RATE,
        // 'realtime' keeps the encoder to a decode order that matches
        // presentation order: no B-frames, so every chunk's timestamp moves
        // forward and a frame dropped at the input leaves no hole in the
        // reference chain. 'quality' would reorder for a little more
        // compression, which is exactly what a screen capture cannot afford.
        latencyMode: 'realtime'
      };
      run.videoEncoder.configure(run.videoConfig);

      if (audio) {
        run.audioEncoder = new AudioEncoder({
          output: function (chunk, meta) { onChunk(run, chunk, meta, false); },
          // An audio glitch must never take the video down with it — but the
          // operator must not be handed a silent file with no idea why, so the
          // first failure is reported once through the toast the recording
          // already reports itself with.
          error: function (e) {
            run.hasAudio = false;
            if (!run.audioWarned) {
              run.audioWarned = true;
              toast('Audio stopped: ' + ((e && e.message) || 'the encoder failed'), true);
            }
          }
        });
        run.audioEncoder.configure(audioChoice.config);
        run.hasAudio = true;
      }

      markSinkStarted(run);
    });
  });
}

/** Opens whatever the run writes to. The file sink creates the file; the
 *  stream sink has already opened its HTTP request and only needs to know it
 *  is ready. */
function openSink(run) {
  if (run.sink === 'stream') return Promise.resolve(socketOpen(run));
  return run.folder.getFileHandle(run.fileName, { create: true })
    .then(function (handle) { return handle.createWritable(); })
    .then(function (writable) { run.writer = writable; return true; })
    .catch(function (err) { sinkFailure(run, err); return false; });
}

function closeSink(run) {
  if (run.sink === 'stream') {
    // End the upload gracefully. The muxer has already written its last
    // fragment, so a clean close lets the server's ffmpeg flush and
    // disconnect; killing the socket here would cut the final fragment off.
    if (run.ws) {
      try { if (run.ws.readyState === 1) run.ws.close(1000); } catch (e) { /* already closed */ }
      run.ws = null;
    }
    return;
  }
  if (run.writer) { try { run.writer.close(); } catch (e) {} run.writer = null; }
}

/** Abandons a stream outright: the socket is closed without the graceful
 *  handshake, so the server stops reading and tears ffmpeg down at once. Used
 *  when the stream failed, never on a normal stop. */
function abortStream(run) {
  if (run.ws) {
    try { run.ws.close(); } catch (e) {}
    run.ws = null;
  }
}

/** Waits for the relay to report how the stream ended. The server knows before
 *  the page does — ffmpeg's exit code is the truth — so the operator is told
 *  what actually happened rather than "stream ended" on a stream that failed. */
function awaitStreamEnd(run) {
  var deadline = Date.now() + 20000;
  function poll() {
    return fetch(STREAM_STATUS_PATH, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (status) {
        if (status.state === 'failed') return { failed: status.detail || 'The relay stopped.' };
        if (status.state === 'stopped' || status.state === 'idle') return {};
        if (Date.now() > deadline) return {};
        return new Promise(function (r) { setTimeout(r, 700); }).then(poll);
      })
      .catch(function () { return {}; });
  }
  return poll();
}

/** While on air, keeps an eye on the relay. A relay that has stopped is not
 *  treated as fatal on its own: the socket layer is already reopening it, and
 *  only when the reconnect attempts are spent does the stream end. That is the
 *  difference between a stream that survives a dropped uplink and one that
 *  dies at the first hiccup. */
function startLiveWatch(run) {
  stopLiveWatch();
  run.watch = setInterval(function () {
    if (!run || run.finished || run.stopRequested) return;
    fetch(STREAM_STATUS_PATH, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (status) {
        if (run.finished || run.stopRequested) return;
        var down = status.state === 'failed' || status.state === 'idle';
        if (!down) {
          run.relayDownSince = null;
          return;
        }
        // The relay went away. Give the socket reconnect its chance; only a
        // sustained outage ends the stream.
        if (!run.relayDownSince) run.relayDownSince = Date.now();
        if (!run.reconnecting && !socketOpen(run)) scheduleStreamReconnect(run);
        if (Date.now() - run.relayDownSince > 45000) {
          sinkFailure(run, new Error(status.detail || 'The relay could not be restored.'));
        }
      })
      .catch(function () { /* a blip in the poll is not a failure */ });
  }, 2000);
}

function stopLiveWatch() {
  if (air && air.watch) { clearInterval(air.watch); air.watch = null; }
}

/** The record button shows elapsed/remaining; the live button shows the time
 *  on air. Which sink started decides which one is repainted. */
function markSinkStarted(run) {
  if (run.sink === 'stream') {
    run.state = 'live';
    setLiveButton('live');
    startLiveTicker();
    startLiveWatch(run);
    return;
  }
  markRecordingStarted(run);
}

function onChunk(run, chunk, meta, isVideo) {
  if (!run.muxer) return;
  // The one and only place a timestamp is rebased. The pump encodes with the
  // raw capture timestamp, so the pause offset is applied here, once, to both
  // tracks. Applying it in the pump as well would subtract it twice for any
  // chunk the encoder buffered across a pause, pushing that chunk behind the
  // ones already written — which drops a frame out of the reference chain.
  var rebased = chunk.timestamp - run.pausedMicros;
  // A WebCodecs chunk's `duration` is frequently null — a screen-capture
  // encoder is not obliged to fill it in — and mp4-muxer rejects a chunk whose
  // duration is not a finite number. The throw used to be swallowed here, so
  // every video sample was silently dropped, the video track never received a
  // decoder config, and `finalize()` died on it: a 0-byte file, or a recording
  // with audio and no picture. The duration is therefore always supplied — the
  // chunk's own when it has one, otherwise the gap since the previous sample,
  // otherwise one frame period.
  var duration = Number.isFinite(chunk.duration) && chunk.duration > 0
    ? chunk.duration
    : (isVideo ? run.lastVideoDuration : run.lastAudioDuration) || 0;
  if (isVideo) {
    if (rebased <= run.lastVideoTs) return;
    var videoGap = run.lastVideoTs >= 0 ? rebased - run.lastVideoTs : 0;
    if (!duration) duration = videoGap || REC_FRAME_PERIOD_MICROS;
    run.lastVideoTs = rebased;
    run.lastVideoDuration = duration;
  } else {
    // Audio chunks are independently decodable, so a stale one is simply
    // dropped; there is no reference chain to break.
    if (rebased <= run.lastAudioTs) return;
    if (!duration) duration = 20000;
    run.lastAudioTs = rebased;
    run.lastAudioDuration = duration;
  }
  run.written += chunk.byteLength || 0;
  var sample = duration === chunk.duration ? chunk : withDuration(chunk, duration);
  try {
    if (isVideo) run.muxer.addVideoChunk(sample, meta, rebased);
    // The audio description is ours for AAC (run.audioMeta) and the encoder's
    // own for Opus, whose dOps box reads preskip and gain from it.
    else run.muxer.addAudioChunk(sample, run.audioMeta || meta, rebased);
    run.samplesWritten = (run.samplesWritten || 0) + 1;
    if (isVideo) run.videoSamples = (run.videoSamples || 0) + 1;
  } catch (err) {
    if (!run.chunkWarned) {
      run.chunkWarned = true;
      toast('A frame could not be written: ' + ((err && err.message) || err), true);
    }
  }
}

/** A copy of an encoded chunk carrying a duration the muxer will accept.
 *  `EncodedVideoChunk` is immutable, so the data is copied into a fresh chunk —
 *  the same bytes, the same type, the same timestamp. */
function withDuration(chunk, duration) {
  try {
    var data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    var Ctor = chunk.type === 'key' || chunk.type === 'delta'
      ? window.EncodedVideoChunk : window.EncodedAudioChunk;
    return new Ctor({
      type: chunk.type,
      timestamp: chunk.timestamp,
      duration: duration,
      data: data
    });
  } catch (err) {
    return chunk;
  }
}

/* ------------------------------------------------------- capture and pumps

   One screen capture feeds every sink. A sink is one destination for the
   picture — a file on a drive, or the RTMP relay — and each has its own
   encoders and muxer. Recording and streaming can therefore run together or
   one at a time, and starting or stopping either leaves the other untouched.

   The capture itself is the only shared object: one getDisplayMedia, one
   screen-picker prompt, one audio mix, one 4K canvas that both sinks encode
   from. That is what keeps the two outputs identical in content rather than
   merely similar. */

function activeSinks() {
  return [rec, air].filter(function (run) { return !!run && !run.stopRequested; });
}

function anyPumping() {
  return activeSinks().some(function (run) { return run.state === 'recording' || run.state === 'live'; });
}

/** True while any sink is between 'starting' and 'finishing' — the window in
 *  which the shared capture must be kept. */
function captureInUse() {
  return [rec, air].some(function (run) { return !!run && !run.finished; });
}

function ensureCapture(primed) {
  // A capture that failed is not reusable: the sink that asked for it reports
  // the failure and releases it, but if a second sink arrives in the same
  // instant it must not inherit the dead capture.
  if (shared && shared.failed) { releaseCapture(); }
  if (shared) return Promise.resolve(shared);
  var pending = {
    ready: false, failed: null, stream: null, audioMix: null,
    videoProc: null, videoReader: null, videoDone: null,
    audioProc: null, audioReader: null, audioDone: null,
    canvas: null, ctx: null, frame: null, tick: null,
    videoTrack: null, audioTrack: null
  };
  shared = pending;

  // The audio mix asks for the microphone, which is a second prompt; it is
  // built first so both prompts are answered before the capture starts.
  return navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { ideal: REC_TARGET_SIZES[0][0] },
      height: { ideal: REC_TARGET_SIZES[0][1] },
      frameRate: { ideal: REC_FRAME_RATE }
    },
    audio: true,
    // Ask for the whole screen, so the projector's monitor is captured full
    // screen rather than one window.
    preferCurrentTab: false,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    systemAudio: 'include'
  }).then(function (stream) {
    pending.stream = stream;
    pending.videoTrack = stream.getVideoTracks()[0] || null;
    return buildAudioMix(stream, primed);
  }).then(function (mix) {
    pending.audioMix = mix;
    if (!pending.videoTrack) throw new Error('No screen video was shared.');
    var settings = pending.videoTrack.getSettings();
    // One 4K canvas for the whole capture: it is letterboxed from the
    // monitor's own size, and every sink encodes this same canvas, so the
    // picture recorded and the picture streamed are the same picture.
    Object.assign(pending, createCaptureCanvas(settings.width || 1920, settings.height || 1080));
    pending.audioTrack = (mix && mix.hasAny) ? mix.stream.getAudioTracks()[0] : null;
    // Measure the track's real format *before* the pump takes its reader: the
    // probe consumes a frame, and the pump must not lose one. The measurement
    // is what the encoder is configured from, because getSettings() reports the
    // target the constraints asked for and may differ from what is delivered.
    return probeAudioFormat(pending.audioTrack).then(function (format) {
      if (mix) mix.measuredFormat = format;
      // One reader for the whole capture. A reader cannot be shared, so the
      // frames are read here and drawn onto the canvas once; each sink then
      // encodes that same canvas.
      var vproc = new MediaStreamTrackProcessor({ track: pending.videoTrack });
      pending.videoProc = vproc;
      pending.videoReader = vproc.readable.getReader();
      pending.videoDone = pumpCapture(pending);
      if (pending.audioTrack) {
        var aproc = new MediaStreamTrackProcessor({ track: pending.audioTrack });
        pending.audioProc = aproc;
        pending.audioReader = aproc.readable.getReader();
        pending.audioDone = pumpCaptureAudio(pending);
      }
      pending.ready = true;
      return pending;
    });
  }).catch(function (err) {
    // A refused screen share, or a capture that could not start: tell every
    // sink that is waiting, then let go.
    pending.failed = err;
    pending.ready = true;
    return pending;
  });
}

/** Reads the capture once, paints each frame onto the shared canvas, and tells
 *  every live sink to encode the canvas at the capture's own timestamp.
 *
 *  Dropping is deliberate: when an encoder's queue is deep the frame is skipped
 *  rather than queued, so a 4K screen the software encoder cannot keep up with
 *  falls behind instead of stretching the output. Frames closer together than
 *  one frame period are dropped too, because the muxer times the video track in
 *  units of the declared frame rate and two frames inside one unit would share
 *  a decode timestamp. */
function pumpCapture(capture) {
  function loop() {
    return capture.videoReader.read().then(function (res) {
      if (res.done) return;
      var frame = res.value;
      var sinks = activeSinks().filter(function (run) {
        return (run.state === 'recording' || run.state === 'live') &&
          run.videoEncoder && run.videoEncoder.state === 'configured' &&
          run.videoEncoder.encodeQueueSize <= 8;
      });
      if (!sinks.length) {
        frame.close();
        return loop();
      }
      // A capture that is delivering black frames (a protected/DRM surface,
      // some GPU paths, a monitor showing a secure desktop) would otherwise
      // record a black file with perfect audio and no hint why. Sample the
      // first few frames and, if every one is black, say so plainly.
      sampleBlackFrame(capture, frame);
      capture.frame = frame.timestamp;
      var at = frame.timestamp - (sinks[0].pausedMicros || 0);
      // Too close to the last painted frame: drop it rather than let a sink
      // write a duplicate decode timestamp.
      if (capture.lastPaintedTs >= 0 && at - capture.lastPaintedTs < REC_MIN_STEP_MICROS) {
        frame.close();
        return loop();
      }
      capture.lastPaintedTs = at;
      try {
        capture.ctx.drawImage(frame, capture.dx, capture.dy, capture.drawWidth, capture.drawHeight);
      } catch (err) { /* frame closed */ }
      // Judged *after* the paint: the canvas must already hold this frame for
      // the snapshot to be meaningful.
      verifyCanvasCopy(capture, frame);
      var rawTimestamp = frame.timestamp;
      // Normally the encoders take the canvas, so both sinks get the same
      // letterboxed picture. When the canvas snapshot proved black
      // (verifyCanvasCopy) the captured frame itself is encoded instead —
      // unscaled, but real — and the canvas is bypassed entirely.
      var direct = capture.directFallback;
      sinks.forEach(function (run) {
        var keyFrame = run.lastKeyFrameTs < -1e15 || run.forceKeyFrame ||
          ((rawTimestamp - run.pausedMicros) - run.lastKeyFrameTs) >= REC_KEYFRAME_SECONDS * 1000000;
        if (keyFrame) run.lastKeyFrameTs = rawTimestamp - run.pausedMicros;
        run.forceKeyFrame = false;
        try {
          var out = direct
            ? new VideoFrame(frame, { timestamp: rawTimestamp })
            : new VideoFrame(capture.canvas, { timestamp: rawTimestamp });
          var opts = { keyFrame: keyFrame };
          // The stream encodes a smaller picture than the canvas holds, so the
          // encoder is told to scale; the frame is shared, so nothing is drawn
          // twice. In the direct path the source is the capture's own size,
          // so the same scaling still applies.
          var srcW = direct ? out.displayWidth : capture.canvas.width;
          var srcH = direct ? out.displayHeight : capture.canvas.height;
          if (run.outWidth && (run.outWidth !== srcW || run.outHeight !== srcH)) {
            opts.scaledWidth = run.outWidth;
            opts.scaledHeight = run.outHeight;
          }
          run.videoEncoder.encode(out, opts);
          out.close();
        } catch (err) { /* encoder closed */ }
      });
      // In direct mode the canvas is black, so the closing hold (holdLastFrame)
      // needs the last real frame kept aside — one frame, replaced each time.
      if (direct) {
        if (capture.holdFrame) { try { capture.holdFrame.close(); } catch (e) {} }
        try { capture.holdFrame = new VideoFrame(frame, { timestamp: rawTimestamp }); }
        catch (e) { capture.holdFrame = null; }
      }
      frame.close();
      return loop();
    }).catch(function () { /* track ended or reader released */ });
  }
  return loop();
}

/** Proves once, on the first lit frame, that a `VideoFrame` taken from the 4K
 *  canvas actually carries the picture that was just drawn onto it.
 *
 *  On some GPU/driver combinations a frame snapshotted from a hardware-backed
 *  canvas is returned *black* even though the canvas is visibly correct — the
 *  classic "recording is a black screen with audio" report. Nothing in the page
 *  can prevent that, but it can be detected and routed around: from then on the
 *  captured frame itself is handed to the encoders (scaled to the delivery
 *  size) instead of the canvas. The letterbox is lost in that mode, which is a
 *  far better outcome than a black file. */
function verifyCanvasCopy(capture, frame) {
  if (capture.canvasVerified || capture.directFallback) return;
  try {
    var probe = new VideoFrame(capture.canvas, { timestamp: frame.timestamp });
    var bitmap = null;
    // drawImage from the VideoFrame into the scratch canvas is the read-back
    // that reveals whether the snapshot has content.
    var scratch = capture.probeCanvas;
    var sctx = capture.probeCtx;
    if (!scratch) {
      scratch = document.createElement('canvas');
      scratch.width = 16; scratch.height = 16;
      sctx = scratch.getContext('2d', { willReadFrequently: true });
      capture.probeCanvas = scratch;
      capture.probeCtx = sctx;
    }
    sctx.drawImage(probe, 0, 0, 16, 16);
    probe.close();
    var px = sctx.getImageData(0, 0, 16, 16).data;
    var lit = 0;
    for (var i = 0; i < px.length; i += 4) {
      if (px[i] > 12 || px[i + 1] > 12 || px[i + 2] > 12) lit += 1;
    }
    // The source frame was already known to have content (sampleBlackFrame
    // only lets us here once it has seen light), so an unlit canvas snapshot
    // means the canvas path is broken.
    if (lit < 8) {
      capture.directFallback = true;
      toast('Recording the captured frames directly — the screen could not be copied through the canvas.', true);
      return;
    }
    capture.canvasVerified = true;
  } catch (err) { /* no VideoFrame support for the probe: leave the canvas path */ }
}

/** Watches the first handful of captured frames. A screen share that is
 *  delivering nothing but black is a specific, common failure — a protected
 *  window, an HDCP surface, a monitor showing the lock screen — and the
 *  recording it produces is audio with a black picture. Rather than let the
 *  operator discover that after the service, sample a small patch of each of
 *  the first few frames and tell them once, plainly, if it is all black. */
function sampleBlackFrame(capture, frame) {
  if (capture.blackChecked >= 30 || capture.blackWarned) return;
  capture.blackChecked = (capture.blackChecked || 0) + 1;
  try {
    // A tiny scratch canvas: reading back from the 4K canvas on every frame
    // would stall the pipeline, but a 16x16 sample is cheap and only runs for
    // the opening second.
    if (!capture.probeCanvas) {
      capture.probeCanvas = document.createElement('canvas');
      capture.probeCanvas.width = 16;
      capture.probeCanvas.height = 16;
      capture.probeCtx = capture.probeCanvas.getContext('2d', { willReadFrequently: true });
    }
    capture.probeCtx.drawImage(frame, 0, 0, 16, 16);
    var px = capture.probeCtx.getImageData(0, 0, 16, 16).data;
    var lit = 0;
    for (var i = 0; i < px.length; i += 4) {
      if (px[i] > 12 || px[i + 1] > 12 || px[i + 2] > 12) { lit += 1; }
    }
    capture.blackLit = (capture.blackLit || 0) + lit;
    // Only judge after enough frames that a genuinely dark first frame (a
    // fade-in) is not mistaken for a dead capture.
    if (capture.blackChecked === 30 && capture.blackLit < 30) {
      capture.blackWarned = true;
      toast('The screen capture is coming through black. Share the display window or the whole screen — ' +
        'a protected window or the lock screen cannot be captured.', true);
    }
  } catch (err) { /* a frame we cannot sample is simply not judged */ }
}

function pumpCaptureAudio(capture) {
  function loop() {
    return capture.audioReader.read().then(function (res) {
      if (res.done) return;
      var data = res.value;
      var sinks = activeSinks().filter(function (run) {
        return (run.state === 'recording' || run.state === 'live') &&
          run.hasAudio && run.audioEncoder && run.audioEncoder.state === 'configured';
      });
      sinks.forEach(function (run) {
        try {
          run.audioEncoder.encode(data);
        } catch (err) { /* closed */ }
      });
      data.close();
      if (sinks.some(function (run) { return run.audioEncoder.encodeQueueSize > 16; })) {
        return new Promise(function (r) { setTimeout(r, 4); }).then(loop);
      }
      return loop();
    }).catch(function () { /* track ended or reader released */ });
  }
  return loop();
}

function releaseCapture() {
  if (!shared) return;
  var capture = shared;
  shared = null;
  if (capture.holdFrame) { try { capture.holdFrame.close(); } catch (e) {} capture.holdFrame = null; }
  if (capture.videoReader) { try { capture.videoReader.cancel(); } catch (e) {} }
  if (capture.audioReader) { try { capture.audioReader.cancel(); } catch (e) {} }
  if (capture.stream) capture.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
  teardownAudioMix(capture.audioMix);
}

/** Ends a run: stop its encoders, flush them, hold the last frame if the audio
 *  outlasts the video, and finalize the muxer. For a file that is the moov and
 *  the last slices going to disk; for a stream it is the final fragment and the
 *  end of the upload. This is the pause after Stop — the sink works on while
 *  the console carries on.
 *
 *  The encoders are flushed *before* the tail is measured, because a flushed
 *  encoder is the only point at which the last chunk of each track has actually
 *  been emitted and their end times are final. */
function finishSink(run) {
  run.state = 'finishing';
  if (run.sink === 'stream') stopLiveTicker(); else stopRecTicker();
  var videoDone = run.videoDone || Promise.resolve();
  var audioDone = run.audioDone || Promise.resolve();
  var pauseFlush = run.pauseFlush || Promise.resolve();
  pauseFlush.catch(function () {})
    .then(function () { return Promise.all([videoDone, audioDone]); })
    .then(function () {
      if (run.videoEncoder && run.videoEncoder.state === 'configured') return run.videoEncoder.flush();
    })
    .then(function () {
      if (run.audioEncoder && run.audioEncoder.state === 'configured') return run.audioEncoder.flush();
    })
    .then(function () {
      // The audio pump usually stops a fraction of a second after the video one.
      // Hold the last frame for that much longer so both tracks end together
      // instead of the video finishing short.
      run.audioTailMs = Math.max(0,
        (run.lastAudioTs + run.lastAudioDuration) - (run.lastVideoTs + run.lastVideoDuration));
      return holdLastFrame(run);
    })
    .then(function () {
      if (run.videoEncoder && run.videoEncoder.state === 'configured') return run.videoEncoder.flush();
    })
    .then(function () {
      if (run.muxer) run.muxer.finalize();
      return closeSink(run);
    })
    .then(function () { finishUp(run, null); })
    .catch(function (err) { finishUp(run, err); });
}

/** Holds the last captured frame on the glass for a moment after the capture
 *  stops, so the video track is not shorter than the audio one.
 *
 *  The two pumps stop at slightly different instants — audio is chunked in
 *  ~20ms slices and is often a fraction of a second ahead — and a track that
 *  ends early makes a player's timeline disagree with itself at the end of the
 *  file. A short freeze on the final frame costs nothing and removes the
 *  disagreement. */
function holdLastFrame(run) {
  return new Promise(function (resolve) {
    var holdMs = Math.max(0, run.audioTailMs || 0);
    if (!holdMs || !run.videoEncoder || run.videoEncoder.state !== 'configured') { resolve(); return; }
    setTimeout(function () {
      if (!run.videoEncoder || run.videoEncoder.state !== 'configured') { resolve(); return; }
      try {
        // onChunk will subtract the pause offset, so add it back here: the
        // hold is a position in file time, and that is what must survive.
        var source = (shared && shared.directFallback && shared.holdFrame)
          ? shared.holdFrame : run.compositor.canvas;
        var out = new VideoFrame(source, {
          timestamp: run.lastVideoTs + run.pausedMicros + (run.lastVideoDuration || 33333),
          duration: Math.round(holdMs * 1000)
        });
        var opts = { keyFrame: false };
        var srcW = source.displayWidth || source.width;
        var srcH = source.displayHeight || source.height;
        if (run.outWidth && (run.outWidth !== srcW || run.outHeight !== srcH)) {
          opts.scaledWidth = run.outWidth;
          opts.scaledHeight = run.outHeight;
        }
        run.videoEncoder.encode(out, opts);
        out.close();
      } catch (err) { /* encoder closed */ }
      resolve();
    }, 220);
  });
}

/** Releases everything a run held and reports the result. The notification is
 *  the only thing the operator sees; the full path is in its tooltip. */
function finishUp(run, error) {
  if (run.sink === 'stream') { stopLiveTicker(); stopLiveWatch(); } else { stopRecTicker(); }
  run.finished = true;
  if (run.sink === 'stream') {
    if (air === run) { air = null; setLiveButton(null); }
    // A failed stream must be aborted so the server stops reading; a normal end
    // has already closed the body in finishSink.
    if (error) abortStream(run);
  } else {
    if (rec === run) { rec = null; setRecordButton(null); }
    closeSink(run);
  }
  if (!captureInUse()) releaseCapture();
  if (error) {
    toast((run.sink === 'stream' ? 'Stream failed: ' : 'Recording failed: ') +
      ((error && error.message) || error), true);
    return;
  }
  if (run.sink === 'stream') {
    // The server, not the page, knows whether ffmpeg relayed cleanly, so the
    // operator is told the truth a moment later rather than "stream ended".
    awaitStreamEnd(run).then(function (result) {
      if (result.failed) toast('Stream failed: ' + result.failed, true);
      else toast('Stream ended.');
    });
    return;
  }
  toast('Recording saved');
}

/** A sink could not start or died: release it, keep the other one going, and
 *  let go of the capture only when nothing is left using it. */
function sinkFailure(run, err) {
  if (!run || run.finished) return;
  [run.videoEncoder, run.audioEncoder].forEach(function (enc) {
    if (enc && enc.state !== 'closed') { try { enc.close(); } catch (e) {} }
  });
  finishUp(run, err || new Error('The sink stopped.'));
}

/** The operator-facing reason a capture failed. */
function captureFailureMessage(err) {
  var name = err && err.name;
  if (name === 'NotAllowedError') return 'No screen was shared.';
  if (name === 'NotSupportedError') return 'This browser cannot capture the screen.';
  if (name === 'AbortError') return 'The picker was dismissed.';
  return (err && err.message) || String(err);
}

/** A run's mutable state. Both sinks share the shape; only the target differs. */
function newRun(sink, extra) {
  var run = {
    sink: sink,
    state: 'starting',
    stopRequested: false,
    finished: false,
    hasAudio: false,
    written: 0,
    muxer: null,
    videoEncoder: null,
    audioEncoder: null,
    videoDone: null,
    audioDone: null,
    compositor: null,
    pausedMicros: 0,
    pauseWallAt: null,
    pauseFlush: null,
    forceKeyFrame: false,
    lastKeyFrameTs: -Infinity,
    lastEncodeTs: -1,
    lastVideoTs: -1,
    lastAudioTs: -1,
    lastVideoDuration: 0,
    lastAudioDuration: 0,
    audioTailMs: 0
  };
  Object.keys(extra || {}).forEach(function (k) { run[k] = extra[k]; });
  return run;
}

/** Brings a run up on the shared capture and starts its encoders. */
function startSink(run, primed) {
  return ensureCapture(primed).then(function (capture) {
    if (capture.failed) throw capture.failed;
    if (run.stopRequested) return;
    run.compositor = createCompositor(capture);
    return buildPipeline(run, capture.audioMix);
  }).catch(function (err) {
    if (run.stopRequested) return;
    sinkFailure(run, err);
  });
}

function startRecording() {
  if (rec) return; // already running; Stop is how you end it

  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    toast('This browser cannot capture the screen.', true);
    return;
  }
  if (typeof window.showDirectoryPicker !== 'function') {
    toast('Recording to a folder needs Chrome or Edge on a desktop.', true);
    return;
  }
  if (!canUseWebCodecs()) {
    toast('This browser cannot encode an MP4.', true);
    return;
  }

  // The folder picker needs a user gesture, and so does the AudioContext — it
  // is created here, synchronously, because Chrome will only start one created
  // under a gesture. Built later, after the pickers have awaited, it can be born
  // suspended, and a suspended context's MediaStreamDestination emits silence.
  var primed = primeAudioContext();
  var startedAt = new Date();
  var run = newRun('file', {
    startedAt: startedAt,
    folderName: recordingFolderName(startedAt),
    fileName: recordingFileName(startedAt),
    dir: null, folder: null, freeBytes: null, pausedTotal: 0, pausedAt: null, tick: null,
    audioMix: null
  });
  rec = run;

  window.showDirectoryPicker({ mode: 'readwrite', id: 'ewc-display-recordings' })
    .then(function (dir) {
      if (rec !== run) return null;
      run.dir = dir;
      return dir.getDirectoryHandle(run.folderName, { create: true }).then(function (folder) {
        run.folder = folder;
        return startSink(run, primed);
      });
    })
    .catch(function (err) {
      if (primed) teardownContext(primed);
      if (rec === run) sinkFailure(run, err);
    });
}

function pauseRecording() {
  if (!rec || rec.state !== 'recording') return;
  rec.state = 'paused';
  rec.pausedAt = Date.now();
  rec.pauseWallAt = performance.now();
  // Flush both encoders now, and hold the result: the pause offset must not
  // move until everything buffered before the pause has been written with the
  // old offset. Advancing it early would rebase those chunks twice, pushing
  // them behind the samples already written.
  var flushes = [];
  if (rec.videoEncoder && rec.videoEncoder.state === 'configured') flushes.push(rec.videoEncoder.flush().catch(function () {}));
  if (rec.audioEncoder && rec.audioEncoder.state === 'configured') flushes.push(rec.audioEncoder.flush().catch(function () {}));
  rec.pauseFlush = Promise.all(flushes);
  setRecordButton('paused');
}

function resumeRecording() {
  if (!rec || rec.state !== 'paused') return;
  var run = rec;
  var flush = run.pauseFlush || Promise.resolve();
  // Wait for the pause flush to land before moving the offset, then resume.
  flush.catch(function () {}).then(function () {
    if (rec !== run || run.state !== 'paused') return;
    run.pausedTotal += Date.now() - run.pausedAt;
    run.pausedAt = null;
    // The frames captured while paused were dropped, so shift the timeline back
    // by the wall-clock time spent paused: the gap vanishes instead of leaving a
    // frozen stretch in the file. The first frame back is a fresh keyframe, so
    // seeking into the join stays clean.
    run.pausedMicros += Math.round((performance.now() - run.pauseWallAt) * 1000);
    run.pauseWallAt = null;
    run.pauseFlush = null;
    run.forceKeyFrame = true;
    run.state = 'recording';
    setRecordButton('recording');
  });
}

function stopRecording() {
  if (!rec || rec.stopRequested) return;
  var run = rec;
  run.stopRequested = true;
  // The bar returns to rest the instant Stop is pressed: the operator asked
  // for the recording to end, not to watch the muxer work. Flush, index and
  // close run on in the background while the console carries on, and the
  // finished file reports itself through a toast.
  setRecordButton(null);
  finishSink(run);
}

/* ======================================================================
   13b. GO LIVE — RTMP
   A browser cannot speak RTMP, so the console encodes the same 4K picture it
   records into a fragmented MP4 and posts it to this project's own server,
   which pipes it into ffmpeg to relay to YouTube. The stream key is the
   operator's, kept in this browser and sent only to that relay.
   ====================================================================== */

/** The RTMP URL, with the key appended. YouTube's ingest is
 *  `<url>/<key>`, but a backup URL (`.../live2?backup=1`) carries its own
 *  query string, and the key must go on the *path* — appending it after the
 *  query would make `?backup=1/key`, which the ingest treats as a query value
 *  and rejects. So the key is appended to the path and any query is preserved
 *  at the end. */
function composeRtmpUrl(base, key) {
  base = (base || '').trim().replace(/\/+$/, '');
  key = (key || '').trim();
  if (!base) return '';
  if (!key) return base;
  var hash = '';
  var hashAt = base.indexOf('#');
  if (hashAt >= 0) { hash = base.slice(hashAt); base = base.slice(0, hashAt); }
  var query = '';
  var queryAt = base.indexOf('?');
  if (queryAt >= 0) { query = base.slice(queryAt); base = base.slice(0, queryAt); }
  return base + '/' + key + query + hash;
}

function loadStreamSettings() {
  var saved = null;
  try { saved = JSON.parse(localStorage.getItem(STREAM_KEY_STORAGE) || 'null'); } catch (e) { saved = null; }
  saved = saved || {};
  if (el.rtmpUrlInput) el.rtmpUrlInput.value = saved.url || STREAM_DEFAULT_URL;
  if (el.rtmpBackupInput) el.rtmpBackupInput.value = saved.backup || STREAM_DEFAULT_BACKUP;
  if (el.rtmpKeyInput) el.rtmpKeyInput.value = saved.key || '';
}

function saveStreamSettings() {
  try {
    localStorage.setItem(STREAM_KEY_STORAGE, JSON.stringify({
      url: el.rtmpUrlInput ? el.rtmpUrlInput.value.trim() : '',
      backup: el.rtmpBackupInput ? el.rtmpBackupInput.value.trim() : '',
      key: el.rtmpKeyInput ? el.rtmpKeyInput.value.trim() : ''
    }));
  } catch (e) { /* private mode; the settings simply do not persist */ }
}

function setStreamStatus(message, isError) {
  if (!el.rtmpStatus) return;
  el.rtmpStatus.textContent = message || '';
  el.rtmpStatus.classList.toggle('is-error', !!isError);
}

/** Asks the server whether it can relay at all, once, and says so plainly. A
 *  missing ffmpeg is the one failure worth knowing before a service starts. */
function probeStreamRelay() {
  fetch(STREAM_PROBE_PATH, { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (info) {
      if (info && info.ffmpeg && info.rtmp) {
        setStreamStatus('Relay ready.', false);
      } else if (info && info.ffmpeg) {
        setStreamStatus('This server\'s ffmpeg has no RTMP support.', true);
      } else {
        setStreamStatus('No ffmpeg on the server, so Go Live cannot relay.', true);
      }
    })
    .catch(function () { /* served from file://; Go Live will say so itself */ });
}

/** The one stream the server will accept. Whatever the URL resolves to, the
 *  relay reports the same state either way. */
function startLive() {
  if (air) return; // already on air; End Stream is how you stop

  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    toast('This browser cannot capture the screen.', true);
    return;
  }
  if (!canUseWebCodecs()) {
    toast('This browser cannot encode the stream.', true);
    return;
  }

  var url = composeRtmpUrl(el.rtmpUrlInput ? el.rtmpUrlInput.value : '', el.rtmpKeyInput ? el.rtmpKeyInput.value : '');
  if (!url) { toast('Enter a stream URL and key first.', true); return; }
  saveStreamSettings();

  var primed = primeAudioContext();
  var run = newRun('stream', { startedAt: new Date(), socket: null, audioMix: null });
  air = run;
  setLiveButton('connecting');

  // Which audio the console will send is settled before the socket opens: the
  // relay fixes its ffmpeg arguments then, and cannot change them mid-stream.
  probeStreamAudioCodec().then(function (audioCodec) {
    if (air !== run) return;
    run.audioHint = audioCodec;
    return openStreamSocket(run, url, audioCodec);
  }).then(function () {
    if (air !== run) return;
    return startSink(run, primed);
  }).catch(function (err) {
    if (primed) teardownContext(primed);
    if (air !== run) return;
    air = null;
    setLiveButton(null);
    toast('Could not start the stream: ' + captureFailureMessage(err), true);
  });
}

/** Opens the relay socket and resolves once the server has accepted it, having
 *  told it which audio codec to expect. */
function openStreamSocket(run, url, audioCodec) {
  var started;
  try {
    started = createStreamUpload(run, url, audioCodec);
  } catch (err) {
    throw new Error((err && err.message) || err);
  }
  return started;
}

/** Opens the relay socket the muxer writes into, and returns a promise that
 *  resolves once the server has accepted it.
 *
 *  This is a WebSocket, not a streamed `fetch`. A streaming request body needs
 *  HTTP/2 — Chromium refuses a ReadableStream body over HTTP/1.1 with
 *  ERR_ALPN_NEGOTIATION_FAILED — and the church server is HTTP/1.1. A
 *  WebSocket is the transport meant for a continuous browser-to-server byte
 *  pipe over HTTP/1.1, so the encoded video travels in binary frames and the
 *  server unwraps them into ffmpeg. */
function createStreamUpload(run, url, audioCodec) {
  run.streamUrl = url;
  var ws = new WebSocket(streamSocketUrl());
  ws.binaryType = 'arraybuffer';
  run.ws = ws;
  run.queued = [];
  run.queuedBytes = 0;
  run.bitrateStep = 0;
  run.reconnectAttempts = 0;

  var settled = false;
  var ready = new Promise(function (resolve, reject) {
    ws.onopen = function () {
      // The first message is the target; a header cannot be read after the
      // handshake reply is already on the wire, so the URL goes first. The
      // audio codec rides with it: the relay decides there whether to copy or
      // transcode the audio track, and that cannot change once ffmpeg is up.
      ws.send(JSON.stringify({ url: url, audio: audioCodec || 'aac' }));
    };
    ws.onmessage = function (event) {
      var hello = {};
      try { hello = JSON.parse(event.data); } catch (e) { /* not our json */ }
      if (hello.state === 'ready' && !settled) {
        settled = true;
        resolve({ ready: true, socket: ws });
        flushStreamQueue(run);
      }
    };
    ws.onerror = function () {
      if (settled) return;
      settled = true;
      reject(new Error('The relay refused the stream.'));
    };
    ws.onclose = function () {
      if (!settled) {
        settled = true;
        // The server closed instead of saying "ready": read the reason from
        // the status endpoint, which the relay sets before closing.
        fetch(STREAM_STATUS_PATH, { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (status) {
            reject(new Error(status.detail || 'The relay refused the stream.'));
          })
          .catch(function () { reject(new Error('The relay refused the stream.')); });
        return;
      }
      // A close *after* the stream was live is the uplink dropping, not a
      // refusal: reopen it rather than leave the operator streaming into a
      // socket that no longer exists.
      if (run.ws === ws) {
        run.ws = null;
        if (!run.stopRequested) scheduleStreamReconnect(run);
      }
    };
  });

  // A tiny grace period lets the server's ready arrive before the first bytes;
  // it does not gate the frames, it only orders the status the operator sees.
  var delay = new Promise(function (r) { setTimeout(r, 250); });
  return Promise.all([ready, delay]).then(function (parts) { return parts[0]; });
}

/** The relay's WebSocket URL on this origin, http or https. */
function streamSocketUrl() {
  var scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return scheme + '//' + location.host + STREAM_WS_PATH;
}

/** The muxer's output hook. Bytes go straight to the socket once the relay has
 *  accepted it; while it is closed (a dropped uplink, a relay restart) they are
 *  queued and the socket is reopened.
 *
 *  A weak uplink is *shaped*, never fatal. If the socket's send buffer grows
 *  past a couple of seconds of the current bitrate, the bitrate is stepped down
 *  the ladder — the picture softens and the queue drains. Only when the buffer
 *  passes the hard limit does the video input start being dropped (a live
 *  stream must never fall minutes behind), and even then it recovers on its
 *  own. This is the OBS/Wirecast model: adapt, do not abort. */
function sendStreamBytes(run, data, position) {
  if (!run || run.stopRequested || run.finished) return;
  if (!socketOpen(run)) {
    // Not a failure: the reconnect loop owns reopening. Hold the bytes in
    // order, and cap the hold so a long outage cannot eat the heap.
    run.queued.push(data);
    run.queuedBytes += data.byteLength;
    while (run.queuedBytes > STREAM_MAX_QUEUE_BYTES && run.queued.length > 1) {
      run.queuedBytes -= run.queued.shift().byteLength;
    }
    scheduleStreamReconnect(run);
    return;
  }
  captureStreamInit(run, data, position);
  flushStreamQueue(run);
  adaptStreamBitrate(run);
  if (run.ws.bufferedAmount > STREAM_MAX_QUEUE_BYTES) {
    // Drop this chunk rather than let the socket fall further behind live.
    // The muxer's samples are independent enough that a missing fragment only
    // costs a moment of picture, and the decoder resyncs at the next keyframe.
    run.droppedBytes = (run.droppedBytes || 0) + data.byteLength;
    return;
  }
  writeStreamChunk(run, data);
}

/** The seconds of video sitting in the relay socket's send buffer at the
 *  current bitrate — the one number that says whether the uplink is keeping
 *  up. */
function streamBufferSeconds(run) {
  if (!socketOpen(run)) return 0;
  var bytesPerSecond = (run.videoBps || STREAM_BITRATE_STEPS[0]) / 8;
  return run.ws.bufferedAmount / bytesPerSecond;
}

/** Walks the bitrate ladder with the uplink: down when the send buffer grows,
 *  back up when it stays clear. Reconfiguring a WebCodecs encoder at run time
 *  is allowed and is what makes this possible without a restart. */
function adaptStreamBitrate(run) {
  if (run.sink !== 'stream' || !run.videoEncoder ||
      run.videoEncoder.state !== 'configured' || !run.videoConfig) return;
  var seconds = streamBufferSeconds(run);
  var step = run.bitrateStep || 0;
  var now = performance.now();

  if (seconds > STREAM_ABR_SOFT_SECONDS && step < STREAM_BITRATE_STEPS.length - 1) {
    // Only step down once a second or so, or a single burst would walk the
    // ladder to the floor before the queue has had a chance to drain.
    if (now - (run.lastBitrateChange || 0) < 1200) return;
    step += 1;
    run.lastBitrateChange = now;
    run.lastClearAt = null;
    applyStreamBitrate(run, step);
    return;
  }

  if (seconds < STREAM_ABR_SOFT_SECONDS * 0.4 && step > 0) {
    if (!run.lastClearAt) { run.lastClearAt = now; return; }
    if (now - run.lastClearAt < STREAM_ABR_RECOVER_SECONDS * 1000) return;
    step -= 1;
    run.lastBitrateChange = now;
    run.lastClearAt = null;
    applyStreamBitrate(run, step);
  }
}

function applyStreamBitrate(run, step) {
  run.bitrateStep = step;
  run.videoBps = STREAM_BITRATE_STEPS[step];
  var config = Object.assign({}, run.videoConfig, { bitrate: run.videoBps });
  run.videoConfig = config;
  try { run.videoEncoder.configure(config); } catch (err) { /* encoder gone */ }
}

/** Reopens the relay socket after a drop, backing off between attempts. The
 *  encoder and the muxer never stop, so the picture simply resumes when the
 *  uplink comes back — no restart, no lost recording. */
function scheduleStreamReconnect(run) {
  if (!run || run.stopRequested || run.finished || run.reconnecting) return;
  if ((run.reconnectAttempts || 0) >= STREAM_RECONNECT_ATTEMPTS) {
    sinkFailure(run, new Error('The relay connection could not be restored.'));
    return;
  }
  run.reconnecting = true;
  var attempt = (run.reconnectAttempts || 0) + 1;
  run.reconnectAttempts = attempt;
  var delay = Math.min(STREAM_RECONNECT_MAX_MS, 500 * Math.pow(2, attempt - 1));
  if (attempt === 1) toast('Stream connection dropped — reconnecting…', true);
  setTimeout(function () {
    if (!run || run.stopRequested || run.finished) return;
    reopenStreamSocket(run).then(function () {
      run.reconnecting = false;
      run.reconnectAttempts = 0;
      run.needInit = true;
      run.forceKeyFrame = true;   // give the new ffmpeg a fresh keyframe at once
      toast('Stream reconnected.');
      flushStreamQueue(run);
    }).catch(function () {
      run.reconnecting = false;
      scheduleStreamReconnect(run);
    });
  }, delay);
}

/** A fresh WebSocket to the same relay, with the same URL and audio codec.
 *  The relay starts a new ffmpeg for it; YouTube treats it as the same stream
 *  because the key is unchanged, so viewers see a short gap, not a new stream. */
function reopenStreamSocket(run) {
  return new Promise(function (resolve, reject) {
    var ws;
    try { ws = new WebSocket(streamSocketUrl()); }
    catch (err) { reject(err); return; }
    ws.binaryType = 'arraybuffer';
    var settled = false;
    ws.onopen = function () {
      ws.send(JSON.stringify({ url: run.streamUrl, audio: run.audioHint || 'aac' }));
    };
    ws.onmessage = function (event) {
      var hello = {};
      try { hello = JSON.parse(event.data); } catch (e) {}
      if (hello.state === 'ready' && !settled) {
        settled = true;
        run.ws = ws;
        resolve();
      }
    };
    ws.onerror = function () { if (!settled) { settled = true; reject(new Error('reconnect failed')); } };
    ws.onclose = function () { if (!settled) { settled = true; reject(new Error('reconnect failed')); } };
  });
}

/** Whether the relay socket is open and past the handshake. */
function socketOpen(run) {
  return !!run.ws && run.ws.readyState === 1;
}

function flushStreamQueue(run) {
  if (!run.queued.length || !socketOpen(run)) return;
  var queued = run.queued;
  run.queued = [];
  run.queuedBytes = 0;
  // A reconnected relay starts a brand-new ffmpeg reading a stream that is no
  // longer at its beginning, so the init segment (ftyp + moov) has to be
  // replayed first or the new process cannot parse a single sample.
  if (run.needInit && run.initBytes && run.initBytes.length) {
    run.needInit = false;
    writeStreamChunk(run, run.initBytes);
  }
  queued.forEach(function (data) { writeStreamChunk(run, data); });
}

/** Keeps a copy of the fragmented MP4's opening bytes — everything written
 *  from position 0 until the cap. That is the ftyp/moov a fresh ffmpeg needs in
 *  order to read the samples that follow it after a reconnect. */
function captureStreamInit(run, data, position) {
  if (run.initBytes && run.initBytes.length >= STREAM_INIT_CAP) return;
  var have = run.initBytes ? run.initBytes.length : 0;
  if (position !== have) return; // not contiguous with what we have
  var room = STREAM_INIT_CAP - have;
  var slice = data.byteLength > room ? data.subarray(0, room) : data;
  var merged = new Uint8Array(have + slice.byteLength);
  if (have) merged.set(run.initBytes, 0);
  merged.set(slice, have);
  run.initBytes = merged;
}

function writeStreamChunk(run, data) {
  try {
    run.ws.send(data);
  } catch (err) {
    // The socket went away under us. Do not end the stream for it — close the
    // dead socket and let the reconnect loop open a fresh one; the queued
    // bytes follow when it is ready.
    run.ws = null;
    if (!run.stopRequested) scheduleStreamReconnect(run);
  }
}

/** Ends the stream: the muxer writes its final fragment, the upload ends, and
 *  the server's ffmpeg flushes and disconnects. The relay keeps working after
 *  the button returns to rest, so the console carries on. */
function stopLive() {
  if (!air || air.stopRequested) return;
  var run = air;
  run.stopRequested = true;
  setLiveButton(null);
  finishSink(run);
}

function setLiveButton(state) {
  if (!el.liveBtn) return;
  var active = state === 'live' || state === 'connecting';
  el.liveBtn.classList.toggle('is-recording', active);
  el.liveStopBtn.hidden = state !== 'live';
  if (state === 'connecting') {
    el.liveBtnLabel.textContent = 'Connecting…';
  } else if (state === 'live') {
    // Keep the time on air if the ticker is already running; a reconnect must
    // not reset it to zero.
    if (!air || !air.tick) el.liveBtnLabel.textContent = '0:00';
  } else {
    el.liveBtnLabel.textContent = 'Go Live';
  }
}

function startLiveTicker() {
  stopLiveTicker();
  air.tick = setInterval(function () {
    if (!air) return;
    var elapsed = (Date.now() - air.startedAt) / 1000;
    el.liveBtnLabel.textContent = formatCompact(elapsed);
  }, 1000);
}

function stopLiveTicker() {
  if (air && air.tick) { clearInterval(air.tick); air.tick = null; }
}

el.liveBtn.addEventListener('click', function () {
  if (air) {
    if (air.stopRequested) toast('Still ending the stream…');
    else stopLive();
    return;
  }
  startLive();
});
el.liveStopBtn.addEventListener('click', function () {
  if (!air || air.stopRequested) return;
  stopLive();
});
[el.rtmpUrlInput, el.rtmpKeyInput, el.rtmpBackupInput].forEach(function (input) {
  if (input) input.addEventListener('change', saveStreamSettings);
});

el.recordBtn.addEventListener('click', function () {
  if (rec) {
    if (rec.stopRequested) toast('Still finishing the last recording…');
    else stopRecording();
    return;
  }
  startRecording();
});
el.recPauseBtn.addEventListener('click', function () {
  if (!rec || rec.stopRequested) return;
  if (rec.state === 'paused') resumeRecording(); else pauseRecording();
});
el.recStopBtn.addEventListener('click', function () {
  if (!rec || rec.stopRequested) return;
  stopRecording();
});

// Leaving the page tears the capture down; the encoders are flushed as the page
// unloads so a file is not left without its index and the relay is not left
// waiting for bytes that will never come.
window.addEventListener('beforeunload', function () {
  [rec, air].forEach(function (run) {
    if (!run) return;
    if (run.muxer) { try { run.muxer.finalize(); } catch (err) {} }
    if (run.sink === 'stream' && run.ws) {
      try { if (run.ws.readyState === 1) run.ws.close(1000); } catch (err) {}
    }
  });
});
  /* ==========================================================================
     14. KEYBOARD SHORTCUTS
     Anything typed into a field is left alone; otherwise ←/→ step verses,
     ↑/↓ step lyric lines, Space launches, and the ‹ › buttons mirror these.
     ========================================================================== */

  document.addEventListener('keydown', function (e) {
    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    var family = modeFamily(preview.mode);
    if (e.key === 'ArrowLeft' && family === 'scripture') { e.preventDefault(); stepScripture(-1); }
    else if (e.key === 'ArrowRight' && family === 'scripture') { e.preventDefault(); stepScripture(1); }
    else if (e.key === 'ArrowUp' && family === 'lyrics') { e.preventDefault(); stepLyric(-1); }
    else if (e.key === 'ArrowDown' && family === 'lyrics') { e.preventDefault(); stepLyric(1); }
    else if (e.key === ' ') { e.preventDefault(); pushLive(false); }
  });

  /* ==========================================================================
     15. INIT
     ========================================================================== */

  function init() {
    loadPersisted();
    loadSongs();
    loadStreamSettings();
    probeStreamRelay();

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
    if (preview.webpageUrl) el.webpageUrlInput.value = preview.webpageUrl;

    setRecordButton(null);

    // Report the saved AI key (masked) and whether the features are on.
    reflectAiKey();

    // Read the camera list up front so the picker is ready the moment the
    // operator switches to Camera. Permission is only requested when they
    // actually open that panel (setMode), not on every console load.
    refreshCameras();

    // Audio inputs (microphone, a DroidCam phone, a desk on the line-in jack)
    // and the remembered line-in switch.
    setAudioLineIn(!!preview.audioLineIn);
    refreshAudioInputs();

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
