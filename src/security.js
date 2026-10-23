// src/security.js
// Security primitives: secrets, headers, host allow-listing, rate limiting,
// constant-time credential checks, and untrusted-event sanitisation.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------- secrets --

/**
 * Load (or first-time generate) the two credentials.
 *
 *   ingestKey   write-only  — handed to the page being instrumented.
 *   adminToken  read-only   — required to read any recorded session.
 *
 * Splitting them means a compromised instrumented page can create slices but
 * can never read another user's recording.
 */
function loadSecrets(secretsPath) {
  const abs = path.resolve(secretsPath);
  const dir = path.dirname(abs);

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  let secrets = null;
  try {
    secrets = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch {
    secrets = null;
  }

  if (
    !secrets ||
    typeof secrets.ingestKey !== 'string' ||
    typeof secrets.adminToken !== 'string' ||
    secrets.ingestKey.length < 32 ||
    secrets.adminToken.length < 32
  ) {
    secrets = {
      ingestKey: crypto.randomBytes(32).toString('base64url'),
      adminToken: crypto.randomBytes(32).toString('base64url'),
    };
    fs.writeFileSync(abs, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(abs, 0o600);
    } catch {
      /* best effort on filesystems without POSIX modes */
    }
  }

  return secrets;
}

/** Constant-time string comparison (length-independent). */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Read a credential from its dedicated header, falling back to a bearer token.
 * Each route names the header it expects, so the write key and the read token
 * can never be confused for one another.
 */
function credentialOf(req, headerName) {
  if (headerName) {
    const direct = req.get(headerName);
    if (direct) return direct.trim();
  }
  const header = req.get('authorization');
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
  return '';
}

/** Express middleware: require one of the configured credentials. */
function requireCredential(getExpected, headerName) {
  return function credentialGate(req, res, next) {
    const supplied = credentialOf(req, headerName);
    if (!supplied || !safeEqual(supplied, getExpected())) {
      // Uniform response: no hint about which credential or whether it exists.
      res.setHeader('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ error: 'unauthorized' });
    }
    return next();
  };
}

// ---------------------------------------------------------------- headers --

const CSP_BASE = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "child-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
];

/**
 * Policy for /player.html.
 *
 * The player is framed with sandbox="allow-scripts" and therefore has an opaque
 * origin. `'self'` is unreliable in that situation, so every source is an
 * explicit origin instead. Nothing else is allowed.
 */
function playerCsp(origins) {
  const src = origins.join(' ');
  return [
    "default-src 'none'",
    `script-src ${src}`,
    `style-src ${src} 'unsafe-inline'`,
    `img-src ${src} data: blob:`,
    `media-src ${src} data: blob:`,
    `font-src ${src} data:`,
    "connect-src 'none'",
    // rrweb's replayer renders into its own nested, sandboxed frame.
    `frame-src ${src} about:`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    // Explicit origins rather than 'self' (see above).
    `frame-ancestors ${src}`,
  ].join('; ');
}

/**
 * Baseline hardening headers applied to every response.
 *
 * `origins` lists the loopback origins this service is reachable at. The replay
 * page frames the player from the *other* origin, so frame-src must name both.
 */
function securityHeaders({ frameAncestors = "'none'", origins = [] } = {}) {
  const frameSources = ["'self'", ...origins].join(' ');
  const csp = [...CSP_BASE, `frame-src ${frameSources}`, `frame-ancestors ${frameAncestors}`].join('; ');

  return function applyHeaders(req, res, next) {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', frameAncestors === "'self'" ? 'SAMEORIGIN' : 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Permissions-Policy',
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()'
    );
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.removeHeader('X-Powered-By');
    next();
  };
}

// ------------------------------------------------------- host allow-listing --

/**
 * Reject requests whose Host header is not allow-listed. Blocks DNS-rebinding
 * attacks, where evil.example resolves to 127.0.0.1 and the browser then treats
 * this local service as same-origin.
 */
function hostAllowlist(allowedHosts) {
  const allowed = new Set(allowedHosts.map((h) => h.toLowerCase()));

  return function checkHost(req, res, next) {
    const raw = (req.get('host') || '').toLowerCase();
    // Strip the port; keep IPv6 brackets.
    const host = raw.startsWith('[')
      ? raw.slice(0, raw.indexOf(']') + 1)
      : raw.split(':')[0];

    if (!allowed.has(host)) {
      return res.status(421).json({ error: 'misdirected request' });
    }
    return next();
  };
}

// ------------------------------------------------------------ rate limiting --

/** Fixed-window per-IP limiter. Small, dependency-free, in-process. */
function rateLimit({ windowMs, max, name }) {
  const buckets = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of buckets) {
      if (entry.reset <= now) buckets.delete(key);
    }
  }, windowMs);
  if (typeof sweep.unref === 'function') sweep.unref();

  return function limiter(req, res, next) {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${name}:${ip}`;
    const now = Date.now();

    let entry = buckets.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      buckets.set(key, entry);
    }

    entry.count += 1;
    const remaining = Math.max(0, max - entry.count);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil((entry.reset - now) / 1000)));

    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ error: 'too many requests' });
    }
    return next();
  };
}

// -------------------------------------------------------------- validation --

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ----------------------------------------------------- untrusted sanitising --

const EVENT_TYPES = new Set([0, 1, 2, 3, 4, 5]);
const INCREMENTAL_SOURCES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

const DANGEROUS_SCHEMES = /^\s*(?:javascript|vbscript|data\s*:\s*text\/html|data\s*:\s*image\/svg\+xml)/i;
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'poster', 'background', 'data']);
const BLOCKED_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'applet', 'frame', 'frameset', 'base']);

/**
 * Recursively scrub a recorded node/event tree.
 *
 * Defends against stored XSS through malformed replay data: event-handler
 * attributes, javascript: URLs, srcdoc payloads and active tags are removed
 * before the data is ever stored or served.
 */
function scrub(value, cfg, depth = 0) {
  if (depth > 64) return null;

  if (typeof value === 'string') {
    return value.length > cfg.maxStringLength
      ? value.slice(0, cfg.maxStringLength)
      : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    // Dropped (blocked) nodes must not leave holes in the snapshot tree.
    return value
      .map((item) => scrub(item, cfg, depth + 1))
      .filter((item) => item !== null);
  }
  if (!isPlainObject(value)) return null;

  // Drop active elements entirely (rrweb would recreate them in the player).
  if (typeof value.tagName === 'string' && BLOCKED_TAGS.has(value.tagName.toLowerCase())) {
    return null;
  }

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (/^on/i.test(key)) continue; // onclick, onerror, onload, ...
    if (key === 'srcdoc') continue; // inline HTML document
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;

    if (URL_ATTRS.has(key.toLowerCase()) && typeof val === 'string' && DANGEROUS_SCHEMES.test(val)) {
      continue;
    }
    out[key] = scrub(val, cfg, depth + 1);
  }
  return out;
}

/**
 * Validate and sanitise an uploaded slice.
 * Returns { events } on success or { error } on rejection.
 */
function sanitizeEvents(raw, cfg) {
  if (!Array.isArray(raw)) return { error: 'slice must be an array' };
  if (raw.length === 0) return { error: 'slice must not be empty' };
  if (raw.length > cfg.maxEventsPerSlice) return { error: 'slice too large' };

  const events = [];
  for (const event of raw) {
    if (!isPlainObject(event)) return { error: 'event must be an object' };

    // Two shapes are accepted: rrweb events (numeric type) and the SDK's own
    // network/console/error envelopes (string type).
    const isRrweb = typeof event.type === 'number';
    const isEnvelope = event.type === 'network' || event.type === 'console' || event.type === 'error';

    if (!isRrweb && !isEnvelope) return { error: 'unsupported event type' };
    if (isRrweb && !EVENT_TYPES.has(event.type)) return { error: 'unsupported rrweb event' };

    if (isRrweb && (typeof event.timestamp !== 'number' || !Number.isFinite(event.timestamp))) {
      return { error: 'event missing timestamp' };
    }

    if (
      isRrweb &&
      event.type === 3 &&
      isPlainObject(event.data) &&
      typeof event.data.source === 'number' &&
      !INCREMENTAL_SOURCES.has(event.data.source)
    ) {
      return { error: 'unsupported incremental source' };
    }

    const clean = scrub(event, cfg);
    if (clean === null) return { error: 'malformed event' };

    // Normalise the timestamp across both shapes.
    if (isEnvelope) {
      if (typeof clean.timestamp !== 'number' || !Number.isFinite(clean.timestamp)) {
        clean.timestamp = 0;
      }
    }
    events.push(clean);
  }

  return { events };
}

module.exports = {
  loadSecrets,
  safeEqual,
  credentialOf,
  requireCredential,
  securityHeaders,
  playerCsp,
  hostAllowlist,
  rateLimit,
  isUuid,
  isPlainObject,
  sanitizeEvents,
};
