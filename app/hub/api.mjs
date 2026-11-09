// HTTP API and live events for the DriveAtlas interface.
import path from 'node:path';
import { APP_DIR, PORT, VERSION, DATA_DIR } from './config.mjs';
import { Router, readJson, sendJson, parseCookies, serveFile, SECURITY_HEADERS } from './http.mjs';
import { hasOwner, getOwner, createOwner, verifyPassword, createSession, getSession, deleteSession, httpError } from './auth.mjs';
import { getSetting, setSetting } from './db.mjs';
import { diskKey } from './disks.mjs';
import {
  listDrives, getDrive, createDrive, updateDrive, deleteDrive, withLive, connectedView, summary,
  applyChanges, dismissChanges, matchDisk
} from './catalog.mjs';
import { browse, search, entryDetail, openInExplorer, currentScans, scanHistory } from './files.mjs';

export const SCAN_DEFAULTS = { media: true, fingerprint: true, hidden: true, keepScans: 3, exclude: [] };
export const scanDefaults = (db) => ({ ...SCAN_DEFAULTS, ...getSetting(db, 'scanDefaults', {}) });

const COOKIE = 'da_session';
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const UI_DIR = path.join(APP_DIR, 'ui');
const SHARED_DIR = path.join(APP_DIR, 'shared');

export function createHub({ db, watcher, scans }) {
  const router = new Router();
  const clients = new Set();

  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };

  const sessionCookie = (token, maxAgeDays = 30) =>
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.round(maxAgeDays * 86400)}`;

  // ---- Account ----
  router.on('GET', '/api/state', (ctx) => ({
    version: VERSION,
    hasOwner: hasOwner(db),
    signedIn: Boolean(ctx.session),
    owner: ctx.session ? getOwner(db) : null,
    dataDir: DATA_DIR,
    settings: { theme: getSetting(db, 'theme', 'system') }
  }), { public: true });

  router.on('POST', '/api/setup', async (ctx) => {
    const body = await readJson(ctx.req);
    createOwner(db, body.name, body.password);
    const token = createSession(db);
    return { status: 200, body: { ok: true }, headers: { 'Set-Cookie': sessionCookie(token) } };
  }, { public: true });

  router.on('POST', '/api/login', async (ctx) => {
    const body = await readJson(ctx.req);
    if (!hasOwner(db)) throw httpError(409, 'Create your account first.');
    if (!verifyPassword(db, body.password)) {
      await new Promise((r) => setTimeout(r, 600));
      throw httpError(401, 'That password is not right. Try again.');
    }
    const token = createSession(db);
    return { status: 200, body: { ok: true }, headers: { 'Set-Cookie': sessionCookie(token) } };
  }, { public: true });

  router.on('POST', '/api/logout', (ctx) => {
    deleteSession(db, ctx.token);
    return { status: 200, body: { ok: true }, headers: { 'Set-Cookie': sessionCookie('', 0) } };
  });

  // ---- Settings ----
  router.on('PUT', '/api/settings', async (ctx) => {
    const body = await readJson(ctx.req);
    if (body.theme !== undefined) {
      if (!['system', 'light', 'dark'].includes(body.theme)) throw httpError(400, 'Theme must be system, light or dark.');
      setSetting(db, 'theme', body.theme);
    }
    return { theme: getSetting(db, 'theme', 'system') };
  });

  // ---- Drives and connected disks ----
  router.on('GET', '/api/summary', () => ({ ...summary(db, watcher.disks), ready: watcher.ready }));
  router.on('GET', '/api/connected', () => ({ ready: watcher.ready, disks: connectedView(db, watcher.disks) }));
  router.on('POST', '/api/connected/refresh', async () => {
    await watcher.refresh();
    return { ready: watcher.ready, disks: connectedView(db, watcher.disks) };
  });

  router.on('GET', '/api/drives', () => ({ drives: withLive(db, watcher.disks) }));

  router.on('POST', '/api/drives', async (ctx) => {
    const body = await readJson(ctx.req);
    let disk = null;
    if (body.fromDiskKey) {
      disk = watcher.disks.find((d) => diskKey(d) === body.fromDiskKey);
      if (!disk) throw httpError(409, 'That drive is no longer connected. Plug it in again, or add it without detection.');
      if (matchDisk(listDrives(db), disk)) throw httpError(409, 'That drive is already in your catalog.');
    }
    const drive = createDrive(db, body, disk);
    broadcast('catalog', { reason: 'created', id: drive.id });
    return { status: 201, body: { drive } };
  });

  router.on('GET', '/api/drives/:id', (ctx) => {
    const drive = getDrive(db, ctx.params.id);
    if (!drive) throw httpError(404, 'That drive is not in your catalog.');
    const live = withLive(db, watcher.disks).find((d) => d.id === drive.id);
    const disk = watcher.disks.find((d) => matchDisk([drive], d));
    return { drive: { ...drive, ...pickLive(live) }, disk: disk || null };
  });

  router.on('PATCH', '/api/drives/:id', async (ctx) => {
    const drive = updateDrive(db, ctx.params.id, await readJson(ctx.req));
    broadcast('catalog', { reason: 'updated', id: drive.id });
    return { drive };
  });

  router.on('DELETE', '/api/drives/:id', (ctx) => {
    deleteDrive(db, ctx.params.id);
    broadcast('catalog', { reason: 'deleted', id: ctx.params.id });
    return { ok: true };
  });

  router.on('POST', '/api/drives/:id/changes/apply', async (ctx) => {
    const body = await readJson(ctx.req);
    const drive = getDrive(db, ctx.params.id);
    if (!drive) throw httpError(404, 'That drive is not in your catalog.');
    const disk = watcher.disks.find((d) => matchDisk([drive], d)) || null;
    const updated = applyChanges(db, drive.id, disk, { status: body.status });
    broadcast('catalog', { reason: 'changes-applied', id: drive.id });
    return { drive: updated };
  });

  router.on('POST', '/api/drives/:id/changes/dismiss', (ctx) => {
    dismissChanges(db, ctx.params.id);
    broadcast('catalog', { reason: 'changes-dismissed', id: ctx.params.id });
    return { ok: true };
  });

  // ---- Scanning ----
  router.on('GET', '/api/scans', () => scans.status());

  router.on('POST', '/api/drives/:id/scan', async (ctx) => {
    const body = await readJson(ctx.req);
    const drive = getDrive(db, ctx.params.id);
    if (!drive) throw httpError(404, 'That drive is not in your catalog.');
    // Test builds may scan any folder in place of a drive.
    if (process.env.DRIVEATLAS_TEST === '1' && body.root) {
      return { ids: [scans.enqueue({ driveId: drive.id, partitionIdx: 1, root: body.root, label: 'Test folder', options: body.options })] };
    }
    const disk = watcher.disks.find((d) => matchDisk([drive], d));
    if (!disk) throw httpError(409, 'Plug this drive in to scan it.');
    const wanted = Array.isArray(body.partitions) ? new Set(body.partitions.map(Number)) : null;
    const parts = disk.partitions.filter((p) => p.letter && p.fileSystem && (!wanted || wanted.has(p.number)));
    if (!parts.length) throw httpError(409, 'This drive has no partition Windows can read with a drive letter, so there is nothing to scan.');
    const ids = parts.map((p) => scans.enqueue({
      driveId: drive.id, partitionIdx: p.number, root: `${p.letter}:\\`, label: p.label ? `${p.label} (${p.letter}:)` : `${p.letter}:`,
      bytesEstimate: p.capacity != null && p.free != null ? p.capacity - p.free : null, options: body.options
    }));
    return { ids };
  });

  for (const action of ['pause', 'resume', 'cancel']) {
    router.on('POST', `/api/scans/:id/${action}`, (ctx) => {
      if (!scans[action](ctx.params.id)) throw httpError(409, 'That scan is not running or queued.');
      return scans.status();
    });
  }

  router.on('GET', '/api/drives/:id/scans', (ctx) => ({ current: currentScans(db, ctx.params.id), history: scanHistory(db, ctx.params.id) }));

  router.on('GET', '/api/drives/:id/browse', (ctx) => {
    const q = ctx.url.searchParams;
    return browse(db, { driveId: ctx.params.id, scanId: q.get('scan') || null, dir: q.get('dir') || 0, sort: q.get('sort') || 'name', order: q.get('order') || 'asc', hidden: q.get('hidden') === '1' });
  });

  router.on('GET', '/api/search', (ctx) => {
    const q = ctx.url.searchParams;
    return search(db, { q: q.get('q'), kind: q.get('kind') || null, minSize: q.get('minSize') || null, driveId: q.get('drive') || null, hidden: q.get('hidden') === '1' });
  });

  router.on('GET', '/api/entries/:id', (ctx) => ({ entry: entryDetail(db, ctx.params.id) }));
  router.on('POST', '/api/entries/:id/open', (ctx) => openInExplorer(db, ctx.params.id, watcher.disks));

  router.on('GET', '/api/settings/scan', () => scanDefaults(db));
  router.on('PUT', '/api/settings/scan', async (ctx) => {
    const body = await readJson(ctx.req);
    const next = { ...scanDefaults(db) };
    for (const k of ['media', 'fingerprint', 'hidden']) if (k in body) next[k] = Boolean(body[k]);
    if ('keepScans' in body) next.keepScans = Math.min(20, Math.max(1, Number(body.keepScans) || 3));
    if ('exclude' in body) {
      if (!Array.isArray(body.exclude)) throw httpError(400, 'Excluded folders must be a list.');
      next.exclude = [...new Set(body.exclude.map((x) => String(x).trim()).filter(Boolean))].slice(0, 100);
    }
    setSetting(db, 'scanDefaults', next);
    return next;
  });

  // ---- Live events (Server-Sent Events) ----
  router.on('GET', '/api/events', (ctx) => {
    const { res } = ctx;
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

      // Writes must come from the app itself (a custom header cannot be sent cross-site).
      if (req.method !== 'GET' && req.headers['x-driveatlas'] !== '1') return sendJson(res, 403, { error: 'Forbidden' });

      const token = parseCookies(req.headers.cookie)[COOKIE];
      const session = getSession(db, token);
      if (!route.opts.public && !session) return sendJson(res, 401, { error: 'Please sign in.' });

      const out = await route.handler({ req, res, params: route.params, session, token, url });
      if (out && out.stream) return;
      if (out && out.status && out.body) return sendJson(res, out.status, out.body, out.headers);
      return sendJson(res, 200, out ?? { ok: true });
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Something went wrong in the hub. Check its log.' : err.message });
      else res.end();
    }
  }

  return { handle, broadcast, clientCount: () => clients.size };
}

function pickLive(live) {
  if (!live) return {};
  const { connected, internal, letters, diskNumber, used, total, liveStatus, hasPendingChanges } = live;
  return { connected, internal, letters, diskNumber, used, total, liveStatus, hasPendingChanges };
}
