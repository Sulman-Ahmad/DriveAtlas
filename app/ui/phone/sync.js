// Linking with DriveAtlas on a PC and two-way sync. Battery-friendly: the phone never syncs in the background.
// It syncs when the app opens or comes back to the front, a few seconds after something changes, and while
// the app is open it waits for the PC to say "something changed" with one short request at a time.
import { db } from './db.js';
import { seal, open, importKey, pairKey } from './crypto.js';
import { deviceId, phoneInfo } from './native.js';
import { emit, openEvents } from './events.js';
import { normalizeCode, parseAddress, upsertStatement, deleteStatements, sortForApply, ENTRY_COLUMNS, ENTRY_CHUNK, PHONE_ENTRY_LIMIT } from '/shared/sync.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const columns = new Map();
const cols = async (t) => {
  if (!columns.has(t)) columns.set(t, (await db.all(`PRAGMA table_info(${t})`)).map((c) => c.name));
  return columns.get(t);
};

export async function currentLink() {
  const l = await db.get("SELECT * FROM linked_devices WHERE role = 'pc' AND revoked_at IS NULL AND device_key IS NOT NULL ORDER BY created_at DESC LIMIT 1");
  if (!l) return null;
  const [host, port] = String(l.address || '').split(':');
  return { ...l, host, port: Number(port) };
}

async function request(url, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(body.headers || {}) }, body: JSON.stringify(body.json), signal: ctrl.signal });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw fail(res.status, j.error || `The PC answered ${res.status}.`);
    return j;
  } catch (err) {
    if (err.status) throw err;
    throw fail(503, 'Your PC is not reachable. Check that DriveAtlas is running on it and both are on the same Wi-Fi.');
  } finally {
    clearTimeout(timer);
  }
}

async function call(link, op, body, timeoutMs = 30000) {
  const me = await deviceId();
  const key = await importKey(link.device_key);
  const env = await seal(key, me, op, 'req', body);
  const reply = await request(`http://${link.host}:${link.port}/sync/${op}`, { json: env, headers: { 'X-DA-Device': me } }, timeoutMs);
  return open(key, me, op, 'res', reply);
}

// ---- Linking ----
export async function link({ address, code }) {
  const addr = parseAddress(address);
  if (!addr) throw fail(400, 'Type the PC address shown on your PC, like 192.168.1.20.');
  const c = normalizeCode(code);
  if (!c) throw fail(400, 'The link code has 16 letters and numbers, like K7Q2-M9XD-4TPA-HW3C.');
  const me = await deviceId();
  const info = await phoneInfo();
  const key = await pairKey(c);
  const env = await seal(key, me, 'pair', 'req', { name: info.name, platform: 'android', role: 'phone' });
  let answer;
  try {
    answer = await request(`http://${addr.host}:${addr.port}/pair`, { json: { deviceId: me, env } }, 30000);
  } catch (err) {
    if (err.status !== 503) throw err;
    throw fail(503, `Could not reach DriveAtlas on your PC at ${addr.host}. Check the address and that both are on the same Wi-Fi. If they are, Windows on the PC is probably keeping the phone out: DriveAtlas on the PC shows the fix next to the link code.`);
  }
  const reply = await open(key, me, 'pair', 'res', answer);
  const t = Date.now();
  await db.tx([
    { sql: "UPDATE linked_devices SET revoked_at = ?, device_key = NULL WHERE role = 'pc' AND id != ?", params: [t, reply.hubId] },
    { sql: `INSERT INTO linked_devices (id, name, platform, role, token_hash, device_key, address, created_at, last_seen_at, sent_seq, received_seq, revoked_at)
      VALUES (?, ?, 'windows', 'pc', 'pc', ?, ?, ?, ?, 0, 0, NULL)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, device_key = excluded.device_key, address = excluded.address, last_seen_at = excluded.last_seen_at,
        sent_seq = 0, received_seq = 0, revoked_at = NULL`, params: [reply.hubId, reply.hubName || 'PC', reply.deviceKey, `${addr.host}:${addr.port}`, t, t] },
    // One account across devices: the phone takes the PC's account ID and name.
    ...(reply.account ? [{ sql: 'UPDATE owner SET account_id = ?, name = ? WHERE id = 1', params: [reply.account.id, reply.account.name] }] : [])
  ]);
  await syncNow();
  kick();
  return { ok: true, name: reply.hubName };
}

export async function unlink() {
  await db.run("UPDATE linked_devices SET revoked_at = ?, device_key = NULL WHERE role = 'pc' AND revoked_at IS NULL", [Date.now()]);
  emit('sync', { state: 'unlinked' });
}

// ---- Sync ----
let running = null;
let lastState = 'idle';
export const syncState = () => lastState;

export function syncNow() {
  if (!running) running = doSync().finally(() => { running = null; });
  return running;
}

async function doSync() {
  const l = await currentLink();
  if (!l) return { linked: false };
  lastState = 'syncing';
  emit('sync', { state: lastState });
  let changed = false;
  try {
    changed = (await pushChanges(l)) || changed;
    changed = (await pushEntries(l)) || changed;
    changed = (await pullChanges(l)) || changed;
    changed = (await pullEntries(l)) || changed;
    await db.run('UPDATE linked_devices SET last_sync_at = ?, last_seen_at = ? WHERE id = ?', [Date.now(), Date.now(), l.id]);
    lastState = 'synced';
    emit('sync', { state: lastState });
    if (changed) emit('catalog', { reason: 'sync' });
    return { linked: true, changed };
  } catch (err) {
    lastState = err.status === 503 ? 'unreachable' : 'error';
    emit('sync', { state: lastState, error: err.message });
    throw err;
  }
}

async function pushChanges(l) {
  let since = l.sent_seq || 0;
  let any = false;
  for (;;) {
    const rows = await db.all(`SELECT table_name AS t, row_id AS id, MAX(seq) AS seq FROM change_log WHERE seq > ? AND (device_id IS NULL OR device_id != ?)
      GROUP BY table_name, row_id ORDER BY seq LIMIT 500`, [since, l.id]);
    if (!rows.length) return any;
    const changes = [];
    for (const r of rows) {
      const row = await db.get(`SELECT * FROM ${r.t} WHERE id = ?`, [r.id]).catch(() => null);
      if (r.t === 'scans' && row && row.status !== 'done') continue;
      if (row && r.t === 'scans') delete row.indexed;
      changes.push({ t: r.t, id: r.id, row: row || null });
    }
    if (changes.length) await call(l, 'push', { changes });
    since = rows[rows.length - 1].seq;
    await db.run('UPDATE linked_devices SET sent_seq = ? WHERE id = ?', [since, l.id]);
    any = true;
    if (rows.length < 500) return any;
  }
}

// File lists of scans made on this phone go to the PC once.
async function pushEntries(l) {
  const done = new Set(JSON.parse((await db.value("SELECT value FROM settings WHERE key = 'uploadedScans'")) || '[]'));
  const scans = await db.all("SELECT id FROM scans WHERE status = 'done' AND scanned_on = ? AND indexed = 1", [`phone:${await deviceId()}`]);
  let any = false;
  for (const { id } of scans) {
    if (done.has(id)) continue;
    let after = -1;
    for (;;) {
      const rows = (await db.all(`SELECT ${ENTRY_COLUMNS.join(', ')} FROM entries WHERE scan_id = ? AND eid > ? ORDER BY eid LIMIT ?`, [id, after, ENTRY_CHUNK]))
        .map((r) => ENTRY_COLUMNS.map((c) => r[c]));
      const last = rows.length < ENTRY_CHUNK;
      await call(l, 'entries-put', { scanId: id, rows, done: last }, 120000);
      if (last) break;
      after = rows[rows.length - 1][0];
    }
    done.add(id);
    any = true;
    await db.run("INSERT INTO settings(key, value) VALUES ('uploadedScans', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify([...done])]);
  }
  return any;
}

async function apply(l, changes) {
  const statements = [{ sql: 'UPDATE sync_ctx SET origin = ? WHERE id = 1', params: [l.id] }];
  for (const c of sortForApply(changes)) {
    if (c.row) statements.push(upsertStatement(c.t, { ...c.row, id: c.id }, await cols(c.t)));
    else statements.push(...deleteStatements(c.t, c.id));
  }
  statements.push({ sql: 'UPDATE sync_ctx SET origin = NULL WHERE id = 1', params: [] });
  await db.tx(statements);
}

async function pullChanges(l) {
  let since = l.received_seq || 0;
  let any = false;
  for (;;) {
    const r = await call(l, 'pull', { since, limit: 500 });
    if (r.changes.length) { await apply(l, r.changes); any = true; }
    since = r.next;
    await db.run('UPDATE linked_devices SET received_seq = ? WHERE id = ?', [since, l.id]);
    if (!r.more) return any;
  }
}

// File lists of the PC's scans come to the phone, unless they are too big for it.
async function pullEntries(l) {
  const scans = await db.all("SELECT id FROM scans WHERE status = 'done' AND indexed = 0 AND file_count + folder_count <= ?", [PHONE_ENTRY_LIMIT]);
  let any = false;
  for (const { id } of scans) {
    let after = -1;
    const insert = `INSERT OR IGNORE INTO entries (scan_id, ${ENTRY_COLUMNS.join(', ')}) VALUES (?, ${ENTRY_COLUMNS.map(() => '?').join(', ')})`;
    for (;;) {
      const r = await call(l, 'entries-get', { scanId: id, after }, 120000);
      if (r.missing) break;
      if (r.rows.length) await db.tx([{ sql: insert, rows: r.rows.map((row) => [id, ...row]) }]);
      if (r.done) {
        await db.tx([
          { sql: 'INSERT INTO entries_fts(rowid, name) SELECT id, name FROM entries WHERE scan_id = ? AND eid > 0', params: [id] },
          { sql: 'UPDATE sync_ctx SET origin = ? WHERE id = 1', params: [l.id] },
          { sql: 'UPDATE scans SET indexed = 1 WHERE id = ?', params: [id] },
          { sql: 'UPDATE sync_ctx SET origin = NULL WHERE id = 1', params: [] }
        ]);
        any = true;
        break;
      }
      after = r.rows[r.rows.length - 1][0];
    }
  }
  return any;
}

// ---- When to sync ----
let waiting = false;
let failures = 0;
let backoffUntil = 0;
let debounce = null;

// After a failed sync (PC off, other Wi-Fi), wait 30 s, then 1, 2, 4 minutes, up to 5 minutes, before trying again.
export function kick() {
  if (document.hidden || Date.now() < backoffUntil) return;
  syncNow().then(() => { failures = 0; backoffUntil = 0; listen(); }).catch(() => {
    failures += 1;
    backoffUntil = Date.now() + Math.min(5 * 60000, 30000 * 2 ** (failures - 1));
  });
}

// While the app is open: one short request at a time that returns when the PC has something new.
async function listen() {
  if (waiting) return;
  waiting = true;
  try {
    while (!document.hidden) {
      const l = await currentLink();
      if (!l) break;
      const r = await call(l, 'wait', { since: l.received_seq || 0, ms: 8000 }, 15000);
      if (r.changed) await syncNow();
    }
  } catch {
    failures += 1;
    backoffUntil = Date.now() + Math.min(5 * 60000, 30000 * 2 ** (failures - 1));
  } finally {
    waiting = false;
  }
}

export function startSync() {
  document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });
  const events = openEvents();
  const soon = () => { clearTimeout(debounce); debounce = setTimeout(kick, 5000); };
  events.addEventListener('catalog', (e) => { if (JSON.parse(e.data).reason !== 'sync') soon(); });
  events.addEventListener('scan-finished', soon);
  kick();
}
