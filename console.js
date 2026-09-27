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

   A third, deliberately narrower path is the "silent" one: stepping to the
   next verse or lyric line while that item is already live updates the screen
   straight away, since re-launching every line mid-song would be unusable.
   Those controls call `pushLive` and skip the launch step; they are a no-op
   for the screen if nothing is live yet.

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
    eventName: 'Sunday Service',
    targetISO: EWC.nextSunday9am().toISOString(),
    scriptureBookIndex: 0,
    scriptureChapter: 2,
    scriptureVerse: 4,
    activeSongId: null,
    lyricLineIndex: 0
  };

  /** The last thing launched. `null` mode means nothing has been launched. */
  var live = { mode: null, content: null };

  var bibleData = null;
  var songs = [];
  var revision = 0;
  var sessionId = 'session-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);

  /** Serialised snapshot of what is on the screen, for comparing against the
   *  preview to tell whether the operator has edited what was launched. */
  function fingerprint(mode, content) {
    if (mode === null) return '';
    return mode + '|' + JSON.stringify(content || null);
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
        eventName: preview.eventName,
        targetISO: preview.targetISO,
        scriptureBookIndex: preview.scriptureBookIndex,
        scriptureChapter: preview.scriptureChapter,
        scriptureVerse: preview.scriptureVerse,
        activeSongId: preview.activeSongId,
        lyricLineIndex: preview.lyricLineIndex
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
    return {};
  }

  function pushMessage(state, revisionNumber) {
    return {
      type: 'push',
      session: sessionId,
      revision: revisionNumber,
      mode: state.mode,
      content: buildContent(state)
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
      content: buildContent(preview)
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
    if (live.mode !== preview.mode) {
      el.previewNote.textContent = 'Not launched — ' + describe(live.mode, live.content) + ' is still on the screen.';
      el.previewNote.dataset.state = 'idle';
      return;
    }
    if (fingerprint(live.mode, live.content) !== fingerprint(preview.mode, buildContent(preview))) {
      el.previewNote.textContent = 'Preview edited — press Launch to put it on the screen.';
      el.previewNote.dataset.state = 'idle';
      return;
    }
    el.previewNote.textContent = 'Live on the church screen: ' + describe(live.mode, live.content) + '.';
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
        live = { mode: message.mode, content: buildContent(preview) };
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
    live = { mode: preview.mode, content: buildContent(preview) };
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
     8. SILENT LIVE CONTROLS
     While scripture or lyrics are already live, stepping the line/verse goes
     straight to the screen without a launch. If nothing is live (or a
     different mode is live) this is a pure preview change.
     ========================================================================== */

  function liveMatchesMode(mode) { return live.mode === mode; }

  function stepScripture(direction) {
    if (!bibleData) return;
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
    renderPreview();
    if (liveMatchesMode('scripture')) pushLive(false); else updateLaunchNote();
    savePersisted();
  }

  function stepLyric(direction) {
    var song = getActiveSong();
    if (!song) return;
    var next = preview.lyricLineIndex + direction;
    if (next < 0 || next >= song.lines.length) return; // deliberately no wrap
    preview.lyricLineIndex = next;
    renderPreview();
    if (liveMatchesMode('lyrics')) pushLive(false); else updateLaunchNote();
    savePersisted();
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
    renderPreview();
    if (liveMatchesMode('scripture')) pushLive(false);
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
    renderPreview();
    if (liveMatchesMode('scripture')) pushLive(false);
    savePersisted();
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

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'song-delete';
      remove.textContent = '\u00d7';
      remove.title = 'Delete ' + song.title;
      remove.setAttribute('aria-label', 'Delete ' + song.title);
      remove.addEventListener('click', function () { deleteSong(song.id); });

      row.appendChild(load);
      row.appendChild(remove);
      el.songList.appendChild(row);
    });
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

    // Same title = an edit, so re-saving updates rather than duplicating.
    var existing = songs.find(function (song) { return song.title.toLowerCase() === title.toLowerCase(); });
    var song = existing || { id: makeSongId(), title: title, lines: [], updatedAt: 0 };
    song.title = title;
    song.lines = lines;
    song.updatedAt = Date.now();
    if (!existing) songs.push(song);
    if (!saveSongs()) return;

    el.songTitleInput.value = '';
    el.songLyricsInput.value = '';
    setSongStatus(existing ? 'Updated “' + title + '”.' : 'Saved “' + title + '”.');

    showSong(song.id);
    setMode('lyrics');
  }

  function deleteSong(id) {
    songs = songs.filter(function (song) { return song.id !== id; });
    if (preview.activeSongId === id) {
      preview.activeSongId = null;
      preview.lyricLineIndex = 0;
    }
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
     12. MODE SWITCHING + TIMER FIELDS
     ========================================================================== */

  function setMode(mode) {
    preview.mode = mode;

    document.getElementById('timer-fields').style.opacity = mode === 'timer' ? '1' : '.4';
    document.getElementById('scripture-fields').style.opacity = mode === 'scripture' ? '1' : '.4';
    document.getElementById('lyrics-fields').style.opacity = mode === 'lyrics' ? '1' : '.4';

    el.modeToggleGroup.querySelectorAll('button').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    afterPreviewChange();
  }

  el.modeToggleGroup.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-mode]');
    if (btn) setMode(btn.dataset.mode);
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

    // Paint the iframe. It may already be loaded when this runs (cache), in
    // which case the `load` event will never fire again.
    if (previewFrame.contentDocument && previewFrame.contentDocument.readyState === 'complete') {
      onPreviewReady();
    }

    el.modeToggleGroup.querySelectorAll('button').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.mode === preview.mode);
    });
    updateLaunchNote();
    ping();
  }

  init();
})();
