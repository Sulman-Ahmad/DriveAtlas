// Keeps file lists up to date while drives are plugged in. Windows tells DriveAtlas when something changes in a
// watched folder (no polling, so an idle drive costs nothing); changes are gathered for a few seconds and then only
// those folders are compared with the catalog. When a drive is plugged in, or DriveAtlas starts, a quick catch-up
// scan picks up what changed while nobody was watching. Windows' own folders are never watched.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { matchDisk, listDrives } from './catalog.mjs';
import { excluder, flagsFor, CTRL } from './scan/walk.mjs';
import { SKIP_TOP, SKIP_IN_USER, SKIP_USERS, isDriveRoot, isSystemDrive, systemSkip } from './scan/skip.mjs';

const QUIET_MS = 2500;
const MAX_WAIT_MS = 10000;


// Which folders to watch for a scan root, and how. The Windows drive is watched folder by folder, leaving out
// Windows, Program Files, ProgramData and each user's AppData; any other drive is watched as a whole.
export function watchPlan(root) {
  const rootDir = isDriveRoot(root) ? `${root.slice(0, 2)}\\` : root;
  if (!isDriveRoot(root) || !fs.existsSync(path.join(rootDir, 'Windows', 'System32'))) return [{ dir: rootDir, base: '', recursive: true }];
  const plan = [{ dir: rootDir, base: '', recursive: false }];
  let top = [];
  try { top = fs.readdirSync(rootDir, { withFileTypes: true }); } catch { return plan; }
  for (const de of top) {
    const low = de.name.toLowerCase();
    if (!de.isDirectory() || SKIP_TOP.has(low) || flagsFor(de.name)) continue;
    if (low !== 'users') { plan.push({ dir: path.join(rootDir, de.name), base: de.name, recursive: true }); continue; }
    const usersDir = path.join(rootDir, de.name);
    plan.push({ dir: usersDir, base: de.name, recursive: false });
    let users = [];
    try { users = fs.readdirSync(usersDir, { withFileTypes: true }); } catch { continue; }
    for (const u of users) {
      if (!u.isDirectory() || SKIP_USERS.has(u.name.toLowerCase())) continue;
      const userDir = path.join(usersDir, u.name);
      const userBase = `${de.name}\\${u.name}`;
      plan.push({ dir: userDir, base: userBase, recursive: false });
      let inside = [];
      try { inside = fs.readdirSync(userDir, { withFileTypes: true }); } catch { continue; }
      for (const f of inside) {
        if (!f.isDirectory() || SKIP_IN_USER.has(f.name.toLowerCase()) || flagsFor(f.name)) continue;
        try { if (fs.lstatSync(path.join(userDir, f.name)).isSymbolicLink()) continue; } catch { continue; }
        plan.push({ dir: path.join(userDir, f.name), base: `${userBase}\\${f.name}`, recursive: true });
      }
    }
  }
  return plan;
}

// True when a changed path should be ignored: skipped folders, hidden or system names (if not recorded),
// and anything under folders the watch plan leaves out.
function ignorer(root, options) {
  const isExcluded = excluder(options.exclude);
  const systemDrive = isSystemDrive(root);
  return (rel) => {
    const parts = rel.split('\\').filter(Boolean);
    if (systemDrive && systemSkip(rel)) return true;
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      acc = acc ? `${acc}\\${parts[i]}` : parts[i];
      if (!options.hidden && flagsFor(parts[i])) return true;
      if (i < parts.length - 1 && isExcluded(parts[i], acc)) return true;
    }
    return false;
  };
}

export class LiveManager extends EventEmitter {
  constructor({ db, dbPath, getDisks, scans, getDefaults }) {
    super();
    Object.assign(this, { db, dbPath, getDisks, scans, getDefaults });
    this.targets = new Map(); // key drive:partition -> target
    this.waiting = []; // targets with changes ready to apply
    this.running = null;
    this.ctrl = new Int32Array(new SharedArrayBuffer(4));
    this.worker = null;
    this.stopped = false;
    scans.on('finished', () => this.update());
    scans.on('update', () => this.next());
  }

  enabled() { return this.getDefaults().live !== false; }

  // The current scan of each partition this PC made, for drives that are plugged in now.
  desired() {
    const out = new Map();
    if (!this.enabled()) return out;
    const disks = this.getDisks() || [];
    const drives = listDrives(this.db);
    const rows = this.db.prepare(`SELECT id, drive_id, partition_idx, root, options FROM scans
      WHERE is_current = 1 AND status = 'done' AND (scanned_on IS NULL OR scanned_on NOT LIKE 'phone:%')`).all();
    for (const s of rows) {
      let root = null;
      if (s.root && !isDriveRoot(s.root)) {
        // A folder that was scanned on its own (test catalogs): watched where it is.
        if (fs.existsSync(s.root)) root = s.root;
      } else {
        const drive = drives.find((d) => d.id === s.drive_id);
        const disk = drive && disks.find((dk) => matchDisk([drive], dk));
        const part = disk && disk.partitions.find((p) => p.number === s.partition_idx && p.letter);
        if (part) root = `${part.letter}:\\`;
      }
      if (!root) continue;
      let options = {};
      try { options = { ...this.getDefaults(), ...JSON.parse(s.options || '{}') }; } catch { options = this.getDefaults(); }
      options.exclude = this.getDefaults().exclude;
      options.systemDrive = isSystemDrive(root);
      out.set(`${s.drive_id}:${s.partition_idx}`, { key: `${s.drive_id}:${s.partition_idx}`, scanId: s.id, driveId: s.drive_id, partitionIdx: s.partition_idx, root, options });
    }
    return out;
  }

  // Called when drives are plugged in or out, a scan finishes, or the setting changes.
  update() {
    if (this.stopped) return;
    const want = this.desired();
    for (const [key, t] of this.targets) {
      const w = want.get(key);
      if (!w || w.root !== t.root) { this.close(t); this.targets.delete(key); continue; }
      if (w.scanId !== t.scanId) { t.scanId = w.scanId; t.options = w.options; } // a new full scan became current: keep the changes seen meanwhile
    }
    for (const [key, w] of want) {
      if (this.targets.has(key)) continue;
      const t = { ...w, watchers: [], dirty: new Map(), timer: null, firstAt: 0, state: 'watching', lastChangeAt: null, progress: null, error: null };
      this.targets.set(key, t);
      this.watch(t);
      // Plugged in or DriveAtlas just started: catch up on changes made while nobody was watching.
      t.dirty.set('', true);
      this.ready(t);
    }
    this.emit('status');
  }

  watch(t) {
    const ignore = ignorer(t.root, t.options);
    for (const p of watchPlan(t.root)) {
      try {
        const w = fs.watch(p.dir, { recursive: p.recursive, persistent: false }, (type, name) => {
          if (name === null || name === undefined) { this.mark(t, p.base, true); return; } // too many changes at once: check that folder fully
          const rel = (p.base ? `${p.base}\\${name}` : String(name)).replace(/\//g, '\\');
          if (ignore(rel)) return;
          const parent = rel.split('\\').slice(0, -1).join('\\');
          this.mark(t, parent, false);
          this.mark(t, rel, false);
        });
        w.on('error', () => { try { w.close(); } catch { /* closed */ } });
        t.watchers.push(w);
      } catch {
        // A folder that cannot be watched (no permission): the catch-up scan still covers it.
      }
    }
  }

  close(t) {
    clearTimeout(t.timer);
    for (const w of t.watchers) { try { w.close(); } catch { /* closed */ } }
    t.watchers = [];
    this.waiting = this.waiting.filter((x) => x !== t);
  }

  mark(t, rel, recursive) {
    if (!this.targets.has(t.key)) return;
    if (!t.dirty.size) t.firstAt = Date.now();
    t.dirty.set(rel, recursive || t.dirty.get(rel) === true);
    clearTimeout(t.timer);
    const wait = Math.max(0, Math.min(QUIET_MS, t.firstAt + MAX_WAIT_MS - Date.now()));
    t.timer = setTimeout(() => this.ready(t), wait);
  }

  ready(t) {
    clearTimeout(t.timer);
    if (!this.waiting.includes(t)) this.waiting.push(t);
    this.next();
  }

  // A full scan of the same partition is running: wait for it, the changes are applied to the new scan.
  busyWithFullScan(t) {
    const s = this.scans.status();
    return [s.active, ...s.queue].some((j) => j && j.driveId === t.driveId && j.partitionIdx === t.partitionIdx);
  }

  next() {
    if (this.running || this.stopped) return;
    const i = this.waiting.findIndex((t) => this.targets.get(t.key) === t && t.dirty.size && !this.busyWithFullScan(t));
    if (i < 0) return;
    const t = this.waiting.splice(i, 1)[0];
    const folders = [...t.dirty].map(([rel, recursive]) => ({ rel, recursive }));
    t.dirty = new Map();
    const catchUp = folders.some((f) => f.rel === '' && f.recursive);
    t.state = catchUp ? 'catching-up' : 'updating';
    t.progress = null;
    this.emit('status');
    const job = { id: crypto.randomUUID(), scanId: t.scanId, root: t.root, folders, options: t.options };
    this.running = { job, target: t, catchUp };
    this.startWorker();
    this.worker.postMessage(job);
  }

  startWorker() {
    if (this.worker) return;
    const w = new Worker(new URL('./scan/live-worker.mjs', import.meta.url), { workerData: { dbPath: this.dbPath, ctrl: this.ctrl.buffer } });
    w.on('message', (m) => this.onMessage(m));
    w.on('error', (err) => this.onMessage({ type: 'failed', id: this.running?.job.id, error: err.message }));
    w.on('exit', () => {
      if (this.worker === w) this.worker = null;
      if (this.running) this.onMessage({ type: 'failed', id: this.running.job.id, error: 'The file-list updater stopped.' });
    });
    this.worker = w;
  }

  onMessage(m) {
    const r = this.running;
    if (!r || m.id !== r.job.id) return;
    const t = r.target;
    if (m.type === 'progress') {
      if (r.catchUp) { t.progress = { folders: m.stats.folders, changed: m.stats.changed }; this.emit('status'); }
      return;
    }
    this.running = null;
    t.state = 'watching';
    t.progress = null;
    if (m.type === 'done') {
      t.error = null;
      if (m.result && m.result.changed) {
        t.lastChangeAt = Date.now();
        this.emit('changed', { driveId: t.driveId, scanId: t.scanId, changed: m.result.changed, catchUp: r.catchUp });
      }
      if (m.result && m.result.missing) this.update();
    } else {
      t.error = m.error || 'The file list could not be updated.';
      console.error('[live]', t.error);
    }
    this.emit('status');
    this.next();
  }

  // "Check for changes" on a drive page.
  catchUp(driveId) {
    let any = false;
    for (const t of this.targets.values()) {
      if (t.driveId !== driveId) continue;
      t.dirty.set('', true);
      this.ready(t);
      any = true;
    }
    return any;
  }

  status() {
    const drives = {};
    for (const t of this.targets.values()) {
      const d = drives[t.driveId] || (drives[t.driveId] = { state: 'watching', lastChangeAt: null, progress: null, error: null });
      if (t.state === 'catching-up' || (t.state === 'updating' && d.state === 'watching')) d.state = t.state;
      if (t.progress) d.progress = t.progress;
      if (t.lastChangeAt && (!d.lastChangeAt || t.lastChangeAt > d.lastChangeAt)) d.lastChangeAt = t.lastChangeAt;
      if (t.error) d.error = t.error;
    }
    return { enabled: this.enabled(), drives };
  }

  stop() {
    this.stopped = true;
    for (const t of this.targets.values()) this.close(t);
    this.targets.clear();
    Atomics.store(this.ctrl, 0, CTRL.CANCEL);
    if (this.worker) { try { this.worker.postMessage({ type: 'close' }); } catch { /* gone */ } }
  }
}
