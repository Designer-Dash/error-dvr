// public/player.js
// Runs inside a sandboxed iframe (opaque origin, no allow-same-origin).
// Anything a recorded page smuggled into the event stream executes in here,
// isolated from the DVR origin, its storage and its API token.
//
// The parent drives playback over postMessage:
//   in  : dvr:load {events} · dvr:play {at} · dvr:pause · dvr:seek {at}
//   out : dvr:ready {duration} · dvr:tick {at,duration} · dvr:end · dvr:error

(function () {
  'use strict';

  var container = document.getElementById('player');
  var msgEl = document.getElementById('msg');

  var replayer = null;
  var duration = 0;
  var timer = null;
  var lastTick = 0;
  var viewport = { width: 0, height: 0 };

  function show(text) {
    msgEl.textContent = text;
    msgEl.classList.add('show');
  }

  function hide() {
    msgEl.classList.remove('show');
  }

  function pick(global, name) {
    if (!global) return null;
    if (typeof global[name] === 'function') return global[name];
    if (global.default) {
      if (typeof global.default[name] === 'function') return global.default[name];
      if (typeof global.default === 'function' && name === 'default') return global.default;
    }
    return null;
  }

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function acceptable(event) {
    if (!isPlainObject(event)) return false;
    if (typeof event.type !== 'number') return false;
    if (event.type < 0 || event.type > 5) return false;
    if (typeof event.timestamp !== 'number' || !Number.isFinite(event.timestamp)) return false;
    return true;
  }

  function send(message) {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(message, '*');
    }
  }

  function currentTime() {
    if (!replayer) return 0;
    try {
      return Number(replayer.getCurrentTime()) || 0;
    } catch (e) {
      return 0;
    }
  }

  function stopTimer() {
    if (timer) {
      window.clearInterval(timer);
      timer = null;
    }
  }

  function startTimer() {
    stopTimer();
    timer = window.setInterval(function () {
      var at = currentTime();
      if (Math.abs(at - lastTick) < 40) return;
      lastTick = at;
      send({ type: 'dvr:tick', at: at, duration: duration });
    }, 120);
  }

  /**
   * Scale the recorded viewport down to fit the stage. rrweb renders at the
   * original size, which overflows a small panel.
   */
  function fit() {
    var wrapper = container.querySelector('.replayer-wrapper');
    if (!wrapper) return;

    var width = viewport.width;
    var height = viewport.height;
    if (!width || !height) return;

    var availW = container.clientWidth || 1;
    var availH = container.clientHeight || 1;
    var scale = Math.min(availW / width, availH / height);

    wrapper.style.transformOrigin = 'top left';
    wrapper.style.transform = 'scale(' + scale + ')';
    wrapper.style.width = width + 'px';
    wrapper.style.height = height + 'px';

    var iframe = wrapper.querySelector('iframe');
    if (iframe) {
      iframe.style.width = width + 'px';
      iframe.style.height = height + 'px';
    }

    // Centre the scaled canvas in the available space.
    container.style.position = 'relative';
    container.style.overflow = 'hidden';
    wrapper.style.position = 'absolute';
    wrapper.style.left = Math.max(0, (availW - width * scale) / 2) + 'px';
    wrapper.style.top = Math.max(0, (availH - height * scale) / 2) + 'px';
  }

  function mount(events) {
    var Replayer = pick(window.rrweb, 'Replayer');

    if (!Replayer) {
      show('Replay engine unavailable.');
      send({ type: 'dvr:error', message: 'Replayer missing' });
      return;
    }

    try {
      // Recorded viewport size comes from the Meta event.
      for (var i = 0; i < events.length; i++) {
        if (events[i].type === 4 && events[i].data && events[i].data.width) {
          viewport.width = Number(events[i].data.width) || 0;
          viewport.height = Number(events[i].data.height) || 0;
          break;
        }
      }

      replayer = new Replayer(events, {
        root: container,
        skipInactive: true,
        showWarning: false,
        speed: 1,
        mouseTail: false,
        // rrweb 2.1 builds a nested sandbox inside `wrapper` before attaching
        // it to the document, which throws. This flag makes it create the
        // frame directly. Isolation is already guaranteed: this whole document
        // is a sandboxed, opaque origin with connect-src 'none'.
        UNSAFE_replayCanvas: true,
      });

      var meta = null;
      try {
        meta = replayer.getMetaData();
      } catch (e) {
        meta = null;
      }
      duration = meta && Number(meta.totalTime) ? Number(meta.totalTime) : 0;

      replayer.on('finish', function () {
        stopTimer();
        send({ type: 'dvr:end', at: duration, duration: duration });
      });

      // Park at the first frame so the stage shows real content immediately.
      try {
        replayer.pause(0);
      } catch (e) {
        /* ignore */
      }

      hide();
      fit();
      send({ type: 'dvr:ready', duration: duration });
    } catch (error) {
      show('Replay failed: ' + String(error && error.message ? error.message : error));
      send({ type: 'dvr:error', message: String(error && error.message ? error.message : error) });
    }
  }

  window.addEventListener('message', function (event) {
    // Only accept messages from our parent frame.
    if (event.source !== window.parent) return;

    var data = event.data;
    if (!isPlainObject(data) || typeof data.type !== 'string') return;

    if (data.type === 'dvr:load') {
      if (!Array.isArray(data.events)) return;
      var events = data.events.filter(acceptable);
      if (events.length === 0) {
        show('No playable events.');
        return;
      }
      mount(events);
      return;
    }

    if (!replayer) return;

    if (data.type === 'dvr:play') {
      var from = Number.isFinite(Number(data.at)) ? Number(data.at) : currentTime();
      try {
        replayer.play(from >= duration - 50 ? 0 : from);
        startTimer();
      } catch (e) {
        send({ type: 'dvr:error', message: String(e && e.message) });
      }
      return;
    }

    if (data.type === 'dvr:pause') {
      try {
        replayer.pause();
      } catch (e) {
        /* ignore */
      }
      stopTimer();
      return;
    }

    if (data.type === 'dvr:seek') {
      var at = Math.max(0, Number(data.at) || 0);
      try {
        replayer.pause(at);
        lastTick = -1;
        send({ type: 'dvr:tick', at: at, duration: duration });
      } catch (e) {
        /* ignore */
      }
    }
  });

  window.addEventListener('resize', function () {
    if (replayer) fit();
  });

  show('Waiting for session data…');
})();
