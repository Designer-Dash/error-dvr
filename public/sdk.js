// public/sdk.js
// Collection SDK: records a rolling window of DOM mutations, network metadata
// and console output, then uploads one slice when an error occurs.
//
// Loaded as a classic script from the DVR origin (see GET /). Uses the vendored
// rrweb global — no CDN, no ESM import, no third-party fetch.

(function () {
  'use strict';

  var cfg = window.__DVR__ || {};
  var privacy = cfg.privacyMasking !== false;

  // The SDK is dropped into *your* site, so the upload URL is usually
  // cross-origin. That is fine: /upload is write-only, requires the ingest key,
  // and no read endpoint sends CORS headers.
  var uploadUrl;
  try {
    uploadUrl = new URL(cfg.uploadUrl || '/upload', window.location.href).href;
  } catch (e) {
    console.warn('[dvr] invalid upload URL; recording disabled');
    return;
  }
  if (!/^https?:$/.test(new URL(uploadUrl).protocol)) {
    console.warn('[dvr] refusing to record: upload URL must be http(s)');
    return;
  }
  if (!cfg.ingestKey) {
    console.warn('[dvr] no ingest key provided; recording disabled');
    return;
  }

  var MAX_EVENTS = cfg.maxEvents || 5000;
  var WINDOW_MS = (cfg.sliceLengthSec || 15) * 1000;
  var UPLOAD_COOLDOWN_MS = 10000;

  var buffer = [];
  var lastUpload = 0;
  var lastEmit = 0;
  var uploading = false;
  var internal = false; // suppress self-recording recursion

  // ------------------------------------------------------------ redaction --

  var SECRET_PARAM = /^(?:access[_-]?token|api[_-]?key|auth|authorization|code|cookie|jwt|otp|passw(?:or)?d|pwd|refresh[_-]?token|secret|session(?:id)?|sig|signature|token)$/i;
  var EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  var CARD = /\b(?:\d[ -]*?){13,19}\b/g;
  var LONG_TOKEN = /\b[A-Za-z0-9_-]{32,}\b/g;

  /** Mask a string: emails, card-shaped digits and long random tokens. */
  function redactText(input) {
    if (!privacy || typeof input !== 'string') return input;
    return input
      .replace(EMAIL, '[email]')
      .replace(CARD, '[number]')
      .replace(LONG_TOKEN, '[redacted]');
  }

  /**
   * Redact a URL: keep scheme/host/path (useful for debugging) but remove
   * credentials and secret-looking query values.
   */
  function redactUrl(input) {
    var raw = typeof input === 'string' ? input : String(input && input.url ? input.url : '');
    var parsed;
    try {
      parsed = new URL(raw, window.location.href);
    } catch (e) {
      return redactText(raw);
    }

    var out = parsed.origin + parsed.pathname;

    if (parsed.search && parsed.searchParams) {
      var parts = [];
      parsed.searchParams.forEach(function (value, key) {
        var safeValue = SECRET_PARAM.test(key)
          ? '[redacted]'
          : encodeURIComponent(redactText(value)).slice(0, 120);
        parts.push(encodeURIComponent(key) + '=' + safeValue);
      });
      if (parts.length) out += '?' + parts.join('&');
    }

    return out;
  }

  /** Remove the local username from absolute filesystem paths. */
  function redactPath(value) {
    if (!privacy || typeof value !== 'string') return value;
    return value
      .replace(/([A-Za-z]:\\Users\\)[^\\]+/g, '$1[user]')
      .replace(/\/(?:home|Users)\/[^/]+/g, '/home/[user]');
  }

  // --------------------------------------------------------------- buffer --

  function push(event) {
    buffer.push(event);

    // Hard cap: protects the tab from runaway memory in a long session.
    if (buffer.length > MAX_EVENTS) {
      buffer.splice(0, buffer.length - MAX_EVENTS);
    }

    // Time-based prune, safe against out-of-order timestamps.
    var cutoff = Date.now() - WINDOW_MS;
    while (buffer.length && typeof buffer[0].timestamp === 'number' && buffer[0].timestamp < cutoff) {
      buffer.shift();
    }

    // Report buffer depth to the host page, at most a few times a second.
    var now = Date.now();
    if (now - lastEmit > 250) {
      lastEmit = now;
      emit('dvr:buffer', { count: buffer.length });
    }
  }

  // --------------------------------------------------------- DOM recording --

  // The UMD bundle exposes a namespace object; `record` may sit on it directly
  // or under `.default` depending on the build.
  function resolveRecord() {
    const ns = window.rrweb;
    if (!ns) return null;
    if (typeof ns.record === 'function') return ns.record;
    if (ns.default && typeof ns.default.record === 'function') return ns.default.record;
    return null;
  }

  function begin(record) {
    // rrweb's own masking primitives run inside the recorder, so plaintext
    // inputs are never serialised in the first place.
    record({
      emit: function (event) {
        push(event);
      },
      maskAllInputs: privacy,
      maskInputOptions: privacy
        ? { password: true, email: true, tel: true, text: true, number: true, search: true, url: true }
        : {},
      maskInputFn: privacy
        ? function (value) {
            return '*'.repeat(Math.min(String(value).length, 32));
          }
        : undefined,
      maskTextSelector: privacy ? '[data-dvr-sensitive], [autocomplete="cc-number"], [autocomplete="one-time-code"]' : undefined,
      blockSelector: '[data-dvr-block]',
      maskTextClass: 'dvr-mask',
      recordCanvas: false,
      collectFonts: false,
      // Inline the CSS so a replay is self-contained and never pulls styles
      // (or tracking pixels) from third-party origins.
      inlineStylesheet: true,
      sampling: { mousemove: 50, scroll: 100, media: 800, input: 'last' },
    });
  }

  /**
   * The host page may not include rrweb. Pull it from the DVR origin — the same
   * origin we upload to — so a one-line snippet still produces a replayable
   * trace instead of a DOM-less one.
   */
  function loadRuntime(onReady) {
    var src;
    try {
      src = new URL('/vendor/rrweb.js', uploadUrl).href;
    } catch (e) {
      src = null;
    }
    if (!src) {
      onReady(null);
      return;
    }

    var script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = function () {
      onReady(resolveRecord());
    };
    script.onerror = function () {
      onReady(null);
    };
    (document.head || document.documentElement).appendChild(script);
  }

  function startRecording() {
    const record = resolveRecord();
    if (record) {
      begin(record);
      return;
    }
    loadRuntime(function (loaded) {
      if (!loaded) {
        console.warn('[dvr] rrweb unavailable; DOM recording disabled');
        return;
      }
      begin(loaded);
    });
  }

  // ---------------------------------------------------------- network hook --

  function wrapFetch() {
    var origFetch = window.fetch;
    if (typeof origFetch !== 'function') return;

    window.fetch = function (input, init) {
      var started = performance.now();
      var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      var url = redactUrl(typeof input === 'string' ? input : input && input.url);
      var self = this;
      var args = arguments;

      return Promise.resolve(origFetch.apply(self, args)).then(
        function (response) {
          if (!internal) {
            push({
              type: 'network',
              method: method,
              url: url,
              status: response.status,
              duration: Math.round((performance.now() - started) * 10) / 10,
              timestamp: Date.now(),
            });
          }
          return response;
        },
        function (error) {
          if (!internal) {
            push({
              type: 'network',
              method: method,
              url: url,
              status: 'error',
              error: redactText(String(error && error.message)),
              duration: Math.round((performance.now() - started) * 10) / 10,
              timestamp: Date.now(),
            });
          }
          throw error;
        }
      );
    };
  }

  function wrapXHR() {
    var OrigXHR = window.XMLHttpRequest;
    if (typeof OrigXHR !== 'function') return;

    function WrappedXHR() {
      var xhr = new OrigXHR();
      var method = '';
      var url = '';
      var started = 0;

      var origOpen = xhr.open;
      xhr.open = function (m, u) {
        method = String(m || 'GET').toUpperCase();
        url = redactUrl(u);
        return origOpen.apply(xhr, arguments);
      };

      xhr.addEventListener('loadstart', function () {
        started = performance.now();
      });

      xhr.addEventListener('loadend', function () {
        if (internal) return;
        push({
          type: 'network',
          method: method,
          url: url,
          status: xhr.status,
          duration: Math.round((performance.now() - started) * 10) / 10,
          timestamp: Date.now(),
        });
      });

      return xhr;
    }

    window.XMLHttpRequest = WrappedXHR;
  }

  // ---------------------------------------------------------- console hook --

  function describe(value) {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.name + ': ' + value.message;
    try {
      return JSON.stringify(value);
    } catch (e) {
      return Object.prototype.toString.call(value);
    }
  }

  function hookConsole() {
    ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
      var orig = console[level];
      if (typeof orig !== 'function') return;

      console[level] = function () {
        if (!internal) {
          var message = Array.prototype.map.call(arguments, describe).join(' ');
          push({
            type: 'console',
            level: level,
            message: redactText(message).slice(0, 4000),
            timestamp: Date.now(),
          });
        }
        return orig.apply(console, arguments);
      };
    });
  }

  // ------------------------------------------------------------ error hooks --

  function listenErrors() {
    window.addEventListener('error', function (event) {
      push({
        type: 'error',
        message: redactText(String(event.message || 'Error')).slice(0, 2000),
        filename: redactPath(String(event.filename || '')),
        lineno: Number(event.lineno) || 0,
        colno: Number(event.colno) || 0,
        stack: redactText(String((event.error && event.error.stack) || '')).slice(0, 8000),
        timestamp: Date.now(),
      });
      scheduleUpload();
    });

    window.addEventListener('unhandledrejection', function (event) {
      var reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
      push({
        type: 'error',
        message: redactText('UnhandledPromiseRejection: ' + reason).slice(0, 2000),
        timestamp: Date.now(),
      });
      scheduleUpload();
    });
  }

  // ----------------------------------------------------------------- upload --

  function scheduleUpload() {
    var now = Date.now();
    if (uploading || now - lastUpload < UPLOAD_COOLDOWN_MS) return;
    lastUpload = now;

    // Give the recorder a beat to capture the post-error frame.
    setTimeout(uploadSlice, 500);
  }

  function uploadSlice() {
    if (uploading || buffer.length === 0) return;
    uploading = true;
    internal = true;

    var events = buffer.slice(-MAX_EVENTS);

    window
      .fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-DVR-Ingest': cfg.ingestKey,
        },
        body: JSON.stringify({ slice: events, timestamp: Date.now() }),
        // No `keepalive`: Chrome caps keepalive bodies at 64 KB, and a snapshot
        // with inlined styles easily exceeds that, silently dropping the upload.
        // Slices are uploaded while the page is alive, so it buys us nothing.
        credentials: 'omit',
        cache: 'no-store',
      })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        internal = false;
        uploading = false;
        emit('dvr:uploaded', data || {});
      })
      .catch(function () {
        internal = false;
        uploading = false;
      });
  }

  // ------------------------------------------------------------------- init --

  /** Small public surface so the host page can render recorder state. */
  function emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail: detail }));
    } catch (e) {
      /* CustomEvent unsupported: the recorder still works */
    }
  }

  wrapFetch();
  wrapXHR();
  hookConsole();
  listenErrors();
  startRecording();
  emit('dvr:ready', { masking: privacy, windowSec: Math.round(WINDOW_MS / 1000) });
})();
