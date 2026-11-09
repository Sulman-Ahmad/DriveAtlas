// DriveAtlas hub: starts the catalog database, the disk watcher and the web server.
//   node --disable-warning=ExperimentalWarning hub/main.mjs [--open]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PORT, HOST, OPEN_WINDOW, DATA_DIR, VERSION, BACKGROUND, LOG_PATH, DB_PATH } from './config.mjs';
import { ScanManager } from './scan/manager.mjs';

if (BACKGROUND) {
  const log = fs.createWriteStream(LOG_PATH, { flags: 'a' });
  const write = (level) => (...a) => log.write(`${new Date().toISOString()} ${level} ${a.map((x) => (x instanceof Error ? x.stack : String(x))).join(' ')}\n`);
  console.log = write('INFO');
  console.error = write('ERROR');
}
import { openDb } from './db.mjs';
import { DiskWatcher, diskKey } from './disks.mjs';
import { createHub, scanDefaults } from './api.mjs';
import { syncConnected, connectedView } from './catalog.mjs';

const db = openDb();
const watcher = new DiskWatcher();
const scans = new ScanManager(db, DB_PATH, () => scanDefaults(db));
const hub = createHub({ db, watcher, scans });

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
const url = `http://localhost:${PORT}/`;

watcher.on('change', ({ disks, added, removed, first }) => {
  const result = syncConnected(db, disks);
  hub.broadcast('disks', { disks: connectedView(db, disks) });
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

function findBrowser() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
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
  const profile = path.join(path.dirname(DATA_DIR), 'window');
  spawn(browser, [`--app=${url}`, `--user-data-dir=${profile}`, '--window-size=1320,880', '--no-first-run', '--no-default-browser-check'], {
    detached: true, stdio: 'ignore', windowsHide: false
  }).unref();
}

const server = http.createServer((req, res) => hub.handle(req, res));
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Already running: just bring up a window.
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
  watcher.start();
  if (OPEN_WINDOW) openWindow();
});

function shutdown() {
  scans.stop();
  watcher.stop();
  server.close();
  try { db.close(); } catch { /* already closed */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
