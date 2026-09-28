/* ============================================================================
   EXPLOITS WORSHIP CENTRE — SHARED DISPLAY HELPERS

   This module is loaded by *both* pages:

     display.html  — the projection screen. Runs the wall clock, the countdown
                     and the ambient background; renders the "live" content.
     console.html  — the control room. Together with an inline copy of this
                     same module (in its own <script> block) it previews the
                     show and drives the display over a BroadcastChannel.

   Only pure, side-effect-free helpers and the read-only song library live
   here, so neither page can accidentally become the source of truth for the
   other. State and realtime sync are each page's own business.
   ========================================================================== */
(function (global) {
  'use strict';

  var EWC = global.EWC = global.EWC || {};

  /* -- Small utilities ------------------------------------------------------- */

  /** Zero-pads a number to two digits. */
  function pad2(n) { return String(n).padStart(2, '0'); }

  /** The next upcoming Sunday at 09:00 local time — a friendly default so the
   *  countdown is never sitting at 00:00:00 on first load. */
  function nextSunday9am() {
    var now = new Date();
    var result = new Date(now);
    result.setHours(9, 0, 0, 0);
    var daysUntilSunday = (7 - now.getDay()) % 7; // 0 if today is Sunday
    if (daysUntilSunday === 0 && result <= now) {
      result.setDate(result.getDate() + 7); // today's 9am already passed
    } else {
      result.setDate(result.getDate() + daysUntilSunday);
    }
    return result;
  }

  /** Formats a Date for an <input type="datetime-local"> value. */
  function toDatetimeLocalValue(date) {
    return [
      date.getFullYear(),
      pad2(date.getMonth() + 1),
      pad2(date.getDate())
    ].join('-') + 'T' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  /** Formats the countdown target for the caption, e.g. "Sun, 27 Sep · 9:00 AM". */
  function formatTargetSubcaption(targetDate) {
    var dateStr = targetDate.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    var timeStr = targetDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return dateStr + ' \u00b7 ' + timeStr;
  }

  /** Breaks a remaining duration (ms) into the units worth showing. An empty
   *  leading unit (hours, then minutes) is dropped rather than shown as "00",
   *  so a 45-second countdown reads as just "45". */
  function getVisibleSegments(remainingMs) {
    var totalSeconds = Math.max(0, Math.round(remainingMs / 1000));
    var h = Math.floor(totalSeconds / 3600);
    var m = Math.floor((totalSeconds % 3600) / 60);
    var s = totalSeconds % 60;

    var segments = [];
    if (h > 0) segments.push({ unit: 'hours', value: pad2(h) });
    if (h > 0 || m > 0) segments.push({ unit: 'minutes', value: pad2(m) });
    segments.push({ unit: 'seconds', value: pad2(s) }); // seconds always shown
    return { segments: segments, totalSeconds: totalSeconds };
  }

  /* -- Scripture text normalisation -----------------------------------------
     en_kjv.json carries the KJV's own printing apparatus inline: {are} marks a
     supplied word, {word: Heb. ...} is a translator's note, and «...» wraps a
     book colophon. bible-data.js is already cleaned when it is generated, but
     a raw en_kjv.json arriving via fetch() or the file picker is not — so
     normalise here and both pages render identically. */

  var FALLBACK_BOOK_NAMES = [
    'Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy', 'Joshua', 'Judges', 'Ruth',
    '1 Samuel', '2 Samuel', '1 Kings', '2 Kings', '1 Chronicles', '2 Chronicles', 'Ezra',
    'Nehemiah', 'Esther', 'Job', 'Psalms', 'Proverbs', 'Ecclesiastes', 'Song of Solomon',
    'Isaiah', 'Jeremiah', 'Lamentations', 'Ezekiel', 'Daniel', 'Hosea', 'Joel', 'Amos',
    'Obadiah', 'Jonah', 'Micah', 'Nahum', 'Habakkuk', 'Zephaniah', 'Haggai', 'Zechariah',
    'Malachi', 'Matthew', 'Mark', 'Luke', 'John', 'Acts', 'Romans', '1 Corinthians',
    '2 Corinthians', 'Galatians', 'Ephesians', 'Philippians', 'Colossians', '1 Thessalonians',
    '2 Thessalonians', '1 Timothy', '2 Timothy', 'Titus', 'Philemon', 'Hebrews', 'James',
    '1 Peter', '2 Peter', '1 John', '2 John', '3 John', 'Jude', 'Revelation'
  ];

  var KJV_NOTE = /:\s|\.\.\.|\b(?:Heb|Gr|Chal|Syriac|Arab|i\.e)\.|(?:^|[;,])\s*or,/;
  var KJV_NOTE_MAX_LENGTH = 34; // supplied-word spans are always short

  function isKjvNote(span) {
    return span.length > KJV_NOTE_MAX_LENGTH || KJV_NOTE.test(span);
  }

  /** Drops translator's notes and colophons, unwrapping supplied words so the
   *  verse reads as clean scripture. */
  function stripKjvMarkup(verse) {
    if (verse.indexOf('{') === -1 && verse.indexOf('\u00ab') === -1) return verse;
    var text = verse.replace(/\u00ab.*?\u00bb/g, '');
    // A few verses close a note early and leave an extra "}" — the note really
    // runs to the last "}", so treat that whole region as one span.
    if (text.split('}').length > text.split('{').length) {
      var start = text.indexOf('{');
      var end = text.lastIndexOf('}');
      if (end > start) {
        var inner = text.slice(start + 1, end);
        text = text.slice(0, start) + (isKjvNote(inner) ? '' : inner) + text.slice(end + 1);
      }
    }
    text = text.replace(/\{([^{}]*)\}/g, function (match, span) {
      return isKjvNote(span) ? '' : span;
    });
    return text.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
  }

  /** Parses JSON text, tolerating the UTF-8 BOM that some copies of
   *  en_kjv.json (including this repo's) carry — JSON.parse rejects it. */
  function parseBibleJSON(text) {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  }

  /** Cleans and installs a Bible array, returning it (or null if unusable). */
  function normalizeBibleData(data) {
    if (!Array.isArray(data) || data.length === 0) return null;
    return data.map(function (book) {
      return Object.assign({}, book, {
        chapters: book.chapters.map(function (chapter) {
          return chapter.map(stripKjvMarkup);
        })
      });
    });
  }

  /** Human-readable name for a book index, filling in a canonical name when
   *  the file itself doesn't supply one. */
  function bookName(bibleData, index) {
    var entry = bibleData && bibleData[index];
    if (entry && entry.book) return entry.book;
    if (FALLBACK_BOOK_NAMES[index]) return FALLBACK_BOOK_NAMES[index];
    return entry ? entry.abbrev.toUpperCase() : '';
  }

  /**
   * Loads the Bible text, trying in order:
   *   1. an in-page copy (a manual file the operator picked, stored in
   *      `manualBible`), honoured so their choice survives later navigations;
   *   2. bible-data.js, injected as a classic <script>. This is what makes
   *      file:/// work: browsers block fetch() against local files, but a
   *      classic script tag is still allowed;
   *   3. fetch(en_kjv.json) when the folder is served over http(s).
   * Resolves with the normalized array, or rejects with a reason.
   */
  var bibleLoadState = 'idle';
  var manualBible = null;
  var bibleInFlight = null;

  function loadBibleData(options) {
    options = options || {};
    if (manualBible) { bibleLoadState = 'ready'; return Promise.resolve(manualBible); }
    if (bibleLoadState === 'ready' && EWC.bibleData) return Promise.resolve(EWC.bibleData);
    if (bibleInFlight) return bibleInFlight;

    var bibleScript = options.bibleScript || 'bible-data.js';

    function tryScript() {
      return new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = bibleScript;
        script.onload = resolve;
        script.onerror = function () { reject(new Error('bible-data.js not found')); };
        document.head.appendChild(script);
      }).then(function () {
        var data = normalizeBibleData(global.__EWC_BIBLE_DATA__);
        if (!data) throw new Error('bible-data.js contained no data');
        return data;
      });
    }

    function tryFetch() {
      if (location.protocol === 'file:') throw new Error('local files cannot be fetched');
      return fetch('en_kjv.json').then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.text();
      }).then(function (text) {
        var data = normalizeBibleData(parseBibleJSON(text));
        if (!data) throw new Error('Unexpected file format');
        return data;
      });
    }

    bibleLoadState = 'loading';
    bibleInFlight = tryScript()
      .catch(tryFetch)
      .then(function (data) {
        EWC.bibleData = data;
        bibleLoadState = 'ready';
        bibleInFlight = null;
        return data;
      })
      .catch(function (err) {
        bibleLoadState = 'error';
        bibleInFlight = null;
        throw err;
      });
    return bibleInFlight;
  }

  /** Installs an already-parsed Bible array (e.g. a file the operator picked). */
  function setManualBible(data) {
    var normalized = normalizeBibleData(data);
    if (!normalized) return null;
    manualBible = normalized;
    EWC.bibleData = normalized;
    bibleLoadState = 'ready';
    return normalized;
  }

  /* -- Song library (read-only here) ----------------------------------------
     Songs live in localStorage under their own key rather than the settings
     blob: lyrics are far bigger than everything else the display stores, and
     keeping them separate means an oversized song can never take the timer
     settings down with it. The console is the only writer. */

  function isUsableSong(song) {
    return song && typeof song.id === 'string' && typeof song.title === 'string'
      && Array.isArray(song.lines) && song.lines.every(function (line) { return typeof line === 'string'; });
  }

  function getSongs(key) {
    try {
      var saved = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(saved) ? saved.filter(isUsableSong) : [];
    } catch (err) {
      console.warn('Could not read saved songs:', err);
      return [];
    }
  }

  /** Splits a textarea into display lines: one row per line, blank rows
   *  dropped (they'd otherwise render as empty gaps in the lyric column). */
  function splitLyricLines(text) {
    return text.split(/\r?\n/).map(function (line) { return line.trim(); })
      .filter(function (line) { return line.length > 0; });
  }

  /* -- Shared storage keys --------------------------------------------------- */
  EWC.SETTINGS_KEY = 'ewc-display-settings-v1';
  EWC.SONGS_KEY = 'ewc-display-songs-v1';

  /* -- Durable media store ---------------------------------------------------
     Two things are far too big for localStorage and cannot cross windows as an
     object URL, so both live in one shared IndexedDB database that every page
     on this origin can read:

       * 'backgrounds' — the backdrop photo. The console drops the chosen bytes
         in, the display reads them back. The bus only carries a nudge.
       * 'foreground'  — the media shown inside the glass panel (a photo,
         video, GIF or audio file). Same deal: the console stores a Blob plus
         its name/mime/kind, the display reads the record back. Camera feeds
         are not stored — the display opens its own camera. */
  var MEDIA_DB = 'ewc-display-media';
  var MEDIA_DB_VERSION = 2;
  var BG_STORE = 'backgrounds';
  var FG_STORE = 'foreground';
  var BG_KEY = 'active';
  var FG_KEY = 'active';

  function openMediaDB() {
    return new Promise(function (resolve, reject) {
      if (!global.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
      var request = indexedDB.open(MEDIA_DB, MEDIA_DB_VERSION);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(BG_STORE)) db.createObjectStore(BG_STORE);
        if (!db.objectStoreNames.contains(FG_STORE)) db.createObjectStore(FG_STORE);
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  /** Runs one transaction against a named store in the media database. */
  function withStore(storeName, mode, work) {
    return openMediaDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, mode);
        var request = work(tx.objectStore(storeName));
        tx.oncomplete = function () { resolve(request && request.result); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      }).finally(function () { db.close(); });
    });
  }

  /** Stores the baked background image (an ArrayBuffer, or null to clear). */
  function putBackgroundImage(data) {
    return withStore(BG_STORE, 'readwrite', function (store) {
      return data ? store.put(data, BG_KEY) : store.delete(BG_KEY);
    });
  }

  /** Reads back the stored background image, or null when none is set. */
  function getBackgroundImage() {
    return withStore(BG_STORE, 'readonly', function (store) {
      return store.get(BG_KEY);
    }).catch(function () { return null; });
  }

  /** Stores the foreground media record ({kind, mime, name, blob}), or clears
   *  it when passed null. */
  function putForegroundMedia(record) {
    return withStore(FG_STORE, 'readwrite', function (store) {
      return record ? store.put(record, FG_KEY) : store.delete(FG_KEY);
    });
  }

  /** Reads back the foreground media record, or null when none is set. */
  function getForegroundMedia() {
    return withStore(FG_STORE, 'readonly', function (store) {
      return store.get(FG_KEY);
    }).catch(function () { return null; });
  }

  EWC.putBackgroundImage = putBackgroundImage;
  EWC.getBackgroundImage = getBackgroundImage;
  EWC.putForegroundMedia = putForegroundMedia;
  EWC.getForegroundMedia = getForegroundMedia;

  EWC.pad2 = pad2;
  EWC.nextSunday9am = nextSunday9am;
  EWC.toDatetimeLocalValue = toDatetimeLocalValue;
  EWC.formatTargetSubcaption = formatTargetSubcaption;
  EWC.getVisibleSegments = getVisibleSegments;
  EWC.stripKjvMarkup = stripKjvMarkup;
  EWC.parseBibleJSON = parseBibleJSON;
  EWC.normalizeBibleData = normalizeBibleData;
  EWC.bookName = bookName;
  EWC.loadBibleData = loadBibleData;
  EWC.setManualBible = setManualBible;
  EWC.getBibleLoadState = function () { return bibleLoadState; };
  EWC.getSongs = getSongs;
  EWC.splitLyricLines = splitLyricLines;
  EWC.isUsableSong = isUsableSong;
  EWC.FALLBACK_BOOK_NAMES = FALLBACK_BOOK_NAMES;
})(window);
