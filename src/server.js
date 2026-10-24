// src/server.js
// Error-DVR server. Exposes start() so the CLI can own argument parsing,
// port selection and shutdown.
//
// Security model:
//   * binds to loopback only
//   * Host allow-list (DNS-rebinding defence)
//   * ingest key (write) and admin token (read) are separate credentials
//   * uploads are schema-validated, size-capped, sanitised and rate-limited
//   * reads never send CORS headers; only the write-only ingest endpoint does
//   * replay data is never executed in a privileged origin
//   * strict CSP + hardening headers on every response

'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');

const defaults = require('./config.json');
const { openDatabase } = require('./db');
const { summarize } = require('./summarize');
const { resolveDataDir, secretsPathIn, databasePathIn } = require('./paths');
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

const PKG_ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(PKG_ROOT, 'public');
const VENDOR_DIR = path.join(PKG_ROOT, 'vendor');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// Files the browser may load. A fixed map beats a static directory mount:
// nothing that is not listed here can ever be served.
const ASSETS = {
  '/app.css': ['app.css', 'text/css'],
  '/app.js': ['app.js', 'application/javascript'],
  '/replay.css': ['replay.css', 'text/css'],
  '/replay.js': ['replay.js', 'application/javascript'],
  '/demo.css': ['demo.css', 'text/css'],
  '/demo.js': ['demo.js', 'application/javascript'],
  // Embedded in someone else's page, so CORP must allow cross-origin.
  '/sdk.js': ['sdk.js', 'application/javascript', { corp: 'cross-origin' }],
  // Loaded by the cross-origin player frame, so CORP must allow cross-origin.
  '/player.js': ['player.js', 'application/javascript', { corp: 'cross-origin' }],
};

// Vendored rrweb runtime: pinned files served from this origin, never a CDN.
const VENDOR = {
  '/vendor/rrweb.js': ['rrweb.umd.min.cjs', 'application/javascript'],
  '/vendor/rrweb-player.js': ['rrweb-player.umd.min.cjs', 'application/javascript'],
  '/vendor/rrweb-player.css': ['rrweb-player.css', 'text/css'],
};

/**
 * Merge defaults, a config file and CLI options into the runtime config.
 * @param {object} options { port, host, dataDir, quiet }
 */
function buildConfig(options = {}) {
  const host = options.host || defaults.host;
  if (!LOOPBACK_HOSTS.has(host)) {
    const error = new Error(
      `Refusing to bind to "${host}". Error-DVR is loopback-only: the replay ` +
        'isolation depends on a second loopback origin, and recordings hold ' +
        'masked user sessions. Put a TLS reverse proxy in front if you need ' +
        'remote access.'
    );
    error.code = 'NON_LOOPBACK_HOST';
    throw error;
  }

  const dataDir = resolveDataDir(options.dataDir);

  return {
    ...defaults,
    ...(options.port !== undefined ? { port: options.port } : {}),
    host,
    dataDir,
    databasePath: databasePathIn(dataDir),
    secretsPath: secretsPathIn(dataDir),
    quiet: Boolean(options.quiet),
  };
}

function start(options = {}) {
  const config = buildConfig(options);

  const PORT = config.port;

  // Every origin this service may legitimately be reached at. Used for the
  // player's Content-Security-Policy, where 'self' is unreliable because the
  // player is a separate origin.
  const ORIGINS = [
    `http://${config.host}:${PORT}`,
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    `http://[::1]:${PORT}`,
  ].filter((value, index, all) => all.indexOf(value) === index);

  // CSP host-sources cannot be IPv6 literals; keep them out of policy strings
  // while still accepting the host in the allow-list.
  const CSP_ORIGINS = ORIGINS.filter((origin) => !origin.includes('['));

  const secrets = loadSecrets(config.secretsPath);
  const store = openDatabase({ databasePath: config.databasePath, maxSlices: config.maxSlices });

  // Demo-page bootstrap. The key is write-only, and this file is same-origin.
  const bootstrapScript = `window.__DVR__ = ${JSON.stringify({
    uploadUrl: '/upload',
    ingestKey: secrets.ingestKey,
    sliceLengthSec: config.sliceLengthSec,
    privacyMasking: config.privacyMasking,
    maxEvents: config.maxEventsPerSlice,
  }).replace(/</g, '\\u003c')};`;

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.set('trust proxy', false);

  // ---------------------------------------------------------------- guards --

  app.use(hostAllowlist(config.allowedHosts));

  app.use((req, res, next) =>
    securityHeaders({ frameAncestors: "'none'", origins: CSP_ORIGINS })(req, res, next)
  );

  /**
   * CORS for the ingest endpoint only.
   *
   * The SDK is meant to be dropped into *someone else's* site, so its upload is
   * cross-origin. That is safe here because /upload is write-only: it requires
   * the ingest key, and no read endpoint ever emits these headers. A page that
   * holds the key can create slices (rate-limited) and still cannot read any.
   */
  app.use((req, res, next) => {
    if (req.path !== '/upload') return next();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-dvr-ingest');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  });

  // ---------------------------------------------------------------- assets --

  for (const [route, [file, type, opts = {}]] of Object.entries(ASSETS)) {
    app.get(route, (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.type(type);
      if (opts.corp === 'cross-origin') {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      }
      res.sendFile(path.join(PUBLIC_DIR, file));
    });
  }

  for (const [route, [file, type]] of Object.entries(VENDOR)) {
    app.get(route, (req, res) => {
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      res.type(type);
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.sendFile(path.join(VENDOR_DIR, file));
    });
  }

  // ----------------------------------------------------------------- pages --

  app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(PUBLIC_DIR, 'app.html'));
  });

  /** Instrumented demo page used to try the recorder. */
  app.get('/demo', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(PUBLIC_DIR, 'demo.html'));
  });

  /** Same-origin bootstrap for the demo page. */
  app.get('/config.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/javascript');
    res.send(bootstrapScript);
  });

  app.get('/replay/:id', (req, res) => {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'invalid slice id' });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(path.join(PUBLIC_DIR, 'replay.html'));
  });

  /** Player page: framed by the replay page from the other loopback origin. */
  app.get('/player.html', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', playerCsp(CSP_ORIGINS));
    res.removeHeader('X-Frame-Options');
    res.sendFile(path.join(PUBLIC_DIR, 'player.html'));
  });

  // ------------------------------------------------------------------- api --

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
      if (result.error) return res.status(400).json({ error: result.error });

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

      if (!stored.ok) return res.status(500).json({ error: 'store failed' });

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

  app.get(
    '/api/slices',
    readLimit,
    requireCredential(() => secrets.adminToken, 'x-dvr-token'),
    (req, res) => {
      const requested = Number(req.query.limit);
      const limit =
        Number.isFinite(requested) && requested > 0
          ? Math.min(Math.floor(requested), config.maxListLimit)
          : 50;

      res.setHeader('Cache-Control', 'no-store');
      return res.json({ slices: store.listSlices(limit), total: store.count() });
    }
  );

  app.get(
    '/api/slice/:id',
    readLimit,
    requireCredential(() => secrets.adminToken, 'x-dvr-token'),
    (req, res) => {
      const { id } = req.params;
      if (!isUuid(id)) return res.status(400).json({ error: 'invalid slice id' });

      const record = store.getSlice(id);
      if (!record) return res.status(404).json({ error: 'not found' });

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

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.get('/favicon.ico', (req, res) => res.status(204).end());

  // ------------------------------------------------------------- fallbacks --

  app.use((req, res) => res.status(404).json({ error: 'not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && (err.type === 'entity.too.large' || err.status === 413)) {
      return res.status(413).json({ error: 'payload too large' });
    }
    if (err && (err.type === 'entity.parse.failed' || err.status === 400)) {
      return res.status(400).json({ error: 'invalid JSON' });
    }
    console.error('[error]', err && err.code ? err.code : 'unexpected');
    return res.status(500).json({ error: 'internal error' });
  });

  // --------------------------------------------------------------- listen --

  const server = app.listen(PORT, config.host);

  const handle = {
    server,
    app,
    store,
    config,
    secrets,
    url: `http://${config.host}:${PORT}`,
    /** Called once the socket is actually bound. */
    onListening(callback) {
      server.once('listening', () => callback(handle));
      return handle;
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => {
          store.close();
          resolve();
        });
        setTimeout(() => {
          store.close();
          resolve();
        }, 3000).unref();
      });
    },
  };

  return handle;
}

module.exports = { start, buildConfig, LOOPBACK_HOSTS };
