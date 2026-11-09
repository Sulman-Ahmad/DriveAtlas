// Runs one scan in a background thread so the app stays responsive.
import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from '../db.mjs';
import { walkTree, finishScan, deleteScanData } from './walk.mjs';

const { dbPath, scanId, root, options, ctrl, keep } = workerData;
const db = openDb(dbPath);
const control = new Int32Array(ctrl);

try {
  db.prepare("UPDATE scans SET status = 'running', started_at = ? WHERE id = ?").run(Date.now(), scanId);
  const result = walkTree(db, {
    scanId, root, options, control,
    onProgress: (stats) => parentPort.postMessage({ type: 'progress', stats })
  });
  if (result.cancelled) {
    deleteScanData(db, scanId);
    parentPort.postMessage({ type: 'cancelled', totals: result });
  } else {
    finishScan(db, scanId, result, keep);
    parentPort.postMessage({ type: 'done', totals: result });
  }
} catch (err) {
  try {
    db.prepare("UPDATE scans SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run(String(err.message || err), Date.now(), scanId);
  } catch { /* database closed */ }
  parentPort.postMessage({ type: 'failed', error: String(err.message || err) });
} finally {
  db.close();
}
