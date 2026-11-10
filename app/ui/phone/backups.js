// Encrypted backups on the phone. Same file format as the PC (shared/backup-format.js), so the PC can restore a
// phone's backup and the phone can restore the PC's. Backups go to a folder you choose with Android's picker:
// on the phone, an SD card, a USB drive, or a cloud app's folder.
import { db, getSetting, setSetting } from './db.js';
import { plugin } from './native.js';
import { emit } from './events.js';
import { deriveBackupKey, makeBackup, openBackup, readBackupHeader, toB64, fromB64 } from '/shared/backup-format.js';

export const BACKUP_DEFAULTS = { auto: true, folder: null, keep: 7 };
const NAME_RE = /^DriveAtlas-backup-\d{4}-\d{2}-\d{2}-\d{4}( \(\d+\))?\.dabackup$/;
const HOUR = 3600 * 1000;
// This phone's own settings, carried over when a backup replaces the catalog.
const KEEP_ON_RESTORE = ['phoneLock', 'phoneLockGuard', 'phoneBiometric', 'deviceId', 'phoneMode', 'phoneBackup', 'backupKey', 'theme', 'scanDefaults'];
const fail = (status, message, code) => Object.assign(new Error(message), { status, code });

function needPlugin() {
  const p = plugin();
  if (!p) throw fail(409, 'Backups to a folder work in the Android app.');
  return p;
}

// Same names as the PC's backups.
export function fileNameFor(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `DriveAtlas-backup-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}.dabackup`;
}

export async function backupConfig() {
  return { ...BACKUP_DEFAULTS, ...(await getSetting('phoneBackup', {})) };
}

export async function backupStatus() {
  const [cfg, key, log] = await Promise.all([backupConfig(), getSetting('backupKey'),
    db.all('SELECT created_at, kind, path, size, status, error FROM backups ORDER BY created_at DESC LIMIT 8')]);
  let files = [];
  let folderLost = false;
  if (cfg.folder && plugin()) {
    try {
      const r = await plugin().listBackups({ folder: cfg.folder.uri });
      files = (r.files || []).filter((f) => f.ours).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 10)
        .map((f) => ({ uri: f.uri, name: f.name, size: f.size ?? null, modified: f.modified ?? null }));
    } catch (e) {
      folderLost = e && e.code === 'NO_FOLDER';
    }
  }
  return { hasPassword: Boolean(key), folder: cfg.folder ? { name: cfg.folder.name } : null, folderLost, auto: cfg.auto, keep: cfg.keep, running: Boolean(running), recent: log, files };
}

export async function setBackupPassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw fail(400, 'Use a backup password of at least 8 characters.');
  if (password.length > 200) throw fail(400, 'That password is too long (200 characters at most).');
  await setSetting('backupKey', await deriveBackupKey(password));
}

export async function chooseFolder() {
  const r = await needPlugin().pickBackupFolder();
  if (!r || !r.uri) return { picked: false };
  await setSetting('phoneBackup', { ...(await backupConfig()), folder: { uri: r.uri, name: r.name || 'Chosen folder' } });
  return { picked: true, name: r.name || 'Chosen folder' };
}

export async function updateBackupSettings(body) {
  const cfg = await backupConfig();
  if (typeof body.auto === 'boolean') cfg.auto = body.auto;
  if (body.keep !== undefined) {
    if (!Number.isInteger(body.keep) || body.keep < 1 || body.keep > 60) throw fail(400, 'Keep between 1 and 60 backups.');
    cfg.keep = body.keep;
  }
  await setSetting('phoneBackup', cfg);
  return { auto: cfg.auto, keep: cfg.keep };
}

let running = null;
export function backupNow(kind, version) {
  if (!running) running = makeOne(kind, version).finally(() => { running = null; });
  return running;
}

async function makeOne(kind, version) {
  const p = needPlugin();
  const [cfg, key] = await Promise.all([backupConfig(), getSetting('backupKey')]);
  if (!key) throw fail(409, 'Set a backup password first.', 'NO_PASSWORD');
  if (!cfg.folder) throw fail(409, 'Choose a folder for backups first.', 'NO_FOLDER');
  const id = crypto.randomUUID();
  const started = Date.now();
  try {
    const file = await makeBackup(await db.backupCopy(), key, { version, created: started });
    const saved = await p.writeBackup({ folder: cfg.folder.uri, name: fileNameFor(new Date(started)), data: toB64(file) });
    await db.run('INSERT INTO backups (id, created_at, kind, path, size, status, error) VALUES (?, ?, ?, ?, ?, ?, NULL)', [id, started, kind, saved.name, file.length, 'ok']);
    await prune(p, cfg).catch(() => {});
    emit('backup', { status: 'ok', name: saved.name });
    return { ok: true, name: saved.name, size: file.length };
  } catch (err) {
    const message = String((err && err.message) || err).slice(0, 300);
    await db.run('INSERT INTO backups (id, created_at, kind, path, size, status, error) VALUES (?, ?, ?, NULL, NULL, ?, ?)', [id, started, kind, 'error', message]).catch(() => {});
    emit('backup', { status: 'error', error: message });
    throw fail(err.status || 500, message, err.code);
  }
}

// Keeps the newest `keep` backups in the folder. Only removes files with DriveAtlas's own backup names.
async function prune(p, cfg) {
  const { files = [] } = await p.listBackups({ folder: cfg.folder.uri });
  const ours = files.filter((f) => NAME_RE.test(f.name)).sort((a, b) => b.name.localeCompare(a.name));
  for (const f of ours.slice(cfg.keep)) await p.deleteBackup({ uri: f.uri }).catch(() => {});
}

// Daily automatic backups, made when you open the app (nothing runs in the background, which saves battery).
export async function autoBackupIfDue(version) {
  if (!plugin() || running) return;
  const cfg = await backupConfig();
  if (!cfg.auto || !cfg.folder || !(await getSetting('backupKey'))) return;
  const lastOk = await db.value("SELECT MAX(created_at) FROM backups WHERE kind = 'auto' AND status = 'ok'");
  const lastTry = await db.value("SELECT MAX(created_at) FROM backups WHERE kind = 'auto'");
  if (lastOk && Date.now() - lastOk < 20 * HOUR) return;
  if (lastTry && Date.now() - lastTry < HOUR) return; // after a failed try, wait an hour
  await backupNow('auto', version).catch(() => {});
}

// ---------- Restore ----------
let picked = null;

// Picks a backup file (anywhere Android can reach, or one listed in the backup folder) and checks it is a backup.
export async function pickRestoreFile(uri) {
  const p = needPlugin();
  let r;
  try {
    r = uri ? await p.readBackup({ uri }) : await p.openBackup();
  } catch (e) {
    throw fail(400, e.message || 'The file could not be read.');
  }
  if (!r || !r.data) return { picked: false };
  const bytes = fromB64(r.data);
  let header;
  try { header = readBackupHeader(bytes).h; } catch (e) { picked = null; throw fail(400, e.message, e.code); }
  picked = { name: r.name, size: r.size, bytes };
  return { picked: true, name: r.name, size: r.size, created: header.created ?? null, version: header.version ?? null };
}

export const hasPicked = () => Boolean(picked);

// Opens the picked backup with its password and puts its catalog in place of this phone's.
export async function restorePicked(password) {
  if (!picked) throw fail(409, 'Pick a backup file first.');
  if (typeof password !== 'string' || !password || password.length > 200) throw fail(400, 'Enter the password the backup was made with.');
  let opened;
  try {
    opened = await openBackup(picked.bytes, password);
  } catch (e) {
    throw fail(e.code === 'BAD_PASSWORD' ? 401 : 400, e.message, e.code);
  }
  const keep = [];
  for (const key of KEEP_ON_RESTORE) {
    const value = await db.value('SELECT value FROM settings WHERE key = ?', [key]);
    if (value != null) keep.push({ key, value });
  }
  let info;
  try {
    info = await db.restore(opened.db, keep);
  } catch (e) {
    throw fail(400, e.message);
  }
  picked = null;
  // Without a backup password of its own yet, the phone keeps making backups with the one you just used.
  if (!keep.some((k) => k.key === 'backupKey')) await setBackupPassword(password).catch(() => {});
  emit('catalog', { reason: 'restore' });
  return info;
}
