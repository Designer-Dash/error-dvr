// test/security.test.mjs
// Black-box security regression tests for the hardened Error-DVR.
//
//   node test/security.test.mjs [baseUrl]
//
// Exits non-zero if any check fails.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const ORIGIN = new URL(BASE).origin;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secrets = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/.secrets.json'), 'utf8'));

const ingest = { 'X-DVR-Ingest': secrets.ingestKey };
const admin = { Authorization: `Bearer ${secrets.adminToken}` };

let pass = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  \u001b[32mPASS\u001b[0m  ${name}`);
  } else {
    failures.push(name);
    console.log(`  \u001b[31mFAIL\u001b[0m  ${name}  ${detail}`);
  }
}

function section(title) {
  console.log(`\n\u001b[36m== ${title} ==\u001b[0m`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, pathname, { headers = {}, body, contentType, retryOn429 = true } = {}) {
  for (let attempt = 0; ; attempt++) {
    const options = { method, headers: { ...headers }, redirect: 'manual' };
    if (body !== undefined) {
      options.body = body;
      options.headers['Content-Type'] = contentType || 'application/json';
    }
    const res = await fetch(BASE + pathname, options);
    const text = await res.text();

    // The limiter is shared state; back off rather than reporting a false failure.
    if (res.status === 429 && retryOn429 && attempt < 3) {
      const retryAfter = Number(res.headers.get('retry-after')) || 5;
      await sleep(Math.min(65000, retryAfter * 1000 + 250));
      continue;
    }
    return { status: res.status, headers: res.headers, text };
  }
}

/** Node's fetch forbids overriding Host, so use http.request for that one. */
function rawRequest(hostHeader) {
  return new Promise((resolve) => {
    const url = new URL(BASE + '/healthz');
    const request = http.request(
      { hostname: url.hostname, port: url.port, path: '/healthz', method: 'GET', headers: { Host: hostHeader } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    request.on('error', () => resolve(-1));
    request.end();
  });
}

const consolePayload = JSON.stringify({
  slice: [{ type: 'console', level: 'log', message: 'hello', timestamp: 1700000000000 }],
  timestamp: 1700000000000,
});

function xssPayload() {
  return JSON.stringify({
    timestamp: 1700000000000,
    slice: [
      {
        type: 2,
        timestamp: 1700000000000,
        data: {
          node: {
            type: 0,
            id: 1,
            childNodes: [
              { type: 2, tagName: 'script', id: 2, childNodes: [], isSVG: false, attributes: {} },
              {
                type: 2,
                tagName: 'img',
                id: 3,
                childNodes: [],
                isSVG: false,
                attributes: { onerror: 'alert(1)', src: 'javascript:alert(2)', onclick: 'steal()', 'data-x': 'keep' },
              },
              { type: 2, tagName: 'iframe', id: 4, childNodes: [], isSVG: false, attributes: { srcdoc: '<script>alert(3)</script>' } },
              { type: 2, tagName: 'a', id: 5, childNodes: [], isSVG: false, attributes: { href: 'javascript:alert(4)' } },
            ],
          },
          initialOffset: { top: 0, left: 0 },
        },
      },
    ],
  });
}

// ------------------------------------------------------------------ tests --

section('1. Transport & headers');
const home = await req('GET', '/');
check('dashboard served', home.status === 200, `status=${home.status}`);
const csp = home.headers.get('content-security-policy') || '';
check("CSP with default-src 'none'", csp.includes("default-src 'none'"), csp);
check("frame-ancestors 'none'", csp.includes("frame-ancestors 'none'"));
check("object-src 'none'", csp.includes("object-src 'none'"));
check('nosniff', home.headers.get('x-content-type-options') === 'nosniff');
check('no-referrer', home.headers.get('referrer-policy') === 'no-referrer');
check('X-Frame-Options DENY', home.headers.get('x-frame-options') === 'DENY');
check('X-Powered-By removed', home.headers.get('x-powered-by') === null);
check('dashboard no-store', (home.headers.get('cache-control') || '').includes('no-store'));

const player = await req('GET', '/player.html');
const playerCsp = player.headers.get('content-security-policy') || '';
check('player CSP uses explicit origins (opaque-origin safe)', playerCsp.includes(ORIGIN) && !/script-src 'self'/.test(playerCsp), playerCsp);
check('player not frameable by wildcard', !playerCsp.includes('frame-ancestors *'), playerCsp);
check('player cannot connect out', playerCsp.includes("connect-src 'none'"));
check('player frame-scoped to own origins', playerCsp.includes('frame-ancestors ' + ORIGIN));
check('vendor assets marked cross-origin for the sandbox frame', ((await req('GET', '/vendor/rrweb.js')).headers.get('cross-origin-resource-policy') || '') === 'cross-origin');

section('2. DNS-rebinding / host allow-list');
check('foreign Host header rejected (421)', (await rawRequest('evil.example.com')) === 421);
check('allow-listed Host accepted', (await rawRequest('localhost:3000')) === 200);

section('3. Upload authentication');
check('unauthenticated upload rejected', (await req('POST', '/upload', { body: consolePayload })).status === 401);
check('bad ingest key rejected', (await req('POST', '/upload', { body: consolePayload, headers: { 'X-DVR-Ingest': 'wrong' } })).status === 401);
check('admin token cannot ingest (key separation)', (await req('POST', '/upload', { body: consolePayload, headers: admin })).status === 401);

section('4. Upload validation & sanitisation');
const up = await req('POST', '/upload', { body: xssPayload(), headers: ingest });
check('deliberately malicious slice stored', up.status === 200, `status=${up.status} ${up.text.slice(0, 120)}`);

check('unknown event type rejected', (await req('POST', '/upload', { body: '{"slice":[{"type":999,"timestamp":1}],"timestamp":1}', headers: ingest })).status === 400);
check('empty slice rejected', (await req('POST', '/upload', { body: '{"slice":[],"timestamp":1}', headers: ingest })).status === 400);
check('non-array slice rejected', (await req('POST', '/upload', { body: '{"slice":"x","timestamp":1}', headers: ingest })).status === 400);
check('missing slice rejected', (await req('POST', '/upload', { body: '{"oops":true}', headers: ingest })).status === 400);
check('malformed JSON rejected', (await req('POST', '/upload', { body: '{not json', headers: ingest })).status === 400);

const bigEvents = Array.from({ length: 2000 }, () => ({
  type: 'console',
  level: 'log',
  message: 'A'.repeat(1000),
  timestamp: 1,
}));
check(
  'oversized body rejected (413)',
  (await req('POST', '/upload', { body: JSON.stringify({ slice: bigEvents, timestamp: 1 }), headers: ingest })).status === 413
);

const tooMany = Array.from({ length: 6000 }, () => ({ type: 'console', level: 'log', message: 'x', timestamp: 1 }));
check('too many events rejected', (await req('POST', '/upload', { body: JSON.stringify({ slice: tooMany, timestamp: 1 }), headers: ingest })).status === 400);

section('5. Read authorisation & IDOR');
const upJson = JSON.parse(up.text);
const sliceId = upJson.sliceId;
check('server-generated UUID id', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sliceId || ''), sliceId);
check('replay URL returned', upJson.replayUrl === `/replay/${sliceId}`);
check('severity summarised on upload', ['critical', 'warning', 'info'].includes(upJson.severity), upJson.severity);

check('read without token rejected', (await req('GET', `/api/slice/${sliceId}`)).status === 401);
check('ingest key cannot read', (await req('GET', `/api/slice/${sliceId}`, { headers: ingest })).status === 401);

const read = await req('GET', `/api/slice/${sliceId}`, { headers: admin });
check('admin token can read', read.status === 200, `status=${read.status}`);
const readJson = JSON.parse(read.text);
check('integrity verified ok', readJson.integrity === 'ok', readJson.integrity);
check('slice response no-store', (read.headers.get('cache-control') || '').includes('no-store'));
check('summary attached to slice', Boolean(readJson.summary && readJson.summary.severity), JSON.stringify(readJson.summary));

// The dashboard list endpoint is metadata-only and equally protected.
check('listing without token rejected', (await req('GET', '/api/slices')).status === 401);
check('listing rejects the ingest key', (await req('GET', '/api/slices', { headers: ingest })).status === 401);
const list = await req('GET', '/api/slices?limit=5', { headers: admin });
check('listing works with the admin token', list.status === 200, `status=${list.status}`);
const listJson = JSON.parse(list.text);
check('listing is capped by limit', Array.isArray(listJson.slices) && listJson.slices.length <= 5, String(listJson.slices?.length));
check('listing never returns payloads', !list.text.includes('"slice"') && !list.text.includes('childNodes'));
check('listing reports a total', typeof listJson.total === 'number');

section('6. Stored-XSS sanitisation of persisted data');
const stored = read.text;
check('javascript: URL stripped', !stored.includes('javascript:alert'));
check('onerror stripped', !/onerror/i.test(stored));
check('onclick stripped', !/onclick/i.test(stored));
check('srcdoc stripped', !stored.includes('srcdoc'));
check('script element dropped', !stored.includes('"tagName":"script"'));
check('iframe element dropped', !stored.includes('"tagName":"iframe"'));
check('benign attribute preserved', stored.includes('"data-x":"keep"'));

check('invalid slice id rejected', (await req('GET', '/api/slice/not-a-uuid', { headers: admin })).status === 400);
check('unknown slice 404', (await req('GET', '/api/slice/00000000-0000-4000-8000-000000000000', { headers: admin })).status === 404);
check('invalid replay id rejected', (await req('GET', '/replay/12345')).status === 400);
check('valid replay page served', (await req('GET', `/replay/${sliceId}`)).status === 200);

section('7. Path traversal / static exposure');
const traversals = [
  '/public/../src/config.json',
  '/public/..%2f..%2fsrc/config.json',
  '/public/%2e%2e/%2e%2e/.secrets.json',
  '/public/%2e%2e%2f%2e%2e%2fdata%2f.secrets.json',
  '/data/.secrets.json',
  '/src/config.json',
  '/package.json',
  '/.secrets.json',
  '/app.html',
];
for (const p of traversals) {
  const r = await req('GET', p);
  check(`blocked: ${p}`, r.status >= 400, `status=${r.status}`);
}

section('8. Rate limiting');
let limited = false;
for (let i = 0; i < 45; i++) {
  const r = await req('POST', '/upload', { body: '{"slice":[],"timestamp":1}', headers: ingest, retryOn429: false });
  if (r.status === 429) {
    limited = true;
    break;
  }
}
check('upload flood rate-limited (429)', limited);

section('9. Secret handling');
const secretFile = path.join(ROOT, 'data/.secrets.json');
check('secrets file exists', fs.statSync(secretFile).isFile());
check('ingest key differs from admin token', secrets.ingestKey !== secrets.adminToken);
check('keys have >= 256-bit entropy', secrets.ingestKey.length >= 32 && secrets.adminToken.length >= 32);

section('10. UI wiring');
const replayPath = '/replay/' + sliceId;
const PAGES = ['/', '/demo', replayPath, '/player.html'];

// Inline scripts would be blocked by our own CSP, so none may remain.
for (const page of PAGES) {
  const html = (await req('GET', page)).text;
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].filter(
    (m) => m[1].trim() !== ''
  );
  check(`no inline scripts on ${page}`, inline.length === 0, `found ${inline.length}`);
}

// Every local asset referenced must resolve, or the UI silently breaks.
for (const page of PAGES) {
  const html = (await req('GET', page)).text;
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((ref) => ref.startsWith('/') && !ref.startsWith('//'));
  const broken = [];
  for (const ref of new Set(refs)) {
    const r = await req('GET', ref);
    if (r.status !== 200) broken.push(`${ref} (${r.status})`);
  }
  check(`all assets on ${page} resolve`, broken.length === 0, broken.join(', '));
}

const demoHtml = (await req('GET', '/demo')).text;
check('demo loads the SDK and bootstrap', demoHtml.includes('/sdk.js') && demoHtml.includes('/config.js'));
const cfgJs = await req('GET', '/config.js');
check('config carries the ingest key, not the admin token', cfgJs.text.includes('ingestKey') && !cfgJs.text.includes('adminToken'));
check('config.js is not cached', (cfgJs.headers.get('cache-control') || '').includes('no-store'));

for (const asset of ['/player.js', '/vendor/rrweb.js', '/vendor/rrweb-player.js', '/vendor/rrweb-player.css']) {
  const r = await req('GET', asset);
  check(`CORP permits opaque-origin frame: ${asset}`, (r.headers.get('cross-origin-resource-policy') || '') === 'cross-origin', r.headers.get('cross-origin-resource-policy') || 'missing');
}

const replayHtml = (await req('GET', replayPath)).text;
check('replay page sandboxes the player frame', replayHtml.includes('sandbox="allow-scripts allow-same-origin"'));
check('replay page has no CDN references', !replayHtml.includes('jsdelivr'));
const replayJs = (await req('GET', '/replay.js')).text;
check('player is loaded from a separate origin', replayJs.includes('localhost') && replayJs.includes('/player.html'));

const dashboardHtml = (await req('GET', '/')).text;
check('dashboard never embeds a token', !dashboardHtml.includes(secrets.adminToken) && !dashboardHtml.includes(secrets.ingestKey));

// ----------------------------------------------------------------- summary --

console.log('\n' + '='.repeat(52));
if (failures.length === 0) {
  console.log(`  \u001b[32mALL CHECKS PASSED: ${pass}\u001b[0m`);
} else {
  console.log(`  \u001b[31m${failures.length} FAILED\u001b[0m, ${pass} passed`);
  for (const f of failures) console.log(`   - ${f}`);
}
console.log('='.repeat(52));

process.exit(failures.length === 0 ? 0 : 1);
