// src/summarize.js
// Derives the metadata the dashboard needs (severity, page, error) from a
// sanitised event slice. Computed once at write time so listing traces never
// has to read or parse whole payloads.

'use strict';

const CLICK = 2; // rrweb MouseInteraction type: Click

function labelFromPath(pathname) {
  if (!pathname || pathname === '/') return 'Home';
  const last = pathname.split('/').filter(Boolean).pop() || 'Home';
  return last
    .replace(/[-_]+/g, ' ')
    .replace(/\.\w+$/, '')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .slice(0, 48);
}

/**
 * @param {Array} events sanitised events
 * @returns {object} compact summary, safe to persist as JSON
 */
function summarize(events) {
  const summary = {
    href: '',
    path: '',
    pageLabel: 'Unknown page',
    eventCount: events.length,
    domCount: 0,
    netCount: 0,
    consoleCount: 0,
    errorCount: 0,
    warnCount: 0,
    netErrorCount: 0,
    durationMs: 0,
    errorAt: null,
    lastInteractionAt: null,
    firstError: null,
    lastError: null,
    lastRequest: null,
  };

  let minTs = Infinity;
  let maxTs = -Infinity;
  const errors = [];

  for (const event of events) {
    const ts = Number(event.timestamp);
    if (Number.isFinite(ts)) {
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
    }

    if (typeof event.type === 'number') {
      summary.domCount += 1;

      if (event.type === 4 && event.data && typeof event.data.href === 'string') {
        summary.href = event.data.href.slice(0, 300);
      }

      if (event.type === 3 && event.data) {
        // MouseInteraction / click is the strongest "user did something" signal.
        if (event.data.source === 2 && event.data.type === CLICK) {
          summary.lastInteractionAt = ts;
        } else if (event.data.source === 5) {
          summary.lastInteractionAt = ts; // typed input
        }
      }
      continue;
    }

    if (event.type === 'network') {
      summary.netCount += 1;
      const status = event.status;
      if (status === 'error' || (typeof status === 'number' && status >= 400)) {
        summary.netErrorCount += 1;
      }
      summary.lastRequest = {
        method: String(event.method || 'GET').slice(0, 8),
        url: String(event.url || '').slice(0, 300),
        status: status === 'error' ? 'error' : Number(status) || 0,
      };
      continue;
    }

    if (event.type === 'console') {
      summary.consoleCount += 1;
      if (event.level === 'warn') summary.warnCount += 1;
      if (event.level === 'error') {
        summary.errorCount += 1;
        errors.push({
          source: 'console',
          message: String(event.message || '').slice(0, 500),
          timestamp: ts,
        });
      }
      continue;
    }

    if (event.type === 'error') {
      summary.errorCount += 1;
      errors.push({
        source: 'uncaught',
        message: String(event.message || 'Error').slice(0, 500),
        filename: String(event.filename || '').slice(0, 300),
        lineno: Number(event.lineno) || 0,
        colno: Number(event.colno) || 0,
        stack: String(event.stack || '').slice(0, 2000),
        timestamp: ts,
      });
    }
  }

  if (Number.isFinite(minTs) && Number.isFinite(maxTs)) {
    summary.durationMs = Math.max(0, maxTs - minTs);
  }

  if (summary.href) {
    try {
      summary.path = new URL(summary.href).pathname.slice(0, 200);
    } catch {
      summary.path = '';
    }
  }
  summary.pageLabel = labelFromPath(summary.path);

  if (errors.length > 0) {
    summary.firstError = errors[0];
    summary.lastError = errors[errors.length - 1];
    if (Number.isFinite(minTs)) {
      summary.errorAt = Math.max(0, errors[0].timestamp - minTs);
    }
  }

  summary.severity =
    summary.errorCount > 0 ? 'critical' : summary.warnCount > 0 || summary.netErrorCount > 0 ? 'warning' : 'info';

  return summary;
}

module.exports = { summarize, labelFromPath };
