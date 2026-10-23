// test/shots.mjs — seeds sample traces and captures UI screenshots.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] || 'http://127.0.0.1:3100';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'shots');
const SECRETS_PATH = process.argv[3] || path.join(ROOT, 'data/.secrets.json');
const secrets = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
const ingest = { 'X-DVR-Ingest': secrets.ingestKey, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

function snapshot(pathname, text, extra) {
  const now = Date.now();
  return {
    timestamp: now,
    slice: [
      { type: 4, timestamp: now, data: { href: BASE + pathname, width: 1280, height: 800 } },
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
                attributes: {},
                childNodes: [
                  {
                    type: 2,
                    tagName: 'body',
                    id: 3,
                    isSVG: false,
                    attributes: {},
                    childNodes: [
                      { type: 2, tagName: 'h1', id: 4, isSVG: false, attributes: {}, childNodes: [{ type: 3, id: 5, textContent: text, isStyle: false }] },
                      { type: 2, tagName: 'p', id: 6, isSVG: false, attributes: {}, childNodes: [{ type: 3, id: 7, textContent: 'Replayed from a recorded slice.', isStyle: false }] },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
      { type: 3, timestamp: now + 400, data: { source: 2, type: 2, id: 4, x: 40, y: 20 } },
      ...extra,
    ],
  };
}

const samples = [
  snapshot('/checkout', 'Checkout', [
    { type: 'network', method: 'POST', url: BASE + '/api/pay', status: 500, duration: 842.2, timestamp: Date.now() },
    { type: 'network', method: 'GET', url: BASE + '/api/cart', status: 200, duration: 42.1, timestamp: Date.now() + 10 },
    { type: 'console', level: 'error', message: 'Payment failed', timestamp: Date.now() + 20 },
    { type: 'error', message: 'TypeError: cart is null', filename: 'app.js', lineno: 42, colno: 7, timestamp: Date.now() + 30 },
  ]),
  snapshot('/login', 'Sign in', [
    { type: 'network', method: 'POST', url: BASE + '/api/session', status: 401, duration: 118.4, timestamp: Date.now() },
    { type: 'console', level: 'warn', message: 'Session refresh returned 401', timestamp: Date.now() + 10 },
  ]),
  snapshot('/pricing', 'Pricing', [
    { type: 'network', method: 'GET', url: BASE + '/api/plans', status: 200, duration: 65.0, timestamp: Date.now() },
    { type: 'console', level: 'log', message: 'plans loaded', timestamp: Date.now() + 10 },
  ]),
];

const seeded = [];
for (const sample of samples) {
  const res = await fetch(BASE + '/upload', { method: 'POST', headers: ingest, body: JSON.stringify(sample) });
  const body = await res.text();
  console.log('seed', res.status, body.slice(0, 120));
  if (res.status === 200) {
    try {
      seeded.push(JSON.parse(body).sliceId);
    } catch {
      /* ignore */
    }
  }
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-shots-'));
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--window-size=1440,900',
  '--remote-debugging-port=9340',
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' });

const waitFor = async (fn, ms = 20000) => {
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
    return await (await fetch('http://127.0.0.1:9340/json/version')).json();
  } catch {
    return null;
  }
});

const list = await (await fetch('http://127.0.0.1:9340/json/list')).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
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
    }, 20000);
  });

await send('Page.enable');
await send('Runtime.enable');

async function shot(name, url, { full = true, waitMs = 2600, before = null } = {}) {
  await send('Page.navigate', { url });
  await sleep(waitMs);
  if (before) {
    await send('Runtime.evaluate', { expression: before, returnByValue: true });
    await sleep(900);
  }
  const res = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
  console.log('wrote', file);
}

const token = secrets.adminToken;
const sliceId = seeded[0];
const dash = `${BASE}/#token=${encodeURIComponent(token)}`;

await shot('dashboard', dash);
await shot('recordings', dash, { before: `document.querySelector('[data-view="recordings"]').click()` });
if (sliceId) {
  await shot('replay', `${BASE}/replay/${sliceId}#token=${encodeURIComponent(token)}`, { waitMs: 4500 });
}
await shot('demo', `${BASE}/demo`);

ws.close();
chrome.kill();
await sleep(400);
fs.rmSync(profile, { recursive: true, force: true });
