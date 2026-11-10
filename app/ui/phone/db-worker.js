// The phone's catalog database: SQLite running in a background worker, stored in the app's private
// storage (OPFS, "SAH pool" mode, which needs no special page headers). Same schema as the PC hub.
// Messages: { id, op, sql?, params?, statements? } -> { id, ok, result } or { id, ok: false, error }.
import sqlite3InitModule from '/vendor/sqlite/sqlite3.mjs';
import { MIGRATIONS } from '/shared/schema.js';

let db = null;
let sqlite = null;
let persistent = false;
const ready = open();
ready.catch(() => {}); // callers await it and receive the error

async function open() {
  const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
  sqlite = sqlite3;
  try {
    const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'driveatlas-pool', directory: '/driveatlas', initialCapacity: 6 });
    db = new pool.OpfsSAHPoolDb('/driveatlas.db');
    persistent = true;
  } catch (err) {
    // Without private storage the catalog would vanish when the app closes, so refuse to pretend.
    throw new Error(`This phone cannot store the catalog (${err && err.message ? err.message : 'private storage unavailable'}). Update "Android System WebView" from the Play Store and try again.`);
  }
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = TRUNCATE; PRAGMA synchronous = NORMAL;');
  let version = db.selectValue('PRAGMA user_version');
  while (version < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      version += 1;
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return { version, persistent, sqlite: sqlite3.version.libVersion };
}

// sqlite-wasm refuses an empty parameter list on a statement that has no parameters.
const bindOf = (params) => (Array.isArray(params) && params.length ? params : undefined);
const rowsOf = (sql, params) => db.selectObjects(sql, bindOf(params));

function run(sql, params) {
  db.exec({ sql, bind: bindOf(params) });
  return { changes: db.changes(), lastId: Number(db.selectValue('SELECT last_insert_rowid()')) };
}

const ops = {
  info: () => ready,
  all: ({ sql, params }) => rowsOf(sql, params),
  get: ({ sql, params }) => rowsOf(sql, params)[0] ?? null,
  value: ({ sql, params }) => db.selectValue(sql, bindOf(params)) ?? null,
  run: ({ sql, params }) => run(sql, params),
  exec: ({ sql }) => { db.exec(sql); return true; },
  // Several statements in one transaction; each is { sql, params } or { sql, rows: [[...], ...] } for bulk inserts.
  tx: ({ statements }) => {
    db.exec('BEGIN');
    try {
      const results = [];
      for (const s of statements) {
        if (s.rows) {
          const stmt = db.prepare(s.sql);
          try { for (const r of s.rows) { stmt.bind(r).stepReset(); stmt.clearBindings(); } } finally { stmt.finalize(); }
          results.push({ changes: s.rows.length });
        } else if (s.select) {
          results.push(rowsOf(s.sql, s.params));
        } else {
          results.push(run(s.sql, s.params));
        }
      }
      db.exec('COMMIT');
      return results;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  },
  // A consistent copy of the whole database as bytes (for backups and moving to a PC).
  export: () => sqlite.capi.sqlite3_js_db_export(db.pointer)
};

self.onmessage = async (e) => {
  const { id, op } = e.data || {};
  try {
    await ready;
    if (!ops[op]) throw new Error(`Unknown database operation: ${op}`);
    const result = await ops[op](e.data);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) });
  }
};
