// Runs file-list refreshes (live changes and catch-up scans) one at a time in a background thread.
import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from '../db.mjs';
import { refreshScan } from './refresh.mjs';

const db = openDb(workerData.dbPath);
const control = new Int32Array(workerData.ctrl);

parentPort.on('message', (job) => {
  if (job.type === 'close') { try { db.close(); } catch { /* closed */ } parentPort.close(); return; }
  try {
    const result = refreshScan(db, {
      scanId: job.scanId, root: job.root, folders: job.folders, options: job.options, control,
      onProgress: (stats) => parentPort.postMessage({ type: 'progress', id: job.id, stats })
    });
    parentPort.postMessage({ type: 'done', id: job.id, result });
  } catch (err) {
    parentPort.postMessage({ type: 'failed', id: job.id, error: String(err && err.message ? err.message : err) });
  }
});
