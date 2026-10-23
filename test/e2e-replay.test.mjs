// test/e2e-replay.test.mjs
// End-to-end browser test: records a slice through the API, then exercises the
// replay page, the demo recorder and the dashboard in headless Chrome.
//
// The player is a sandboxed iframe, which Chrome renders as an out-of-process
// iframe (OOPIF); it does not appear in Page.getFrameTree, so we attach to it
// as a separate target.
//
//   node test/e2e-replay.test.mjs [baseUrl] [chromePath]
//
// Reports SKIP (exit 0) when no headless browser can start.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const CHROME = process.argv[3] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secrets = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/.secrets.json'), 'utf8'));

const ingest = { 'X-DVR-Ingest': secrets.ingestKey };
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

// ---------------------------------------------------------------- payload --

function buildSlice() {
  const now = Date.now();
  return {
    timestamp: now,
    slice: [
      { type: 4, timestamp: now, data: { href: BASE + '/checkout', width: 1280, height: 800 } },
      {
        type: 2,
        timestamp: now + 1,
        data: {
          initialOffset: { top: 0, left: 0 },
          node: {
            type: 0,
            id: 1,
            childNodes: [
              {
                type: 2,
                tagName: 'html',
                id: 2,
                isSVG: false,
                attributes: { lang: 'en' },
                childNodes: [
                  { type: 2, tagName: 'head', id: 3, isSVG: false, attributes: {}, childNodes: [] },
                  {
                    type: 2,
                    tagName: 'body',
                    id: 4,
                    isSVG: false,
                    attributes: {},
                    childNodes: [
                      {
                        type: 2,
                        tagName: 'h1',
                        id: 5,
                        isSVG: false,
                        attributes: {},
                        childNodes: [{ type: 3, id: 6, textContent: 'Checkout', isStyle: false }],
                      },
                      {
                        type: 2,
                        tagName: 'img',
                        id: 7,
                        isSVG: false,
                        attributes: { src: 'x', onerror: 'window.top.__pwned=1' },
                        childNodes: [],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
      { type: 3, timestamp: now + 2, data: { source: 2, type: 2, id: 5, x: 10, y: 10 } },
      { type: 'network', method: 'POST', url: BASE + '/api/pay', status: 500, duration: 12.5, timestamp: now + 3 },
      { type: 'console', level: 'error', message: 'Payment failed', timestamp: now + 4 },
      { type: 'error', message: 'TypeError: cart is null', filename: 'app.js', lineno: 42, colno: 7, timestamp: now + 5 },
    ],
  };
}

// ------------------------------------------------------------------- CDP --

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(`${msg.sessionId || ''}:${msg.id}`)) {
        const key = `${msg.sessionId || ''}:${msg.id}`;
        const { resolve, reject } = this.pending.get(key);
        this.pending.delete(key);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const key = `${sessionId || ''}:${id}`;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    this.ws.send(JSON.stringify(message));
    return new Promise((resolve, reject) => {
      this.pending.set(key, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(key)) {
          this.pending.delete(key);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 15000);
    });
  }
}

async function waitFor(fn, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await sleep(150);
  }
  return null;
}

// ------------------------------------------------------------------ upload --

const slice = buildSlice();
let upload;
let uploadText;
for (let attempt = 0; attempt < 4; attempt++) {
  upload = await fetch(BASE + '/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ingest },
    body: JSON.stringify(slice),
  });
  uploadText = await upload.text();
  if (upload.status !== 429) break;
  const retryAfter = Number(upload.headers.get('retry-after')) || 5;
  console.log(`\n  rate limited; waiting ${retryAfter}s`);
  await sleep(Math.min(65000, retryAfter * 1000 + 250));
}
if (!upload.ok) {
  console.error(`\n  upload failed (HTTP ${upload.status}): ${uploadText.slice(0, 200)}`);
  process.exit(1);
}
const uploadJson = JSON.parse(uploadText);
console.log(`\n  uploaded slice ${uploadJson.sliceId} (${uploadJson.eventCount} events)`);

// ------------------------------------------------------------------ chrome --

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-chrome-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--remote-debugging-port=9333',
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' }
);

let skipped = false;

try {
  const version = await waitFor(async () => {
    try {
      return await (await fetch('http://127.0.0.1:9333/json/version')).json();
    } catch {
      return null;
    }
  });

  if (!version) {
    console.log('\n  \u001b[33mSKIP\u001b[0m  headless browser could not start in this environment.');
    skipped = true;
    throw new Error('__skip__');
  }
  check('headless Chrome started', true);

  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const cdp = new CDP(ws);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');
  // The sandboxed player is a separate target; attach to it automatically.
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

  const mainEval = async (expression) => {
    const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
    if (res.exceptionDetails) return { __error: res.exceptionDetails.text };
    return res.result.value;
  };

  // ------------------------------------------------------------- replay ----
  console.log('\n\u001b[36m== Replay page ==\u001b[0m');

  const replayUrl = `${BASE}/replay/${uploadJson.sliceId}#token=${encodeURIComponent(secrets.adminToken)}`;
  await cdp.send('Page.navigate', { url: replayUrl });

  const iframeTarget = await waitFor(async () => {
    const ev = cdp.events.find(
      (e) => e.method === 'Target.attachedToTarget' && e.params.targetInfo.type === 'iframe'
    );
    return ev ? ev.params : null;
  });
  check('player iframe is process-isolated (separate target)', Boolean(iframeTarget));

  await sleep(3000);

  const status = await mainEval(`document.getElementById('status').textContent`);
  check('replay status reports DOM events', /DOM events/.test(String(status)), String(status));
  check('no fatal error state', !/Could not load|Admin token required/.test(String(status)), String(status));

  const warnDisplay = await mainEval(`getComputedStyle(document.getElementById('warning')).display`);
  check('integrity warning hidden for intact slice', warnDisplay === 'none', String(warnDisplay));

  const netText = await mainEval(`document.getElementById('networkLog').textContent`);
  check('network tab rendered', /POST/.test(String(netText)) && /500/.test(String(netText)), String(netText).slice(0, 120));

  const consText = await mainEval(`document.getElementById('consoleLog').textContent`);
  check('console tab rendered', /Payment failed/.test(String(consText)), String(consText).slice(0, 120));

  const errLine = await mainEval(`document.getElementById('errLine').textContent`);
  check('error summary shows the thrown error', /TypeError/.test(String(errLine)), String(errLine));

  const explainCount = await mainEval(`document.querySelectorAll('#explain .explain-item').length`);
  check('plain-English explanation rendered', Number(explainCount) >= 3, String(explainCount));

  const sevChip = await mainEval(`document.getElementById('sevChip').textContent`);
  check('severity chip reads Critical', /Critical/i.test(String(sevChip)), String(sevChip));

  const href = await mainEval('location.href');
  check('admin token stripped from address bar', !String(href).includes(secrets.adminToken), String(href));

  const frameInfo = await mainEval(
    `(() => { const f = document.getElementById('playerFrame');
       return { present: Boolean(f), sandbox: f && f.getAttribute('sandbox'),
                isolated: (() => { try { return f.contentDocument === null; } catch (e) { return true; } })() }; })()`
  );
  check('iframe present with sandbox flags', frameInfo?.present === true && String(frameInfo?.sandbox).includes('allow-scripts'), JSON.stringify(frameInfo));
  check('parent cannot access iframe document', frameInfo?.isolated === true);

  const coverHidden = await mainEval(`document.getElementById('cover').hidden`);
  check('replay canvas uncovered once ready', coverHidden === true, String(coverHidden));

  const pin = await mainEval(
    `(() => { const p = document.getElementById('tlPin'); return { hidden: p.hidden, left: p.style.left }; })()`
  );
  check('error pin placed on the timeline', pin?.hidden === false && String(pin.left).includes('%'), JSON.stringify(pin));

  if (iframeTarget?.sessionId) {
    const session = iframeTarget.sessionId;
    const frameEval = async (expression) => {
      const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, session);
      if (res.exceptionDetails) return { __error: res.exceptionDetails.text };
      return res.result.value;
    };

    const origin = await frameEval('self.origin');
    const parentOrigin = new URL(BASE).origin;
    check('player runs on a separate loopback origin', origin !== parentOrigin && /^https?:\/\//.test(String(origin)), String(origin));

    const parentAccess = await frameEval(
      `(() => { try { return window.parent.document ? 'accessible' : 'blocked'; } catch (e) { return 'blocked'; } })()`
    );
    check('iframe cannot read parent DOM', parentAccess === 'blocked', String(parentAccess));

    const tokenLeak = await frameEval(
      `(() => { try { return localStorage.getItem('dvr-token') === null && sessionStorage.getItem('dvr-token') === null ? 'clean' : 'leak'; } catch (e) { return 'blocked'; } })()`
    );
    check('player origin holds no admin token', tokenLeak === 'clean' || tokenLeak === 'blocked', String(tokenLeak));

    const mount = await frameEval(
      `(() => {
         const wrapper = document.querySelector('.replayer-wrapper');
         const frame = document.querySelector('iframe');
         let text = '';
         let nested = false;
         try {
           if (frame && frame.contentDocument && frame.contentDocument.body) {
             nested = true;
             text = frame.contentDocument.body.innerText.slice(0, 120);
           }
         } catch (e) { /* cross-origin */ }
         return {
           wrapper: Boolean(wrapper),
           iframes: document.querySelectorAll('iframe').length,
           frameWidth: frame ? Math.round(frame.getBoundingClientRect().width) : 0,
           nested: nested,
           text: text,
         };
       })()`
    );
    check('rrweb player mounted', mount?.wrapper === true && mount?.iframes === 1, JSON.stringify(mount));
    check('replay frame is laid out', mount?.frameWidth > 0, JSON.stringify(mount));
    check('recorded DOM rebuilt into the replay frame', /Checkout/.test(String(mount?.text)), JSON.stringify(mount));

    const pwned = await frameEval('String(window.__pwned)');
    check('injected onerror did not execute', pwned !== '1', pwned);
  }

  const securityEntries = cdp.events
    .filter((e) => e.method === 'Log.entryAdded')
    .map((e) => e.params.entry)
    .filter((e) => e.source === 'security');
  const cspViolations = securityEntries.filter((e) => /Content Security Policy/i.test(e.text));
  check('no CSP violations on replay page', cspViolations.length === 0, cspViolations.map((v) => v.text).join(' | '));

  const exceptions = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
  check('no uncaught exceptions on replay page', exceptions.length === 0, JSON.stringify(exceptions).slice(0, 300));

  // ----------------------------------------------------------- dashboard ----
  console.log('\n\u001b[36m== Dashboard ==\u001b[0m');
  cdp.events.length = 0;

  await cdp.send('Page.navigate', { url: `${BASE}/#token=${encodeURIComponent(secrets.adminToken)}` });
  await sleep(2500);

  const dash = await mainEval(`(() => ({
    appVisible: !document.getElementById('app').hidden,
    lockHidden: document.getElementById('lock').hidden,
    traces: document.querySelectorAll('#recent .trace').length,
    sessions: document.getElementById('kpiSessions').textContent,
    critical: document.getElementById('kpiCritical').textContent,
    bars: document.querySelectorAll('#chart .bar').length,
    hash: location.hash,
    title: document.getElementById('greetingTitle').textContent,
  }))()`);

  check('dashboard unlocks with the token', dash?.appVisible === true && dash?.lockHidden === true, JSON.stringify(dash));
  check('recent traces rendered', Number(dash?.traces) > 0, JSON.stringify(dash?.traces));
  check('session KPI populated', Number(dash?.sessions) > 0, String(dash?.sessions));
  check('24-hour chart rendered', Number(dash?.bars) === 24, String(dash?.bars));
  check('token removed from the URL', !String(dash?.hash || '').includes('token'), String(dash?.hash));
  check('greeting rendered', /Good (morning|afternoon|evening)/.test(String(dash?.title)), String(dash?.title));

  // Drawer opens from a trace card.
  await mainEval(`document.querySelector('#recent .trace').click()`);
  await sleep(500);
  const drawer = await mainEval(`(() => ({
    open: !document.getElementById('drawer').hidden && document.getElementById('drawer').classList.contains('show'),
    title: document.getElementById('drawerTitle').textContent,
    hasOpen: Boolean(document.getElementById('drawerOpen')),
  }))()`);
  check('detail drawer opens', drawer?.open === true, JSON.stringify(drawer));
  check('drawer offers the replay action', drawer?.hasOpen === true);

  // ------------------------------------------------------------ recorder ---
  console.log('\n\u001b[36m== Recorder (demo page) ==\u001b[0m');
  cdp.events.length = 0;

  await cdp.send('Page.navigate', { url: `${BASE}/demo` });
  await sleep(2500);

  const bootstrapped = await mainEval(`typeof window.__DVR__ === 'object' && Boolean(window.__DVR__.ingestKey)`);
  check('demo page bootstraps the SDK', bootstrapped === true);

  const sdkWarnings = cdp.events
    .filter((e) => e.method === 'Runtime.consoleAPICalled')
    .flatMap((e) => e.params.args.map((a) => a.value))
    .filter((v) => typeof v === 'string' && v.includes('[dvr]'));
  check('SDK reports no configuration problems', sdkWarnings.length === 0, sdkWarnings.join(' | '));

  const armed = await mainEval(`document.getElementById('recLabel').textContent`);
  check('recorder reports armed', /armed/i.test(String(armed)), String(armed));

  await mainEval(`document.getElementById('crashBtn').click()`);
  await sleep(4500);

  const uploadRequest = cdp.events.find(
    (e) => e.method === 'Network.requestWillBeSent' && e.params.request.method === 'POST' && e.params.request.url.endsWith('/upload')
  );
  check('crashing the page triggers a slice upload', Boolean(uploadRequest));

  const uploadResponse = cdp.events.find(
    (e) => e.method === 'Network.responseReceived' && e.params.response.url.endsWith('/upload')
  );
  check('slice upload accepted', uploadResponse && uploadResponse.params.response.status === 200, uploadResponse ? String(uploadResponse.params.response.status) : 'no response');

  const resultCard = await mainEval(`document.querySelectorAll('#out .result').length`);
  check('result card rendered after upload', Number(resultCard) === 1, String(resultCard));

  ws.close();
} catch (error) {
  if (error.message !== '__skip__') throw error;
} finally {
  try {
    chrome.kill();
  } catch {
    /* ignore */
  }
  await sleep(400);
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log('\n' + '='.repeat(52));
if (skipped) {
  console.log('  \u001b[33mE2E SKIPPED\u001b[0m (no usable headless browser)');
} else if (failures.length === 0) {
  console.log(`  \u001b[32mALL E2E CHECKS PASSED: ${pass}\u001b[0m`);
} else {
  console.log(`  \u001b[31m${failures.length} FAILED\u001b[0m, ${pass} passed`);
  for (const f of failures) console.log(`   - ${f}`);
}
console.log('='.repeat(52));
process.exit(skipped || failures.length === 0 ? 0 : 1);
