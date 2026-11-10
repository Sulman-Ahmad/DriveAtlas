// Scans on the phone: the Android side walks the folders and sends names in batches; this file stores them
// the same way the PC scanner does (entries, folder totals, search index, last N scans kept per partition).
import { db } from './db.js';
import { plugin, deviceId } from './native.js';
import { emit } from './events.js';
import { extOf, kindOf } from '/shared/kinds.js';

const INSERT = `INSERT INTO entries (scan_id, eid, parent_eid, name, is_dir, size, modified_at, created_at, ext, kind, flags,
  fingerprint, width, height, duration_s, taken_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

class PhoneScans {
  constructor() {
    this.queue = [];
    this.active = null;
    this.listeners = null;
  }

  async listen() {
    if (this.listeners) return;
    const p = plugin();
    if (!p) return;
    this.listeners = [
      await p.addListener('scanBatch', (m) => this.onBatch(m)),
      await p.addListener('scanProgress', (m) => this.onProgress(m))
    ];
  }

  enqueue(job) {
    const full = { id: crypto.randomUUID(), state: 'queued', stats: { files: 0, folders: 0, bytes: 0, skipped: 0 }, ...job };
    this.queue.push(full);
    emit('scan-update', this.status());
    this.tick();
    return full.id;
  }

  status() {
    return { active: this.active ? this.view(this.active) : null, queue: this.queue.map((j) => this.view(j)) };
  }

  view(job) {
    const s = job.stats;
    const now = Date.now();
    const elapsed = job.startedAt ? Math.max(1, (job.pausedAt || now) - job.startedAt - (job.pausedMs || 0)) : 0;
    const percent = job.bytesEstimate ? Math.min(99, Math.floor((s.bytes / job.bytesEstimate) * 100)) : null;
    const rate = elapsed ? s.bytes / (elapsed / 1000) : 0;
    const etaSeconds = job.bytesEstimate && rate > 0 && s.bytes < job.bytesEstimate ? Math.round((job.bytesEstimate - s.bytes) / rate) : null;
    return {
      id: job.id, driveId: job.driveId, partitionIdx: job.partitionIdx, label: job.label, root: job.path || job.uri || null, state: job.state,
      files: s.files, folders: s.folders, bytes: s.bytes, skipped: s.skipped || 0, current: s.current || null,
      bytesEstimate: job.bytesEstimate || null, filesEstimate: null, percent, etaSeconds,
      filesPerSecond: elapsed ? Math.round(s.files / (elapsed / 1000)) : 0, elapsedSeconds: Math.round(elapsed / 1000),
      options: job.options, error: job.error || null
    };
  }

  async tick() {
    if (this.active || !this.queue.length) return;
    const job = this.queue.shift();
    this.active = job;
    try {
      await this.run(job);
    } catch (err) {
      job.state = 'failed';
      job.error = err && err.message ? err.message : String(err);
      await this.discard(job).catch(() => {});
    }
    this.active = null;
    emit('scan-finished', this.view(job));
    emit('scan-update', this.status());
    if (job.state === 'done') emit('catalog', { reason: 'scan', id: job.driveId });
    this.tick();
  }

  async run(job) {
    const p = plugin();
    if (!p) throw new Error('Scanning needs the DriveAtlas app on Android.');
    await this.listen();
    job.state = 'running';
    job.startedAt = Date.now();
    job.write = Promise.resolve();
    job.parentOf = new Map();
    job.dirs = new Map(); // eid -> [size, items]
    job.dirs.set(0, [0, 0]);
    await db.tx([
      { sql: `INSERT INTO scans (id, drive_id, partition_idx, partition_label, root, started_at, scanned_on, options, status, bytes_estimate)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`, params: [job.id, job.driveId, job.partitionIdx, job.label, job.path || job.uri || null, job.startedAt, `phone:${await deviceId()}`, JSON.stringify(job.options), job.bytesEstimate || null] },
      { sql: INSERT, params: [job.id, 0, null, job.label, 1, 0, null, null, null, null, 0, null, null, null, null, null] }
    ]);
    emit('scan-update', this.status());
    const result = await p.scan({ scanId: job.id, path: job.path || null, uri: job.uri || null, options: job.options });
    await job.write;
    if (job.writeError) throw job.writeError;
    if (result && result.cancelled) { job.state = 'cancelled'; await this.discard(job); return; }
    if (result && result.error) throw new Error(result.error);
    job.stats.skipped = result?.skipped || 0;
    await this.finish(job);
    job.state = 'done';
  }

  onBatch(m) {
    const job = this.active;
    if (!job || !m || m.scanId !== job.id || !Array.isArray(m.entries)) return;
    const rows = [];
    for (const e of m.entries) {
      const [eid, parent, name, isDir, size, mtime, flags, fingerprint, width, height, duration, takenAt] = e;
      job.parentOf.set(eid, parent);
      if (isDir) {
        job.dirs.set(eid, [0, 0]);
        job.stats.folders += 1;
      } else {
        job.stats.files += 1;
        job.stats.bytes += size || 0;
      }
      const ext = isDir ? null : extOf(name);
      rows.push([job.id, eid, parent, name, isDir ? 1 : 0, isDir ? 0 : size || 0, mtime || null, null, ext, isDir ? null : kindOf(ext), flags || 0,
        fingerprint || null, width || null, height || null, duration || null, takenAt || null]);
      // Add the file to its folder's size and file count (folders are summed upwards when the scan ends).
      if (!isDir) { const d = job.dirs.get(parent); if (d) { d[0] += size || 0; d[1] += 1; } }
    }
    job.write = job.write.then(() => db.tx([{ sql: INSERT, rows }])).catch((err) => { job.writeError = err; });
    this.onProgress({ scanId: job.id, current: m.current });
  }

  onProgress(m) {
    const job = this.active;
    if (!job || !m || m.scanId !== job.id) return;
    if (m.current) job.stats.current = m.current;
    const now = Date.now();
    if (!job.lastEmit || now - job.lastEmit > 300) { job.lastEmit = now; emit('scan-progress', this.view(job)); }
  }

  async finish(job) {
    // Children always have a larger number than their folder, so add totals upwards in reverse order.
    const ids = [...job.dirs.keys()].sort((a, b) => b - a);
    for (const id of ids) {
      if (id === 0) continue;
      const parent = job.dirs.get(job.parentOf.get(id));
      const own = job.dirs.get(id);
      if (parent) { parent[0] += own[0]; parent[1] += own[1]; }
    }
    const keep = job.keep || 3;
    const old = await db.all(`SELECT id FROM scans WHERE drive_id = ? AND partition_idx IS ? AND status = 'done' AND id != ?
      ORDER BY finished_at DESC LIMIT -1 OFFSET ?`, [job.driveId, job.partitionIdx, job.id, keep - 1]);
    const t = Date.now();
    const statements = [
      { sql: 'UPDATE entries SET size = ?, items = ? WHERE scan_id = ? AND eid = ?', rows: ids.map((id) => [job.dirs.get(id)[0], job.dirs.get(id)[1], job.id, id]) },
      { sql: 'INSERT INTO entries_fts(rowid, name) SELECT id, name FROM entries WHERE scan_id = ? AND eid > 0', params: [job.id] },
      { sql: 'UPDATE scans SET is_current = 0 WHERE drive_id = ? AND partition_idx IS ? AND id != ?', params: [job.driveId, job.partitionIdx, job.id] },
      { sql: `UPDATE scans SET status = 'done', is_current = 1, indexed = 1, finished_at = ?, file_count = ?, folder_count = ?, total_bytes = ?, skipped = ? WHERE id = ?`,
        params: [t, job.stats.files, job.stats.folders, job.stats.bytes, job.stats.skipped || 0, job.id] },
      { sql: 'UPDATE drives SET last_scanned_at = ?, updated_at = ? WHERE id = ?', params: [t, t, job.driveId] }
    ];
    for (const { id } of old) statements.push(...deleteScanStatements(id));
    await db.tx(statements);
  }

  async discard(job) {
    await db.tx(deleteScanStatements(job.id));
  }

  async control(id, action) {
    const p = plugin();
    const queued = this.queue.findIndex((j) => j.id === id);
    if (action === 'cancel' && queued >= 0) { this.queue.splice(queued, 1); emit('scan-update', this.status()); return true; }
    const job = this.active;
    if (!job || job.id !== id || !p) return false;
    if (action === 'pause' && job.state === 'running') { await p.pauseScan(); job.state = 'paused'; job.pausedAt = Date.now(); }
    else if (action === 'resume' && job.state === 'paused') { await p.resumeScan(); job.pausedMs = (job.pausedMs || 0) + (Date.now() - job.pausedAt); job.pausedAt = null; job.state = 'running'; }
    else if (action === 'cancel') { job.state = 'cancelling'; await p.cancelScan(); }
    else return false;
    emit('scan-update', this.status());
    return true;
  }
}

// Removes a scan, its entries and, if they were indexed, their search index rows.
export function deleteScanStatements(scanId) {
  return [
    { sql: "INSERT INTO entries_fts(entries_fts, rowid, name) SELECT 'delete', e.id, e.name FROM entries e JOIN scans s ON s.id = e.scan_id WHERE s.id = ? AND s.indexed = 1 AND e.eid > 0", params: [scanId] },
    { sql: 'DELETE FROM entries WHERE scan_id = ?', params: [scanId] },
    { sql: 'DELETE FROM entry_log WHERE scan_id = ?', params: [scanId] },
    { sql: 'DELETE FROM scans WHERE id = ?', params: [scanId] }
  ];
}

export const scans = new PhoneScans();
