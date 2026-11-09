// File maps: browse a drive's folders, search every drive, show one file's details.
import { spawn } from 'node:child_process';
import { httpError } from './auth.mjs';
import { matchDisk, listDrives } from './catalog.mjs';
import { FLAG } from '../shared/kinds.js';

const HIDDEN_MASK = FLAG.HIDDEN | FLAG.SYSTEM;
const ENTRY_COLS = `e.id, e.scan_id, e.eid, e.parent_eid, e.name, e.is_dir, e.size, e.items, e.modified_at, e.created_at, e.ext, e.kind,
  e.flags, e.fingerprint, e.width, e.height, e.duration_s, e.taken_at`;

// Looks up parent folders, remembering what it has seen during one request.
function pather(db) {
  const get = db.prepare('SELECT eid, parent_eid, name FROM entries WHERE scan_id = ? AND eid = ?');
  const cache = new Map();
  const node = (scanId, eid) => {
    const key = `${scanId}:${eid}`;
    if (!cache.has(key)) cache.set(key, get.get(scanId, eid) || null);
    return cache.get(key);
  };
  // Folders from the drive root down to (and including) eid, without the root itself.
  return (scanId, eid) => {
    const chain = [];
    let cur = node(scanId, eid);
    for (let guard = 0; cur && cur.parent_eid != null && guard < 512; guard++) {
      chain.unshift({ eid: cur.eid, name: cur.name });
      cur = node(scanId, cur.parent_eid);
    }
    return chain;
  };
}

const relPath = (chain) => '\\' + chain.map((c) => c.name).join('\\');

export function currentScans(db, driveId) {
  return db.prepare(`SELECT id, partition_idx, partition_label, root, finished_at, file_count, folder_count, total_bytes, skipped, options
    FROM scans WHERE drive_id = ? AND is_current = 1 ORDER BY partition_idx`).all(driveId)
    .map((s) => ({ ...s, options: JSON.parse(s.options || '{}') }));
}

export function scanHistory(db, driveId) {
  return db.prepare(`SELECT id, partition_idx, partition_label, root, started_at, finished_at, file_count, folder_count, total_bytes, status, is_current
    FROM scans WHERE drive_id = ? AND status = 'done' ORDER BY finished_at DESC`).all(driveId);
}

const SORTS = { name: 'e.name COLLATE NOCASE', size: 'e.size', modified: 'e.modified_at', kind: 'e.kind' };

export function browse(db, { driveId, scanId, dir = 0, sort = 'name', order = 'asc', hidden = false }) {
  const scans = currentScans(db, driveId);
  const scan = scanId ? scans.find((s) => s.id === scanId) || db.prepare("SELECT * FROM scans WHERE id = ? AND drive_id = ? AND status = 'done'").get(scanId, driveId) : scans[0];
  if (!scan) return { scans, scan: null, folder: null, path: [], entries: [] };
  const folder = db.prepare(`SELECT ${ENTRY_COLS} FROM entries e WHERE e.scan_id = ? AND e.eid = ?`).get(scan.id, Number(dir) || 0);
  if (!folder || !folder.is_dir) throw httpError(404, 'That folder is not in this scan.');
  const by = SORTS[sort] || SORTS.name;
  const dirSql = order === 'desc' ? 'DESC' : 'ASC';
  const entries = db.prepare(`SELECT ${ENTRY_COLS} FROM entries e WHERE e.scan_id = ? AND e.parent_eid = ? ${hidden ? '' : `AND (e.flags & ${HIDDEN_MASK}) = 0`}
    ORDER BY e.is_dir DESC, ${by} ${dirSql}, e.name COLLATE NOCASE LIMIT 5000`).all(scan.id, folder.eid);
  const hiddenCount = hidden ? 0 : db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE scan_id = ? AND parent_eid = ? AND (flags & ${HIDDEN_MASK}) != 0`).get(scan.id, folder.eid).n;
  return { scans, scan, folder, path: pather(db)(scan.id, folder.eid), entries, hiddenCount };
}

// Turns typed words into a full-text query: every word must match the start of a word in the name.
function ftsQuery(q) {
  const words = String(q || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return words.slice(0, 8).map((w) => `"${w}"*`).join(' ');
}

export function search(db, { q, kind, minSize, driveId, hidden = false, limit = 200 }) {
  const match = ftsQuery(q);
  if (!match) return { total: 0, results: [], tookMs: 0, namesSearched: 0 };
  const t0 = Date.now();
  const where = ['entries_fts MATCH ?', 's.is_current = 1'];
  const args = [match];
  if (kind === 'folder') where.push('e.is_dir = 1');
  else if (kind) { where.push('e.kind = ?'); args.push(kind); }
  if (minSize) { where.push('e.size >= ?'); args.push(Number(minSize)); }
  if (driveId) { where.push('s.drive_id = ?'); args.push(driveId); }
  if (!hidden) where.push(`(e.flags & ${HIDDEN_MASK}) = 0`);
  const from = `FROM entries_fts f JOIN entries e ON e.id = f.rowid JOIN scans s ON s.id = e.scan_id WHERE ${where.join(' AND ')}`;
  const rows = db.prepare(`SELECT ${ENTRY_COLS}, s.drive_id, s.partition_idx, s.finished_at AS scanned_at ${from}
    ORDER BY e.is_dir DESC, bm25(entries_fts), e.size DESC LIMIT ?`).all(...args, Math.min(Number(limit) || 200, 1000));
  const total = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 ${from} LIMIT 10000)`).get(...args).n;
  const pathOf = pather(db);
  const results = rows.map((r) => {
    const chain = pathOf(r.scan_id, r.parent_eid);
    return { ...r, folderPath: relPath(chain) + (chain.length ? '\\' : '') };
  });
  const namesSearched = db.prepare('SELECT COALESCE(SUM(file_count + folder_count), 0) AS n FROM scans WHERE is_current = 1').get().n;
  return { total, results, tookMs: Date.now() - t0, namesSearched };
}

export function entryDetail(db, id) {
  const e = db.prepare(`SELECT ${ENTRY_COLS}, s.drive_id, s.partition_idx, s.partition_label, s.finished_at AS scanned_at, s.is_current
    FROM entries e JOIN scans s ON s.id = e.scan_id WHERE e.id = ?`).get(Number(id));
  if (!e) throw httpError(404, 'That file is not in your catalog any more. Try searching again.');
  const pathOf = pather(db);
  const chain = pathOf(e.scan_id, e.eid);
  const copies = e.fingerprint && !e.is_dir ? db.prepare(`SELECT e.id, e.scan_id, e.eid, e.name, s.drive_id FROM entries e JOIN scans s ON s.id = e.scan_id
    WHERE e.fingerprint = ? AND e.size = ? AND e.id != ? AND s.is_current = 1 LIMIT 20`).all(e.fingerprint, e.size, e.id)
    .map((c) => ({ ...c, path: relPath(pathOf(c.scan_id, c.eid)) })) : [];
  return { ...e, path: relPath(chain), chain, copies };
}

// Opens a file's folder in Windows Explorer with the file selected, if its drive is plugged in.
export function openInExplorer(db, id, disks) {
  const e = entryDetail(db, id);
  const drive = listDrives(db).find((d) => d.id === e.drive_id);
  const disk = drive && disks.find((d) => matchDisk([drive], d));
  if (!disk) throw httpError(409, 'Plug this drive in to open the file.');
  const part = disk.partitions.find((p) => p.number === e.partition_idx) || disk.partitions.find((p) => p.letter);
  if (!part || !part.letter) throw httpError(409, 'This drive has no drive letter right now, so Explorer cannot open it.');
  const full = `${part.letter}:${e.path === '\\' ? '\\' : e.path}`;
  // Names come from the scanned drive. Refuse anything that could break out of the quoted argument.
  if (!/^[A-Za-z]$/.test(part.letter) || /["\u0000-\u001F]/.test(full)) throw httpError(400, 'This file name cannot be opened safely in Explorer.');
  const arg = e.is_dir ? `"${full}"` : `/select,"${full}"`;
  spawn('explorer.exe', [arg], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
  return { opened: full };
}
