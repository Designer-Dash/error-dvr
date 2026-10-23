// src/server.js
// Hardened Error-DVR backend.
//
// Security model:
//   * binds to loopback only
//   * Host allow-list (DNS-rebinding defence)
//   * ingest key (write) and admin token (read) are separate credentials
//   * uploads are schema-validated, size-capped, sanitised and rate-limited
//   * replay data is never executed in a privileged origin
//   * strict CSP + hardening headers on every response

'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');

const config = require('./config.json');
const { openDatabase } = require('./db');
const { summarize } = require('./summarize');
const {
  loadSecrets,
  requireCredential,
  securityHeaders,
  playerCsp,
  hostAllowlist,
  rateLimit,
  isUuid,
  sanitizeEvents,
} = require('./security');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VENDOR_DIR = path.join(__dirname, '..', 'vendor');

// DVR_PORT lets tests run alongside an already-running instance.
const PORT = Number(process.env.DVR_PORT) || config.port;

// Every origin this service may legitimately be reached at. Used for the
// player's Content-Security-Policy, where 'self' is unreliable because the
// player frame is sandboxed into an opaque origin.
const ORIGINS = [
  `http://${config.host}:${PORT}`,
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  `http://[::1]:${PORT}`,
].filter((value, index, all) => all.indexOf(value) === index);

// CSP host-sources cannot be IPv6 literals; keep them out of policy strings
// while still accepting the host in the allow-list.
const CSP_ORIGINS = ORIGINS.filter((origin) => !origin.includes('['));

// Files the browser may load. A fixed map beats a static directory mount:
// nothing that is not listed here can ever be served.
const ASSETS = {
  '/app.css': ['app.css', 'text/css'],
  '/app.js': ['app.js', 'application/javascript'],
  '/replay.css': ['replay.css', 'text/css'],
  '/replay.js': ['replay.js', 'application/javascript'],
  '/demo.css': ['demo.css', 'text/css'],
  '/demo.js': ['demo.js', 'application/javascript'],
  '/sdk.js': ['sdk.js', 'application/javascript'],
  // Loaded by the opaque-origin player frame, so CORP must allow cross-origin.
  '/player.js': ['player.js', 'application/javascript', { corp: 'cross-origin' }],
};

// Vendored rrweb runtime: pinned files served from this origin, never a CDN.
const VENDOR = {
  '/vendor/rrweb.js': ['rrweb.umd.min.cjs', 'application/javascript'],
  '/vendor/rrweb-player.js': ['rrweb-player.umd.min.cjs', 'application/javascript'],
  '/vendor/rrweb-player.css': ['rrweb-player.css', 'text/css'],
};

const secrets = loadSecrets(path.resolve(__dirname, '..', config.secretsPath));
const store = openDatabase(config);

const app = express();
app.disable('x-powered-by');
app.set('etag', false);
app.set('trust proxy', false); // never trust X-Forwarded-For from a client

// ------------------------------------------------------------------ guards --

app.use(hostAllowlist(config.allowedHosts));

// Nothing may frame us. The replay page may frame the player from the other
// loopback origin; the player route overrides this with its own policy.
app.use((req, res, next) =>
  securityHeaders({ frameAncestors: "'none'", origins: CSP_ORIGINS })(req, res, next)
);

for (const [route, [file, type, options = {}]] of Object.entries(ASSETS)) {
  app.get(route, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type(type);
    if (options.corp === 'cross-origin') {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    }
    res.sendFile(path.join(PUBLIC_DIR, file));
  });
}

for (const [route, [file, type]] of Object.entries(VENDOR)) {
  app.get(route, (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.type(type);
    // The sandboxed player frame has an opaque origin, so it fetches these as
    // a cross-origin no-cors request. These files are public library code.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.sendFile(path.join(VENDOR_DIR, file));
  });
}

// ------------------------------------------------------------------- pages --

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'app.html'));
});

/** Instrumented demo page used to generate a trace. */
app.get('/demo', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'demo.html'));
});

/** Per-process bootstrap config. Contains the write-only ingest key. */
app.get('/config.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('application/javascript');
  const bootstrap = JSON.stringify({
    uploadUrl: '/upload',
    ingestKey: secrets.ingestKey,
    sliceLengthSec: config.sliceLengthSec,
    privacyMasking: config.privacyMasking,
    maxEvents: config.maxEventsPerSlice,
  }).replace(/</g, '\\u003c');
  res.send(`window.__DVR__ = ${bootstrap};`);
});

app.get('/replay/:id', (req, res) => {
  if (!isUuid(req.params.id)) {
    return res.status(400).json({ error: 'invalid slice id' });
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.sendFile(path.join(PUBLIC_DIR, 'replay.html'));
});

/** Player page: framed by the replay page with sandbox="allow-scripts". */
app.get('/player.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', playerCsp(CSP_ORIGINS));
  res.removeHeader('X-Frame-Options'); // governed by CSP frame-ancestors instead
  res.sendFile(path.join(PUBLIC_DIR, 'player.html'));
});

// --------------------------------------------------------------------- api --

const ingestLimit = rateLimit({
  windowMs: 60_000,
  max: config.uploadRateLimitPerMin,
  name: 'upload',
});

const readLimit = rateLimit({
  windowMs: 60_000,
  max: config.readRateLimitPerMin,
  name: 'read',
});

// Write-only ingestion endpoint. A compromised instrumented page holds this key
// but cannot use it to read anyone's recording.
app.post(
  '/upload',
  ingestLimit,
  requireCredential(() => secrets.ingestKey, 'x-dvr-ingest'),
  express.json({ limit: config.maxUploadBytes, strict: true }),
  (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'invalid body' });
    }

    const timestamp =
      typeof body.timestamp === 'number' && Number.isFinite(body.timestamp)
        ? Math.floor(body.timestamp)
        : Date.now();

    const result = sanitizeEvents(body.slice, config);
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    // The client never chooses the id: no IDOR, no guessable identifiers.
    const id = crypto.randomUUID();
    const summary = summarize(result.events);

    const stored = store.insertSlice({
      id,
      timestamp,
      payload: { events: result.events, timestamp },
      summary,
      maxSlices: config.maxSlices,
    });

    if (!stored.ok) {
      return res.status(500).json({ error: 'store failed' });
    }

    return res.json({
      status: 'ok',
      sliceId: id,
      replayUrl: `/replay/${id}`,
      eventCount: result.events.length,
      severity: summary.severity,
      pageLabel: summary.pageLabel,
    });
  }
);

// Metadata listing for the dashboard. Requires the admin token; returns
// summaries only, never payloads.
app.get(
  '/api/slices',
  readLimit,
  requireCredential(() => secrets.adminToken, 'x-dvr-token'),
  (req, res) => {
    const requested = Number(req.query.limit);
    const limit = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), config.maxListLimit)
      : 50;

    res.setHeader('Cache-Control', 'no-store');
    return res.json({ slices: store.listSlices(limit), total: store.count() });
  }
);

// Read endpoint: requires the admin token. Sent as a header, so it never lands
// in URLs, proxy logs or Referer headers.
app.get(
  '/api/slice/:id',
  readLimit,
  requireCredential(() => secrets.adminToken, 'x-dvr-token'),
  (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) {
      return res.status(400).json({ error: 'invalid slice id' });
    }

    const record = store.getSlice(id);
    if (!record) {
      return res.status(404).json({ error: 'not found' });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      id,
      integrity: record.integrity,
      createdAt: record.createdAt,
      summary: record.summary,
      slice: record.payload ? record.payload.events : [],
    });
  }
);

app.get('/healthz', (req, res) => {
  res.json({ ok: true });
});

// Browsers ask for this unprompted; answering keeps the request log clean.
app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

// --------------------------------------------------------------- fallbacks --

app.use((req, res) => {
  res.status(404).json({ error: 'not found' });
});

// Central error handler: never leak stack traces or filesystem paths.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ error: 'payload too large' });
  }
  if (err && (err.type === 'entity.parse.failed' || err.status === 400)) {
    return res.status(400).json({ error: 'invalid json' });
  }
  console.error('[error]', err && err.code ? err.code : 'unexpected');
  return res.status(500).json({ error: 'internal error' });
});

// ------------------------------------------------------------------ listen --

const server = app.listen(PORT, config.host, () => {
  const base = `http://${config.host}:${PORT}`;
  console.log('');
  console.log('  Error-DVR (hardened) listening on ' + base);
  console.log('  Database   : ' + store.dbPath);
  console.log('  Secrets    : ' + path.resolve(__dirname, '..', config.secretsPath));
  console.log('');
  console.log('  Dashboard  : ' + base + '/');
  console.log('  Demo page  : ' + base + '/demo');
  console.log('  Admin token: ' + (process.env.DVR_QUIET === '1' ? '(suppressed)' : secrets.adminToken));
  console.log('');
  console.log('  Paste the admin token into the dashboard to unlock it.');
  console.log('');
});

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down`);
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
