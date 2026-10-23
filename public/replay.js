// public/replay.js
// Loads a slice with the admin token, renders the inspector, and drives the
// sandboxed player over postMessage. Text is always written with textContent.

(function () {
  'use strict';

  var TOKEN_KEY = 'dvr-token';
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  var state = {
    events: [],
    network: [],
    consoleEvents: [],
    errors: [],
    dom: [],
    tab: 'network',
    query: '',
    duration: 0,
    at: 0,
    playing: false,
    ready: false,
    errorAt: null,
    urls: [],
    privacyShield: true,
  };

  var els = {};

  /**
   * The player is served from the *other* loopback hostname, so it is a real
   * cross-origin document rather than an opaque one. That matters: rrweb builds
   * its replay inside a nested iframe and cannot reach it when its own origin is
   * opaque. A separate origin still cannot read this page's DOM or session
   * storage, so the isolation holds.
   */
  function playerOrigin() {
    var host = window.location.hostname;
    var port = window.location.port ? ':' + window.location.port : '';
    var alt = host === 'localhost' ? '127.0.0.1' : 'localhost';
    return window.location.protocol + '//' + alt + port;
  }

  var PLAYER_ORIGIN = playerOrigin();

  // ------------------------------------------------------------ utilities --

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function mmss(ms) {
    var total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    var m = Math.floor(total / 60);
    var s = total % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function clock(ts) {
    var ms = Number(ts);
    if (!Number.isFinite(ms)) return '--:--:--';
    try {
      return new Date(ms).toLocaleTimeString(undefined, { hour12: false });
    } catch (e) {
      return '--:--:--';
    }
  }

  function seconds(value) {
    return (Math.max(0, Number(value) || 0) / 1000).toFixed(1) + 's';
  }

  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('show');
    window.clearTimeout(toast._t);
    toast._t = window.setTimeout(function () {
      els.toast.classList.remove('show');
    }, 2400);
  }

  function setStatus(text, isError) {
    els.status.textContent = text;
    els.status.setAttribute('data-state', isError ? 'error' : 'ok');
  }

  function severityOf(networkErrors, errors, warnings) {
    if (errors > 0 || networkErrors > 0) return 'critical';
    if (warnings > 0) return 'warning';
    return 'info';
  }

  // ---------------------------------------------------------------- token --

  function readToken() {
    try {
      var stored = window.sessionStorage.getItem(TOKEN_KEY);
      if (stored) return stored;
    } catch (e) {
      /* ignore */
    }

    var token = '';
    var hash = window.location.hash.replace(/^#/, '');
    if (hash) {
      new URLSearchParams(hash).forEach(function (value, key) {
        if (key === 'token') token = value;
      });
    }
    if (token) {
      try {
        window.history.replaceState(null, '', window.location.pathname);
      } catch (e) {
        /* ignore */
      }
    }
    return token;
  }

  // ---------------------------------------------------------------- fatal --

  function fatal(title, message, actionLabel, actionHref) {
    setStatus(title, true);
    els.cover.hidden = true;
    els.playBtn.disabled = true;

    var box = el('div', 'fatal-stage');
    var inner = el('div', 'inner');
    var glyph = el('div', 'glyph', '!');
    inner.appendChild(glyph);
    inner.appendChild(el('h2', null, title));
    inner.appendChild(el('p', null, message));
    if (actionLabel) {
      var link = el('a', 'btn sm', actionLabel);
      link.href = actionHref || '/';
      inner.appendChild(link);
    }
    box.appendChild(inner);
    document.querySelector('.stage-body').appendChild(box);
  }

  // ------------------------------------------------------------ rendering --

  function renderExplain(events, summary) {
    var host = els.explain;
    host.textContent = '';

    function bullet(mark, text, inferred) {
      var row = el('div', 'explain-item' + (inferred ? ' inferred' : ''));
      row.appendChild(el('span', 'mark', mark));
      row.appendChild(el('span', null, text));
      host.appendChild(row);
    }

    var firstTs = null;
    var lastInteraction = null;
    var lastInteractionKind = '';
    var firstError = null;
    var lastRequest = null;

    events.forEach(function (event) {
      var ts = Number(event.timestamp);
      if (Number.isFinite(ts) && (firstTs === null || ts < firstTs)) firstTs = ts;

      if (typeof event.type === 'number' && event.type === 3 && event.data) {
        if (event.data.source === 2 && event.data.type === 2) {
          lastInteraction = Number(event.timestamp);
          lastInteractionKind = 'click';
        } else if (event.data.source === 5) {
          lastInteraction = Number(event.timestamp);
          lastInteractionKind = 'typing';
        }
      }
    });

    state.consoleEvents.forEach(function (event) {
      if (!firstError && String(event.level) === 'error') firstError = event;
    });
    state.errors.forEach(function (event) {
      if (!firstError) firstError = event;
    });

    if (state.network.length) lastRequest = state.network[state.network.length - 1];

    var page = (summary && summary.pageLabel) || 'Unknown page';
    var path = (summary && summary.path) || '';
    bullet('▣', page + (path ? '  ' + path : ''));

    if (lastInteraction && Number.isFinite(firstTs)) {
      bullet('↳', 'Last ' + lastInteractionKind + ' at ' + seconds(lastInteraction - firstTs) + ' into the window.');
    } else {
      bullet('↳', 'No click or input captured in this window.');
    }

    if (firstError) {
      var offset = Number.isFinite(firstTs) ? ' at ' + seconds(Number(firstError.timestamp) - firstTs) : '';
      var label = firstError.type === 'error' || firstError.source === 'uncaught' ? 'Uncaught' : 'Console error';
      bullet('✕', label + ': ' + String(firstError.message || 'Error') + offset + '.');
    } else {
      bullet('✓', 'No error was recorded in this window.');
    }

    if (lastRequest) {
      bullet(
        '⇄',
        'Last request ' +
          String(lastRequest.method || 'GET') +
          ' ' +
          String(lastRequest.url || '') +
          ' → ' +
          (lastRequest.status === 'error' ? 'failed' : lastRequest.status)
      );
    }

    // One cautious inference, clearly labelled.
    if (firstError && lastRequest && Number.isFinite(firstTs)) {
      var errorAt = Number(firstError.timestamp);
      var requestAt = Number(lastRequest.timestamp);
      if (Number.isFinite(requestAt) && requestAt <= errorAt) {
        bullet(
          '≈',
          'The failure landed ' + seconds(errorAt - requestAt) + ' after that request, so the result of the call is the likely trigger.',
          true
        );
      }
    }
  }

  function netRow(event) {
    var status = event.status === 'error' ? 'ERROR' : String(event.status);
    var cls = event.status === 'error' ? 's-error' : 's-' + String(status).charAt(0);

    var row = el('div', 'row row-net');
    var method = String(event.method || 'GET').toUpperCase();
    row.appendChild(el('span', 'method m-' + method.toLowerCase(), method.slice(0, 6)));
    row.appendChild(el('span', 'url', String(event.url || '')));
    row.appendChild(el('span', 'dur', (Number(event.duration) || 0).toFixed(1) + 'ms'));
    row.appendChild(el('span', 'pill ' + cls, status));
    return row;
  }

  function consoleRow(event) {
    var level = String(event.level || 'log').toLowerCase();
    var row = el('div', 'row row-con' + (level === 'error' ? ' is-error' : ''));
    row.appendChild(el('span', 'lvl lvl-' + level, level.slice(0, 5)));
    row.appendChild(el('span', 'msg', String(event.message || '')));
    row.appendChild(el('span', 'time', clock(event.timestamp)));
    return row;
  }

  function eventRow(event, baseTs) {
    var kind = typeof event.type === 'number' ? 'DOM' : String(event.type).toUpperCase();
    var detail = '';

    if (typeof event.type === 'number') {
      detail = event.type === 2 ? 'Full snapshot' : event.type === 4 ? 'Page metadata' : event.type === 3 ? 'Incremental update' : 'Recorder event';
      if (event.type === 3 && event.data) {
        detail = event.data.source === 2 ? 'Mouse interaction' : event.data.source === 5 ? 'Input' : 'DOM mutation';
      }
    } else if (event.type === 'network') {
      detail = String(event.method || 'GET') + ' ' + String(event.url || '') + ' → ' + event.status;
    } else if (event.type === 'console') {
      detail = String(event.level || 'log').toUpperCase() + ' · ' + String(event.message || '');
    } else {
      detail = String(event.message || 'Error');
    }

    var row = el('div', 'row row-evt');
    row.appendChild(el('span', 'lvl', kind.slice(0, 6)));
    row.appendChild(el('span', 'msg', detail));
    var offset = Number(event.timestamp) - baseTs;
    row.appendChild(el('span', 'time', Number.isFinite(offset) ? '+' + seconds(offset) : ''));
    return row;
  }

  function filtered(list, textOf) {
    var query = state.query.trim().toLowerCase();
    if (!query) return list;
    return list.filter(function (event) {
      return textOf(event).toLowerCase().indexOf(query) !== -1;
    });
  }

  function renderTab() {
    var baseTs = null;
    state.events.forEach(function (event) {
      var ts = Number(event.timestamp);
      if (Number.isFinite(ts) && (baseTs === null || ts < baseTs)) baseTs = ts;
    });
    if (baseTs === null) baseTs = 0;

    renderNetwork(baseTs);
    renderConsole();
    renderUrls(baseTs);
    renderEvents(baseTs);
  }

  function emptyInto(host, title, copy) {
    host.textContent = '';
    var box = el('div', 'empty');
    box.appendChild(el('div', 'glyph', '◌'));
    box.appendChild(el('strong', null, title));
    box.appendChild(el('span', null, copy));
    host.appendChild(box);
  }

  function renderNetwork() {
    var host = els.networkLog;
    if (state.network.length === 0) {
      emptyInto(host, 'No network activity', 'The SDK only records requests that happened inside the window.');
      return;
    }
    var list = filtered(state.network, function (event) {
      return [event.method, event.url, event.status].join(' ');
    });
    if (list.length === 0) {
      emptyInto(host, 'Nothing matches', 'No request matches the current filter.');
      return;
    }
    host.textContent = '';
    list.forEach(function (event) {
      host.appendChild(netRow(event));
    });
  }

  function renderConsole() {
    var host = els.consoleLog;
    if (state.consoleEvents.length === 0) {
      emptyInto(host, 'Console is quiet', 'No log, warning or error was captured.');
      return;
    }
    var list = filtered(state.consoleEvents, function (event) {
      return [event.level, event.message].join(' ');
    });
    if (list.length === 0) {
      emptyInto(host, 'Nothing matches', 'No log line matches the current filter.');
      return;
    }
    host.textContent = '';
    list.forEach(function (event) {
      host.appendChild(consoleRow(event));
    });
  }

  function renderEvents(baseTs) {
    var host = els.eventsLog;
    if (state.events.length === 0) {
      emptyInto(host, 'No events', 'This slice contains no recorded events.');
      return;
    }
    var list = filtered(state.events, function (event) {
      return [event.type, event.message, event.url, event.level].join(' ');
    });
    if (list.length === 0) {
      emptyInto(host, 'Nothing matches', 'No event matches the current filter.');
      return;
    }
    host.textContent = '';
    list.forEach(function (event) {
      host.appendChild(eventRow(event, baseTs));
    });
  }

  function renderUrls(baseTs) {
    if (!els.urlsLog) return;
    var host = els.urlsLog;
    if (state.urls.length === 0) {
      emptyInto(host, 'No navigation entries', 'No page navigations or distinct URL paths were captured.');
      return;
    }
    var list = filtered(state.urls, function (u) {
      return [u.url, u.type, u.label].join(' ');
    });
    if (list.length === 0) {
      emptyInto(host, 'Nothing matches', 'No URL matches the current filter.');
      return;
    }
    host.textContent = '';
    var wrap = el('div', 'url-flow-list');
    list.forEach(function (item, idx) {
      var row = el('div', 'url-flow-item');
      row.appendChild(el('span', 'url-step-badge', 'Step ' + (idx + 1)));
      var info = el('div', 'url-flow-info');
      info.appendChild(el('span', 'url-flow-path', item.url));
      var meta = el('div', 'url-flow-meta');
      meta.appendChild(el('span', null, item.type || 'Page'));
      if (item.timestamp && baseTs) {
        meta.appendChild(el('span', null, '+' + ((item.timestamp - baseTs) / 1000).toFixed(1) + 's'));
      }
      info.appendChild(meta);
      row.appendChild(info);
      wrap.appendChild(row);
    });
    host.appendChild(wrap);
  }

  // ------------------------------------------------------------- playback --

  function setPlayIcon(playing) {
    state.playing = playing;
    var play = els.playBtn.querySelector('.i-play');
    var pause = els.playBtn.querySelector('.i-pause');
    if (play) play.hidden = playing;
    if (pause) pause.hidden = !playing;
    els.playBtn.setAttribute('aria-label', playing ? 'Pause replay' : 'Play replay');
  }

  function paintProgress() {
    var ratio = state.duration > 0 ? clamp(state.at / state.duration, 0, 1) : 0;
    els.tlFill.style.width = (ratio * 100).toFixed(2) + '%';
    els.tlHead.style.left = (ratio * 100).toFixed(2) + '%';
    els.timecode.textContent = mmss(state.at) + ' / ' + mmss(state.duration);
    els.timeline.setAttribute('aria-valuemax', String(Math.round(state.duration)));
    els.timeline.setAttribute('aria-valuenow', String(Math.round(state.at)));
  }

  function post(message) {
    if (!els.frame.contentWindow) return;
    els.frame.contentWindow.postMessage(message, PLAYER_ORIGIN);
  }

  function seekTo(ms) {
    if (!state.ready) return;
    state.at = clamp(ms, 0, state.duration);
    paintProgress();
    post({ type: 'dvr:seek', at: state.at });
  }

  function togglePlay() {
    if (!state.ready) return;
    if (state.playing) {
      post({ type: 'dvr:pause' });
      setPlayIcon(false);
    } else {
      post({ type: 'dvr:play', at: state.at });
      setPlayIcon(true);
    }
  }

  function wirePlayer() {
    window.addEventListener('message', function (event) {
      if (event.source !== els.frame.contentWindow) return;
      if (event.origin !== PLAYER_ORIGIN) return;
      var data = event.data;
      if (!data || typeof data.type !== 'string') return;

      if (data.type === 'dvr:ready') {
        state.ready = true;
        state.duration = Number(data.duration) || 0;
        els.playBtn.disabled = false;
        els.cover.hidden = true;
        placePin();
        paintProgress();
        post({ type: 'dvr:play', at: 0 });
        setPlayIcon(true);
      }

      if (data.type === 'dvr:tick') {
        state.at = Number(data.at) || 0;
        state.duration = Number(data.duration) || state.duration;
        paintProgress();
      }

      if (data.type === 'dvr:end') {
        setPlayIcon(false);
        state.at = state.duration;
        paintProgress();
      }

      if (data.type === 'dvr:error') {
        els.cover.hidden = false;
        els.coverText.textContent = 'Replay failed: ' + String(data.message || 'unknown error');
        els.playBtn.disabled = true;
      }
    });
  }

  function placePin() {
    var errorAt = state.errorAt;
    if (errorAt === null || errorAt === undefined || !(state.duration > 0)) {
      els.tlPin.hidden = true;
      return;
    }
    var ratio = clamp(Number(errorAt) / state.duration, 0, 1);
    els.tlPin.style.left = (ratio * 100).toFixed(2) + '%';
    els.tlPin.title = 'First error at ' + seconds(errorAt);
    els.tlPin.hidden = false;
  }

  // ---------------------------------------------------------------- tabs --

  function setTab(name) {
    state.tab = name;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (button) {
      button.setAttribute('aria-selected', String(button.getAttribute('data-tab') === name));
    });
    els.networkLog.hidden = name !== 'network';
    els.consoleLog.hidden = name !== 'console';
    els.eventsLog.hidden = name !== 'events';
    if (els.urlsLog) els.urlsLog.hidden = name !== 'urls';

    var focusMap = { network: els.networkLog, console: els.consoleLog, events: els.eventsLog, urls: els.urlsLog };
    if (focusMap[name]) focusMap[name].scrollTop = 0;
  }

  // ----------------------------------------------------------------- init --

  function cacheElements() {
    els = {
      sev: document.getElementById('sev'),
      sevChip: document.getElementById('sevChip'),
      traceTitle: document.getElementById('traceTitle'),
      sliceId: document.getElementById('sliceId'),
      status: document.getElementById('status'),
      warning: document.getElementById('warning'),
      frame: document.getElementById('playerFrame'),
      cover: document.getElementById('cover'),
      coverText: document.getElementById('coverText'),
      playBtn: document.getElementById('playBtn'),
      timecode: document.getElementById('timecode'),
      timeline: document.getElementById('timeline'),
      tlFill: document.getElementById('tlFill'),
      tlHead: document.getElementById('tlHead'),
      tlPin: document.getElementById('tlPin'),
      errLine: document.getElementById('errLine'),
      errMeta: document.getElementById('errMeta'),
      explain: document.getElementById('explain'),
      netCount: document.getElementById('netCount'),
      conCount: document.getElementById('conCount'),
      evCount: document.getElementById('evCount'),
      urlsLog: document.getElementById('urlsLog'),
      urlCount: document.getElementById('urlCount'),
      stageBody: document.getElementById('stageBody'),
      privacyToggleBtn: document.getElementById('privacyToggleBtn'),
      privacyToggleText: document.getElementById('privacyToggleText'),
      privacyNoticeText: document.getElementById('privacyNoticeText'),
      jump15s: document.getElementById('jump15s'),
      jump10s: document.getElementById('jump10s'),
      jump5s: document.getElementById('jump5s'),
      jumpCrash: document.getElementById('jumpCrash'),
      networkLog: document.getElementById('networkLog'),
      consoleLog: document.getElementById('consoleLog'),
      eventsLog: document.getElementById('eventsLog'),
      filter: document.getElementById('filter'),
      shareBtn: document.getElementById('shareBtn'),
      toast: document.getElementById('toast'),
      stageMeta: document.getElementById('stageMeta'),
    };
  }

  function bind() {
    els.playBtn.addEventListener('click', togglePlay);

    els.timeline.addEventListener('click', function (event) {
      if (!state.duration) return;
      var rect = els.timeline.getBoundingClientRect();
      var ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
      seekTo(ratio * state.duration);
    });

    els.timeline.addEventListener('keydown', function (event) {
      if (!state.duration) return;
      var step = 1000;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        seekTo(state.at + step);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        seekTo(state.at - step);
      } else if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        togglePlay();
      }
    });

    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (button) {
      button.addEventListener('click', function () {
        setTab(button.getAttribute('data-tab'));
      });
    });

    els.filter.addEventListener('input', function () {
      state.query = els.filter.value;
      renderTab();
    });

    els.shareBtn.addEventListener('click', function () {
      var link = window.location.origin + window.location.pathname;
      var done = function (ok) {
        toast(ok ? 'Link copied — the recipient still needs the admin token.' : 'Copy failed.');
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(done, function () {
          done(false);
        });
      } else {
        done(false);
      }
    });

    document.addEventListener('keydown', function (event) {
      if (event.target === els.filter) return;
      if (event.key === ' ') {
        event.preventDefault();
        togglePlay();
      }
    });

    function togglePrivacyShield() {
      state.privacyShield = !state.privacyShield;
      if (els.stageBody) {
        if (state.privacyShield) {
          els.stageBody.classList.add('privacy-shield-active');
          if (els.privacyToggleBtn) {
            els.privacyToggleBtn.classList.remove('disabled');
            els.privacyToggleBtn.classList.add('active');
          }
          if (els.privacyToggleText) els.privacyToggleText.textContent = 'Privacy Shield: ON (Content Masked)';
          if (els.privacyNoticeText) els.privacyNoticeText.textContent = 'Zero-Knowledge Mode: Customer text & inputs are masked';
          toast('Zero-Knowledge Privacy Shield enabled — user content masked');
        } else {
          els.stageBody.classList.remove('privacy-shield-active');
          if (els.privacyToggleBtn) {
            els.privacyToggleBtn.classList.add('disabled');
            els.privacyToggleBtn.classList.remove('active');
          }
          if (els.privacyToggleText) els.privacyToggleText.textContent = 'Privacy Shield: OFF (Raw View)';
          if (els.privacyNoticeText) els.privacyNoticeText.textContent = 'Raw View: Content unmasked for administrative debug';
          toast('Privacy Shield disabled — raw DOM visible');
        }
      }
    }

    if (els.privacyToggleBtn) {
      els.privacyToggleBtn.addEventListener('click', togglePrivacyShield);
    }

    function jumpBuffer(sec) {
      if (!state.ready) return;
      var anchor = state.errorAt !== null && state.errorAt !== undefined ? state.errorAt : state.duration;
      var target = sec === 0 ? anchor : Math.max(0, anchor - (sec * 1000));
      seekTo(target);
      if (sec === 0) {
        toast('Jumped to moment of crash');
      } else {
        toast('Scrubbed to -' + sec + 's buffer before crash');
      }
    }

    if (els.jump15s) els.jump15s.addEventListener('click', function () { jumpBuffer(15); });
    if (els.jump10s) els.jump10s.addEventListener('click', function () { jumpBuffer(10); });
    if (els.jump5s) els.jump5s.addEventListener('click', function () { jumpBuffer(5); });
    if (els.jumpCrash) els.jumpCrash.addEventListener('click', function () { jumpBuffer(0); });
  }

  function start() {
    cacheElements();
    wirePlayer();
    bind();

    var segments = window.location.pathname.split('/').filter(Boolean);
    var sliceId = segments.length ? decodeURIComponent(segments[segments.length - 1]) : '';
    els.sliceId.textContent = sliceId ? sliceId.slice(0, 8) : '—';

    if (!UUID_RE.test(sliceId)) {
      fatal('Invalid trace URL', 'The address does not contain a valid trace identifier.', 'Back to dashboard', '/');
      return;
    }

    var token = readToken();
    if (!token) {
      fatal(
        'Admin token required',
        'Open the dashboard and unlock it first — the token is held in that tab and reused here.',
        'Unlock dashboard',
        '/'
      );
      return;
    }

    var requested = new URLSearchParams(window.location.search).get('at');

    fetch('/api/slice/' + encodeURIComponent(sliceId), {
      headers: { Authorization: 'Bearer ' + token },
      credentials: 'omit',
      cache: 'no-store',
    })
      .then(function (response) {
        if (response.status === 401) throw new Error('Unauthorized — the admin token is invalid.');
        if (response.status === 404) throw new Error('Trace not found.');
        if (!response.ok) throw new Error('Request failed (HTTP ' + response.status + ').');
        return response.json();
      })
      .then(function (data) {
        handleSlice(data, requested);
      })
      .catch(function (error) {
        fatal('Could not load this trace', String(error && error.message ? error.message : error), 'Back to dashboard', '/');
      });
  }

  function handleSlice(data, requested) {
    var events = Array.isArray(data.slice) ? data.slice : [];
    if (events.length === 0) {
      fatal('Empty trace', 'This slice contains no events to replay.', 'Back to dashboard', '/');
      return;
    }

    state.events = events;

    var firstTs = null;
    var lastTs = null;

    events.forEach(function (event) {
      if (!event || typeof event !== 'object') return;
      var ts = Number(event.timestamp);
      if (Number.isFinite(ts)) {
        if (firstTs === null || ts < firstTs) firstTs = ts;
        if (lastTs === null || ts > lastTs) lastTs = ts;
      }

      if (event.type === 'network') state.network.push(event);
      else if (event.type === 'console') state.consoleEvents.push(event);
      else if (event.type === 'error') {
        state.errors.push(event);
        state.consoleEvents.push({ level: 'error', message: event.message, timestamp: event.timestamp });
      } else if (typeof event.type === 'number') state.dom.push(event);
    });

    // First failure, in slice-relative milliseconds.
    var errorEvent = state.errors[0] || state.consoleEvents.filter(function (e) {
      return String(e.level) === 'error';
    })[0];
    state.errorAt = errorEvent && Number.isFinite(firstTs)
      ? Math.max(0, Number(errorEvent.timestamp) - firstTs)
      : data.summary && data.summary.errorAt !== undefined ? data.summary.errorAt : null;

    var summary = data.summary || {};
    var warnings = state.consoleEvents.filter(function (e) {
      return String(e.level) === 'warn';
    }).length;
    var netErrors = state.network.filter(function (e) {
      return e.status === 'error' || (typeof e.status === 'number' && e.status >= 400);
    }).length;
    var sev = severityOf(netErrors, state.errors.length, warnings);

    els.sev.className = 'sev ' + sev;
    els.sevChip.className = 'chip sev-chip ' + sev;
    els.sevChip.textContent = sev === 'critical' ? 'Critical' : sev === 'warning' ? 'Warning' : 'Info';
    els.sevChip.hidden = false;

    els.traceTitle.textContent = summary.pageLabel || 'Recorded session';
    document.title = (summary.pageLabel || 'Trace') + ' · Error-DVR';

    setStatus(
      state.dom.length + ' DOM events · ' + state.network.length + ' network · ' + state.consoleEvents.length + ' console'
    );

    if (data.integrity && data.integrity !== 'ok') {
      els.warning.hidden = false;
    }

    els.netCount.textContent = String(state.network.length);
    els.conCount.textContent = String(state.consoleEvents.length);
    els.evCount.textContent = String(state.events.length);

    state.urls = [];
    events.forEach(function (e) {
      if (e.type === 4 && e.data && e.data.href) {
        state.urls.push({
          url: e.data.href,
          type: 'Page Navigation (DOM)',
          timestamp: e.timestamp,
        });
      } else if (e.type === 'network' && e.url) {
        state.urls.push({
          url: (e.method || 'GET') + ' ' + e.url + (e.status ? ' [' + e.status + ']' : ''),
          type: 'API / Network Request',
          timestamp: e.timestamp,
        });
      }
    });
    if (summary.href && !state.urls.some(function (u) { return u.url === summary.href; })) {
      state.urls.unshift({
        url: summary.href,
        type: 'Initial Page View',
        timestamp: events[0] ? events[0].timestamp : null,
      });
    }
    if (els.urlCount) els.urlCount.textContent = String(state.urls.length);

    var firstError = state.errors[0];
    els.errLine.textContent = firstError
      ? String(firstError.message || 'Error')
      : netErrors > 0
        ? 'Network failures recorded (' + netErrors + ')'
        : 'No error in this window';

    els.errMeta.textContent = firstError && firstError.filename
      ? firstError.filename + (firstError.lineno ? ':' + firstError.lineno : '')
      : summary.path || '';

    renderExplain(events, summary);
    renderTab();

    var domEvents = state.dom;
    if (domEvents.length === 0) {
      fatal('Nothing to replay', 'This slice has no DOM events, so there is no visual session to show.', 'Back to dashboard', '/');
      return;
    }

    els.cover.hidden = false;
    els.coverText.textContent = 'Preparing replay…';

    els.frame.addEventListener(
      'load',
      function () {
        post({ type: 'dvr:load', events: domEvents });
        if (requested) {
          var at = Number(requested);
          if (Number.isFinite(at)) window.setTimeout(function () {
            seekTo(at);
          }, 400);
        }
      },
      { once: true }
    );
    els.frame.src = PLAYER_ORIGIN + '/player.html';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
