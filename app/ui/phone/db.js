// Talks to the phone's catalog database worker. Every call returns a promise.
let worker = null;
let seq = 0;
const waiting = new Map();

function start() {
  if (worker) return worker;
  worker = new Worker('/ui/phone/db-worker.js', { type: 'module' });
  worker.onmessage = (e) => {
    const { id, ok, result, error } = e.data || {};
    const w = waiting.get(id);
    if (!w) return;
    waiting.delete(id);
    if (ok) w.resolve(result); else w.reject(new Error(error));
  };
  worker.onerror = (e) => {
    const err = new Error(e.message || 'The catalog database stopped.');
    for (const w of waiting.values()) w.reject(err);
    waiting.clear();
  };
  return worker;
}

function send(msg) {
  start();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, ...msg });
  });
}

export const db = {
  info: () => send({ op: 'info' }),
  all: (sql, params = []) => send({ op: 'all', sql, params }),
  get: (sql, params = []) => send({ op: 'get', sql, params }),
  value: (sql, params = []) => send({ op: 'value', sql, params }),
  run: (sql, params = []) => send({ op: 'run', sql, params }),
  exec: (sql) => send({ op: 'exec', sql }),
  // statements: [{ sql, params } | { sql, rows: [[...]] } | { sql, params, select: true }], all in one transaction
  tx: (statements) => send({ op: 'tx', statements }),
  export: () => send({ op: 'export' }),
  backupCopy: () => send({ op: 'backupCopy' }),
  // keep: [{ key, value }] settings of this phone to carry over into the restored catalog
  restore: (bytes, keep) => send({ op: 'restore', bytes, keep })
};

export async function getSetting(key, fallback = null) {
  const v = await db.value('SELECT value FROM settings WHERE key = ?', [key]);
  return v == null ? fallback : JSON.parse(v);
}

export function setSetting(key, value) {
  return db.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, JSON.stringify(value)]);
}
