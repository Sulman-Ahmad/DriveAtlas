// Encrypted backups (AES-256-GCM, key from your password with scrypt), restore,
// daily automatic backups, and moving the catalog to another folder.
import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, DB_PATH, VERSION, writeConfig } from './config.mjs';
import { getSetting, setSetting, SCHEMA_VERSION } from './db.mjs';
import { httpError } from './auth.mjs';
import { folderPath } from './validate.mjs';

const KDF = { N: 131072, r: 8, p: 1 };
const NAME_RE = /^DriveAtlas-backup-\d{4}-\d{2}-\d{2}-\d{4}\.dabackup$/;
export const BACKUP_DEFAULTS = { enabled: false, folder: null, keep: 7 };
export const MAX_BACKUP_BYTES = 16 * 2 ** 30;
let busy = false;

function runWorker(data) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./backup-worker.mjs', import.meta.url), { workerData: data });
    w.once('message', (m) => (m.ok ? resolve(m.result) : reject(Object.assign(httpError(m.code === 'ERROR' ? 500 : 400, m.message), { code: m.code }))));
    w.once('error', reject);
    w.once('exit', (code) => { if (code !== 0) reject(httpError(500, 'The backup worker stopped unexpectedly.')); });
  });
}

const scrypt = (password, salt) => new Promise((resolve, reject) => {
  crypto.scrypt(String(password), salt, 32, { ...KDF, maxmem: 160 * KDF.N * KDF.r + 16 * 2 ** 20 }, (e, k) => (e ? reject(e) : resolve(k)));
});

// Derives the backup key from your password (at sign-in), so daily backups never need the password itself.
export async function rememberBackupKey(db, password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  setSetting(db, 'backupKey', { salt: salt.toString('base64'), key: key.toString('base64'), N: KDF.N, r: KDF.r, p: KDF.p });
}

export const hasBackupKey = (db) => Boolean(getSetting(db, 'backupKey'));
export const backupSettings = (db) => ({ ...BACKUP_DEFAULTS, ...getSetting(db, 'backup', {}) });

export function fileNameFor(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `DriveAtlas-backup-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}.dabackup`;
}

function log(db, kind, status, extra = {}) {
  db.prepare('INSERT INTO backups (id, created_at, kind, path, size, status, error) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), Date.now(), kind, extra.path || null, extra.size || null, status, extra.error || null);
}

export async function createBackup(db, folder, kind = 'manual') {
  const k = getSetting(db, 'backupKey');
  if (!k) throw httpError(409, 'Sign out and sign in again once, so DriveAtlas can prepare your backup key.');
  if (busy) throw httpError(409, 'A backup is already being made. Try again in a moment.');
  busy = true;
  const dest = path.join(folder, fileNameFor());
  try {
    fs.mkdirSync(folder, { recursive: true });
    if (fs.existsSync(dest)) throw httpError(409, 'A backup with this time stamp already exists. Wait a minute and try again.');
    const header = { app: 'DriveAtlas', format: 1, version: VERSION, created: Date.now(), kdf: { name: 'scrypt', N: k.N, r: k.r, p: k.p, salt: k.salt },
      cipher: 'aes-256-gcm', iv: crypto.randomBytes(12).toString('base64'), compression: 'gzip' };
    const snapshot = path.join(DATA_DIR, `.snapshot-${crypto.randomBytes(8).toString('hex')}.db`);
    const { size } = await runWorker({ op: 'create', dbPath: DB_PATH, dest, snapshot, key: k.key, header });
    log(db, kind, 'ok', { path: dest, size });
    return { path: dest, size };
  } catch (err) {
    log(db, kind, 'failed', { path: dest, error: String(err.message).slice(0, 300) });
    throw err;
  } finally {
    busy = false;
  }
}

export const backupRunning = () => busy;

// Keeps only the newest `keep` automatic backups in the folder. Touches only files DriveAtlas named.
export function pruneBackups(folder, keep) {
  let names = [];
  try { names = fs.readdirSync(folder).filter((n) => NAME_RE.test(n)).sort().reverse(); } catch { return 0; }
  let removed = 0;
  for (const n of names.slice(keep)) {
    try { fs.rmSync(path.join(folder, n)); removed += 1; } catch { /* in use or protected: leave it */ }
  }
  return removed;
}

export function recentBackups(db, limit = 8) {
  return db.prepare('SELECT created_at, kind, path, size, status, error FROM backups ORDER BY created_at DESC LIMIT ?').all(limit);
}

// Checks a backup with the password and stages it; the hub swaps it in when it restarts.
export async function stageRestore(file, password) {
  if (typeof password !== 'string' || !password || password.length > 200) throw httpError(400, 'Enter the password the backup was made with.');
  const st = fs.statSync(file);
  if (!st.isFile() || st.size > MAX_BACKUP_BYTES) throw httpError(400, 'That file is too large to be a DriveAtlas backup.');
  const tmp = `${DB_PATH}.restore-check`;
  fs.rmSync(tmp, { force: true });
  const info = await runWorker({ op: 'restore', file, password, outFile: tmp, schemaVersion: SCHEMA_VERSION });
  fs.renameSync(tmp, `${DB_PATH}.restore`);
  return info;
}

// Called at start-up, before the catalog opens: swaps in a staged restore and keeps the old catalog aside.
export function applyStagedRestore() {
  const staged = `${DB_PATH}.restore`;
  if (!fs.existsSync(staged)) return false;
  const aside = `${DB_PATH}.before-restore`;
  fs.rmSync(aside, { force: true });
  if (fs.existsSync(DB_PATH)) fs.renameSync(DB_PATH, aside);
  for (const ext of ['-wal', '-shm']) fs.rmSync(DB_PATH + ext, { force: true });
  fs.renameSync(staged, DB_PATH);
  return true;
}

// Restricts a folder to your Windows account, SYSTEM and Administrators (best effort).
function restrictFolder(dir) {
  return new Promise((resolve) => {
    const user = `${process.env.USERDOMAIN || os.hostname()}\\${process.env.USERNAME || os.userInfo().username}`;
    const child = spawn('icacls', [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

// Copies the catalog into "<folder>\DriveAtlas Data" and points DriveAtlas there after a restart.
export async function moveCatalog(folder) {
  const parent = folderPath(folder, 'Catalog folder');
  const target = path.join(parent, 'DriveAtlas Data');
  if (path.resolve(target).toLowerCase() === path.resolve(DATA_DIR).toLowerCase()) throw httpError(409, 'Your catalog is already in that folder.');
  fs.mkdirSync(target, { recursive: true });
  const dest = path.join(target, 'driveatlas.db');
  if (fs.existsSync(dest)) throw httpError(409, 'That folder already holds a DriveAtlas catalog. Pick another folder, or restore a backup instead.');
  const probe = path.join(target, `.write-test-${crypto.randomBytes(4).toString('hex')}`);
  try { fs.writeFileSync(probe, 'ok'); fs.rmSync(probe); } catch { throw httpError(400, 'DriveAtlas cannot write to that folder. Pick another one.'); }
  const restricted = await restrictFolder(target);
  await runWorker({ op: 'copy', dbPath: DB_PATH, dest });
  writeConfig({ dataDir: target });
  return { target, restricted };
}

// Daily automatic backups to the chosen folder, checked every 30 minutes.
export function startBackupScheduler(db, onDone) {
  const tick = async () => {
    const s = backupSettings(db);
    if (!s.enabled || !s.folder || !hasBackupKey(db) || busy) return;
    const last = db.prepare("SELECT MAX(created_at) AS t FROM backups WHERE kind = 'auto' AND status = 'ok'").get().t;
    if (last && Date.now() - last < 23.5 * 3600 * 1000) return;
    try {
      const r = await createBackup(db, s.folder, 'auto');
      pruneBackups(s.folder, s.keep);
      onDone({ ok: true, ...r });
    } catch (err) {
      onDone({ ok: false, error: err.message });
    }
  };
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 30 * 60_000).unref();
}
