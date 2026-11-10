// Keeps the phone's own file lists up to date: a quick catch-up when the app opens or a drive is plugged in, and
// live updates while the app is on screen (Android tells the app when a watched folder changes). Nothing runs in the
// background. Only what changed is written, and changed entries go to a linked PC as small batches.
// Works for drives scanned with All files access (scans made through the folder picker are updated by scanning again).
import { db, getSetting } from './db.js';
import { plugin, deviceId, readPhoneDisks } from './native.js';
import { emit } from './events.js';
import { entryEditStatements } from '/shared/sync.js';
import { extOf, kindOf, FLAG } from '/shared/kinds.js';

const CATCH_UP_EVERY = 30 * 60000;
const DETAILS_BATCH = 40;
const TX_CHUNK = 3000;
const OLD_COLS = 'e.id, e.eid, e.parent_eid, e.name, e.is_dir, e.size, e.items, e.modified_at, e.created_at, e.flags, e.fingerprint, e.width, e.height, e.duration_s, e.taken_at';

// Runs a native walk (names, sizes and dates only) and collects its rows. Resolves null when the folder is gone.
async function nativeWalk(path, maxDepth, options) {
  const p = plugin();
  const walkId = crypto.randomUUID();
  const rows = [];
  const handle = await p.addListener('walkBatch', (m) => { if (m && m.scanId === walkId && Array.isArray(m.entries)) rows.push(...m.entries); });
  try {
    const r = await p.walk({ walkId, path, maxDepth, options: { hidden: options.hidden !== false, exclude: options.exclude || [] } });
    if (r && r.gone) return null;
    if (r && r.error) throw new Error(r.error);
    if (r && r.cancelled) throw Object.assign(new Error('Stopped.'), { cancelled: true });
    return rows;
  } finally {
    await handle.remove();
  }
}

// Native rows -> nodes with paths relative to the walked folder ("a/b/c"), parents before children.
function nodesOf(rows) {
  const byEid = new Map([[0, { rel: '', key: '', depth: 0 }]]);
  const out = [];
  for (const r of rows) {
    const parent = byEid.get(r[1]);
    if (!parent) continue;
    const rel = parent.rel ? `${parent.rel}/${r[2]}` : r[2];
    const n = { rel, key: rel.toLowerCase(), parentKey: parent.key, depth: parent.depth + 1, name: r[2], isDir: Boolean(r[3]), size: r[3] ? 0 : r[4] || 0, mtime: r[5] || null, flags: r[6] || 0 };
    byEid.set(r[0], n);
    out.push(n);
  }
  return out;
}

// The catalog's entries under a folder, down to maxDepth levels (0: all), with the same relative paths.
async function oldNodes(scanId, baseEid, maxDepth) {
  const rows = await db.all(`WITH RECURSIVE sub(eid, depth) AS (SELECT ?, 0 UNION ALL SELECT e.eid, sub.depth + 1 FROM entries e JOIN sub ON e.parent_eid = sub.eid
      WHERE e.scan_id = ? AND (? = 0 OR sub.depth < ?))
    SELECT ${OLD_COLS}, sub.depth AS depth FROM sub JOIN entries e ON e.scan_id = ? AND e.eid = sub.eid WHERE sub.depth > 0 ORDER BY sub.depth`,
  [baseEid, scanId, maxDepth, maxDepth, scanId]);
  const relOf = new Map([[baseEid, '']]);
  for (const r of rows) {
    const p = relOf.get(r.parent_eid);
    r.rel = p ? `${p}/${r.name}` : r.name;
    r.key = r.rel.toLowerCase();
    relOf.set(r.eid, r.rel);
  }
  return rows;
}

const row = (eid, parent, name, isDir, size, items, mtime, created, flags, d) => {
  const ext = isDir ? null : extOf(name) || null;
  return [eid, parent, name, isDir ? 1 : 0, size, items, mtime, created, ext, isDir ? 'folder' : kindOf(ext), flags,
    d ? d[0] : null, d ? d[1] : null, d ? d[2] : null, d ? d[3] : null, d ? d[4] : null];
};

async function details(paths, options) {
  const out = new Map();
  if (!paths.length || (!options.fingerprint && !options.media)) return out;
  for (let i = 0; i < paths.length; i += DETAILS_BATCH) {
    const part = paths.slice(i, i + DETAILS_BATCH);
    const r = await plugin().fileDetails({ paths: part, fingerprint: options.fingerprint !== false, media: options.media !== false });
    part.forEach((p, j) => out.set(p, (r.items || [])[j] || null));
  }
  return out;
}

async function runChunks(statements) {
  for (let i = 0; i < statements.length; i += TX_CHUNK) await db.tx(statements.slice(i, i + TX_CHUNK));
}

/**
 * Compares one folder (rel, relative to the scan root; '' for the root) with the drive and records the differences.
 * recursive: every folder below too (a catch-up); otherwise only the folder's own entries (live updates).
 */
export async function refreshFolder(scan, rel, recursive) {
  const base = rel ? await resolve(scan.id, rel) : { eid: 0 };
  if (!base) return 0;
  const basePath = rel ? `${scan.root}/${rel}` : scan.root;
  const depth = recursive ? 0 : 1;
  const fresh = await nativeWalk(basePath, depth, scan.options);
  if (fresh === null) {
    // The folder itself is gone: compare its parent instead.
    return rel ? refreshFolder(scan, rel.split('/').slice(0, -1).join('/'), false) : 0;
  }
  const now = nodesOf(fresh);
  const before = await oldNodes(scan.id, base.eid, depth);
  const oldByKey = new Map(before.map((o) => [o.key, o]));
  const newByKey = new Map(now.map((n) => [n.key, n]));
  const statements = [];
  const touched = new Set();
  let nextEid = ((await db.value('SELECT MAX(eid) FROM entries WHERE scan_id = ?', [scan.id])) ?? 0) + 1;
  let changes = 0;

  // 1. Gone, or a file became a folder (or the other way round): removed with everything under it.
  const removed = new Set();
  for (const o of before) {
    const n = newByKey.get(o.key);
    if (n && n.isDir === Boolean(o.is_dir)) continue;
    const parentKey = o.key.includes('/') ? o.key.slice(0, o.key.lastIndexOf('/')) : '';
    if (removed.has(parentKey)) { removed.add(o.key); continue; }
    removed.add(o.key);
    const sub = await db.all(`WITH RECURSIVE sub(eid) AS (SELECT ? UNION ALL SELECT e.eid FROM entries e JOIN sub ON e.parent_eid = sub.eid WHERE e.scan_id = ?)
      SELECT eid FROM sub`, [o.eid, scan.id]);
    for (const s of sub) statements.push(...entryEditStatements(scan.id, s.eid, null));
    touched.add(o.parent_eid);
    changes += sub.length;
  }

  // 2. New and changed entries. Files that are new or changed are read once for their fingerprint and details.
  const assigned = new Map([['', base.eid]]);
  for (const o of before) if (!removed.has(o.key)) assigned.set(o.key, o.eid);
  const added = now.filter((n) => { const o = oldByKey.get(n.key); return !o || removed.has(n.key); });
  const changed = now.filter((n) => { const o = oldByKey.get(n.key); return o && !removed.has(n.key) && (o.name !== n.name || o.modified_at !== n.mtime || (o.flags & ~FLAG.DENIED) !== (n.flags & ~FLAG.DENIED) || (!n.isDir && o.size !== n.size)); });
  const needDetails = [...added.filter((n) => !n.isDir), ...changed.filter((n) => !n.isDir && (oldByKey.get(n.key).size !== n.size || oldByKey.get(n.key).modified_at !== n.mtime))]
    .map((n) => `${basePath}/${n.rel}`);
  const info = await details(needDetails, scan.options);
  const expand = [];
  for (const n of added) {
    const parent = assigned.get(n.parentKey);
    if (parent === undefined) continue;
    const eid = nextEid++;
    assigned.set(n.key, eid);
    statements.push(...entryEditStatements(scan.id, eid, row(eid, parent, n.name, n.isDir, n.size, n.isDir ? 0 : null, n.mtime, null, n.flags, n.isDir ? null : info.get(`${basePath}/${n.rel}`))));
    touched.add(parent);
    if (n.isDir) touched.add(eid);
    if (n.isDir && depth && !(n.flags & (FLAG.EXCLUDED | FLAG.DENIED | FLAG.LINK))) expand.push({ eid, path: `${basePath}/${n.rel}` });
    changes += 1;
  }
  for (const n of changed) {
    const o = oldByKey.get(n.key);
    const content = !n.isDir && (o.size !== n.size || o.modified_at !== n.mtime);
    const d = n.isDir ? null : content ? info.get(`${basePath}/${n.rel}`) : [o.fingerprint, o.width, o.height, o.duration_s, o.taken_at];
    statements.push(...entryEditStatements(scan.id, o.eid, row(o.eid, o.parent_eid, n.name, n.isDir, n.isDir ? o.size : n.size, o.items, n.mtime, o.created_at, n.flags, d)));
    touched.add(o.parent_eid);
    changes += 1;
  }
  await runChunks(statements);

  // 3. New folders found while looking at one folder: everything inside them is added too.
  for (const x of expand) {
    const inner = await nativeWalk(x.path, 0, scan.options);
    if (!inner) continue;
    const nodes = nodesOf(inner);
    const ids = new Map([['', x.eid]]);
    const files = await details(nodes.filter((n) => !n.isDir).map((n) => `${x.path}/${n.rel}`), scan.options);
    const more = [];
    for (const n of nodes) {
      const parent = ids.get(n.parentKey);
      if (parent === undefined) continue;
      const eid = nextEid++;
      ids.set(n.key, eid);
      more.push(...entryEditStatements(scan.id, eid, row(eid, parent, n.name, n.isDir, n.size, n.isDir ? 0 : null, n.mtime, null, n.flags, n.isDir ? null : files.get(`${x.path}/${n.rel}`))));
      if (n.isDir) touched.add(eid);
      touched.add(parent);
      changes += 1;
    }
    await runChunks(more);
  }

  // 4. Folder sizes and file counts, from the changed folders up to the top.
  if (changes) await db.recompute(scan.id, [...touched].filter((e) => e !== null && e !== undefined));
  return changes;
}

async function resolve(scanId, rel) {
  let eid = 0;
  for (const part of rel.split('/').filter(Boolean)) {
    const r = await db.get('SELECT eid, is_dir, flags FROM entries WHERE scan_id = ? AND parent_eid = ? AND name = ? COLLATE NOCASE LIMIT 1', [scanId, eid, part]);
    if (!r || !r.is_dir || (r.flags & (FLAG.EXCLUDED | FLAG.LINK))) return null;
    eid = r.eid;
  }
  return { eid };
}

// ---------- When to update ----------
class PhoneLive {
  constructor() {
    this.targets = new Map(); // scanId -> { scan, driveId, lastCatchUp, state }
    this.chain = Promise.resolve();
    this.pending = 0;
    this.listening = false;
    this.watching = false;
    this.isBusy = () => false; // set by the scanner: a full scan of that drive is running
  }

  async enabled() {
    return Boolean(plugin()) && (await getSetting('scanDefaults', {})).live !== false;
  }

  // The current scans this phone made of drives it can see now, scanned with All files access (a real path).
  async load() {
    const me = `phone:${await deviceId()}`;
    const disks = await readPhoneDisks({ fresh: true });
    const mounted = disks.flatMap((d) => d.partitions.map((p) => p.path)).filter(Boolean);
    const rows = await db.all("SELECT id, drive_id, root, options FROM scans WHERE is_current = 1 AND status = 'done' AND scanned_on = ?", [me]);
    const keep = new Set();
    for (const s of rows) {
      if (!s.root || !s.root.startsWith('/') || !mounted.some((m) => s.root === m || s.root.startsWith(`${m}/`))) continue;
      let options = {};
      try { options = JSON.parse(s.options || '{}'); } catch { options = {}; }
      const scan = { id: s.id, root: s.root.replace(/\/+$/, ''), options };
      const prev = this.targets.get(s.id);
      // Updated in place: work already queued for this scan reports into the same object.
      if (prev) Object.assign(prev, { scan, driveId: s.drive_id });
      else this.targets.set(s.id, { scan, driveId: s.drive_id, lastCatchUp: 0, state: 'watching', error: null });
      keep.add(s.id);
    }
    for (const id of [...this.targets.keys()]) if (!keep.has(id)) this.targets.delete(id);
  }

  run(t, work) {
    this.pending += 1;
    this.chain = this.chain.then(async () => {
      if (!this.targets.has(t.scan.id) || this.isBusy(t.driveId)) { t.state = 'watching'; emit('live', this.status()); return; }
      try {
        const changed = await work();
        if (changed) emit('catalog', { reason: 'live', id: t.driveId, changed });
      } catch (err) {
        if (!err.cancelled) t.error = err.message;
      } finally {
        t.state = 'watching';
        emit('live', this.status());
      }
    }).finally(() => { this.pending -= 1; });
    return this.chain;
  }

  catchUpTarget(t) {
    t.lastCatchUp = Date.now();
    t.state = 'catching-up';
    emit('live', this.status());
    return this.run(t, () => refreshFolder(t.scan, '', true));
  }

  // The app came to the front, a drive was plugged in, or the setting changed.
  async start({ force = false } = {}) {
    if (!(await this.enabled()) || document.hidden) { await this.stop(); return; }
    await this.load();
    await this.listen();
    for (const t of this.targets.values()) if (force || Date.now() - t.lastCatchUp > CATCH_UP_EVERY) this.catchUpTarget(t);
    const roots = [...this.targets.values()].map((t) => t.scan.root);
    if (roots.length) { await plugin().watchFolders({ roots, maxFolders: 4000 }).catch(() => {}); this.watching = true; }
    else await this.stopWatching();
    emit('live', this.status());
  }

  async listen() {
    if (this.listening) return;
    this.listening = true;
    await plugin().addListener('foldersChanged', (m) => this.onChanged((m && m.paths) || []));
  }

  onChanged(paths) {
    for (const p of paths) {
      const t = [...this.targets.values()].find((x) => p === x.scan.root || p.startsWith(`${x.scan.root}/`));
      if (!t) continue;
      const rel = p === t.scan.root ? '' : p.slice(t.scan.root.length + 1);
      if (t.state === 'watching') t.state = 'updating';
      this.run(t, () => refreshFolder(t.scan, rel, false));
    }
    emit('live', this.status());
  }

  async catchUp(driveId) {
    await this.load();
    const mine = [...this.targets.values()].filter((t) => t.driveId === driveId);
    for (const t of mine) this.catchUpTarget(t);
    return mine.length > 0;
  }

  async stopWatching() {
    if (this.watching && plugin()) await plugin().stopWatching().catch(() => {});
    this.watching = false;
  }

  async stop() {
    await this.stopWatching();
    if (plugin() && this.pending) await plugin().stopWalks().catch(() => {});
  }

  status() {
    const drives = {};
    for (const t of this.targets.values()) {
      const d = drives[t.driveId] || (drives[t.driveId] = { state: 'watching', lastChangeAt: null, error: null });
      if (t.state !== 'watching') d.state = t.state;
      if (t.error) d.error = t.error;
    }
    return { enabled: this.watching || this.targets.size > 0, drives };
  }
}

export const live = new PhoneLive();
