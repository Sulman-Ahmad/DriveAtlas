// Walks a folder tree and records every file and folder in the catalog database:
// names, sizes and dates, plus media details and quick fingerprints when asked.
// Read-only: files are opened only to read a few small chunks, never changed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readMedia, HEAD_BYTES } from './media.mjs';
import { extOf, kindOf, MEDIA_EXTS, FLAG } from '../../shared/kinds.js';

const FP_CHUNK = 64 * 1024;
const BATCH = 2000;
export const SYSTEM_NAMES = new Set(['$recycle.bin', 'system volume information', 'pagefile.sys', 'hiberfil.sys', 'swapfile.sys',
  'dumpstack.log.tmp', 'dumpstack.log', '$windows.~bt', '$windows.~ws', '$sysreset', '$winreagent', 'config.msi', 'msocache',
  'bootmgr', 'bootnxt', '$getcurrent', 'recovery', 'documents and settings']);
const HIDDEN_NAMES = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);

// Control codes shared with the main thread: 0 run, 1 pause, 2 cancel.
export const CTRL = { RUN: 0, PAUSE: 1, CANCEL: 2 };

export function flagsFor(name) {
  const low = name.toLowerCase();
  let f = 0;
  if (SYSTEM_NAMES.has(low)) f |= FLAG.SYSTEM | FLAG.HIDDEN;
  else if (low.startsWith('.') || HIDDEN_NAMES.has(low) || low.startsWith('~$')) f |= FLAG.HIDDEN;
  return f;
}

export function fingerprintAndHead(fd, size, wantHead) {
  const hash = crypto.createHash('sha1');
  hash.update(`${size}:`);
  const firstLen = Math.min(size, Math.max(FP_CHUNK, wantHead ? HEAD_BYTES : 0));
  const first = Buffer.alloc(firstLen);
  const n = fs.readSync(fd, first, 0, firstLen, 0);
  const head = first.subarray(0, n);
  if (size <= 2 * FP_CHUNK) {
    // Small file: hash it whole.
    if (size > n) {
      const rest = Buffer.alloc(size - n);
      fs.readSync(fd, rest, 0, rest.length, n);
      hash.update(head).update(rest);
    } else hash.update(head);
  } else {
    hash.update(head.subarray(0, FP_CHUNK));
    const last = Buffer.alloc(FP_CHUNK);
    fs.readSync(fd, last, 0, FP_CHUNK, size - FP_CHUNK);
    hash.update(last);
  }
  return { fp: hash.digest('hex').slice(0, 24), head };
}

// Builds a matcher for excluded folders: plain names ("node_modules") match
// anywhere; paths with a backslash ("Windows\WinSxS") match from the root.
export function excluder(list = []) {
  const names = new Set();
  const paths = new Set();
  for (const raw of list) {
    const x = String(raw).trim().replace(/\//g, '\\').replace(/^\\+|\\+$/g, '').toLowerCase();
    if (!x) continue;
    if (x.includes('\\')) paths.add(x.replace(/^[a-z]:\\/, '')); else names.add(x);
  }
  return (name, rel) => names.has(name.toLowerCase()) || paths.has(rel.toLowerCase());
}

/**
 * Scans `root` into the entries table under `scanId`.
 * options: { media, fingerprint, hidden, exclude: [] }
 * control: Int32Array (CTRL codes) or null; onProgress(stats) is called about 3 times a second.
 * Returns totals, or { cancelled: true }.
 */
export function walkTree(db, { scanId, root, options = {}, control = null, onProgress = () => {} }) {
  const insert = db.prepare(`INSERT INTO entries (scan_id, eid, parent_eid, name, is_dir, size, modified_at, created_at, ext, kind,
    flags, fingerprint, width, height, duration_s, taken_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const isExcluded = excluder(options.exclude);
  const rows = [];
  const flush = () => {
    if (!rows.length) return;
    db.exec('BEGIN');
    try { for (const r of rows) insert.run(...r); db.exec('COMMIT'); } catch (err) { db.exec('ROLLBACK'); throw err; }
    rows.length = 0;
  };

  const rootStat = fs.statSync(root);
  rows.push([scanId, 0, null, root, 1, 0, Math.round(rootStat.mtimeMs) || null, null, null, 'folder', 0, null, null, null, null, null]);
  const parentOf = new Map();
  const dirSize = new Map([[0, 0]]);
  const dirItems = new Map([[0, 0]]);
  const deniedDirs = [];
  const stack = [{ dir: root, rel: '', eid: 0 }];
  let nextEid = 1;
  const stats = { files: 0, folders: 0, bytes: 0, skipped: 0, current: root };
  let lastReport = 0;

  const report = (force) => {
    const now = Date.now();
    if (force || now - lastReport > 300) { lastReport = now; onProgress({ ...stats }); }
  };

  const checkControl = () => {
    if (!control) return false;
    while (Atomics.load(control, 0) === CTRL.PAUSE) Atomics.wait(control, 0, CTRL.PAUSE, 500);
    return Atomics.load(control, 0) === CTRL.CANCEL;
  };

  while (stack.length) {
    if (checkControl()) { flush(); return { cancelled: true, ...stats }; }
    const { dir, rel, eid: dirEid } = stack.pop();
    stats.current = dir;
    let list;
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      deniedDirs.push(dirEid);
      stats.skipped += 1;
      continue;
    }
    for (const de of list) {
      const name = de.name;
      const full = path.join(dir, name);
      const childRel = rel ? `${rel}\\${name}` : name;
      let flags = flagsFor(name);
      if (!options.hidden && flags) continue;
      let st = null;
      try { st = fs.lstatSync(full); } catch { flags |= FLAG.DENIED; }
      const id = nextEid++;
      const modified = st ? Math.round(st.mtimeMs) : null;
      const created = st && st.birthtimeMs ? Math.round(st.birthtimeMs) : null;
      if (st && st.isSymbolicLink()) flags |= FLAG.LINK;
      const isDir = !(flags & FLAG.LINK) && (de.isDirectory() || (st && st.isDirectory()));

      if (isDir) {
        if (isExcluded(name, childRel)) flags |= FLAG.EXCLUDED;
        rows.push([scanId, id, dirEid, name, 1, 0, modified, created, null, 'folder', flags, null, null, null, null, null]);
        parentOf.set(id, dirEid);
        dirSize.set(id, 0);
        dirItems.set(id, 0);
        stats.folders += 1;
        if (!(flags & (FLAG.EXCLUDED | FLAG.DENIED))) stack.push({ dir: full, rel: childRel, eid: id });
      } else {
        const size = st && !(flags & FLAG.LINK) ? st.size : 0;
        const ext = extOf(name);
        const kind = kindOf(ext);
        let fp = null;
        let media = {};
        const wantMedia = options.media && MEDIA_EXTS.has(ext);
        if (size > 0 && (options.fingerprint || wantMedia) && !(flags & (FLAG.DENIED | FLAG.LINK))) {
          let fd = null;
          try {
            fd = fs.openSync(full, 'r');
            let head = null;
            if (options.fingerprint) ({ fp, head } = fingerprintAndHead(fd, size, wantMedia));
            if (wantMedia) media = readMedia(fd, size, ext, head && head.length >= Math.min(size, HEAD_BYTES) ? head : null);
          } catch {
            // Locked or unreadable file (e.g. in use by Windows): keep its name and size only.
          } finally {
            if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
          }
        }
        rows.push([scanId, id, dirEid, name, 0, size, modified, created, ext || null, kind, flags, fp,
          media.width ?? null, media.height ?? null, media.duration ?? null, media.taken ?? null]);
        dirSize.set(dirEid, dirSize.get(dirEid) + size);
        dirItems.set(dirEid, dirItems.get(dirEid) + 1);
        stats.files += 1;
        stats.bytes += size;
      }
      if (rows.length >= BATCH) flush();
      report(false);
    }
  }
  flush();

  // Folder totals: children always have a larger id than their parent, so add upwards in reverse.
  const dirIds = [...dirSize.keys()].sort((a, b) => b - a);
  for (const id of dirIds) {
    if (id === 0) continue;
    const parent = parentOf.get(id);
    dirSize.set(parent, dirSize.get(parent) + dirSize.get(id));
    dirItems.set(parent, dirItems.get(parent) + dirItems.get(id));
  }
  const upd = db.prepare('UPDATE entries SET size = ?, items = ? WHERE scan_id = ? AND eid = ?');
  const deny = db.prepare('UPDATE entries SET flags = flags | ? WHERE scan_id = ? AND eid = ?');
  db.exec('BEGIN');
  try {
    for (const id of dirIds) upd.run(dirSize.get(id), dirItems.get(id), scanId, id);
    for (const id of deniedDirs) deny.run(FLAG.DENIED, scanId, id);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  report(true);
  return { cancelled: false, ...stats };
}

/**
 * Finishes a scan: indexes names for search, makes it the current scan for its
 * partition, keeps only the newest `keep` scans, and stamps the drive.
 */
export function finishScan(db, scanId, totals, keep = 3) {
  const scan = db.prepare('SELECT drive_id, partition_idx FROM scans WHERE id = ?').get(scanId);
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO entries_fts(rowid, name) SELECT id, name FROM entries WHERE scan_id = ? AND eid > 0').run(scanId);
    db.prepare('UPDATE scans SET is_current = 0 WHERE drive_id = ? AND partition_idx IS ? AND id != ?').run(scan.drive_id, scan.partition_idx, scanId);
    db.prepare(`UPDATE scans SET status = 'done', is_current = 1, indexed = 1, finished_at = ?, file_count = ?, folder_count = ?, total_bytes = ?, skipped = ?
      WHERE id = ?`).run(Date.now(), totals.files, totals.folders, totals.bytes, totals.skipped, scanId);
    db.prepare('UPDATE drives SET last_scanned_at = ? WHERE id = ?').run(Date.now(), scan.drive_id);
    const old = db.prepare(`SELECT id FROM scans WHERE drive_id = ? AND partition_idx IS ? AND status = 'done'
      ORDER BY finished_at DESC LIMIT -1 OFFSET ?`).all(scan.drive_id, scan.partition_idx, keep);
    for (const { id } of old) deleteScanData(db, id);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

// Removes a scan and its entries, keeping the search index in step. Only finished
// scans were added to the search index, so only those are removed from it.
export function deleteScanData(db, scanId) {
  const scan = db.prepare('SELECT indexed FROM scans WHERE id = ?').get(scanId);
  if (scan && scan.indexed) {
    db.prepare(`INSERT INTO entries_fts(entries_fts, rowid, name) SELECT 'delete', id, name FROM entries WHERE scan_id = ? AND eid > 0`).run(scanId);
  }
  db.prepare('DELETE FROM entries WHERE scan_id = ?').run(scanId);
  db.prepare('DELETE FROM entry_log WHERE scan_id = ?').run(scanId);
  db.prepare('DELETE FROM scans WHERE id = ?').run(scanId);
}
