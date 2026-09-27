/* ============================================================================
   EXPLOITS WORSHIP CENTRE — PROJECTION DISPLAY

   This is the screen the congregation sees, and nothing else. It has no
   controls and no settings: a console window (console.html) decides what is
   live and pushes it here over a BroadcastChannel. The same page doubles as
   the console's review pane — the console embeds it in an iframe, adds
   `.is-preview` to <body> and scales the identical 1600×900 stage down, so
   what the operator reviews is pixel-for-pixel what goes live.

   Message flow (all over the 'ewc-display-bus' BroadcastChannel):

     console → display   { type:'push',  revision, mode, content, background }
     console → display   { type:'background', image }      (photo chosen/removed)
     console → display   { type:'ping' }                    (who's out there?)
     display → console   { type:'hello',  clientId }         (on load / on ping)
     display → console   { type:'bye',    clientId }         (on unload)
     display → console   { type:'status', text }             (couldn't load X)

   A message that is not addressed to this client is ignored, and any push
   with a revision at or below the last applied one is dropped — so a console
   refresh can't make the screen jump backwards.
   ========================================================================== */
(function () {
  'use strict';

  var EWC = window.EWC;

  /* ==========================================================================
     1. DOM REFERENCES
     ========================================================================== */

  var el = {
    stage: document.getElementById('stage'),
    bgLayer: document.getElementById('bg-layer'),
    particleCanvas: document.getElementById('particle-canvas'),

    timerView: document.getElementById('timer-view'),
    timerRow: document.getElementById('timer-row'),
    timerCaption: document.getElementById('timer-caption'),
    timerSubcaption: document.getElementById('timer-subcaption'),

    clockView: document.getElementById('clock-view'),
    clockCanvas: document.getElementById('clock-canvas'),
    clockReadout: document.getElementById('clock-readout'),
    clockDate: document.getElementById('clock-date'),

    scriptureView: document.getElementById('scripture-view'),
    scriptureText: document.getElementById('scripture-text'),
    scriptureReference: document.getElementById('scripture-reference'),

    lyricsView: document.getElementById('lyrics-view'),
    lyricsTitle: document.getElementById('lyrics-title'),
    lyricsScrollport: document.getElementById('lyrics-scrollport'),
    lyricsTrack: document.getElementById('lyrics-track'),
    lyricsEmpty: document.getElementById('lyrics-empty'),

    microTime: document.getElementById('micro-time')
  };

  /* ==========================================================================
     2. LIVE STATE — entirely owned by the console, applied here
     ========================================================================== */

  var state = {
    mode: 'timer',
    eventName: 'Sunday Service',
    targetISO: EWC.nextSunday9am().toISOString(),
    scripture: { text: 'Loading Scripture…', reference: '' },
    lyrics: { title: 'Lyrics', lines: null, index: 0, emptyMessage: '' },
    hasCustomBg: false
  };

  var renderedUnitKeys = '';
  var lastRevision = -1;
  var lastSessionId = null;
  var clientId = 'display-' + Math.random().toString(36).slice(2, 9);

  /* ==========================================================================
     3. COUNTDOWN TIMER
     ========================================================================== */

  function buildTimerStructure(segments) {
    el.timerRow.innerHTML = '';
    segments.forEach(function (seg, i) {
      var group = document.createElement('div');
      group.className = 'digit-group';
      group.dataset.unit = seg.unit;
      group.textContent = seg.value;
      el.timerRow.appendChild(group);

      if (i < segments.length - 1) {
        var colon = document.createElement('span');
        colon.className = 'colon';
        colon.textContent = ':';
        el.timerRow.appendChild(colon);
      }
    });
    renderedUnitKeys = segments.map(function (s) { return s.unit; }).join(',');
  }

  function updateTimerValues(segments) {
    segments.forEach(function (seg) {
      var group = el.timerRow.querySelector('[data-unit="' + seg.unit + '"]');
      if (group && group.textContent !== seg.value) group.textContent = seg.value;
    });
  }

  /** Called once a second while the timer is the live view. */
  function renderTimer() {
    var target = new Date(state.targetISO);
    var remainingMs = target.getTime() - Date.now();
    var result = EWC.getVisibleSegments(remainingMs);
    var segments = result.segments;
    var unitKeys = segments.map(function (s) { return s.unit; }).join(',');

    if (unitKeys !== renderedUnitKeys) {
      buildTimerStructure(segments); // the *set* of units changed
    } else {
      updateTimerValues(segments);   // every other tick, text only
    }

    var isComplete = result.totalSeconds <= 0;
    el.timerView.classList.toggle('is-complete', isComplete);
    el.timerCaption.textContent = isComplete
      ? state.eventName + ' has begun'
      : 'to ' + state.eventName;
    el.timerSubcaption.textContent = isComplete ? '' : EWC.formatTargetSubcaption(target);
  }

  /* ==========================================================================
     4. THREE.JS — AMBIENT BACKGROUND PARTICLES
     ========================================================================== */

  function initParticles() {
    try {
      var renderer = new THREE.WebGLRenderer({ canvas: el.particleCanvas, alpha: true, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

      var scene = new THREE.Scene();
      var camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
      camera.position.z = 12;

      var COUNT = 220;
      var positions = new Float32Array(COUNT * 3);
      var speeds = new Float32Array(COUNT);
      for (var i = 0; i < COUNT; i++) {
        positions[i * 3] = (Math.random() - 0.5) * 24;
        positions[i * 3 + 1] = (Math.random() - 0.5) * 14;
        positions[i * 3 + 2] = (Math.random() - 0.5) * 10;
        speeds[i] = 0.15 + Math.random() * 0.35;
      }

      var geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

      // PointsMaterial draws flat squares without a sprite, so bake a soft
      // radial-gradient dot and use it to turn each point into a glowing ember.
      var spriteCanvas = document.createElement('canvas');
      spriteCanvas.width = spriteCanvas.height = 64;
      var spriteCtx = spriteCanvas.getContext('2d');
      var gradient = spriteCtx.createRadialGradient(32, 32, 0, 32, 32, 32);
      gradient.addColorStop(0, 'rgba(255,255,255,1)');
      gradient.addColorStop(0.4, 'rgba(255,220,160,.8)');
      gradient.addColorStop(1, 'rgba(255,180,80,0)');
      spriteCtx.fillStyle = gradient;
      spriteCtx.fillRect(0, 0, 64, 64);

      var material = new THREE.PointsMaterial({
        color: new THREE.Color('#ffc24b'),
        map: new THREE.CanvasTexture(spriteCanvas),
        size: 0.16,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      });
      scene.add(new THREE.Points(geometry, material));

      var resize = function () {
        var rect = el.particleCanvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        camera.aspect = rect.width / rect.height;
        camera.updateProjectionMatrix();
        renderer.setSize(rect.width, rect.height, false);
      };

      var update = function () {
        var pos = geometry.attributes.position.array;
        for (var i = 0; i < COUNT; i++) {
          pos[i * 3 + 1] += speeds[i] * 0.004;
          if (pos[i * 3 + 1] > 7) pos[i * 3 + 1] = -7;
        }
        geometry.attributes.position.needsUpdate = true;
        renderer.render(scene, camera);
      };

      return { resize: resize, update: update };
    } catch (err) {
      console.warn('Ambient particles unavailable:', err);
      return { resize: noop, update: noop };
    }
  }

  function noop() {}

  /* ==========================================================================
     5. THREE.JS — ANALOG CLOCK
     Each hand's pivot points along local +Y at rest (12 o'clock); rotating it
     by -fraction·2π turns it clockwise by that fraction of a full circle.
     ========================================================================== */

  function initAnalogClock() {
    try {
      var renderer = new THREE.WebGLRenderer({ canvas: el.clockCanvas, alpha: true, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

      var scene = new THREE.Scene();
      var camera = new THREE.PerspectiveCamera(34, 1, 0.1, 50);
      camera.position.set(0, 0.4, 13);
      camera.lookAt(0, 0, 0);

      scene.add(new THREE.AmbientLight(0x8891c4, 0.55));
      var keyLight = new THREE.PointLight(0xffc24b, 1.4, 30);
      keyLight.position.set(4, 5, 6);
      scene.add(keyLight);
      var fillLight = new THREE.PointLight(0x3a4b9c, 0.9, 30);
      fillLight.position.set(-5, -3, 4);
      scene.add(fillLight);

      var clockGroup = new THREE.Group();
      scene.add(clockGroup);

      clockGroup.add(new THREE.Mesh(
        new THREE.TorusGeometry(3.05, 0.18, 24, 64),
        new THREE.MeshStandardMaterial({ color: 0xffc24b, metalness: 0.75, roughness: 0.32 })
      ));

      var face = new THREE.Mesh(
        new THREE.CircleGeometry(2.95, 64),
        new THREE.MeshPhysicalMaterial({
          color: 0xf8f9fd, transparent: true, opacity: 0.14,
          roughness: 0.15, metalness: 0.05, clearcoat: 0.6, side: THREE.DoubleSide
        })
      );
      face.position.z = 0.05;
      clockGroup.add(face);

      var hourTickGeo = new THREE.BoxGeometry(0.09, 0.32, 0.05);
      var minuteTickGeo = new THREE.BoxGeometry(0.04, 0.14, 0.05);
      var tickMat = new THREE.MeshStandardMaterial({ color: 0xf8f9fd, metalness: 0.1, roughness: 0.4 });
      var hourTickMat = new THREE.MeshStandardMaterial({ color: 0xffc24b, metalness: 0.3, roughness: 0.3 });
      for (var i = 0; i < 60; i++) {
        var isHour = i % 5 === 0;
        var angle = (i / 60) * Math.PI * 2;
        var radius = isHour ? 2.68 : 2.78;
        var tick = new THREE.Mesh(isHour ? hourTickGeo : minuteTickGeo, isHour ? hourTickMat : tickMat);
        tick.position.set(Math.sin(angle) * radius, Math.cos(angle) * radius, 0.15);
        tick.rotation.z = -angle;
        clockGroup.add(tick);
      }

      function makeHand(length, width, color, zOffset) {
        var pivot = new THREE.Group();
        var mesh = new THREE.Mesh(
          new THREE.BoxGeometry(width, length, 0.06),
          new THREE.MeshStandardMaterial({ color: color, metalness: 0.4, roughness: 0.35 })
        );
        mesh.position.y = length / 2 - width;
        mesh.position.z = zOffset;
        pivot.add(mesh);
        clockGroup.add(pivot);
        return pivot;
      }

      var hourHand = makeHand(1.35, 0.14, 0xf8f9fd, 0.22);
      var minuteHand = makeHand(1.95, 0.1, 0xf8f9fd, 0.26);
      var secondHand = makeHand(2.2, 0.035, 0xf2701b, 0.3);

      var cap = new THREE.Mesh(
        new THREE.CylinderGeometry(0.14, 0.14, 0.4, 24),
        new THREE.MeshStandardMaterial({ color: 0xffc24b, metalness: 0.7, roughness: 0.25 })
      );
      cap.rotation.x = Math.PI / 2;
      cap.position.z = 0.32;
      clockGroup.add(cap);

      var resize = function () {
        var rect = el.clockCanvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        camera.aspect = 1; // .clock-frame is always square; trust that, not rect
        camera.updateProjectionMatrix();
        var size = Math.min(rect.width, rect.height);
        renderer.setSize(size, size, false);
      };

      var update = function (now) {
        var hourFraction = ((now.getHours() % 12) + now.getMinutes() / 60) / 12;
        var minuteFraction = (now.getMinutes() + now.getSeconds() / 60) / 60;
        var secondFraction = (now.getSeconds() + now.getMilliseconds() / 1000) / 60;

        hourHand.rotation.z = -hourFraction * Math.PI * 2;
        minuteHand.rotation.z = -minuteFraction * Math.PI * 2;
        secondHand.rotation.z = -secondFraction * Math.PI * 2;

        var t = now.getTime() / 1000;
        clockGroup.rotation.x = Math.sin(t * 0.15) * 0.05;
        clockGroup.rotation.y = Math.cos(t * 0.1) * 0.06;

        renderer.render(scene, camera);
      };

      return { resize: resize, update: update };
    } catch (err) {
      console.warn('Analog clock unavailable:', err);
      return { resize: noop, update: noop };
    }
  }

  var particles = initParticles();
  var analogClock = initAnalogClock();

  /* ==========================================================================
     6. SCRIPTURE
     The console resolves the verse text (it owns the picker and the manual
     file fallback) and sends the string to show, so this page never has to
     load the Bible itself.
     ========================================================================== */

  var scriptureFadeTimer = null;

  function renderScripture() {
    var text = state.scripture.text || 'Scripture unavailable';
    var reference = state.scripture.reference || '';

    el.scriptureText.style.opacity = '0';
    el.scriptureReference.style.opacity = '0';
    clearTimeout(scriptureFadeTimer);
    scriptureFadeTimer = setTimeout(function () {
      el.scriptureText.textContent = text;
      el.scriptureReference.textContent = reference;
      fitScriptureText();
      el.scriptureText.style.opacity = '1';
      el.scriptureReference.style.opacity = '1';
    }, 220);
  }

  /** Long verses are scaled down to fit the card rather than running off the
   *  bottom of the projection. Reset to the stylesheet size, then step down
   *  until it fits (bounded, so a pathological verse can't loop forever). */
  function fitScriptureText() {
    if (state.mode !== 'scripture') { el.scriptureText.style.fontSize = ''; return; }
    var node = el.scriptureText;
    node.style.fontSize = '';
    var base = parseFloat(getComputedStyle(node).fontSize) || 32;
    var available = el.scriptureView.clientHeight;
    if (!available) return;

    var size = base;
    var guard = 0;
    while (node.scrollHeight > available && size > base * 0.4 && guard++ < 60) {
      size -= 1;
      node.style.fontSize = size + 'px';
    }
  }

  /* ==========================================================================
     7. LYRICS
     The console sends the whole song (title + lines) plus the focused index.
     The track is rebuilt only when the song actually changes; stepping a line
     just re-applies classes and the glide offset.
     ========================================================================== */

  var renderedSongTitle = null;

  function renderLyrics() {
    var lyrics = state.lyrics;

    if (!lyrics.lines || !lyrics.lines.length) {
      el.lyricsTitle.textContent = lyrics.title || 'Lyrics';
      el.lyricsScrollport.hidden = true;
      el.lyricsEmpty.hidden = false;
      el.lyricsEmpty.textContent = lyrics.emptyMessage || 'No song selected.';
      el.lyricsTrack.innerHTML = '';
      renderedSongTitle = null;
      return;
    }

    el.lyricsTitle.textContent = lyrics.title;
    el.lyricsEmpty.hidden = true;
    el.lyricsScrollport.hidden = false;

    if (renderedSongTitle !== lyrics.title) {
      el.lyricsTrack.innerHTML = '';
      lyrics.lines.forEach(function (line) {
        var p = document.createElement('p');
        p.className = 'lyric-line';
        p.textContent = line;
        el.lyricsTrack.appendChild(p);
      });
      renderedSongTitle = lyrics.title;
    }

    applyLyricFocus();
  }

  /** Marks the focused line and slides the track so it sits centred. Position
   *  comes from the row's own offsetTop/offsetHeight — a long lyric wraps, so
   *  the stride is not uniform and an assumed one would land off-centre. */
  function applyLyricFocus() {
    var lines = el.lyricsTrack.children;
    if (!lines.length) return;

    var index = state.lyrics.index;
    if (index < 0) index = 0;
    if (index >= lines.length) index = lines.length - 1;

    for (var i = 0; i < lines.length; i++) {
      lines[i].classList.toggle('is-active', i === index);
      lines[i].classList.toggle('is-past', i < index);
    }

    var active = lines[index];
    var rowTop = active.offsetTop;
    var rowHeight = active.offsetHeight;
    var viewportHeight = el.lyricsScrollport.clientHeight;
    el.lyricsTrack.style.transform = 'translateY(' + -(rowTop + rowHeight / 2 - viewportHeight / 2) + 'px)';

    // A tall active row can overflow the short scrollport; tighten the type
    // rather than let the current line be cut in half.
    el.lyricsScrollport.classList.toggle('is-tight', rowHeight > viewportHeight * 0.86);
  }

  /* ==========================================================================
     8. BACKGROUND IMAGE
     The console bakes the chosen photo down to a reasonable size and stores it
     in the shared IndexedDB store; cookie-light copies (under ~60 KB) also
     travel on the wire so the very first paint after a console refresh can be
     instant. This page keeps its own remembered choice in localStorage so a
     projector restart restores the backdrop without the console present.
     ========================================================================== */

  var CHOICE_KEY = 'ewc-display-bg-choice-v1';
  var appliedBytesLength = -1;
  var objectURL = null;

  function applyBackgroundImage(url) {
    if (objectURL) { URL.revokeObjectURL(objectURL); objectURL = null; }
    el.bgLayer.style.backgroundImage = 'url("' + url + '")';
    el.particleCanvas.style.opacity = '0.35';
    state.hasCustomBg = true;
  }

  function clearBackgroundImage() {
    if (objectURL) { URL.revokeObjectURL(objectURL); objectURL = null; }
    el.bgLayer.style.backgroundImage = '';
    el.particleCanvas.style.opacity = '0.65';
    state.hasCustomBg = false;
  }

  /** Applies raw image bytes (an ArrayBuffer) as the backdrop. */
  function applyBackgroundBuffer(data) {
    if (!data) {
      appliedBytesLength = -1;
      clearBackgroundImage();
      rememberChoice(false);
      return;
    }
    appliedBytesLength = data.byteLength;
    applyBackgroundImage(URL.createObjectURL(new Blob([data])));
    rememberChoice(true);
  }

  /** Reads the shared store and applies it. Skipped when the stored bytes
   *  match what is already on screen (the console nudges more than once). */
  function refreshBackgroundFromStore() {
    return EWC.getBackgroundImage().then(function (data) {
      if (!data) {
        if (state.hasCustomBg || appliedBytesLength !== -1) applyBackgroundBuffer(null);
        return;
      }
      if (data.byteLength === appliedBytesLength && state.hasCustomBg) return;
      applyBackgroundBuffer(data);
    }).catch(function (err) {
      console.warn('Could not read the stored background:', err);
    });
  }

  function rememberChoice(hasImage) {
    try { localStorage.setItem(CHOICE_KEY, JSON.stringify({ hasImage: hasImage })); } catch (err) {}
  }

  /* ==========================================================================
     9. THE BUS
     ========================================================================== */

  var bus = null;
  var isPreview = /(?:^|[?&])preview=1(?:&|$)/.test(location.search);
  try {
    // A preview iframe drives itself directly and must not answer the bus,
    // otherwise it would look doubly present to the console.
    if (!isPreview && 'BroadcastChannel' in window) {
      bus = new BroadcastChannel('ewc-display-bus');
    }
  } catch (err) {
    console.warn('BroadcastChannel unavailable — running as a standalone screen:', err);
  }

  function send(message) {
    if (!bus) return;
    message.from = clientId;
    try { bus.postMessage(message); } catch (err) { console.warn('Could not post to bus:', err); }
  }

  function isForMe(message) {
    return !message.target || message.target === clientId || message.target === 'display';
  }

  bus && (bus.onmessage = function (event) {
    var message = event.data;
    if (!message || !message.type || message.from === clientId) return;

    if (message.type === 'ping') {
      // `mode` is null until a console has actually launched something — a
      // freshly opened (or reloaded) display is showing its default view, and
      // reporting that as "live" would make the console lie.
      send({ type: 'hello', mode: lastSessionId === null ? null : state.mode, revision: lastRevision });
      return;
    }
    if (!isForMe(message)) return;

    if (message.type === 'push') {
      // A new console session resets its revision counter, so only compare
      // revisions within the same session — otherwise every launch after a
      // console refresh would look like an old, already-applied message.
      if (message.session !== lastSessionId) {
        lastSessionId = message.session;
        lastRevision = -1;
      }
      if (typeof message.revision === 'number' && message.revision <= lastRevision) return;
      if (typeof message.revision === 'number') lastRevision = message.revision;
      applyPush(message);
    } else if (message.type === 'background') {
      // The bytes themselves live in the shared IndexedDB store; the message
      // is just the nudge to look. A cookie-light copy may ride along so the
      // very first paint after a console refresh is instant.
      if (message.buffer) { applyBackgroundBuffer(message.buffer); return; }
      refreshBackgroundFromStore().then(function () {
        if (message.image) applyBackgroundImage(message.image);
      });
      if (!message.image) EWC.putBackgroundImage(null).catch(noop);
    }
  });

  /** Console iframe: apply a state directly, bypassing the bus entirely. */
  window.__ewcPreview = {
    apply: function (message) { applyPush(message); },
    backgroundBuffer: applyBackgroundBuffer
  };

  /** Applies one complete console state. */
  function applyPush(message) {
    if (message.session) lastSessionId = message.session;
    if (message.mode) state.mode = message.mode;
    var content = message.content || {};

    if (state.mode === 'timer') {
      if (content.eventName) state.eventName = content.eventName;
      if (content.targetISO) { state.targetISO = content.targetISO; renderedUnitKeys = ''; }
    } else if (state.mode === 'scripture') {
      state.scripture = { text: content.text, reference: content.reference };
    } else if (state.mode === 'lyrics') {
      state.lyrics = {
        title: content.title || 'Lyrics',
        lines: Array.isArray(content.lines) ? content.lines : null,
        index: typeof content.index === 'number' ? content.index : 0,
        emptyMessage: content.emptyMessage || ''
      };
    }

    setMode(state.mode);

    // The photo only changes on an explicit backdrop action, so re-read the
    // shared store just for those and leave it alone on every verse step.
    if (message.backgroundChanged) refreshBackgroundFromStore();
  }

  function setMode(mode) {
    el.timerView.style.display = mode === 'timer' ? 'flex' : 'none';
    el.clockView.style.display = mode === 'clock' ? 'flex' : 'none';
    el.scriptureView.style.display = mode === 'scripture' ? 'flex' : 'none';
    el.lyricsView.style.display = mode === 'lyrics' ? 'flex' : 'none';

    if (mode === 'timer') renderTimer();
    if (mode === 'clock') {
      // The clock-view may still be mid-layout (display:none → flex) this
      // instant, so resize now and again on the next frame.
      analogClock.resize();
      requestAnimationFrame(function () { analogClock.resize(); });
    }
    if (mode === 'scripture') {
      renderScripture();
      requestAnimationFrame(fitScriptureText);
    }
    if (mode === 'lyrics') {
      renderLyrics();
      requestAnimationFrame(function () { renderLyrics(); });
    }
  }

  /* ==========================================================================
     10. PREVIEW MODE + INIT
     ========================================================================== */

  function fitPreview() {
    if (!document.body.classList.contains('is-preview')) return;
    var scale = Math.min(window.innerWidth / 1600, window.innerHeight / 900);
    document.body.style.setProperty('--preview-scale', String(scale));
    handleResize();
  }

  function handleResize() {
    particles.resize();
    analogClock.resize();
    if (state.mode === 'lyrics') applyLyricFocus();
    if (state.mode === 'scripture') fitScriptureText();
  }

  var resizeDebounce = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(function () { fitPreview(); handleResize(); }, 60);
  });

  /** One shared render loop for the particles, the 3D clock and the countdown. */
  var lastRenderedSecond = -1;
  function frame() {
    var now = new Date();
    particles.update();

    var currentSecond = now.getSeconds();
    if (state.mode === 'clock') {
      analogClock.update(now);
      if (currentSecond !== lastRenderedSecond) {
        el.clockReadout.textContent = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
        el.clockDate.textContent = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
      }
    }

    if (currentSecond !== lastRenderedSecond) {
      lastRenderedSecond = currentSecond;
      if (state.mode === 'timer') renderTimer();
      el.microTime.textContent = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    }

    requestAnimationFrame(frame);
  }

  function init() {
    // Restore the remembered backdrop, then adopt the console's if it pushes
    // one. On a projector restart with no console around, this alone brings
    // the picture back.
    try {
      var choice = JSON.parse(localStorage.getItem(CHOICE_KEY) || 'null');
      if (choice && choice.hasImage) refreshBackgroundFromStore();
    } catch (err) {}

    if (isPreview) document.body.classList.add('is-preview');

    setMode(state.mode);
    fitPreview();
    handleResize();
    requestAnimationFrame(frame);

    send({ type: 'hello' }); // tell any listening console we're here
  }

  window.addEventListener('pagehide', function () { send({ type: 'bye' }); });

  init();
})();
