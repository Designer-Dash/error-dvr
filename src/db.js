// src/db.js
// SQLite storage built on Node's built-in `node:sqlite` (no native build step,
// no third-party driver). Every payload is hashed on write and re-verified on
// read so tampering with the database file is detectable.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function openDatabase(config) {
  const dbPath = path.resolve(__dirname, '..', config.databasePath);
  const dataDir = path.dirname(dbPath);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const db = new DatabaseSync(dbPath);

  // WAL for durability/concurrency; trusted_schema off so an attacker who can
  // write to the DB file cannot change query behaviour via schema tricks.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA trusted_schema = OFF');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS slices (
      id          TEXT PRIMARY KEY,
      timestamp   INTEGER NOT NULL,
      payload     TEXT NOT NULL,
      sha256      TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      summary     TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_slices_created ON slices (created_at)');

  // Forward migration for databases created by the first hardened build.
  const columns = db
    .prepare('PRAGMA table_info(slices)')
    .all()
    .map((column) => column.name);
  if (!columns.includes('summary')) {
    db.exec('ALTER TABLE slices ADD COLUMN summary TEXT');
  }

  const insertStmt = db.prepare(
    'INSERT INTO slices (id, timestamp, payload, sha256, created_at, summary) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const getStmt = db.prepare('SELECT payload, sha256, created_at, summary FROM slices WHERE id = ?');
  const listStmt = db.prepare(
    'SELECT id, timestamp, created_at, summary FROM slices ORDER BY created_at DESC LIMIT ?'
  );
  const pruneStmt = db.prepare(`
    DELETE FROM slices WHERE id IN (
      SELECT id FROM slices ORDER BY created_at ASC
      LIMIT MAX(0, (SELECT COUNT(*) FROM slices) - ?)
    )
  `);
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM slices');

  /**
   * Store one sanitised slice. `id` is always server-generated.
   * Returns { ok: true } or { ok: false, reason }.
   */
  function insertSlice({ id, timestamp, payload, summary, maxSlices }) {
    const body = JSON.stringify(payload);
    const digest = sha256(body);
    const meta = summary ? JSON.stringify(summary) : null;

    try {
      insertStmt.run(id, timestamp, body, digest, Date.now(), meta);
    } catch (err) {
      // PRIMARY KEY conflict means the id already existed — never overwrite
      // existing evidence.
      return { ok: false, reason: 'duplicate' };
    }

    pruneStmt.run(maxSlices);
    return { ok: true };
  }

  /**
   * Read a slice and verify its integrity hash.
   * Returns null when absent.
   */
  function getSlice(id) {
    const row = getStmt.get(id);
    if (!row) return null;

    const intact = sha256(row.payload) === row.sha256;
    let parsed;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      return { payload: null, integrity: 'corrupt', createdAt: row.created_at, summary: null };
    }

    let summary = null;
    try {
      summary = row.summary ? JSON.parse(row.summary) : null;
    } catch {
      summary = null;
    }

    return {
      payload: parsed,
      integrity: intact ? 'ok' : 'mismatch',
      createdAt: row.created_at,
      summary,
    };
  }

  /**
   * Newest-first metadata list. Never returns payloads, so the dashboard
   * cannot accidentally pull megabytes of DOM into the browser.
   */
  function listSlices(limit = 50) {
    const rows = listStmt.all(limit);
    return rows.map((row) => {
      let summary = null;
      try {
        summary = row.summary ? JSON.parse(row.summary) : null;
      } catch {
        summary = null;
      }
      return {
        id: row.id,
        timestamp: row.timestamp,
        createdAt: row.created_at,
        summary: summary || {
          severity: 'info',
          pageLabel: 'Unknown page',
          eventCount: 0,
          errorCount: 0,
          durationMs: 0,
          firstError: null,
        },
      };
    });
  }

  function count() {
    return countStmt.get().n;
  }

  function close() {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }

  return { insertSlice, getSlice, listSlices, count, close, dbPath };
}

module.exports = { openDatabase };
