// Keeps a finished scan's file list up to date in place. Each folder asked for is compared with what is on the
// drive now, and only the differences are written: new, changed, renamed and removed files and folders. Files whose
// size and date did not change are never opened again. Used for live watching (a few folders at a time) and for
// catch-up scans (every folder, recursive). Every changed entry is recorded in entry_log so linked devices receive
// just those entries. Read-only on the drive: files are opened only to read a few small chunks.
import fs from 'node:fs';
import path from 'node:path';
import { readMedia, HEAD_BYTES } from './media.mjs';
import { flagsFor, fingerprintAndHead, excluder, CTRL } from './walk.mjs';
import { extOf, kindOf, MEDIA_EXTS, FLAG } from '../../shared/kinds.js';
import { systemSkip } from './skip.mjs';

const BATCH = 2000;
const GONE = new Set(['ENOENT', 'ENOTDIR']);

/**
 * folders: [{ rel, recursive }] with rel relative to the scan root ('' is the root itself, parts joined by "\").
 * options: the scan options (media, fingerprint, hidden, exclude).
 * Returns { changed, folders, files, gone } or { missing: true } when the scan no longer exists.
 */
export function refreshScan(db, { scanId, root, folders, options = {}, control = null, onProgress = () => {} }) {
  const scan = db.prepare("SELECT id, indexed FROM scans WHERE id = ? AND status = 'done'").get(scanId);
  if (!scan) return { missing: true };
  const indexed = Boolean(scan.indexed);
  const isExcluded = excluder(options.exclude);
  // On the Windows drive, Windows' own folders and app settings are left as the last full scan recorded them.
  const skip = options.systemDrive ? systemSkip : () => false;
  const q = {
    child: db.prepare('SELECT eid, is_dir, flags FROM entries WHERE scan_id = ? AND parent_eid = ? AND name = ? COLLATE NOCASE LIMIT 1'),
    children: db.prepare(`SELECT id, eid, name, is_dir, size, items, modified_at, created_at, flags, fingerprint, width, height, duration_s, taken_at
      FROM entries WHERE scan_id = ? AND parent_eid = ?`),
    byEid: db.prepare('SELECT id, eid, parent_eid, name, is_dir, size, items, flags FROM entries WHERE scan_id = ? AND eid = ?'),
    insert: db.prepare(`INSERT INTO entries (scan_id, eid, parent_eid, name, is_dir, size, items, modified_at, created_at, ext, kind, flags,
      fingerprint, width, height, duration_s, taken_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateFile: db.prepare(`UPDATE entries SET name = ?, size = ?, modified_at = ?, created_at = ?, ext = ?, kind = ?, flags = ?, fingerprint = ?,
      width = ?, height = ?, duration_s = ?, taken_at = ? WHERE scan_id = ? AND eid = ?`),
    updateDir: db.prepare('UPDATE entries SET name = ?, modified_at = ?, flags = ? WHERE scan_id = ? AND eid = ?'),
    totals: db.prepare(`SELECT COALESCE(SUM(size), 0) AS size, COALESCE(SUM(CASE WHEN is_dir = 1 THEN COALESCE(items, 0) ELSE 1 END), 0) AS items
      FROM entries WHERE scan_id = ? AND parent_eid = ?`),
    setTotals: db.prepare('UPDATE entries SET size = ?, items = ? WHERE scan_id = ? AND eid = ?'),
    subtree: db.prepare(`WITH RECURSIVE sub(eid) AS (SELECT ? UNION ALL SELECT e.eid FROM entries e JOIN sub ON e.parent_eid = sub.eid WHERE e.scan_id = ?)
      SELECT e.id, e.eid, e.name, e.is_dir, e.size, e.modified_at, e.fingerprint, e.width, e.height, e.duration_s, e.taken_at
      FROM sub JOIN entries e ON e.scan_id = ? AND e.eid = sub.eid`),
    del: db.prepare('DELETE FROM entries WHERE scan_id = ? AND eid = ?'),
    ftsAdd: db.prepare('INSERT INTO entries_fts(rowid, name) VALUES (?, ?)'),
    ftsDel: db.prepare("INSERT INTO entries_fts(entries_fts, rowid, name) VALUES ('delete', ?, ?)"),
    log: db.prepare('INSERT INTO entry_log (scan_id, eid, deleted, device_id, changed_at) VALUES (?, ?, ?, NULL, ?)'),
    maxEid: db.prepare('SELECT MAX(eid) AS m FROM entries WHERE scan_id = ?')
  };

  // Writes are committed in batches so a big change never holds the catalog for long.
  let inTx = false;
  let ops = 0;
  const write = (fn) => {
    if (!inTx) { db.exec('BEGIN'); inTx = true; }
    const r = fn();
    if (++ops >= BATCH) { db.exec('COMMIT'); inTx = false; ops = 0; }
    return r;
  };
  const commit = () => { if (inTx) { db.exec('COMMIT'); inTx = false; ops = 0; } };
  const now = Date.now();
  const log = (eid, deleted = 0) => q.log.run(scanId, eid, deleted, now);

  let nextEid = (q.maxEid.get(scanId).m ?? 0) + 1;
  const stats = { changed: 0, folders: 0, files: 0, current: root };
  const touched = new Map(); // folder eid -> depth, folders whose totals must be worked out again
  const moved = new Map(); // "name|size|modified" -> fingerprint and media of a removed file, reused when it reappears
  const cancelled = () => control && Atomics.load(control, 0) === CTRL.CANCEL;
  let lastReport = 0;
  const report = (force) => { const t = Date.now(); if (force || t - lastReport > 400) { lastReport = t; onProgress({ ...stats }); } };

  const fullPath = (rel) => (rel ? path.join(root, rel) : root);
  const joinRel = (rel, name) => (rel ? `${rel}\\${name}` : name);
  const keyOf = (name, size, modified) => `${name.toLowerCase()}|${size}|${modified}`;

  function readFileInfo(full, size, ext, flags) {
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
        // Locked or unreadable (in use by another program): keep its name and size only.
      } finally {
        if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
    return { fp, width: media.width ?? null, height: media.height ?? null, duration: media.duration ?? null, taken: media.taken ?? null };
  }

  function insertRow(parentEid, name, isDir, size, items, modified, created, ext, kind, flags, info) {
    const eid = nextEid++;
    write(() => {
      const r = q.insert.run(scanId, eid, parentEid, name, isDir ? 1 : 0, size, items, modified, created, ext || null, kind, flags,
        info ? info.fp : null, info ? info.width : null, info ? info.height : null, info ? info.duration : null, info ? info.taken : null);
      if (indexed) q.ftsAdd.run(Number(r.lastInsertRowid), name);
      log(eid);
    });
    stats.changed += 1;
    return eid;
  }

  function newFile(parentEid, name, full, st, flags) {
    const size = st && !(flags & FLAG.LINK) ? st.size : 0;
    const modified = st ? Math.round(st.mtimeMs) : null;
    const created = st && st.birthtimeMs ? Math.round(st.birthtimeMs) : null;
    const ext = extOf(name);
    const reuse = moved.get(keyOf(name, size, modified));
    const info = reuse || readFileInfo(full, size, ext, flags);
    insertRow(parentEid, name, false, size, null, modified, created, ext, kindOf(ext), flags, info);
    stats.files += 1;
    return size;
  }

  // A folder that is new to the catalog: added with everything inside it, totals worked out on the way.
  function newFolder(parentEid, name, full, rel, st, flags) {
    const modified = st ? Math.round(st.mtimeMs) : null;
    const created = st && st.birthtimeMs ? Math.round(st.birthtimeMs) : null;
    const top = insertRow(parentEid, name, true, 0, 0, modified, created, null, 'folder', flags, null);
    stats.folders += 1;
    if (flags & (FLAG.EXCLUDED | FLAG.DENIED | FLAG.LINK) || skip(rel)) return;
    const parentOf = new Map();
    const size = new Map([[top, 0]]);
    const items = new Map([[top, 0]]);
    const denied = [];
    const stack = [{ dir: full, rel, eid: top }];
    while (stack.length) {
      if (cancelled()) break;
      const { dir, rel: dirRel, eid } = stack.pop();
      stats.current = dir;
      let list;
      try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { denied.push(eid); continue; }
      for (const de of list) {
        let f = flagsFor(de.name);
        if (!options.hidden && f) continue;
        const childFull = path.join(dir, de.name);
        const childRel = joinRel(dirRel, de.name);
        let cst = null;
        try { cst = fs.lstatSync(childFull); } catch { f |= FLAG.DENIED; }
        if (cst && cst.isSymbolicLink()) f |= FLAG.LINK;
        const isDir = !(f & FLAG.LINK) && (de.isDirectory() || (cst && cst.isDirectory()));
        if (isDir) {
          if (isExcluded(de.name, childRel)) f |= FLAG.EXCLUDED;
          const m = cst ? Math.round(cst.mtimeMs) : null;
          const c = cst && cst.birthtimeMs ? Math.round(cst.birthtimeMs) : null;
          const child = insertRow(eid, de.name, true, 0, 0, m, c, null, 'folder', f, null);
          stats.folders += 1;
          parentOf.set(child, eid);
          size.set(child, 0);
          items.set(child, 0);
          if (!(f & (FLAG.EXCLUDED | FLAG.DENIED)) && !skip(childRel)) stack.push({ dir: childFull, rel: childRel, eid: child });
        } else {
          const s = newFile(eid, de.name, childFull, cst, f);
          size.set(eid, size.get(eid) + s);
          items.set(eid, items.get(eid) + 1);
        }
        report(false);
      }
    }
    // Children always have larger ids than their parents, so add upwards from the largest.
    const ids = [...size.keys()].sort((a, b) => b - a);
    for (const id of ids) {
      if (id === top) continue;
      const p = parentOf.get(id);
      size.set(p, size.get(p) + size.get(id));
      items.set(p, items.get(p) + items.get(id));
    }
    for (const id of ids) write(() => { q.setTotals.run(size.get(id), items.get(id), scanId, id); log(id); });
    for (const id of denied) write(() => { db.prepare('UPDATE entries SET flags = flags | ? WHERE scan_id = ? AND eid = ?').run(FLAG.DENIED, scanId, id); });
  }

  // Removes an entry and everything under it; remembers removed files so a moved or renamed file is recognised.
  function remove(eid) {
    const rows = q.subtree.all(eid, scanId, scanId);
    for (const r of rows) {
      if (!r.is_dir && r.fingerprint) moved.set(keyOf(r.name, r.size, r.modified_at), { fp: r.fingerprint, width: r.width, height: r.height, duration: r.duration_s, taken: r.taken_at });
      write(() => {
        if (indexed && r.eid > 0) q.ftsDel.run(r.id, r.name);
        q.del.run(scanId, r.eid);
        log(r.eid, 1);
      });
      stats.changed += 1;
    }
  }

  // Compares one folder's entries in the catalog with the folder on the drive.
  function refreshFolder(rel, eid, depth, recursive, queue) {
    const dir = fullPath(rel);
    stats.current = dir;
    let list;
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (GONE.has(err.code)) return 'gone';
      write(() => { db.prepare('UPDATE entries SET flags = flags | ? WHERE scan_id = ? AND eid = ?').run(FLAG.DENIED, scanId, eid); });
      return 'denied';
    }
    const old = new Map();
    for (const r of q.children.all(scanId, eid)) old.set(r.name.toLowerCase(), r);
    const added = [];
    let changed = false;
    for (const de of list) {
      const name = de.name;
      let flags = flagsFor(name);
      if (!options.hidden && flags) continue;
      const full = path.join(dir, name);
      const childRel = joinRel(rel, name);
      let st = null;
      try { st = fs.lstatSync(full); } catch { flags |= FLAG.DENIED; }
      if (st && st.isSymbolicLink()) flags |= FLAG.LINK;
      const isDir = !(flags & FLAG.LINK) && (de.isDirectory() || (st && st.isDirectory()));
      if (isDir && isExcluded(name, childRel)) flags |= FLAG.EXCLUDED;
      const prev = old.get(name.toLowerCase());
      if (prev) old.delete(name.toLowerCase());
      if (!prev || Boolean(prev.is_dir) !== isDir) {
        if (prev) { remove(prev.eid); changed = true; }
        added.push({ name, full, childRel, st, flags, isDir });
        continue;
      }
      const modified = st ? Math.round(st.mtimeMs) : null;
      if (isDir) {
        const was = prev.flags & ~FLAG.DENIED;
        if (prev.name !== name || prev.modified_at !== modified || was !== flags) {
          write(() => {
            if (indexed && prev.name !== name) { q.ftsDel.run(prev.id, prev.name); q.ftsAdd.run(prev.id, name); }
            q.updateDir.run(name, modified, flags, scanId, prev.eid);
            log(prev.eid);
          });
          stats.changed += 1;
          changed = true;
        }
        const nowExcluded = Boolean(flags & FLAG.EXCLUDED);
        if (nowExcluded && !(was & FLAG.EXCLUDED)) {
          // Newly skipped folder: its contents leave the catalog.
          for (const c of q.children.all(scanId, prev.eid)) remove(c.eid);
          touched.set(prev.eid, depth + 1);
          changed = true;
        } else if (!nowExcluded && !(flags & FLAG.LINK) && !skip(childRel) && (recursive || (was & FLAG.EXCLUDED))) {
          queue.push({ rel: childRel, eid: prev.eid, depth: depth + 1, recursive: true });
        }
      } else {
        const size = st && !(flags & FLAG.LINK) ? st.size : 0;
        if (prev.name !== name || prev.size !== size || prev.modified_at !== modified || prev.flags !== flags) {
          const ext = extOf(name);
          const contentChanged = prev.size !== size || prev.modified_at !== modified;
          const info = contentChanged ? readFileInfo(full, size, ext, flags)
            : { fp: prev.fingerprint, width: prev.width, height: prev.height, duration: prev.duration_s, taken: prev.taken_at };
          const created = st && st.birthtimeMs ? Math.round(st.birthtimeMs) : prev.created_at;
          write(() => {
            if (indexed && prev.name !== name) { q.ftsDel.run(prev.id, prev.name); q.ftsAdd.run(prev.id, name); }
            q.updateFile.run(name, size, modified, created, ext || null, kindOf(ext), flags, info.fp, info.width, info.height, info.duration, info.taken, scanId, prev.eid);
            log(prev.eid);
          });
          stats.changed += 1;
          stats.files += 1;
          changed = true;
        }
      }
      report(false);
    }
    // What is no longer there goes first, so a renamed or moved file can reuse its fingerprint.
    for (const prev of old.values()) { remove(prev.eid); changed = true; }
    for (const a of added) {
      if (a.isDir) newFolder(eid, a.name, a.full, a.childRel, a.st, a.flags);
      else newFile(eid, a.name, a.full, a.st, a.flags);
      changed = true;
    }
    if (changed) touched.set(eid, depth);
    stats.folders += 1;
    report(false);
    return 'ok';
  }

  // Finds a folder in the catalog by its path; stops at the deepest folder that exists.
  function resolve(rel) {
    const parts = String(rel || '').split(/[\\/]+/).filter(Boolean);
    let eid = 0;
    for (let i = 0; i < parts.length; i++) {
      const r = q.child.get(scanId, eid, parts[i]);
      if (!r || !r.is_dir) return { eid, depth: i, rel: parts.slice(0, i).join('\\'), partial: true };
      if (r.flags & (FLAG.EXCLUDED | FLAG.LINK)) return null;
      eid = r.eid;
    }
    return { eid, depth: parts.length, rel: parts.join('\\'), partial: false };
  }

  const queue = [];
  for (const f of folders) {
    const r = resolve(f.rel);
    if (r && !(r.rel && skip(r.rel))) queue.push({ rel: r.rel, eid: r.eid, depth: r.depth, recursive: Boolean(f.recursive) && !r.partial });
  }
  const done = new Map(); // eid -> processed recursively?
  let gone = false;
  try {
    while (queue.length) {
      if (cancelled()) break;
      const job = queue.shift();
      const prior = done.get(job.eid);
      if (prior === true || (prior === false && !job.recursive)) continue;
      done.set(job.eid, job.recursive);
      const result = refreshFolder(job.rel, job.eid, job.depth, job.recursive, queue);
      if (result === 'gone') {
        if (job.eid === 0) { gone = true; break; }
        const parentRel = job.rel.split('\\').slice(0, -1).join('\\');
        const p = resolve(parentRel);
        if (p) { done.delete(p.eid); queue.push({ rel: p.rel, eid: p.eid, depth: p.depth, recursive: false }); }
      }
    }
    // Folder totals: the folders that changed, then every folder above them, deepest first.
    const all = new Map(touched);
    for (const [eid, depth] of touched) {
      let cur = q.byEid.get(scanId, eid);
      let d = depth;
      while (cur && cur.parent_eid !== null && cur.parent_eid !== undefined) {
        d -= 1;
        if (!all.has(cur.parent_eid) || all.get(cur.parent_eid) > d) all.set(cur.parent_eid, Math.max(d, 0));
        cur = q.byEid.get(scanId, cur.parent_eid);
      }
    }
    for (const [eid] of [...all].sort((a, b) => b[1] - a[1])) {
      const t = q.totals.get(scanId, eid);
      const cur = q.byEid.get(scanId, eid);
      if (cur && (cur.size !== t.size || cur.items !== t.items)) write(() => { q.setTotals.run(t.size, t.items, scanId, eid); log(eid); });
    }
    if (stats.changed) {
      write(() => {
        const c = db.prepare('SELECT COALESCE(SUM(is_dir), 0) AS dirs, COUNT(*) AS n FROM entries WHERE scan_id = ? AND eid > 0').get(scanId);
        const top = q.byEid.get(scanId, 0);
        db.prepare('UPDATE scans SET file_count = ?, folder_count = ?, total_bytes = ?, updated_at = ? WHERE id = ?')
          .run(c.n - c.dirs, c.dirs, top ? top.size : 0, Date.now(), scanId);
      });
    }
    commit();
  } catch (err) {
    if (inTx) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } inTx = false; }
    throw err;
  }
  report(true);
  return { changed: stats.changed, folders: stats.folders, files: stats.files, gone, cancelled: cancelled() };
}
