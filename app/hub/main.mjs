// DriveAtlas hub: starts the catalog database, the disk watcher and the web server.
//   node --disable-warning=ExperimentalWarning hub/main.mjs [--open] [--background]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  PORT, HOST, OPEN_WINDOW, DATA_DIR, DB_PATH, VERSION, BACKGROUND, LOG_PATH, WINDOW_PROFILE, RESTARTED, TEST_MODE, APP_DIR
} from './config.mjs';
import { applyStagedRestore, startBackupScheduler } from './backup.mjs';
import { openDb } from './db.mjs';
import { createLan } from './lan.mjs';
import { deleteExpiredSessions } from './auth.mjs';
import { DiskWatcher, diskKey } from './disks.mjs';
import { createHub, scanDefaults } from './api.mjs';
import { syncConnected, connectedView } from './catalog.mjs';
import { ScanManager } from './scan/manager.mjs';
import { LiveManager } from './live.mjs';

if (BACKGROUND) {
  const log = fs.createWriteStream(LOG_PATH, { flags: 'a' });
  const write = (level) => (...a) => log.write(`${new Date().toISOString()} ${level} ${a.map((x) => (x instanceof Error ? x.stack : String(x))).join(' ')}\n`);
  console.log = write('INFO');
  console.error = write('ERROR');
}
process.on('uncaughtException', (err) => { console.error('[fatal]', err); process.exit(1); });
process.on('unhandledRejection', (err) => { console.error('[unhandled]', err); });

// A restore chosen in the app is swapped in here, before the catalog opens.
const restored = applyStagedRestore();
const db = openDb();
// A restored catalog starts with nobody signed in (older backups may still hold sign-ins).
if (restored) db.exec('DELETE FROM sessions');
deleteExpiredSessions(db);
setInterval(() => deleteExpiredSessions(db), 6 * 3600 * 1000).unref();
// Leftovers from an interrupted backup, download or health reading.
for (const name of fs.readdirSync(DATA_DIR)) {
  if (/^\.(snapshot|health|upload)-/.test(name) || name.endsWith('.restore-check')) fs.rm(path.join(DATA_DIR, name), { force: true }, () => {});
}
fs.rm(path.join(DATA_DIR, 'exports'), { recursive: true, force: true }, () => {});

const watcher = new DiskWatcher();
const scans = new ScanManager(db, DB_PATH, () => scanDefaults(db));
const url = `http://localhost:${PORT}/`;
let server;
// Wi-Fi access for linked phones; runs only while a device is linked or a link code is waiting.
const lan = createLan({ db, onChange: (what) => hub.broadcast(what === 'devices' ? 'devices' : 'catalog', { reason: 'sync' }) });
// Keeps file lists up to date while drives are plugged in (Windows change notifications, no polling).
const live = new LiveManager({ db, dbPath: DB_PATH, getDisks: () => watcher.disks, scans, getDefaults: () => scanDefaults(db) });
const hub = createHub({ db, watcher, scans, lan, live, restart, stop: () => setTimeout(shutdown, 400) });
let liveTimer = null;
live.on('status', () => { if (!liveTimer) liveTimer = setTimeout(() => { liveTimer = null; hub.broadcast('live', live.status()); }, 300); });
live.on('changed', (c) => hub.broadcast('catalog', { reason: 'live', id: c.driveId, changed: c.changed }));

let lastProgress = 0;
scans.on('progress', (view) => {
  if (Date.now() - lastProgress < 250) return;
  lastProgress = Date.now();
  hub.broadcast('scan-progress', view);
});
scans.on('update', () => hub.broadcast('scan-update', scans.status()));
scans.on('finished', (view) => {
  hub.broadcast('scan-finished', view);
  hub.broadcast('catalog', { reason: 'scanned', id: view.driveId });
});

watcher.on('change', ({ disks, added, removed, first }) => {
  const result = syncConnected(db, disks);
  hub.broadcast('disks', { disks: connectedView(db, disks) });
  live.update();
  if (first) return;
  for (const disk of added) {
    const m = result.matched.find((x) => x.disk === disk);
    const changed = result.changed.find((x) => x.disk === disk);
    if (m) {
      hub.broadcast('plugged', {
        driveId: m.drive.id, name: m.drive.name, type: m.drive.type,
        letters: disk.partitions.map((p) => p.letter).filter(Boolean),
        lastScannedAt: m.drive.last_scanned_at, changes: changed ? changed.changes : []
      });
    } else {
      hub.broadcast('new-disk', { key: diskKey(disk), friendlyName: disk.friendlyName, size: disk.size, letters: disk.partitions.map((p) => p.letter).filter(Boolean) });
    }
  }
  for (const disk of removed) hub.broadcast('unplugged', { key: diskKey(disk), friendlyName: disk.friendlyName });
});
watcher.on('error', (err) => console.error('[disks]', err.message));

startBackupScheduler(db, (r) => {
  if (r.ok) console.log(`[backup] daily backup written (${Math.round(r.size / 1e6)} MB)`);
  else console.error('[backup] daily backup failed:', r.error);
  hub.broadcast('backup', r.ok ? { ok: true, size: r.size } : { ok: false, error: r.error });
});

function findBrowser() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  return [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')
  ].find((p) => fs.existsSync(p));
}

// Opens DriveAtlas in its own app window (no tabs or address bar), with its own profile.
export function openWindow() {
  const browser = findBrowser();
  if (!browser) { console.log(`Open ${url} in your browser.`); return; }
  spawn(browser, [`--app=${url}`, `--user-data-dir=${WINDOW_PROFILE}`, '--window-size=1320,880', '--no-first-run', '--no-default-browser-check'], {
    detached: true, stdio: 'ignore', windowsHide: false
  }).unref();
}

// Restarts the hub (after a restore or a catalog move). Open windows reconnect on their own.
function restart() {
  console.log('[hub] restarting');
  lan.stop();
  live.stop();
  scans.stop();
  watcher.stop();
  server.close();
  server.closeAllConnections();
  setTimeout(() => {
    try { db.close(); } catch { /* already closed */ }
    const args = process.argv.slice(1).filter((a) => a !== '--open' && a !== '--restarted');
    if (!args.includes('--background')) args.push('--background');
    args.push('--restarted');
    spawn(process.execPath, [...process.execArgv, ...args], { detached: true, stdio: 'ignore', env: process.env, cwd: APP_DIR, windowsHide: true }).unref();
    process.exit(0);
  }, 400);
}

server = http.createServer((req, res) => hub.handle(req, res));
server.headersTimeout = 20_000;
server.requestTimeout = 30 * 60_000; // long enough to upload a large backup file
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 64;

let listenTries = 0;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // After a restart the old hub may need a moment to let go of the port.
    if (RESTARTED && listenTries < 20) { listenTries += 1; setTimeout(() => server.listen(PORT, HOST), 300); return; }
    console.log(`DriveAtlas is already running at ${url}`);
    if (OPEN_WINDOW) openWindow();
    setTimeout(() => process.exit(0), 300);
    return;
  }
  throw err;
});
server.listen(PORT, HOST, () => {
  console.log(`DriveAtlas ${VERSION} running at ${url}`);
  console.log(`Catalog: ${DATA_DIR}`);
  if (restored) console.log('[hub] a backup was restored; the previous catalog was kept as driveatlas.db.before-restore');
  if (TEST_MODE) console.log('[hub] TEST MODE: sample-folder scans allowed. Never use test mode with your real catalog.');
  watcher.start();
  lan.update().catch((err) => console.error('[lan]', err.message));
  if (OPEN_WINDOW) openWindow();
});

// Stops the hub for good (Ctrl+C, Windows shutting down, or Stop DriveAtlas in Settings).
function shutdown() {
  console.log('[hub] stopping');
  lan.stop();
  live.stop();
  scans.stop();
  watcher.stop();
  server.close();
  server.closeAllConnections();
  try { db.close(); } catch { /* already closed */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
