// Queues scans, runs them one at a time in a worker thread, and reports progress.
import { Worker } from 'node:worker_threads';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { CTRL, deleteScanData } from './walk.mjs';

export class ScanManager extends EventEmitter {
  constructor(db, dbPath, getDefaults) {
    super();
    this.db = db;
    this.dbPath = dbPath;
    this.getDefaults = getDefaults;
    this.queue = [];
    this.active = null;
    this.recover();
  }

  // Scans left half-done by a crash or shutdown are removed; scan again to refresh.
  recover() {
    const stale = this.db.prepare("SELECT id FROM scans WHERE status IN ('queued', 'running')").all();
    for (const { id } of stale) deleteScanData(this.db, id);
  }

  enqueue({ driveId, partitionIdx = null, root, label = null, bytesEstimate = null, options }) {
    const same = (j) => j.driveId === driveId && j.partitionIdx === partitionIdx;
    if (this.active && same(this.active)) return this.active.id;
    const queued = this.queue.find(same);
    if (queued) return queued.id;
    const opts = { ...this.getDefaults(), ...(options || {}) };
    const id = crypto.randomUUID();
    this.db.prepare(`INSERT INTO scans (id, drive_id, partition_idx, root, started_at, scanned_on, options, status, partition_label, bytes_estimate)
      VALUES (?, ?, ?, ?, ?, 'This PC', ?, 'queued', ?, ?)`).run(id, driveId, partitionIdx, root, Date.now(), JSON.stringify(opts), label, bytesEstimate);
    const prev = this.db.prepare('SELECT file_count FROM scans WHERE drive_id = ? AND partition_idx IS ? AND is_current = 1').get(driveId, partitionIdx);
    this.queue.push({ id, driveId, partitionIdx, root, label, bytesEstimate, filesEstimate: prev ? prev.file_count : null, options: opts, state: 'queued' });
    this.emit('update');
    this.tick();
    return id;
  }

  tick() {
    if (this.active || !this.queue.length) return;
    const job = this.queue.shift();
    const shared = new SharedArrayBuffer(4);
    Object.assign(job, { control: new Int32Array(shared), stats: { files: 0, folders: 0, bytes: 0, skipped: 0, current: job.root },
      state: 'running', startedAt: Date.now(), pausedMs: 0, pausedAt: null });
    this.active = job;
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
      workerData: { dbPath: this.dbPath, scanId: job.id, root: job.root, options: job.options, ctrl: shared, keep: job.options.keepScans || 3 }
    });
    job.worker = worker;
    worker.on('message', (m) => {
      if (m.type === 'progress') { job.stats = m.stats; this.emit('progress', this.view(job)); return; }
      this.finish(job, m);
    });
    worker.on('error', (err) => this.finish(job, { type: 'failed', error: err.message }));
    worker.on('exit', (code) => { if (!job.finished) this.finish(job, { type: 'failed', error: `The scanner stopped unexpectedly (code ${code}).` }); });
    this.emit('update');
  }

  finish(job, m) {
    if (job.finished) return;
    job.finished = true;
    if (m.totals) job.stats = { ...job.stats, ...m.totals };
    job.state = m.type;
    job.error = m.error || null;
    this.active = null;
    this.emit('finished', this.view(job));
    this.emit('update');
    this.tick();
  }

  setControl(id, code) {
    if (this.active && this.active.id === id) {
      const job = this.active;
      if (code === CTRL.PAUSE && job.state === 'running') { job.state = 'paused'; job.pausedAt = Date.now(); }
      if (code === CTRL.RUN && job.state === 'paused') { job.state = 'running'; job.pausedMs += Date.now() - job.pausedAt; job.pausedAt = null; }
      if (code === CTRL.CANCEL) job.state = 'cancelling';
      Atomics.store(job.control, 0, code);
      Atomics.notify(job.control, 0);
      this.emit('update');
      return true;
    }
    if (code === CTRL.CANCEL) {
      const i = this.queue.findIndex((j) => j.id === id);
      if (i >= 0) {
        this.queue.splice(i, 1);
        deleteScanData(this.db, id);
        this.emit('update');
        return true;
      }
    }
    return false;
  }

  pause(id) { return this.setControl(id, CTRL.PAUSE); }
  resume(id) { return this.setControl(id, CTRL.RUN); }
  cancel(id) { return this.setControl(id, CTRL.CANCEL); }

  view(job) {
    const s = job.stats || { files: 0, folders: 0, bytes: 0 };
    const now = Date.now();
    const elapsed = job.startedAt ? Math.max(1, (job.pausedAt || now) - job.startedAt - (job.pausedMs || 0)) : 0;
    const percent = job.bytesEstimate ? Math.min(99, Math.floor((s.bytes / job.bytesEstimate) * 100)) : null;
    const byteRate = elapsed ? s.bytes / (elapsed / 1000) : 0;
    const etaSeconds = job.bytesEstimate && byteRate > 0 && s.bytes < job.bytesEstimate ? Math.round((job.bytesEstimate - s.bytes) / byteRate) : null;
    return {
      id: job.id, driveId: job.driveId, partitionIdx: job.partitionIdx, label: job.label, root: job.root, state: job.state,
      files: s.files, folders: s.folders, bytes: s.bytes, skipped: s.skipped || 0, current: s.current,
      bytesEstimate: job.bytesEstimate, filesEstimate: job.filesEstimate, percent, etaSeconds,
      filesPerSecond: elapsed ? Math.round(s.files / (elapsed / 1000)) : 0, elapsedSeconds: Math.round(elapsed / 1000),
      options: job.options, error: job.error || null
    };
  }

  status() {
    return { active: this.active ? this.view(this.active) : null, queue: this.queue.map((j) => this.view(j)) };
  }

  stop() {
    if (this.active) this.cancel(this.active.id);
  }
}
