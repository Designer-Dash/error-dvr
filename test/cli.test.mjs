// test/cli.test.mjs
// Smoke tests for the command line tool: help, version, server start, the
// token/snippet/rotate commands, and the write-only CORS policy.
//
//   node test/cli.test.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'error-dvr.js');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

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

function run(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: options.cwd || ROOT,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (options.timeout) {
      setTimeout(() => child.kill(), options.timeout);
    }
  });
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-cli-'));
const dataDir = path.join(tmpRoot, 'data');
const port = 4100 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${port}`;

let server;

try {
  console.log('\n\u001b[36m== CLI basics ==\u001b[0m');

  const version = await run(['--version'], { timeout: 15000 });
  check('--version prints the package version', version.stdout.trim() === pkg.version, version.stdout.trim());

  const help = await run(['--help'], { timeout: 15000 });
  check('--help exits 0', help.code === 0, String(help.code));
  check('--help documents the commands', /Usage/.test(help.stdout) && /snippet/.test(help.stdout));
  check('--help documents the port option', /--port/.test(help.stdout));

  const unknown = await run(['nonsense'], { timeout: 15000 });
  check('unknown command fails with a message', unknown.code !== 0 && /unknown command/i.test(unknown.stderr));

  console.log('\n\u001b[36m== server start ==\u001b[0m');

  server = spawn(process.execPath, [BIN, '--port', String(port), '--data-dir', dataDir], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOut = '';
  server.stdout.on('data', (d) => (serverOut += d));
  server.stderr.on('data', (d) => (serverOut += d));

  const ready = await (async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(base + '/healthz');
        if (res.ok) return true;
      } catch {
        /* not up yet */
      }
      await sleep(250);
    }
    return false;
  })();

  check('server comes up', ready, serverOut.slice(0, 300));
  check('startup banner shows the dashboard URL', serverOut.includes(base), serverOut.slice(0, 200));
  check('startup prints an admin token', /admin token/i.test(serverOut));
  check('data directory created', fs.existsSync(path.join(dataDir, '.secrets.json')));

  const home = await fetch(base + '/');
  check('dashboard served', home.status === 200);
  const demo = await fetch(base + '/demo');
  check('demo page served', demo.status === 200);
  const sdk = await fetch(base + '/sdk.js');
  check('sdk served to third-party pages', sdk.status === 200);

  if (ready) {
    console.log('\n\u001b[36m== cross-origin ingest (the snippet path) ==\u001b[0m');

    const secrets = JSON.parse(fs.readFileSync(path.join(dataDir, '.secrets.json'), 'utf8'));
    const origin = 'https://app.example.test';

    const preflight = await fetch(base + '/upload', {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-dvr-ingest',
      },
    });
    check('preflight accepted', preflight.status === 204, String(preflight.status));
    check('preflight allows any origin', preflight.headers.get('access-control-allow-origin') === '*');
    check(
      'preflight allows the ingest header',
      (preflight.headers.get('access-control-allow-headers') || '').toLowerCase().includes('x-dvr-ingest')
    );

    const body = JSON.stringify({
      slice: [
        { type: 'console', level: 'error', message: 'boom from another site', timestamp: Date.now() },
      ],
      timestamp: Date.now(),
    });

    const upload = await fetch(base + '/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, 'X-DVR-Ingest': secrets.ingestKey },
      body,
    });
    const uploadJson = await upload.json();
    check('cross-origin upload accepted', upload.status === 200, `${upload.status} ${JSON.stringify(uploadJson)}`);
    check('upload response allows the origin', upload.headers.get('access-control-allow-origin') === '*');
    check('upload returns a slice id', typeof uploadJson.sliceId === 'string');

    const noKey = await fetch(base + '/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body,
    });
    check('cross-origin upload without a key is rejected', noKey.status === 401, String(noKey.status));

    // Reads must never be readable cross-origin.
    const readNoAuth = await fetch(base + '/api/slices', { headers: { Origin: origin } });
    check('cross-origin read is unauthorised', readNoAuth.status === 401, String(readNoAuth.status));
    check('read endpoint sends no CORS headers', readNoAuth.headers.get('access-control-allow-origin') === null);

    const readAuth = await fetch(base + '/api/slices', {
      headers: { Origin: origin, 'X-DVR-Token': secrets.adminToken },
    });
    check('read endpoint still has no CORS headers even when authorised', readAuth.headers.get('access-control-allow-origin') === null);

    const list = await readAuth.json();
    check('listed the uploaded slice', Array.isArray(list.slices) && list.slices.length === 1, JSON.stringify(list.slices?.length));
    check('summary marked it critical', list.slices[0].summary.severity === 'critical');

    console.log('\n\u001b[36m== token / snippet commands ==\u001b[0m');

    const tokenOut = await run(['token', '--data-dir', dataDir], { timeout: 15000 });
    check('token command prints the admin token', tokenOut.stdout.includes(secrets.adminToken));

    const snippet = await run(['snippet', '--port', String(port), '--data-dir', dataDir], { timeout: 15000 });
    check('snippet includes the upload URL', snippet.stdout.includes(`${base}/upload`));
    check('snippet includes the sdk script tag', snippet.stdout.includes(`${base}/sdk.js`));
    check('snippet includes the ingest key', snippet.stdout.includes(secrets.ingestKey));
    check('snippet never includes the admin token', !snippet.stdout.includes(secrets.adminToken));

    console.log('\n\u001b[36m== key rotation ==\u001b[0m');
    const rotateDir = path.join(tmpRoot, 'rotate');
    const first = await run(['rotate', '--data-dir', rotateDir], { timeout: 15000 });
    const second = await run(['rotate', '--data-dir', rotateDir], { timeout: 15000 });
    const firstToken = (first.stdout.match(/[A-Za-z0-9_-]{40,}/) || [])[0];
    const secondToken = (second.stdout.match(/[A-Za-z0-9_-]{40,}/) || [])[0];
    check('rotate creates a key pair', Boolean(firstToken), first.stdout.slice(0, 120));
    check('rotate replaces the key pair', Boolean(firstToken && secondToken && firstToken !== secondToken));
  }
} finally {
  if (server) {
    server.kill();
    await sleep(400);
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log('\n' + '='.repeat(52));
if (failures.length === 0) {
  console.log(`  \u001b[32mALL CLI CHECKS PASSED: ${pass}\u001b[0m`);
} else {
  console.log(`  \u001b[31m${failures.length} FAILED\u001b[0m, ${pass} passed`);
  for (const f of failures) console.log(`   - ${f}`);
}
console.log('='.repeat(52));
process.exit(failures.length === 0 ? 0 : 1);
