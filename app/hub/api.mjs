// HTTP API and live events for the DriveAtlas interface.
// Every route checks the session on the server; inputs are validated in validate.mjs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { APP_DIR, PORT, VERSION, DATA_DIR, LOG_PATH, TEST_MODE } from './config.mjs';
import { Router, readJson, sendJson, parseCookies, serveFile, SECURITY_HEADERS } from './http.mjs';
import {
  hasOwner, getOwner, createOwner, verifyPassword, changePassword, createSession, getSession, deleteSession, httpError
} from './auth.mjs';
import { getSetting, setSetting } from './db.mjs';
import { diskKey } from './disks.mjs';
import {
  listDrives, getDrive, createDrive, updateDrive, deleteDrive, withLive, connectedView, summary, applyChanges, dismissChanges, matchDisk
} from './catalog.mjs';
import { browse, search, entryDetail, openInExplorer, currentScans, scanHistory } from './files.mjs';
import { uuid, plainObject, driveInput, searchInput, browseInput, folderPath, text, int, bool, oneOf } from './validate.mjs';
import { RateLimiter, LoginGuard } from './ratelimit.mjs';
import { findSmartctl, installSmartctl, readHealthElevated, applyHealth, healthHistory } from './health.mjs';
import { networkCheck, openWindowsPage } from './network.mjs';
import {
  rememberBackupKey, hasBackupKey, backupSettings, createBackup, recentBackups, stageRestore, moveCatalog, pruneBackups, MAX_BACKUP_BYTES, backupRunning
} from './backup.mjs';

const COOKIE = 'da_session';
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
const UI_DIR = path.join(APP_DIR, 'ui');
const SHARED_DIR = path.join(APP_DIR, 'shared');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export const SCAN_DEFAULTS = { media: true, fingerprint: true, hidden: true, keepScans: 3, exclude: [], live: true };
export const scanDefaults = (db) => ({ ...SCAN_DEFAULTS, ...getSetting(db, 'scanDefaults', {}) });

export function createHub({ db, watcher, scans, lan, live, restart, stop }) {
  const router = new Router();
  const clients = new Set();
  const general = new RateLimiter({ windowMs: 60_000, max: 600 });
  const writes = new RateLimiter({ windowMs: 60_000, max: 120 });
  const slow = new RateLimiter({ windowMs: 10_000, max: 1 });
  const guard = new LoginGuard();
  const uploads = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [id, u] of uploads) if (u.expires < now) { fs.rm(u.file, { force: true }, () => {}); uploads.delete(id); }
  }, 60_000).unref();

  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };

  // HttpOnly: page scripts cannot read it. SameSite=Strict: other sites cannot send it. Secure: localhost counts as secure.
  const sessionCookie = (token, maxAgeDays = 30) =>
    `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.round(maxAgeDays * 86400)}`;
  const withSession = (body, token) => ({ status: 200, body, headers: { 'Set-Cookie': sessionCookie(token) } });

  const throttle = (ctx, name) => {
    const wait = slow.take(`${name}:${ctx.ip}`);
    if (wait) throw httpError(429, `Please wait ${wait} seconds before trying that again.`, { retryAfter: wait });
  };

  // Checks a password with a growing lockout after repeated mistakes.
  async function checkPassword(ctx, password, message = 'That password is not right. Try again.') {
    const wait = guard.check(ctx.ip);
    if (wait) throw httpError(429, `Too many wrong passwords. Try again in ${wait} seconds.`, { retryAfter: wait });
    if (!(await verifyPassword(db, password))) {
      guard.fail(ctx.ip);
      await delay(400);
      throw httpError(401, message);
    }
    guard.success(ctx.ip);
  }

  // ---- Account ----
  router.on('GET', '/api/state', (ctx) => {
    const owner = hasOwner(db);
    return {
      version: VERSION,
      hasOwner: owner,
      signedIn: Boolean(ctx.session),
      owner: ctx.session ? getOwner(db) : null,
      dataDir: !owner || ctx.session ? DATA_DIR : null,
      settings: { theme: getSetting(db, 'theme', 'system') }
    };
  }, { public: true });

  router.on('POST', '/api/setup', async (ctx) => {
    const body = plainObject(await readJson(ctx.req));
    if (hasOwner(db)) throw httpError(409, 'This PC already has a DriveAtlas account. Sign in instead.');
    throttle(ctx, 'setup');
    await createOwner(db, body.name, body.password);
    await rememberBackupKey(db, body.password);
    return withSession({ ok: true }, createSession(db));
  }, { public: true });

  router.on('POST', '/api/login', async (ctx) => {
    const body = plainObject(await readJson(ctx.req));
    if (!hasOwner(db)) throw httpError(409, 'Create your account first.');
    await checkPassword(ctx, body.password);
    if (!hasBackupKey(db)) await rememberBackupKey(db, body.password);
    return withSession({ ok: true }, createSession(db));
  }, { public: true });

  router.on('POST', '/api/logout', (ctx) => {
    deleteSession(db, ctx.token);
    return { status: 200, body: { ok: true }, headers: { 'Set-Cookie': sessionCookie('', 0) } };
  });

  router.on('POST', '/api/account/password', async (ctx) => {
    const body = plainObject(await readJson(ctx.req));
    const wait = guard.check(ctx.ip);
    if (wait) throw httpError(429, `Too many wrong passwords. Try again in ${wait} seconds.`, { retryAfter: wait });
    try {
      await changePassword(db, body.current, body.next);
      guard.success(ctx.ip);
    } catch (err) {
      if (err.status === 401) { guard.fail(ctx.ip); await delay(400); }
      throw err;
    }
    await rememberBackupKey(db, body.next);
    return withSession({ ok: true }, createSession(db));
  });

  // ---- Settings ----
  router.on('PUT', '/api/settings', async (ctx) => {
    const body = plainObject(await readJson(ctx.req));
    const theme = oneOf(body.theme, 'Theme', ['system', 'light', 'dark']);
    if (theme) setSetting(db, 'theme', theme);
    return { theme: getSetting(db, 'theme', 'system') };
  });

  router.on('GET', '/api/settings/all', () => ({
    theme: getSetting(db, 'theme', 'system'),
    scan: scanDefaults(db),
    backup: backupSettings(db),
    backupKeyReady: hasBackupKey(db),
    recentBackups: recentBackups(db),
    dataDir: DATA_DIR,
    logPath: LOG_PATH,
    smartctl: findSmartctl(),
    version: VERSION,
    owner: getOwner(db),
    testMode: TEST_MODE
  }));

  // Stops the hub (Settings > Stop DriveAtlas). Start it again with DriveAtlas.vbs or the Start menu shortcut.
  router.on('POST', '/api/hub/stop', () => {
    if (scans.status().active) throw httpError(409, 'A scan is running. Cancel it or let it finish, then stop DriveAtlas.');
    if (backupRunning()) throw httpError(409, 'A backup is being made. Wait for it to finish, then stop DriveAtlas.');
    broadcast('stopping', {});
    stop();
    return { ok: true, stopping: true };
  });

  router.on('PUT', '/api/settings/backup', async (ctx) => {
    const body = plainObject(await readJson(ctx.req));
    const next = { ...backupSettings(db) };
    const enabled = bool(body.enabled, 'Daily backups');
    if (enabled !== undefined) next.enabled = enabled;
    if (body.folder !== undefined) {
      next.folder = body.folder === null || body.folder === '' ? null : folderPath(body.folder, 'Backup folder');
      if (next.folder) {
        try {
          fs.mkdirSync(next.folder, { recursive: true });
          const probe = path.join(next.folder, `.driveatlas-write-test-${crypto.randomBytes(4).toString('hex')}`);
          fs.writeFileSync(probe, 'ok');
          fs.rmSync(probe);
        } catch {
          throw httpError(400, 'DriveAtlas cannot write to that backup folder. Pick another one.');
        }
      }
    }
    const keep = int(body.keep, 'Backups to keep', 1, 60);
    if (keep !== undefined && keep !== null) next.keep = keep;
    if (next.enabled && !next.folder) throw httpError(400, 'Choose a backup folder before turning on daily backups.');
    setSetting(db, 'backup', next);
    return next;
  });

  router.on('POST', '/api/settings/catalog-folder', async (ctx) => {
    const body = plainObject(await readJson(ctx.req));
    throttle(ctx, 'move');
    if (scans.status().active) throw httpError(409, 'Wait for the current scan to finish before moving your catalog.');
    const r = await moveCatalog(body.folder);
    setTimeout(restart, 500);
    return { ok: true, restarting: true, ...r };
  });

  // Windows folder or file picker, shown on this PC's screen.
  router.on('POST', '/api/pick', async (ctx) => {
    const body = plainObject(await readJson(ctx.req));
    const kind = oneOf(body.kind, 'Picker', ['folder', 'backup']) || 'folder';
    throttle(ctx, 'pick');
    return { path: await pickPath(kind) };
  }, { publicIfNoOwner: true });

  // ---- Drives and connected disks ----
  router.on('GET', '/api/summary', () => ({ ...summary(db, watcher.disks), ready: watcher.ready }));
  router.on('GET', '/api/connected', () => ({ ready: watcher.ready, disks: connectedView(db, watcher.disks) }));
  router.on('POST', '/api/connected/refresh', async () => {
    await watcher.refresh();
    return { ready: watcher.ready, disks: connectedView(db, watcher.disks) };
  });

  const watchOf = () => (live ? live.status().drives : {});
  router.on('GET', '/api/drives', () => { const w = watchOf(); return { drives: withLive(db, watcher.disks).map((d) => ({ ...d, watch: w[d.id] || null })) }; });
  router.on('GET', '/api/live', () => (live ? live.status() : { enabled: false, drives: {} }));

  router.on('POST', '/api/drives', async (ctx) => {
    const body = plainObject(await readJson(ctx.req));
    const fields = driveInput(body, { create: true, typeFromDisk: body.fromDiskKey !== undefined });
    let disk = null;
    if (body.fromDiskKey !== undefined) {
      const key = text(body.fromDiskKey, 'Drive', 200, { required: true });
      disk = watcher.disks.find((d) => diskKey(d) === key);
      if (!disk) throw httpError(409, 'That drive is no longer connected. Plug it in again, or add it without detection.');
      if (matchDisk(listDrives(db), disk)) throw httpError(409, 'That drive is already in your catalog.');
    }
    const drive = createDrive(db, fields, disk);
    broadcast('catalog', { reason: 'created', id: drive.id });
    return { status: 201, body: { drive } };
  });

  router.on('GET', '/api/drives/:id', (ctx) => {
    const drive = getDrive(db, uuid(ctx.params.id, 'drive'));
    if (!drive) throw httpError(404, 'That drive is not in your catalog.');
    const conn = withLive(db, watcher.disks).find((d) => d.id === drive.id);
    const disk = watcher.disks.find((d) => matchDisk([drive], d));
    return { drive: { ...drive, ...pickLive(conn), watch: watchOf()[drive.id] || null }, disk: disk || null };
  });

  router.on('PATCH', '/api/drives/:id', async (ctx) => {
    const id = uuid(ctx.params.id, 'drive');
    const drive = updateDrive(db, id, driveInput(await readJson(ctx.req)));
    broadcast('catalog', { reason: 'updated', id });
    return { drive };
  });

  router.on('DELETE', '/api/drives/:id', (ctx) => {
    const id = uuid(ctx.params.id, 'drive');
    if (scans.status().active?.driveId === id) throw httpError(409, 'This drive is being scanned. Cancel the scan first.');
    deleteDrive(db, id);
    broadcast('catalog', { reason: 'deleted', id });
    return { ok: true };
  });

  router.on('POST', '/api/drives/:id/changes/apply', async (ctx) => {
    const id = uuid(ctx.params.id, 'drive');
    const body = plainObject(await readJson(ctx.req));
    const drive = getDrive(db, id);
    if (!drive) throw httpError(404, 'That drive is not in your catalog.');
    const status = oneOf(body.status, 'Status', ['inpc', 'stored', 'lent', 'retired']);
    const disk = watcher.disks.find((d) => matchDisk([drive], d)) || null;
    const updated = applyChanges(db, id, disk, { status });
    broadcast('catalog', { reason: 'changes-applied', id });
    return { drive: updated };
  });

  router.on('POST', '/api/drives/:id/changes/dismiss', (ctx) => {
    const id = uuid(ctx.params.id, 'drive');
    dismissChanges(db, id);
    broadcast('catalog', { reason: 'changes-dismissed', id });
    return { ok: true };
  });

  // ---- Scanning ----
  router.on('GET', '/api/scans', () => scans.status());

  // Quick catch-up: compares the drive with its file list and records only what changed.
  router.on('POST', '/api/drives/:id/catch-up', (ctx) => {
    const id = uuid(ctx.params.id, 'drive');
    if (!live || !live.enabled()) throw httpError(409, 'Turn on “Keep file lists up to date” in Settings first.');
    if (!live.catchUp(id)) throw httpError(409, 'Plug this drive in and scan it once on this PC; after that DriveAtlas keeps its file list up to date.');
    return { ok: true };
  });

  router.on('POST', '/api/drives/:id/scan', async (ctx) => {
    const body = plainObject(await readJson(ctx.req));
    const drive = getDrive(db, uuid(ctx.params.id, 'drive'));
    if (!drive) throw httpError(404, 'That drive is not in your catalog.');
    // Test catalogs only: scan a sample folder in place of a drive.
    if (TEST_MODE && typeof body.root === 'string') {
      return { ids: [scans.enqueue({ driveId: drive.id, partitionIdx: 1, root: body.root, label: 'Test folder' })] };
    }
    const disk = watcher.disks.find((d) => matchDisk([drive], d));
    if (!disk) throw httpError(409, 'Plug this drive in to scan it.');
    let wanted = null;
    if (body.partitions !== undefined) {
      if (!Array.isArray(body.partitions) || body.partitions.length > 128) throw httpError(400, 'Partitions must be a list.');
      wanted = new Set(body.partitions.map((n) => int(n, 'Partition', 0, 1024)));
    }
    const parts = disk.partitions.filter((p) => p.letter && p.fileSystem && (!wanted || wanted.has(p.number)));
    if (!parts.length) throw httpError(409, 'This drive has no partition Windows can read with a drive letter, so there is nothing to scan.');
    const ids = parts.map((p) => scans.enqueue({
      driveId: drive.id, partitionIdx: p.number, root: `${p.letter}:\\`, label: p.label ? `${p.label} (${p.letter}:)` : `${p.letter}:`,
      bytesEstimate: p.capacity != null && p.free != null ? p.capacity - p.free : null
    }));
    return { ids };
  });

  for (const action of ['pause', 'resume', 'cancel']) {
    router.on('POST', `/api/scans/:id/${action}`, (ctx) => {
      if (!scans[action](uuid(ctx.params.id, 'scan'))) throw httpError(409, 'That scan is not running or queued.');
      return scans.status();
    });
  }

  router.on('GET', '/api/drives/:id/scans', (ctx) => {
    const id = uuid(ctx.params.id, 'drive');
    return { current: currentScans(db, id), history: scanHistory(db, id) };
  });

  router.on('GET', '/api/drives/:id/browse', (ctx) => browse(db, { driveId: uuid(ctx.params.id, 'drive'), ...browseInput(ctx.url.searchParams) }));
  router.on('GET', '/api/search', (ctx) => search(db, searchInput(ctx.url.searchParams)));
  router.on('GET', '/api/entries/:id', (ctx) => ({ entry: entryDetail(db, int(ctx.params.id, 'File', 1, Number.MAX_SAFE_INTEGER)) }));
  router.on('POST', '/api/entries/:id/open', (ctx) => openInExplorer(db, int(ctx.params.id, 'File', 1, Number.MAX_SAFE_INTEGER), watcher.disks));

  router.on('GET', '/api/settings/scan', () => scanDefaults(db));
  router.on('PUT', '/api/settings/scan', async (ctx) => {
    const body = plainObject(await readJson(ctx.req));
    const next = { ...scanDefaults(db) };
    for (const k of ['media', 'fingerprint', 'hidden', 'live']) { const v = bool(body[k], k); if (v !== undefined) next[k] = v; }
    const keep = int(body.keepScans, 'Scan history', 1, 20);
    if (keep) next.keepScans = keep;
    if (body.exclude !== undefined) {
      if (!Array.isArray(body.exclude) || body.exclude.length > 100) throw httpError(400, 'Skipped folders must be a list of at most 100 items.');
      next.exclude = [...new Set(body.exclude.map((x) => text(x, 'A skipped folder', 240)).filter(Boolean))];
    }
    setSetting(db, 'scanDefaults', next);
    if (live) live.update();
    return next;
  });

  // ---- Health ----
  // ---- Linked phones (Wi-Fi sync) ----
  router.on('GET', '/api/devices', () => ({ ...lan.status(), devices: lan.devices() }));
  router.on('POST', '/api/devices/link', async (ctx) => { throttle(ctx, 'link'); return lan.beginPairing(); });
  router.on('POST', '/api/devices/:id/unlink', async (ctx) => { await lan.unlink(uuid(ctx.params.id, 'device')); return { ok: true }; });
  // Whether Windows lets a phone on the Wi-Fi reach this PC (network type and firewall rules; read-only).
  router.on('GET', '/api/devices/network', async () => {
    try { return await networkCheck(lan.status().addresses); } catch (e) { return { network: null, publicNetwork: null, firewall: 'unknown', error: e.message }; }
  });
  router.on('POST', '/api/devices/open-settings', async (ctx) => {
    const page = oneOf(plainObject(await readJson(ctx.req)).page, 'Page', ['network', 'firewall']);
    if (!page) throw httpError(400, 'Choose which settings page to open.');
    return { ok: TEST_MODE ? true : openWindowsPage(page), testMode: TEST_MODE };
  });

  router.on('GET', '/api/health', () => ({ smartctl: findSmartctl() }));
  router.on('POST', '/api/health/read', async (ctx) => {
    throttle(ctx, 'health');
    const raw = await readHealthElevated();
    const result = applyHealth(db, raw, watcher.disks);
    broadcast('catalog', { reason: 'health' });
    return result;
  });
  router.on('POST', '/api/health/install-smartctl', (ctx) => {
    throttle(ctx, 'install');
    if (findSmartctl()) return { ok: true, already: true };
    installSmartctl();
    return { ok: true };
  });
  router.on('GET', '/api/drives/:id/health', (ctx) => ({ history: healthHistory(db, uuid(ctx.params.id, 'drive')) }));

  // ---- Backups ----
  router.on('GET', '/api/backups', () => ({ settings: backupSettings(db), recent: recentBackups(db), keyReady: hasBackupKey(db) }));

  router.on('POST', '/api/backup/now', async (ctx) => {
    throttle(ctx, 'backup');
    const s = backupSettings(db);
    if (!s.folder) throw httpError(409, 'Choose a backup folder first.');
    const r = await createBackup(db, s.folder, 'manual');
    pruneBackups(s.folder, Math.max(s.keep, 1));
    return r;
  });

  router.on('GET', '/api/backup/download', async (ctx) => {
    throttle(ctx, 'backup');
    const dir = path.join(DATA_DIR, 'exports');
    const r = await createBackup(db, dir, 'download');
    const { res } = ctx;
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/octet-stream',
      'Content-Length': r.size,
      'Content-Disposition': `attachment; filename="${path.basename(r.path)}"`,
      'Cache-Control': 'no-store'
    });
    const stream = fs.createReadStream(r.path);
    stream.pipe(res);
    const cleanup = () => fs.rm(r.path, { force: true }, () => {});
    res.on('close', cleanup);
    return { stream: true };
  });

  router.on('POST', '/api/restore/upload', async (ctx) => {
    throttle(ctx, 'upload');
    const len = Number(ctx.req.headers['content-length'] || 0);
    if (!len || len > MAX_BACKUP_BYTES) throw httpError(413, 'That file is too large to be a DriveAtlas backup.');
    const id = crypto.randomBytes(16).toString('hex');
    const file = path.join(DATA_DIR, `.upload-${id}.dabackup`);
    let size = 0;
    const counter = new Transform({
      transform(chunk, _e, cb) {
        size += chunk.length;
        cb(size > MAX_BACKUP_BYTES ? httpError(413, 'That file is too large to be a DriveAtlas backup.') : null, chunk);
      }
    });
    try {
      await pipeline(ctx.req, counter, fs.createWriteStream(file, { flags: 'wx' }));
    } catch (err) {
      fs.rmSync(file, { force: true });
      throw err.status ? err : httpError(400, 'The upload did not finish. Try again.');
    }
    uploads.set(id, { file, expires: Date.now() + 30 * 60_000 });
    return { uploadId: id, size };
  }, { publicIfNoOwner: true, rawBody: true });

  router.on('POST', '/api/restore', async (ctx) => {
    const body = plainObject(await readJson(ctx.req));
    if (hasOwner(db)) {
      if (!ctx.session) throw httpError(401, 'Please sign in.');
      await checkPassword(ctx, body.currentPassword, 'Your current password is not right, so the catalog was not replaced.');
    }
    throttle(ctx, 'restore');
    if (scans.status().active) throw httpError(409, 'Wait for the current scan to finish before restoring.');
    let file;
    let upload = null;
    if (body.uploadId !== undefined) {
      upload = uploads.get(String(body.uploadId));
      if (!upload) throw httpError(404, 'That upload has expired. Choose the backup file again.');
      file = upload.file;
    } else {
      file = backupFile(body.path);
    }
    const info = await stageRestore(file, body.password);
    if (upload) { fs.rm(file, { force: true }, () => {}); uploads.delete(String(body.uploadId)); }
    setTimeout(restart, 500);
    return { ok: true, restarting: true, ...info };
  }, { publicIfNoOwner: true });

  // ---- Live events (Server-Sent Events) ----
  router.on('GET', '/api/events', (ctx) => {
    const { res } = ctx;
    if (clients.size >= 20) throw httpError(429, 'Too many open windows.');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', ...SECURITY_HEADERS });
    res.write(`event: hello\ndata: ${JSON.stringify({ ready: watcher.ready })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    ctx.req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return { stream: true };
  });

  async function handle(req, res) {
    try {
      // Only accept requests addressed to this PC (blocks DNS-rebinding tricks).
      if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) {
        res.writeHead(421, { 'Content-Type': 'text/plain' });
        return res.end('Misdirected request');
      }
      const ip = req.socket.remoteAddress || 'local';
      const general_wait = general.take(ip);
      if (general_wait) return sendJson(res, 429, { error: 'Too many requests. Slow down a little.' }, { 'Retry-After': String(general_wait) });

      const url = new URL(req.url, `http://${req.headers.host}`);
      const pathname = url.pathname;

      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
        if (pathname === '/' || pathname === '/index.html') return serveFile(res, UI_DIR, 'index.html');
        if (pathname.startsWith('/ui/') && serveFile(res, UI_DIR, pathname.slice(4))) return;
        if (pathname.startsWith('/vendor/') && serveFile(res, path.join(UI_DIR, 'vendor'), pathname.slice(8))) return;
        if (pathname.startsWith('/shared/') && serveFile(res, SHARED_DIR, pathname.slice(8))) return;
        return sendJson(res, 404, { error: 'Not found' });
      }

      const route = router.match(req.method, pathname);
      if (!route) return sendJson(res, 404, { error: 'Not found' });

      if (req.method !== 'GET') {
        // Writes must come from the app itself: a custom header cannot be sent cross-site,
        // and a browser marks requests from other sites in Origin / Sec-Fetch-Site.
        if (req.headers['x-driveatlas'] !== '1') return sendJson(res, 403, { error: 'Forbidden' });
        if (req.headers.origin && !ALLOWED_ORIGINS.has(req.headers.origin)) return sendJson(res, 403, { error: 'Forbidden' });
        if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return sendJson(res, 403, { error: 'Forbidden' });
        if (!route.opts.rawBody && req.headers['content-type'] && !String(req.headers['content-type']).startsWith('application/json')) {
          return sendJson(res, 415, { error: 'Send JSON.' });
        }
        const w = writes.take(ip);
        if (w) return sendJson(res, 429, { error: 'Too many changes at once. Slow down a little.' }, { 'Retry-After': String(w) });
      }

      const token = parseCookies(req.headers.cookie)[COOKIE];
      const session = getSession(db, token);
      const open = route.opts.public || (route.opts.publicIfNoOwner && !hasOwner(db));
      if (!open && !session) return sendJson(res, 401, { error: 'Please sign in.' });

      const out = await route.handler({ req, res, params: route.params, session, token, url, ip });
      if (out && out.stream) return;
      if (out && out.status && out.body) return sendJson(res, out.status, out.body, out.headers);
      return sendJson(res, 200, out ?? { ok: true });
    } catch (err) {
      const status = err.status || 500;
      // Logs carry the error only: never request bodies, passwords or cookies.
      if (status === 500) console.error(`[api] ${req.method} ${String(req.url).split('?')[0]}:`, err && err.stack ? err.stack : err);
      const headers = err.retryAfter ? { 'Retry-After': String(err.retryAfter) } : {};
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Something went wrong in the hub. Check its log.' : err.message }, headers);
      else res.end();
    }
  }

  return { handle, broadcast, clientCount: () => clients.size };
}

function pickLive(live) {
  if (!live) return {};
  const { connected, internal, letters, diskNumber, used, total, liveStatus, hasPendingChanges, files } = live;
  return { connected, internal, letters, diskNumber, used, total, liveStatus, hasPendingChanges, files };
}

// A backup file path typed or picked by you: a full path to an existing .dabackup file.
function backupFile(p) {
  const s = text(p, 'Backup file', 260, { required: true });
  if (!/^[a-zA-Z]:\\/.test(s) || /["<>|?*]/.test(s.slice(2)) || !s.toLowerCase().endsWith('.dabackup')) {
    throw httpError(400, 'Choose a DriveAtlas backup file (.dabackup).');
  }
  try { if (!fs.statSync(s).isFile()) throw new Error(); } catch { throw httpError(404, 'That backup file was not found.'); }
  return s;
}

// Shows the Windows picker on this PC's screen and returns the chosen path, or null.
function pickPath(kind) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(APP_DIR, 'hub', 'ps', 'pick.ps1'), '-Kind', kind], { windowsHide: true });
    let out = '';
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 5 * 60_000);
    child.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', () => { clearTimeout(timer); const p = out.trim(); resolve(p ? p.slice(0, 260) : null); });
  });
}
