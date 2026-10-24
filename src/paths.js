// src/paths.js
// Where the tool keeps its state. Defaults to ./data in the directory you run
// it from, so recordings stay inspectable and disappear with the project.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function resolveDataDir(explicit) {
  const dir = path.resolve(
    explicit || process.env.DVR_DATA_DIR || path.join(process.cwd(), 'data')
  );
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function secretsPathIn(dataDir) {
  return path.join(dataDir, '.secrets.json');
}

function databasePathIn(dataDir) {
  return path.join(dataDir, 'slices.db');
}

/** Last used port, so `snippet` and `demo` point at the running instance. */
function runtimePathIn(dataDir) {
  return path.join(dataDir, '.runtime.json');
}

module.exports = { resolveDataDir, secretsPathIn, databasePathIn, runtimePathIn };
