// The phone's catalog database: SQLite running in a background worker, stored in the app's private
// storage (OPFS, "SAH pool" mode, which needs no special page headers). Same schema as the PC hub.
// Messages: { id, op, sql?, params?, statements? } -> { id, ok, result } or { id, ok: false, error }.
import sqlite3InitModule from '/vendor/sqlite/sqlite3.mjs';
import { MIGRATIONS } from '/shared/schema.js';

const DB_NAME = '/driveatlas.db';
const PRAGMAS = 'PRAGMA foreign_keys = ON; PRAGMA journal_mode = TRUNCATE; PRAGMA synchronous = NORMAL;';
let db = null;
let sqlite = null;
let pool = null;
let persistent = false;
const ready = open();
ready.catch(() => {}); // callers await it and receive the error

async function open() {
  const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
  sqlite = sqlite3;
  try {
    pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'driveatlas-pool', directory: '/driveatlas', initialCapacity: 6 });
    db = new pool.OpfsSAHPoolDb(DB_NAME);
    persistent = true;
  } catch (err) {
    // Without private storage the catalog would vanish when the app closes, so refuse to pretend.
    throw new Error(`This phone cannot store the catalog (${err && err.message ? err.message : 'private storage unavailable'}). Update "Android System WebView" from the Play Store and try again.`);
  }
  db.exec(PRAGMAS);
  const version = migrate(db);
  return { version, persistent, sqlite: sqlite3.version.libVersion };
}

function migrate(d) {
  let version = d.selectValue('PRAGMA user_version');
  while (version < MIGRATIONS.length) {
    d.exec('BEGIN');
    try {
      d.exec(MIGRATIONS[version]);
      version += 1;
      d.exec(`PRAGMA user_version = ${version}`);
      d.exec('COMMIT');
    } catch (err) {
      d.exec('ROLLBACK');
      throw err;
    }
  }
  return version;
}

// ---------- File lists kept up to date ----------
// Folder totals after entries changed in place: the changed folders and every folder above them, deepest first.
function recompute(scanId, eids) {
  const parentOf = new Map();
  const parent = (e) => {
    if (!parentOf.has(e)) parentOf.set(e, db.selectValue('SELECT parent_eid FROM entries WHERE scan_id = ? AND eid = ?', [scanId, e]) ?? null);
    return parentOf.get(e);
  };
  const all = new Set();
  for (const e of eids) { let cur = e; while (cur !== null && cur !== undefined && !all.has(cur)) { all.add(cur); cur = parent(cur); } }
  const depth = new Map();
  const depthOf = (e) => { if (!depth.has(e)) { const p = parent(e); depth.set(e, p === null ? 0 : depthOf(p) + 1); } return depth.get(e); };
  const order = [...all].sort((a, b) => depthOf(b) - depthOf(a));
  const now = Date.now();
  let changed = 0;
  db.exec('BEGIN');
  try {
    for (const e of order) {
      const cur = db.selectObject('SELECT size, items, is_dir FROM entries WHERE scan_id = ? AND eid = ?', [scanId, e]);
      if (!cur || !cur.is_dir) continue;
      const t = db.selectObject(`SELECT COALESCE(SUM(size), 0) AS size, COALESCE(SUM(CASE WHEN is_dir = 1 THEN COALESCE(items, 0) ELSE 1 END), 0) AS items
        FROM entries WHERE scan_id = ? AND parent_eid = ?`, [scanId, e]);
      if (cur.size === t.size && cur.items === t.items) continue;
      db.exec({ sql: 'UPDATE entries SET size = ?, items = ? WHERE scan_id = ? AND eid = ?', bind: [t.size, t.items, scanId, e] });
      db.exec({ sql: 'INSERT INTO entry_log (scan_id, eid, deleted, device_id, changed_at) VALUES (?, ?, 0, NULL, ?)', bind: [scanId, e, now] });
      changed += 1;
    }
    const c = db.selectObject('SELECT COALESCE(SUM(is_dir), 0) AS dirs, COUNT(*) AS n FROM entries WHERE scan_id = ? AND eid > 0', [scanId]);
    const top = db.selectValue('SELECT size FROM entries WHERE scan_id = ? AND eid = 0', [scanId]) || 0;
    db.exec({ sql: 'UPDATE scans SET file_count = ?, folder_count = ?, total_bytes = ?, updated_at = ? WHERE id = ?', bind: [c.n - c.dirs, c.dirs, top, now, scanId] });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { changed };
}

// ---------- Backups ----------
// Settings that belong to this phone only (its PIN, device ID, sync state and backup folder). They never go into a
// backup, and a restore keeps this phone's own. The backup key does go along, so a PC restoring the backup can keep
// making backups with the same password.
const PHONE_ONLY = ['phoneLock', 'phoneLockGuard', 'phoneBiometric', 'deviceId', 'uploadedScans', 'phoneMode', 'phoneBackup'];
const REQUIRED_TABLES = ['owner', 'drives', 'partitions', 'scans', 'entries', 'settings', 'linked_devices', 'sync_ctx'];
const userError = (message) => Object.assign(new Error(message), { user: true });
const placeholders = (n) => Array(n).fill('?').join(', ');
const exportBytes = (d) => sqlite.capi.sqlite3_js_db_export(d.pointer);

// A database held in memory, made from a database file's bytes.
function fromBytes(input) {
  const bytes = new Uint8Array(input);
  if (bytes.length < 512 || new TextDecoder().decode(bytes.subarray(0, 15)) !== 'SQLite format 3') throw userError('This backup does not contain a DriveAtlas catalog.');
  // The PC keeps its catalog in WAL mode; a copy of it is complete on its own, so read it as an ordinary database.
  if (bytes[18] === 2) bytes[18] = 1;
  if (bytes[19] === 2) bytes[19] = 1;
  const p = sqlite.wasm.allocFromTypedArray(bytes);
  const mem = new sqlite.oo1.DB();
  const rc = sqlite.capi.sqlite3_deserialize(mem.pointer, 'main', p, bytes.byteLength, bytes.byteLength,
    sqlite.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite.capi.SQLITE_DESERIALIZE_RESIZEABLE);
  if (rc) { mem.close(); throw userError('This backup’s catalog could not be opened.'); }
  return mem;
}

// The catalog as it goes into a backup: without this phone's PIN, device ID, PC link keys or sessions.
function backupCopy() {
  const mem = fromBytes(exportBytes(db));
  try {
    mem.exec({ sql: `DELETE FROM settings WHERE key IN (${placeholders(PHONE_ONLY.length)})`, bind: PHONE_ONLY });
    mem.exec('DELETE FROM linked_devices; DELETE FROM sessions; DELETE FROM backups;');
    mem.exec('VACUUM');
    return exportBytes(mem);
  } finally {
    mem.close();
  }
}

// Checks a catalog from a backup, brings it up to this version, keeps this phone's own settings (keep), and only
// then puts it in place of the current catalog. If anything fails, the current catalog stays as it was.
function restoreFrom({ bytes, keep = [] }) {
  const mem = fromBytes(bytes);
  let next;
  let info;
  try {
    let check = 'damaged';
    try { check = mem.selectValue('PRAGMA quick_check'); } catch { /* reported below */ }
    if (check !== 'ok') throw userError('This backup’s catalog is damaged.');
    const version = mem.selectValue('PRAGMA user_version');
    if (!Number.isInteger(version) || version < 1) throw userError('This backup does not contain a DriveAtlas catalog.');
    if (version > MIGRATIONS.length) throw userError('This backup was made by a newer version of DriveAtlas. Update the app on this phone first.');
    try { migrate(mem); } catch { throw userError('This backup’s catalog could not be updated to this version of DriveAtlas.'); }
    const tables = new Set(mem.selectValues("SELECT name FROM sqlite_master WHERE type = 'table'"));
    if (REQUIRED_TABLES.some((t) => !tables.has(t))) throw userError('This backup does not contain a DriveAtlas catalog.');
    const owner = mem.selectObject('SELECT name FROM owner WHERE id = 1');
    if (!owner) throw userError('This backup has no account in it.');
    mem.exec('BEGIN');
    try {
      const drop = [...PHONE_ONLY, 'backupKey'];
      mem.exec({ sql: `DELETE FROM settings WHERE key IN (${placeholders(drop.length)})`, bind: drop });
      for (const k of keep) mem.exec({ sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', bind: [k.key, k.value] });
      // Links belong to the device that made them; link this phone with your PC again after a restore.
      mem.exec('DELETE FROM linked_devices; DELETE FROM sessions; DELETE FROM backups; UPDATE sync_ctx SET origin = NULL WHERE id = 1;');
      mem.exec('COMMIT');
    } catch (err) {
      mem.exec('ROLLBACK');
      throw err;
    }
    info = { owner: owner.name, drives: mem.selectValue('SELECT COUNT(*) FROM drives'), files: mem.selectValue('SELECT COUNT(*) FROM entries WHERE is_dir = 0') };
    next = exportBytes(mem);
  } finally {
    mem.close();
  }
  // Swap it in, keeping the current catalog in memory to put back if that fails.
  const previous = pool.exportFile(DB_NAME);
  db.close();
  db = null;
  try {
    pool.importDb(DB_NAME, next);
    db = new pool.OpfsSAHPoolDb(DB_NAME);
    db.exec(PRAGMAS);
  } catch {
    try { if (db) db.close(); } catch { /* reopened below */ }
    pool.importDb(DB_NAME, previous);
    db = new pool.OpfsSAHPoolDb(DB_NAME);
    db.exec(PRAGMAS);
    throw userError('The backup could not be put in place, so your catalog was not changed.');
  }
  return info;
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
  // A consistent copy of the whole database as bytes.
  export: () => exportBytes(db),
  backupCopy: () => backupCopy(),
  recompute: ({ scanId, eids }) => recompute(scanId, eids),
  restore: (msg) => restoreFrom(msg)
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
