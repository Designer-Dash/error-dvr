// test/shots-live.mjs — records a real session through the demo page, then
// screenshots the dashboard and the replay of that recording.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] || 'http://127.0.0.1:3100';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'shots');
const SECRETS = process.argv[3] || path.join(ROOT, 'data/.secrets.json');
const secrets = JSON.parse(fs.readFileSync(SECRETS, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-live-'));
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  '--force-device-scale-factor=1', '--window-size=1440,900',
  '--remote-debugging-port=9341', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

const waitFor = async (fn, ms = 20000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(150); }
  return null;
};

await waitFor(async () => {
  try { return await (await fetch('http://127.0.0.1:9341/json/version')).json(); } catch { return null; }
});

const list = await (await fetch('http://127.0.0.1:9341/json/list')).json();
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
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 20000);
  });

await send('Page.enable');
await send('Runtime.enable');
await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

async function shot(name, { full = true } = {}) {
  const res = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
  console.log('wrote', file);
}

// 1. Record a real session on the demo page.
await send('Page.navigate', { url: `${BASE}/demo` });
await sleep(3200);
await send('Runtime.evaluate', { expression: `document.getElementById('crashBtn').click()`, returnByValue: true });
await sleep(4000);
await shot('demo');

// 2. Find the newest slice.
const res = await fetch(`${BASE}/api/slices?limit=1`, { headers: { Authorization: `Bearer ${secrets.adminToken}` } });
const data = await res.json();
const sliceId = data.slices && data.slices[0] && data.slices[0].id;
console.log('newest slice:', sliceId, 'severity:', data.slices && data.slices[0] && data.slices[0].summary.severity);

// 3. Dashboard.
await send('Page.navigate', { url: `${BASE}/#token=${encodeURIComponent(secrets.adminToken)}` });
await sleep(2800);
await shot('dashboard');
await send('Runtime.evaluate', { expression: `document.querySelector('[data-view="recordings"]').click()`, returnByValue: true });
await sleep(900);
await shot('recordings');

// 4. Replay of the real recording.
if (sliceId) {
  await send('Page.navigate', { url: `${BASE}/replay/${sliceId}#token=${encodeURIComponent(secrets.adminToken)}` });
  await sleep(5200);
  await shot('replay', { full: false });

  const state = await send('Runtime.evaluate', {
    expression: `(() => ({
      timecode: document.getElementById('timecode').textContent,
      pin: document.getElementById('tlPin').hidden,
      cover: document.getElementById('cover').hidden,
      status: document.getElementById('status').textContent,
    }))()`,
    returnByValue: true,
  });
  console.log('replay state:', JSON.stringify(state.result.value));
}

ws.close();
chrome.kill();
await sleep(400);
fs.rmSync(profile, { recursive: true, force: true });
