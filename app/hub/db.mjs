// Opens the catalog database and applies schema migrations in order.
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './config.mjs';

const MIGRATIONS = [
  // 1: full Phase 1 schema
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE owner (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL,
    pw_salt BLOB NOT NULL,
    pw_hash BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    device TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE drives (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    other_kind TEXT,
    form_factor TEXT,
    brand TEXT,
    model TEXT,
    serial TEXT,
    advertised_bytes INTEGER,
    actual_bytes INTEGER,
    interface TEXT,
    rated_read_mbs INTEGER,
    rated_write_mbs INTEGER,
    speed_class TEXT,
    status TEXT NOT NULL DEFAULT 'stored',
    location TEXT,
    lent_to TEXT,
    lent_since TEXT,
    due_back TEXT,
    colour TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    notes TEXT,
    label_code TEXT UNIQUE,
    purchase_price TEXT,
    purchase_date TEXT,
    shop TEXT,
    warranty_until TEXT,
    match_ids TEXT NOT NULL DEFAULT '[]',
    bus TEXT,
    media TEXT,
    partition_style TEXT,
    bootable_kind TEXT,
    bootable_override TEXT,
    health_status TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    last_scanned_at INTEGER
  );

  CREATE TABLE partitions (
    id TEXT PRIMARY KEY,
    drive_id TEXT NOT NULL REFERENCES drives(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    label TEXT,
    last_letter TEXT,
    filesystem TEXT,
    size INTEGER,
    used INTEGER,
    free INTEGER,
    partition_type TEXT,
    gpt_type TEXT,
    guid TEXT,
    volume_serial TEXT,
    signals TEXT NOT NULL DEFAULT '[]',
    has_windows INTEGER NOT NULL DEFAULT 0,
    encrypted INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX partitions_drive ON partitions(drive_id);

  CREATE TABLE collections (id TEXT PRIMARY KEY, name TEXT NOT NULL, colour TEXT, icon TEXT);
  CREATE TABLE drive_collections (
    drive_id TEXT NOT NULL REFERENCES drives(id) ON DELETE CASCADE,
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    PRIMARY KEY (drive_id, collection_id)
  );

  CREATE TABLE scans (
    id TEXT PRIMARY KEY,
    drive_id TEXT NOT NULL REFERENCES drives(id) ON DELETE CASCADE,
    partition_idx INTEGER,
    root TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    scanned_on TEXT,
    options TEXT NOT NULL DEFAULT '{}',
    file_count INTEGER NOT NULL DEFAULT 0,
    folder_count INTEGER NOT NULL DEFAULT 0,
    total_bytes INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    error TEXT
  );
  CREATE INDEX scans_drive ON scans(drive_id, started_at);

  CREATE TABLE entries (
    id INTEGER PRIMARY KEY,
    scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
    eid INTEGER NOT NULL,
    parent_eid INTEGER,
    name TEXT NOT NULL,
    is_dir INTEGER NOT NULL,
    size INTEGER,
    modified_at INTEGER,
    created_at INTEGER,
    ext TEXT,
    kind TEXT,
    flags INTEGER NOT NULL DEFAULT 0,
    fingerprint TEXT,
    width INTEGER,
    height INTEGER,
    duration_s REAL,
    taken_at INTEGER
  );
  CREATE UNIQUE INDEX entries_scan_eid ON entries(scan_id, eid);
  CREATE INDEX entries_parent ON entries(scan_id, parent_eid);
  CREATE INDEX entries_fp ON entries(fingerprint) WHERE fingerprint IS NOT NULL;
  CREATE VIRTUAL TABLE entries_fts USING fts5(name, content='entries', content_rowid='id', tokenize='unicode61 remove_diacritics 2');

  CREATE TABLE health_snapshots (
    id TEXT PRIMARY KEY,
    drive_id TEXT NOT NULL REFERENCES drives(id) ON DELETE CASCADE,
    taken_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    status TEXT,
    health_pct REAL,
    temp_c REAL,
    power_on_hours INTEGER,
    power_cycles INTEGER,
    tb_written REAL,
    tb_read REAL,
    reallocated INTEGER,
    pending INTEGER,
    media_errors INTEGER,
    raw TEXT
  );
  CREATE INDEX health_drive ON health_snapshots(drive_id, taken_at);

  CREATE TABLE reminders (
    id TEXT PRIMARY KEY,
    drive_id TEXT REFERENCES drives(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    title TEXT,
    every_days INTEGER,
    due_at TEXT,
    last_done_at TEXT
  );

  CREATE TABLE linked_devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'phone',
    token_hash TEXT NOT NULL,
    last_sync_at INTEGER,
    revoked_at INTEGER
  );

  CREATE TABLE pending_changes (
    drive_id TEXT PRIMARY KEY REFERENCES drives(id) ON DELETE CASCADE,
    detected_at INTEGER NOT NULL,
    changes TEXT NOT NULL
  );

  CREATE TABLE change_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    row_id TEXT NOT NULL,
    changed_at INTEGER NOT NULL,
    device_id TEXT,
    fields TEXT,
    deleted INTEGER NOT NULL DEFAULT 0
  );
  `,
  // 2: scanning details
  `
  ALTER TABLE scans ADD COLUMN is_current INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE scans ADD COLUMN partition_label TEXT;
  ALTER TABLE scans ADD COLUMN bytes_estimate INTEGER;
  ALTER TABLE scans ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX scans_current ON scans(drive_id, partition_idx, is_current);
  ALTER TABLE entries ADD COLUMN items INTEGER;
  CREATE INDEX entries_kind ON entries(scan_id, kind);
  `,
  // 3: stronger password hashing parameters, drive health summary, backup log
  `
  ALTER TABLE owner ADD COLUMN pw_params TEXT NOT NULL DEFAULT 'scrypt:16384:8:1';
  ALTER TABLE drives ADD COLUMN health_pct REAL;
  ALTER TABLE drives ADD COLUMN health_state TEXT;
  ALTER TABLE drives ADD COLUMN health_checked_at INTEGER;
  CREATE TABLE backups (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    path TEXT,
    size INTEGER,
    status TEXT NOT NULL,
    error TEXT
  );
  `
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDb(file = DB_PATH) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  let version = db.prepare('PRAGMA user_version').get().user_version;
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
  return db;
}

// Runs fn inside one transaction.
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}
