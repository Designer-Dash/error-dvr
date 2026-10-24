#!/usr/bin/env node
// bin/error-dvr.js — command line entry point.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const pkg = require('../package.json');

// ------------------------------------------------------------ environment --

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(
    `\n  error-dvr needs Node.js 22.5 or newer (found ${process.version}).\n` +
      '  It relies on the built-in node:sqlite module.\n'
  );
  process.exit(1);
}

const c = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  violet: '\u001b[38;5;99m',
  mint: '\u001b[38;5;79m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  grey: '\u001b[90m',
};

const write = (text) => process.stdout.write(text + '\n');

function banner() {
  write('');
  write(`  ${c.violet}${c.bold}Error-DVR${c.reset} ${c.grey}v${pkg.version}${c.reset}`);
  write(`  ${c.grey}record · replay · diagnose the moment before the crash${c.reset}`);
  write('');
}

function help() {
  banner();
  write(`  ${c.bold}Usage${c.reset}`);
  write(`    error-dvr [options]            start the recorder and dashboard`);
  write(`    error-dvr token                print the admin token`);
  write(`    error-dvr rotate               generate a fresh key pair`);
  write(`    error-dvr snippet              print the snippet for your own site`);
  write(`    error-dvr demo                 print the demo page URL`);
  write(`    error-dvr help                 show this message`);
  write('');
  write(`  ${c.bold}Options${c.reset}`);
  write(`    --port <n>        port to listen on            ${c.grey}(default 3000)${c.reset}`);
  write(`    --data-dir <p>    where recordings are stored  ${c.grey}(default ./data)${c.reset}`);
  write(`    --open            open the dashboard in a browser`);
  write(`    --quiet           never print the admin token`);
  write(`    -v, --version     print the version`);
  write(`    -h, --help        show this message`);
  write('');
  write(`  ${c.bold}How it works${c.reset}`);
  write(`    1. run ${c.violet}error-dvr${c.reset} and paste the admin token into the dashboard`);
  write(`    2. add ${c.violet}error-dvr snippet${c.reset} to the page you want to watch`);
  write(`    3. trigger a bug, then open the trace and replay it`);
  write('');
  write(`  ${c.grey}Loopback only. Nothing leaves your machine.${c.reset}`);
  write('');
}

// ------------------------------------------------------------------- args --

function parseArgs(argv) {
  const options = {};
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        fail('--port needs a number between 0 and 65535');
      }
      options.port = value;
    } else if (arg === '--data-dir') {
      const value = argv[++i];
      if (!value) fail('--data-dir needs a path');
      options.dataDir = path.resolve(value);
    } else if (arg === '--open') {
      options.open = true;
    } else if (arg === '--quiet') {
      options.quiet = true;
    } else if (arg === '-v' || arg === '--version') {
      options.version = true;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg.startsWith('-')) {
      fail(`unknown option ${arg}`);
    } else {
      rest.push(arg);
    }
  }

  options.command = rest[0] || 'serve';
  return options;
}

function fail(message) {
  console.error(`\n  ${c.red}✗${c.reset} ${message}\n`);
  process.exit(1);
}

// -------------------------------------------------------------- utilities --

function openBrowser(url) {
  const platform = process.platform;
  const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];

  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* opening a browser is a convenience, never a hard requirement */
  }
}

function readSecrets(dataDir) {
  const { resolveDataDir, secretsPathIn } = require('../src/paths');
  const dir = resolveDataDir(dataDir);
  const file = secretsPathIn(dir);
  if (!fs.existsSync(file)) return { dir, file, secrets: null };
  try {
    return { dir, file, secrets: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return { dir, file, secrets: null };
  }
}

// ---------------------------------------------------------------- commands --

async function serve(options) {
  const { start } = require('../src/server');

  let handle;
  let port = options.port === undefined ? 3000 : options.port;
  const explicitPort = options.port !== undefined;

  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      handle = await new Promise((resolve, reject) => {
        const started = start({ port, dataDir: options.dataDir, quiet: options.quiet });
        const onError = (error) => {
          started.server.removeListener('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          started.server.removeListener('error', onError);
          resolve(started);
        };
        started.server.once('error', onError);
        started.server.once('listening', onListening);
      });
      break;
    } catch (error) {
      if (error.code === 'EADDRINUSE' && !explicitPort) {
        write(`  ${c.grey}port ${port} is busy, trying ${port + 1}…${c.reset}`);
        port += 1;
        continue;
      }
      if (error.code === 'EADDRINUSE') {
        fail(
          `port ${port} is already in use. Try ${c.violet}--port ${port + 1}${c.reset}, ` +
            'or stop whatever is holding it.'
        );
      }
      if (error.code === 'NON_LOOPBACK_HOST') fail(error.message);
      throw error;
    }
  }

  if (!handle) fail('could not find a free port');

  const url = handle.url;
  const token = handle.secrets.adminToken;

  // Remember the port so `snippet` and `demo` match this instance.
  try {
    const { runtimePathIn } = require('../src/paths');
    const file = runtimePathIn(handle.config.dataDir);
    fs.writeFileSync(file, JSON.stringify({ port, url, startedAt: Date.now() }), { mode: 0o600 });
  } catch {
    /* non-fatal */
  }

  banner();
  write(`  ${c.mint}●${c.reset} listening on ${c.bold}${url}${c.reset}`);
  write('');
  write(`  ${c.grey}dashboard${c.reset}  ${url}`);
  write(`  ${c.grey}demo${c.reset}       ${url}/demo`);
  write(`  ${c.grey}data${c.reset}       ${handle.config.dataDir}`);
  write('');
  if (!options.quiet) {
    write(`  ${c.grey}admin token${c.reset}`);
    write(`  ${c.bold}${token}${c.reset}`);
    write(`  ${c.grey}paste it into the dashboard to unlock it${c.reset}`);
  } else {
    write(`  ${c.grey}admin token suppressed (--quiet) — run "error-dvr token" to print it${c.reset}`);
  }
  write('');
  write(`  ${c.grey}press Ctrl+C to stop${c.reset}`);
  write('');

  if (options.open) openBrowser(url);

  const shutdown = async () => {
    write(`\n  ${c.grey}stopping…${c.reset}`);
    await handle.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function tokenCommand(options) {
  const { dir, secrets } = readSecrets(options.dataDir);
  if (!secrets) {
    write(`\n  No key pair yet in ${dir}.`);
    write(`  Start the recorder once (${c.violet}error-dvr${c.reset}) and it will create one.\n`);
    return;
  }
  write('');
  write(`  ${c.grey}admin token${c.reset}`);
  write(`  ${c.bold}${secrets.adminToken}${c.reset}`);
  write('');
  write(`  ${c.grey}ingest key (write-only, for the snippet)${c.reset}`);
  write(`  ${c.grey}${secrets.ingestKey}${c.reset}`);
  write('');
}

function rotateCommand(options) {
  const { resolveDataDir, secretsPathIn } = require('../src/paths');
  const dir = resolveDataDir(options.dataDir);
  const file = secretsPathIn(dir);

  const existed = fs.existsSync(file);
  if (existed) fs.rmSync(file, { force: true });

  const { loadSecrets } = require('../src/security');
  const secrets = loadSecrets(file);

  write('');
  write(`  ${c.mint}✓${c.reset} ${existed ? 'rotated' : 'created'} a new key pair in ${dir}`);
  write('');
  write(`  ${c.grey}admin token${c.reset}  ${c.bold}${secrets.adminToken}${c.reset}`);
  write('');
  write(`  ${c.grey}Existing browser tabs must be re-unlocked.${c.reset}`);
  write('');
}

/** Port of the last started instance, unless the caller passed --port. */
function lastPort(options) {
  if (options.port !== undefined) return options.port;
  try {
    const { resolveDataDir, runtimePathIn } = require('../src/paths');
    const dir = resolveDataDir(options.dataDir);
    const raw = JSON.parse(fs.readFileSync(runtimePathIn(dir), 'utf8'));
    if (Number.isInteger(raw.port)) return raw.port;
  } catch {
    /* no instance has run yet */
  }
  return 3000;
}

function snippetCommand(options) {
  const { dir, secrets } = readSecrets(options.dataDir);
  const port = lastPort(options);
  const base = `http://127.0.0.1:${port}`;

  if (!secrets) {
    write(`\n  No key pair yet in ${dir}. Run ${c.violet}error-dvr${c.reset} once first.\n`);
    return;
  }

  write('');
  write(`  ${c.grey}Paste this into the page you want to watch, just before </body>:${c.reset}`);
  write('');
  write(`<script>`);
  write(
    `  window.__DVR__ = {`
  );
  write(`    uploadUrl: ${JSON.stringify(base + '/upload')},`);
  write(`    ingestKey: ${JSON.stringify(secrets.ingestKey)},`);
  write(`    sliceLengthSec: 15,`);
  write(`    privacyMasking: true`);
  write(`  };`);
  write(`</script>`);
  write(`<script src=${JSON.stringify(base + '/vendor/rrweb.js')}></script>`);
  write(`<script src=${JSON.stringify(base + '/sdk.js')}></script>`);
  write('');
  write(`  ${c.grey}The ingest key is write-only: it can create traces but never read them.${c.reset}`);
  write(`  ${c.grey}Port ${port} matches the instance you last started.${c.reset}`);
  write('');
}

function demoCommand(options) {
  const port = lastPort(options);
  const url = `http://127.0.0.1:${port}/demo`;
  write('');
  write(`  ${url}`);
  write('');
  if (options.open) openBrowser(url);
}

// ------------------------------------------------------------------- main --

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.version) {
    write(pkg.version);
    return;
  }

  if (options.help || options.command === 'help') {
    help();
    return;
  }

  switch (options.command) {
    case 'serve':
      await serve(options);
      return;
    case 'token':
      tokenCommand(options);
      return;
    case 'rotate':
      rotateCommand(options);
      return;
    case 'snippet':
      snippetCommand(options);
      return;
    case 'demo':
      demoCommand(options);
      return;
    default:
      fail(`unknown command "${options.command}". Try ${c.violet}error-dvr help${c.reset}.`);
  }
}

main().catch((error) => {
  if (error && error.code === 'NON_LOOPBACK_HOST') fail(error.message);
  console.error(`\n  ${c.red}✗${c.reset} ${error && error.message ? error.message : error}\n`);
  process.exit(1);
});
