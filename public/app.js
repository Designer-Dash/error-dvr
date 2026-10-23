// public/app.js
// Dashboard shell: token unlock, trace listing, chart, filtering, issue
// grouping and the detail drawer. All text is written with textContent.

(function () {
  'use strict';

  var TOKEN_KEY = 'dvr-token';
  var PAGE = 20;
  var state = {
    token: '',
    slices: [],
    total: 0,
    view: 'dashboard',
    filter: 'all',
    query: '',
    shown: PAGE,
    active: null,
    loading: false,
  };

  var els = {};

  var VIEWS = {
    dashboard: function () {
      return [greetingText(), null];
    },
    recordings: function () {
      return ['Recordings', 'Every captured session, newest first.'];
    },
    issues: function () {
      return ['Issues', 'Recorded failures grouped by message.'];
    },
    settings: function () {
      return ['Settings', 'Local security posture and access.'];
    },
  };

  // ------------------------------------------------------------ utilities --

  function token() {
    try {
      return window.sessionStorage.getItem(TOKEN_KEY) || '';
    } catch (e) {
      return state.token;
    }
  }

  function setToken(value) {
    state.token = value;
    try {
      window.sessionStorage.setItem(TOKEN_KEY, value);
    } catch (e) {
      /* memory-only fallback */
    }
  }

  function clearToken() {
    state.token = '';
    try {
      window.sessionStorage.removeItem(TOKEN_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function icon(paths, size) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', size || 16);
    svg.setAttribute('height', size || 16);
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('aria-hidden', 'true');
    paths.forEach(function (d) {
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    });
    return svg;
  }

  function timeAgo(ts) {
    var diff = Math.max(0, Date.now() - Number(ts));
    var min = Math.floor(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return min + ' min ago';
    var hrs = Math.floor(min / 60);
    if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
    var days = Math.floor(hrs / 24);
    if (days < 7) return days + (days === 1 ? ' day ago' : ' days ago');
    return new Date(Number(ts)).toLocaleDateString();
  }

  function duration(ms) {
    var value = Number(ms) || 0;
    if (value < 1000) return '<1 sec';
    var secs = Math.round(value / 1000);
    if (secs < 60) return secs + ' sec';
    var mins = Math.floor(secs / 60);
    return mins + ' min ' + (secs % 60) + ' sec';
  }

  function greetingText() {
    var hour = new Date().getHours();
    if (hour < 12) return 'Good morning, Dev.';
    if (hour < 18) return 'Good afternoon, Dev.';
    return 'Good evening, Dev.';
  }

  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('show');
    window.clearTimeout(toast._t);
    toast._t = window.setTimeout(function () {
      els.toast.classList.remove('show');
    }, 2400);
  }

  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return false; }
      );
    }
    return Promise.resolve(false);
  }

  function severity(entry) {
    return (entry && entry.summary && entry.summary.severity) || 'info';
  }

  function errorText(entry) {
    var summary = entry && entry.summary;
    if (!summary) return 'No error captured';
    if (summary.firstError && summary.firstError.message) return summary.firstError.message;
    if (summary.netErrorCount > 0 && summary.lastRequest) {
      return summary.lastRequest.method + ' ' + summary.lastRequest.url + ' → ' + summary.lastRequest.status;
    }
    return 'No error captured';
  }

  // -------------------------------------------------------------- network --

  function api(path) {
    return fetch(path, {
      headers: { Authorization: 'Bearer ' + token() },
      credentials: 'omit',
      cache: 'no-store',
    });
  }

  function loadSlices() {
    if (state.loading) return;
    state.loading = true;
    renderSkeletons();

    api('/api/slices?limit=100')
      .then(function (response) {
        if (response.status === 401) {
          clearToken();
          showLock('Your admin token was rejected. Paste it again.');
          throw new Error('unauthorized');
        }
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        state.slices = Array.isArray(data.slices) ? data.slices : [];
        state.total = Number(data.total) || state.slices.length;
        state.loading = false;
        renderAll();
      })
      .catch(function (error) {
        state.loading = false;
        if (error.message !== 'unauthorized') {
          renderAll();
          toast('Could not load traces: ' + error.message);
        }
      });
  }

  // --------------------------------------------------------------- render --

  function renderAll() {
    renderFilters();
    renderRecent();
    renderRecordings();
    renderIssues();
    renderKpis();
    renderChart();
    renderAttention();
    renderCoverage();
    renderSidebar();
    renderSettings();
  }

  function currentList() {
    var query = state.query.trim().toLowerCase();
    return state.slices.filter(function (entry) {
      var summary = entry.summary || {};
      if (state.filter !== 'all' && severity(entry) !== state.filter) return false;
      if (!query) return true;
      var haystack = [
        summary.pageLabel,
        summary.path,
        errorText(entry),
        entry.id,
        summary.lastRequest ? summary.lastRequest.url : '',
      ]
        .join(' ')
        .toLowerCase();
      return haystack.indexOf(query) !== -1;
    });
  }

  function traceCard(entry) {
    var summary = entry.summary || {};
    var sev = severity(entry);

    var card = el('button', 'trace');
    card.type = 'button';
    card.setAttribute('aria-label', 'Open details for ' + (summary.pageLabel || 'trace'));

    card.appendChild(el('span', 'sev ' + sev));

    var body = el('span', 'trace-body');
    var title = el('span', 'trace-title');
    title.appendChild(el('span', null, summary.pageLabel || 'Unknown page'));
    if (summary.path) title.appendChild(el('span', 'path', summary.path));
    body.appendChild(title);

    body.appendChild(el('span', 'trace-error' + (summary.firstError ? '' : ' empty'), errorText(entry)));

    var meta = el('span', 'trace-meta');
    meta.appendChild(el('span', null, duration(summary.durationMs) + ' window'));
    meta.appendChild(el('span', 'sep'));
    meta.appendChild(el('span', null, (summary.netCount || 0) + ' requests'));
    meta.appendChild(el('span', 'sep'));
    meta.appendChild(el('span', null, (summary.eventCount || 0) + ' events'));
    if (summary.errorCount > 1) {
      meta.appendChild(el('span', 'sep'));
      meta.appendChild(el('span', null, summary.errorCount + ' failures'));
    }
    body.appendChild(meta);
    card.appendChild(body);

    var right = el('span', 'trace-right');
    right.appendChild(el('span', 'time-ago', timeAgo(entry.createdAt)));
    right.appendChild(icon(['m9 6 6 6-6 6'], 16));
    card.appendChild(right);

    card.addEventListener('click', function () {
      openDrawer(entry);
    });

    return card;
  }

  function renderSkeletons() {
    [els.recent, els.recordings].forEach(function (host) {
      if (!host) return;
      host.textContent = '';
      for (var i = 0; i < 3; i++) host.appendChild(el('div', 'sk sk-trace'));
    });

    if (els.chart) {
      els.chart.textContent = '';
      for (var j = 0; j < 14; j++) {
        var bar = el('div', 'bar zero');
        bar.style.height = '12%';
        els.chart.appendChild(bar);
      }
    }
  }

  function emptyState(title, copyText, actionLabel, actionHref) {
    var card = el('div', 'empty-card');
    var glyph = el('div', 'empty-glyph');
    glyph.appendChild(icon(['M4 6h16M4 12h16M4 18h10'], 22));
    card.appendChild(glyph);
    card.appendChild(el('h3', null, title));
    card.appendChild(el('p', null, copyText));
    if (actionLabel) {
      var link = el('a', 'btn primary sm', actionLabel);
      link.href = actionHref || '/demo';
      card.appendChild(link);
    }
    return card;
  }

  function renderRecent() {
    var host = els.recent;
    if (!host) return;
    host.textContent = '';

    if (state.slices.length === 0) {
      host.appendChild(
        emptyState(
          'No traces yet',
          'Run a controlled crash on the demo page and the lead-up will appear here within a second.',
          'Generate a demo trace',
          '/demo'
        )
      );
      els.recentCount.textContent = '0';
      return;
    }

    els.recentCount.textContent = String(state.slices.length);
    state.slices.slice(0, 4).forEach(function (entry) {
      host.appendChild(traceCard(entry));
    });
  }

  function renderRecordings() {
    var host = els.recordings;
    if (!host) return;
    host.textContent = '';

    var list = currentList();
    if (els.recordingsCount) {
      els.recordingsCount.textContent = list.length + (list.length === 1 ? ' trace' : ' traces');
    }

    if (list.length === 0) {
      host.appendChild(
        emptyState(
          state.query ? 'Nothing matches' : 'No traces at this severity',
          state.query
            ? 'No trace matches “' + state.query + '”. Try a page name, a path, or error text.'
            : 'Change the filter above, or capture a new trace.',
          null
        )
      );
      return;
    }

    list.slice(0, state.shown).forEach(function (entry) {
      host.appendChild(traceCard(entry));
    });

    if (list.length > state.shown) {
      var more = el(
        'button',
        'btn sm show-more',
        'Show ' + Math.min(PAGE, list.length - state.shown) + ' more of ' + list.length
      );
      more.type = 'button';
      more.addEventListener('click', function () {
        state.shown += PAGE;
        renderRecordings();
      });
      host.appendChild(more);
    }
  }

  function renderFilters() {
    var host = els.filters;
    if (!host) return;
    host.textContent = '';

    var counts = { all: state.slices.length, critical: 0, warning: 0, info: 0 };
    state.slices.forEach(function (entry) {
      counts[severity(entry)] += 1;
    });

    ['all', 'critical', 'warning', 'info'].forEach(function (key) {
      var button = el('button', 'filter-chip');
      button.type = 'button';
      button.setAttribute('aria-pressed', String(state.filter === key));
      button.appendChild(document.createTextNode(key.charAt(0).toUpperCase() + key.slice(1)));
      button.appendChild(el('span', 'n', String(counts[key])));
      button.addEventListener('click', function () {
        state.filter = key;
        state.shown = PAGE;
        renderFilters();
        renderRecordings();
      });
      host.appendChild(button);
    });
  }

  function renderKpis() {
    var critical = state.slices.filter(function (entry) {
      return severity(entry) === 'critical';
    }).length;
    var replayMs = state.slices.reduce(function (sum, entry) {
      return sum + (Number(entry.summary && entry.summary.durationMs) || 0);
    }, 0);

    if (state.view === 'dashboard') {
      els.greetingTitle.textContent = greetingText();
    }

    els.kpiCritical.textContent = String(critical);
    els.kpiSessions.textContent = String(state.total);
    els.kpiReplay.textContent = String(Math.max(0, Math.round(replayMs / 1000)));

    // Subtitle under the greeting.
    var line = els.attentionLine;
    line.textContent = '';
    if (state.loading) {
      line.appendChild(document.createTextNode('Loading traces…'));
      return;
    }
    if (critical > 0) {
      line.appendChild(el('span', 'attention', String(critical)));
      line.appendChild(
        document.createTextNode(
          ' ' + (critical === 1 ? 'trace needs' : 'traces need') + ' attention. The rest look calm.'
        )
      );
    } else if (state.slices.length > 0) {
      line.appendChild(document.createTextNode('No failures recorded — everything looks calm.'));
    } else {
      line.appendChild(document.createTextNode('No traces recorded yet.'));
    }
  }

  /** Hourly histogram of captured traces over the last 24 hours. */
  function renderChart() {
    if (!els.chart) return;
    els.chart.textContent = '';
    els.chartAxis.textContent = '';

    var now = new Date();
    now.setMinutes(0, 0, 0);

    var buckets = [];
    for (var i = 23; i >= 0; i--) {
      var start = now.getTime() - i * 3600000;
      buckets.push({ start: start, end: start + 3600000, count: 0, critical: 0, hour: new Date(start).getHours() });
    }

    state.slices.forEach(function (entry) {
      var created = Number(entry.createdAt);
      for (var b = 0; b < buckets.length; b++) {
        if (created >= buckets[b].start && created < buckets[b].end) {
          buckets[b].count += 1;
          if (severity(entry) === 'critical') buckets[b].critical += 1;
          break;
        }
      }
    });

    var max = 1;
    buckets.forEach(function (bucket) {
      if (bucket.count > max) max = bucket.count;
    });

    buckets.forEach(function (bucket) {
      var bar = el('div', 'bar' + (bucket.count === 0 ? ' zero' : '') + (bucket.critical > 0 ? ' critical' : ''));
      var pct = bucket.count === 0 ? 5 : 16 + (bucket.count / max) * 84;
      bar.style.height = pct.toFixed(1) + '%';
      bar.title = bucket.count + (bucket.count === 1 ? ' trace at ' : ' traces at ') + bucket.hour + ':00';
      els.chart.appendChild(bar);

      var label = el('span', null, bucket.hour % 4 === 0 ? String(bucket.hour).padStart(2, '0') : '');
      els.chartAxis.appendChild(label);
    });
  }

  function renderAttention() {
    if (!els.attention) return;
    els.attention.textContent = '';

    var needy = state.slices.filter(function (entry) {
      var sev = severity(entry);
      return sev === 'critical' || sev === 'warning';
    });

    els.attentionCount.textContent = String(needy.length);

    if (needy.length === 0) {
      var quiet = el('p', 'muted-small');
      quiet.textContent = state.slices.length === 0
        ? 'Nothing recorded yet.'
        : 'Nothing needs attention. Nice.';
      els.attention.appendChild(quiet);
      return;
    }

    needy.slice(0, 4).forEach(function (entry) {
      var row = el('button', 'attention-row');
      row.type = 'button';
      row.appendChild(el('span', 'sev ' + severity(entry)));

      var body = el('span', 'body');
      body.appendChild(el('span', 'name', (entry.summary && entry.summary.pageLabel) || 'Unknown'));
      body.appendChild(el('span', 'why', errorText(entry)));
      row.appendChild(body);

      row.appendChild(el('span', 'when', timeAgo(entry.createdAt)));
      row.addEventListener('click', function () {
        openDrawer(entry);
      });
      els.attention.appendChild(row);
    });
  }

  function renderCoverage() {
    if (!els.coverage) return;
    els.coverage.textContent = '';

    var windows = state.slices
      .map(function (entry) {
        return Number(entry.summary && entry.summary.durationMs) || 0;
      })
      .sort(function (a, b) {
        return a - b;
      });

    var median = windows.length ? windows[Math.floor(windows.length / 2)] : 0;
    var requests = state.slices.reduce(function (sum, entry) {
      return sum + (Number(entry.summary && entry.summary.netCount) || 0);
    }, 0);
    var failures = state.slices.reduce(function (sum, entry) {
      return sum + (Number(entry.summary && entry.summary.errorCount) || 0);
    }, 0);

    function row(key, value) {
      els.coverage.appendChild(el('dt', null, key));
      els.coverage.appendChild(el('dd', null, value));
    }

    row('Traces stored', String(state.total));
    row('Median window', duration(median));
    row('Requests seen', String(requests));
    row('Console failures', String(failures));
  }

  function renderSidebar() {
    var critical = state.slices.filter(function (entry) {
      return severity(entry) === 'critical';
    }).length;
    if (!els.navBadge) return;
    els.navBadge.hidden = critical === 0;
    els.navBadge.textContent = String(critical);
  }

  function renderIssues() {
    var host = els.issues;
    if (!host) return;
    host.textContent = '';

    var groups = {};
    state.slices.forEach(function (entry) {
      var message = errorText(entry);
      if (message === 'No error captured') return;
      if (!groups[message]) groups[message] = [];
      groups[message].push(entry);
    });

    var keys = Object.keys(groups).sort(function (a, b) {
      return groups[b].length - groups[a].length;
    });

    if (keys.length === 0) {
      host.appendChild(
        emptyState('No issues recorded', 'Traces without errors still appear under Recordings.')
      );
      return;
    }

    keys.forEach(function (message) {
      var traces = groups[message];
      var newest = traces[0];

      var card = el('article', 'issue-group');
      var head = el('div', 'issue-head');
      head.appendChild(el('span', 'sev ' + severity(newest)));

      var text = el('div');
      text.appendChild(el('h3', null, message));
      var pages = traces
        .map(function (t) {
          return (t.summary && t.summary.pageLabel) || 'Unknown';
        })
        .filter(function (value, index, all) {
          return all.indexOf(value) === index;
        })
        .join(', ');
      text.appendChild(
        el(
          'p',
          'issue-meta',
          traces.length + (traces.length === 1 ? ' occurrence' : ' occurrences') + ' · ' + pages
        )
      );
      head.appendChild(text);
      card.appendChild(head);

      var list = el('div', 'issue-list');
      traces.slice(0, 5).forEach(function (trace) {
        var row = el('button', 'issue-row');
        row.type = 'button';
        row.appendChild(el('span', 'path', (trace.summary && trace.summary.path) || '/'));
        row.appendChild(el('span', 'time', timeAgo(trace.createdAt)));
        row.addEventListener('click', function () {
          openDrawer(trace);
        });
        list.appendChild(row);
      });
      card.appendChild(list);
      host.appendChild(card);
    });
  }

  function renderSettings() {
    if (!els.storageLine) return;
    els.storageLine.textContent =
      state.total + (state.total === 1 ? ' trace' : ' traces') + ' · ' + state.slices.length + ' loaded';
  }

  // --------------------------------------------------------------- drawer --

  function openDrawer(entry) {
    var summary = entry.summary || {};
    state.active = entry;

    els.drawerSev.className = 'sev ' + severity(entry);
    els.drawerTitle.textContent = summary.pageLabel || 'Trace';

    var body = els.drawerBody;
    body.textContent = '';

    var summaryCard = el('div', 'drawer-card');
    summaryCard.appendChild(el('h3', null, 'Error summary'));
    summaryCard.appendChild(el('p', 'summary-line', errorText(entry)));
    if (summary.firstError && summary.firstError.filename) {
      summaryCard.appendChild(
        el(
          'p',
          'issue-meta',
          summary.firstError.filename + (summary.firstError.lineno ? ':' + summary.firstError.lineno : '')
        )
      );
    }
    body.appendChild(summaryCard);

    var facts = el('div', 'drawer-card');
    facts.appendChild(el('h3', null, 'Session facts'));
    var dl = el('dl', 'kv');
    function row(key, value) {
      dl.appendChild(el('dt', null, key));
      dl.appendChild(el('dd', null, value));
    }
    row('Slice', entry.id.slice(0, 8));
    row('Captured', new Date(Number(entry.createdAt)).toLocaleString());
    row('Window', duration(summary.durationMs));
    row('Requests', String(summary.netCount || 0));
    row('Console', String(summary.consoleCount || 0));
    row('Events', String(summary.eventCount || 0));
    if (summary.lastRequest) {
      row('Last call', summary.lastRequest.method + ' ' + summary.lastRequest.status);
    }
    facts.appendChild(dl);
    body.appendChild(facts);

    var timeline = el('div', 'drawer-card');
    timeline.appendChild(el('h3', null, 'Timeline'));
    timeline.appendChild(
      el(
        'p',
        'issue-meta',
        summary.errorAt !== null && summary.errorAt !== undefined
          ? 'First failure at ' + (Number(summary.errorAt) / 1000).toFixed(1) + 's into the window.'
          : 'No failure recorded in this window.'
      )
    );
    body.appendChild(timeline);

    els.scrim.hidden = false;
    els.drawer.hidden = false;
    window.requestAnimationFrame(function () {
      els.scrim.classList.add('show');
      els.drawer.classList.add('show');
    });
    els.drawerOpen.focus();
  }

  function closeDrawer() {
    els.scrim.classList.remove('show');
    els.drawer.classList.remove('show');
    state.active = null;
    window.setTimeout(function () {
      els.scrim.hidden = true;
      els.drawer.hidden = true;
    }, 240);
  }

  function openReplay(entry) {
    if (!entry) return;
    window.location.href = '/replay/' + encodeURIComponent(entry.id);
  }

  // ----------------------------------------------------------------- lock --

  function showLock(message) {
    els.lock.hidden = false;
    els.app.hidden = true;
    if (message) {
      els.lockError.textContent = message;
      els.lockError.hidden = false;
    }
    window.setTimeout(function () {
      els.tokenInput.focus();
    }, 40);
  }

  function showApp() {
    els.lock.hidden = true;
    els.app.hidden = false;
  }

  function unlock(candidate) {
    els.unlockBtn.disabled = true;
    els.unlockBtn.textContent = 'Checking…';

    fetch('/api/slices?limit=1', {
      headers: { Authorization: 'Bearer ' + candidate },
      credentials: 'omit',
      cache: 'no-store',
    })
      .then(function (response) {
        if (response.status === 401) throw new Error('That token was rejected.');
        if (!response.ok) throw new Error('Server returned HTTP ' + response.status + '.');
        return response.json();
      })
      .then(function () {
        setToken(candidate);
        els.lockError.hidden = true;
        showApp();
        loadSlices();
      })
      .catch(function (error) {
        els.lockError.textContent = error.message;
        els.lockError.hidden = false;
      })
      .then(function () {
        els.unlockBtn.disabled = false;
        els.unlockBtn.textContent = 'Unlock dashboard';
      });
  }

  // ---------------------------------------------------------------- views --

  function setView(name) {
    state.view = name;

    ['dashboard', 'recordings', 'issues', 'settings'].forEach(function (view) {
      var section = document.getElementById('view-' + view);
      if (section) section.hidden = view !== name;
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (button) {
      if (button.getAttribute('data-view') === name) {
        button.setAttribute('aria-current', 'page');
      } else {
        button.removeAttribute('aria-current');
      }
    });

    var title = VIEWS[name] ? VIEWS[name]() : ['Error-DVR', null];
    els.greetingTitle.textContent = title[0];

    if (title[1]) {
      els.attentionLine.textContent = title[1];
    } else {
      renderKpis();
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ----------------------------------------------------------------- init --

  function cacheElements() {
    els = {
      lock: document.getElementById('lock'),
      lockForm: document.getElementById('lockForm'),
      tokenInput: document.getElementById('tokenInput'),
      lockError: document.getElementById('lockError'),
      unlockBtn: document.getElementById('unlockBtn'),
      app: document.getElementById('app'),
      search: document.getElementById('search'),
      refresh: document.getElementById('refresh'),
      account: document.getElementById('account'),
      navBadge: document.getElementById('navBadge'),
      greetingTitle: document.getElementById('greetingTitle'),
      attentionLine: document.getElementById('attentionLine'),
      kpiCritical: document.getElementById('kpiCritical'),
      kpiSessions: document.getElementById('kpiSessions'),
      kpiReplay: document.getElementById('kpiReplay'),
      chart: document.getElementById('chart'),
      chartAxis: document.getElementById('chartAxis'),
      attention: document.getElementById('attention'),
      attentionCount: document.getElementById('attentionCount'),
      coverage: document.getElementById('coverage'),
      recent: document.getElementById('recent'),
      recentCount: document.getElementById('recentCount'),
      recordings: document.getElementById('recordings'),
      recordingsCount: document.getElementById('recordingsCount'),
      filters: document.getElementById('filters'),
      issues: document.getElementById('issues'),
      storageLine: document.getElementById('storageLine'),
      scrim: document.getElementById('scrim'),
      drawer: document.getElementById('drawer'),
      drawerBody: document.getElementById('drawerBody'),
      drawerSev: document.getElementById('drawerSev'),
      drawerTitle: document.getElementById('drawerTitle'),
      drawerOpen: document.getElementById('drawerOpen'),
      drawerCopy: document.getElementById('drawerCopy'),
      drawerClose: document.getElementById('drawerClose'),
      toast: document.getElementById('toast'),
    };
  }

  function bind() {
    els.lockForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var value = els.tokenInput.value.trim();
      if (value) unlock(value);
    });

    els.refresh.addEventListener('click', function () {
      loadSlices();
      toast('Refreshing traces…');
    });

    els.account.addEventListener('click', function () {
      setView('settings');
    });

    els.search.addEventListener('input', function () {
      state.query = els.search.value;
      state.shown = PAGE;
      if (state.view !== 'recordings') setView('recordings');
      renderRecordings();
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (button) {
      button.addEventListener('click', function () {
        setView(button.getAttribute('data-view'));
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-go]'), function (button) {
      button.addEventListener('click', function () {
        setView(button.getAttribute('data-go'));
      });
    });

    els.drawerClose.addEventListener('click', closeDrawer);
    els.scrim.addEventListener('click', closeDrawer);
    els.drawerOpen.addEventListener('click', function () {
      openReplay(state.active);
    });
    els.drawerCopy.addEventListener('click', function () {
      if (!state.active) return;
      var link = window.location.origin + '/replay/' + encodeURIComponent(state.active.id);
      copy(link).then(function (ok) {
        toast(ok ? 'Link copied — the recipient still needs the admin token.' : 'Copy failed.');
      });
    });

    var lockNow = document.getElementById('lockNow');
    if (lockNow) {
      lockNow.addEventListener('click', function () {
        clearToken();
        state.slices = [];
        showLock('Locked. Paste your admin token to continue.');
      });
    }

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !els.drawer.hidden) closeDrawer();
      if (event.key === '/' && document.activeElement !== els.search) {
        event.preventDefault();
        els.search.focus();
      }
    });
  }

  function boot() {
    cacheElements();

    // A token may arrive in the fragment (share links); absorb it, then strip it.
    var hash = window.location.hash.replace(/^#/, '');
    var incoming = '';
    if (hash) {
      new URLSearchParams(hash).forEach(function (value, key) {
        if (key === 'token') incoming = value;
      });
    }
    if (incoming) {
      setToken(incoming);
      try {
        window.history.replaceState(null, '', window.location.pathname);
      } catch (e) {
        /* ignore */
      }
    }

    bind();

    if (token()) {
      showApp();
      els.greetingTitle.textContent = greetingText();
      loadSlices();
    } else {
      showLock('');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
