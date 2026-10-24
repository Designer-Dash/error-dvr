// test/detect.test.mjs
// Proves Error-DVR detects failures that occur naturally in an app — not just
// the demo button. Serves small fixture pages from a separate origin (exactly
// how the snippet is used on a real site) and checks what gets captured.
//
//   node test/detect.test.mjs
//
// Fixtures load only sdk.js, so this also proves the SDK fetches the rrweb
// runtime by itself and still produces a replayable (DOM-bearing) trace.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'error-dvr.js');
const CHROME = process.env.DVR_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-detect-'));
const dataDir = path.join(tmp, 'data');
const port = 4300 + Math.floor(Math.random() * 300);
const fixturePort = port + 1;
const base = `http://127.0.0.1:${port}`;

function page(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body>
<h1>${title}</h1><p>Fixture page for detection tests.</p>
<script>window.__DVR__ = { uploadUrl: ${JSON.stringify(base + '/upload')}, ingestKey: ${JSON.stringify(
    global.INGEST
  )}, sliceLengthSec: 15, privacyMasking: true };</script>
<script src=${JSON.stringify(base + '/sdk.js')}></script>
${body}
</body></html>`;
}

let server;
let chrome;
let fixtures;

try {
  // ---------------------------------------------------------- tool server --
  server = spawn(process.execPath, [BIN, '--port', String(port), '--data-dir', dataDir], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let boot = '';
  server.stdout.on('data', (d) => (boot += d));
  server.stderr.on('data', (d) => (boot += d));

  const up = await (async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(base + '/healthz');
        if (r.ok) return true;
      } catch {
        /* not yet */
      }
      await sleep(250);
    }
    return false;
  })();
  check('tool starts', up, boot.slice(0, 200));

  if (!up) throw new Error('server did not start');

  const secrets = JSON.parse(fs.readFileSync(path.join(dataDir, '.secrets.json'), 'utf8'));
  global.INGEST = secrets.ingestKey;
  const auth = { 'X-DVR-Token': secrets.adminToken };

  const total = async () => {
    const r = await fetch(base + '/api/slices?limit=100', { headers: auth });
    const j = await r.json();
    return j.total;
  };

  // ------------------------------------------------------- fixture site ---
  const pages = {
    '/broken.html': page(
      'Checkout',
      `<script>
        // Ordinary application code: read a value that is not there yet.
        setTimeout(function () {
          var cart = window.__cart;   // undefined on a cold load
          cart.total;                 // TypeError, no demo button involved
        }, 250);
      </script>`
    ),
    '/reject.html': page(
      'Payment',
      `<script>
        setTimeout(function () {
          // A promise nobody catches — how most real async failures surface.
          Promise.reject(new Error('payment gateway timeout'));
        }, 250);
      </script>`
    ),
    '/clean.html': page(
      'Pricing',
      `<script>setTimeout(function () { document.title = 'Pricing loaded'; }, 200);</script>`
    ),
  };

  fixtures = http.createServer((req, res) => {
    const html = pages[req.url];
    if (!html) {
      res.writeHead(404).end('no');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
  });
  await new Promise((r) => fixtures.listen(fixturePort, '127.0.0.1', r));

  // ------------------------------------------------------------- browser --
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-detect-chrome-'));
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=9360', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });

  const waitFor = async (fn, ms = 15000) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      const v = await fn();
      if (v) return v;
      await sleep(150);
    }
    return null;
  };
  await waitFor(async () => {
    try {
      return await (await fetch('http://127.0.0.1:9360/json/version')).json();
    } catch {
      return null;
    }
  });

  const list = await (await fetch('http://127.0.0.1:9360/json/list')).json();
  const target = list.find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      return;
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(
        'console: ' +
          m.params.args
            .map((a) => (a.value !== undefined ? a.value : a.description || a.type))
            .join(' ')
      );
    }
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    }
    if (m.method === 'Network.loadingFailed') {
      logs.push(`net-fail: ${m.params.errorText} type=${m.params.type} cors=${JSON.stringify(m.params.corsErrorStatus || null)}`);
    }
    if (m.method === 'Network.responseReceived' && /upload|rrweb/.test(m.params.response.url)) {
      logs.push(`net-ok: ${m.params.response.status} ${m.params.response.url}`);
    }
    if (m.method === 'Network.requestWillBeSent' && /upload/.test(m.params.request.url)) {
      logs.push(`net-req: ${m.params.request.method} ${m.params.request.url}`);
    }
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
      setTimeout(() => {
        if (pending.has(i)) {
          pending.delete(i);
          rej(new Error('timeout ' + method));
        }
      }, 15000);
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');

  const visit = async (pathname, wait = 3200) => {
    await send('Page.navigate', { url: `http://127.0.0.1:${fixturePort}${pathname}` });
    await sleep(wait);
  };

  console.log('\n\u001b[36m== detection ==\u001b[0m');

  const before = await total();
  check('starts with no traces', before === 0, String(before));

  await visit('/broken.html');
  const afterBroken = await total();
  check('uncaught TypeError is captured', afterBroken === before + 1, `${before} -> ${afterBroken}`);

  await visit('/reject.html');
  const afterReject = await total();
  check('unhandled rejection is captured', afterReject === afterBroken + 1, `${afterBroken} -> ${afterReject}`);

  await visit('/clean.html', 3600);
  const afterClean = await total();
  check('a healthy page creates no trace', afterClean === afterReject, `${afterReject} -> ${afterClean}`);

  console.log('\n\u001b[36m== trace contents ==\u001b[0m');

  const listRes = await (await fetch(base + '/api/slices?limit=10', { headers: auth })).json();
  const traces = listRes.slices;

  const rejectTrace = traces.find((t) => /timeout/i.test(JSON.stringify(t.summary)));
  const typeTrace = traces.find((t) => /Cannot read properties/i.test(JSON.stringify(t.summary)));

  check('rejection trace has the right message', Boolean(rejectTrace), JSON.stringify(traces.map((t) => t.summary.firstError?.message)));
  check('type error trace has the right message', Boolean(typeTrace));

  if (typeTrace) {
    check('trace is severity critical', typeTrace.summary.severity === 'critical', typeTrace.summary.severity);
    check('error attributed to the fixture page', /Broken/i.test(typeTrace.summary.pageLabel || '') && /broken\.html/.test(typeTrace.summary.path || ''), `${typeTrace.summary.pageLabel} ${typeTrace.summary.path}`);
    check('stack points at the fixture file', /broken\.html|fixturePort|:5:/.test(JSON.stringify(typeTrace.summary.firstError)), JSON.stringify(typeTrace.summary.firstError).slice(0, 160));

    const detail = await (await fetch(base + '/api/slice/' + typeTrace.id, { headers: auth })).json();
    const domEvents = (detail.slice || []).filter((e) => typeof e.type === 'number');
    check('slice contains DOM events (rrweb auto-loaded)', domEvents.length > 0, `${domEvents.length} dom events`);
    check('slice contains a full snapshot', domEvents.some((e) => e.type === 2));
    check('replay would have content', domEvents.some((e) => e.type === 2 && JSON.stringify(e).length > 200));
  }

  ws.close();
  console.log('\n  browser diagnostics:');
  if (logs.length === 0) console.log('    (none)');
  for (const line of logs.slice(0, 20)) console.log('    ' + line);
} finally {
  if (chrome) chrome.kill();
  if (fixtures) fixtures.close();
  if (server) server.kill();
  await sleep(400);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log('\n' + '='.repeat(52));
if (failures.length === 0) {
  console.log(`  \u001b[32mALL DETECTION CHECKS PASSED: ${pass}\u001b[0m`);
} else {
  console.log(`  \u001b[31m${failures.length} FAILED\u001b[0m, ${pass} passed`);
  for (const f of failures) console.log(`   - ${f}`);
}
console.log('='.repeat(52));
process.exit(failures.length === 0 ? 0 : 1);
