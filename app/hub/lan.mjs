// Wi-Fi access for linked phones (and later helper PCs). Off until you link a device; then a second listener runs
// on this PC's home-network address only. It answers paired devices only and offers sync only: settings, restore,
// moving the catalog, health readings and the password stay on the PC window.
// Every request and reply is encrypted with the device's own 256-bit key (AES-256-GCM); the device ID, a time
// stamp and a fresh IV are authenticated with it, so old messages cannot be replayed.
import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import { getSetting, setSetting, tx } from './db.mjs';
import { httpError } from './auth.mjs';
import { TEST_MODE } from './config.mjs';
import {
  SYNC_PORT, SYNC_VERSION, SYNC_TABLES, ENTRY_COLUMNS, ENTRY_CHUNK, ENTRY_EDIT_CHUNK, codeFromBytes, normalizeCode, formatCode,
  upsertStatement, deleteStatements, sortForApply, entryEditStatements
} from '../shared/sync.js';

const PAIR_MINUTES = 2;
const CLOCK_SKEW_MS = 10 * 60_000;
const MAX_BODY = 32 * 1024 * 1024;
const WAIT_MS = 25_000;

const isPrivate = (ip) => {
  const v4 = String(ip || '').replace(/^::ffff:/, '');
  const p = v4.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n))) return false;
  return p[0] === 10 || p[0] === 127 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
};

export function homeAddresses() {
  if (TEST_MODE) return ['127.0.0.1'];
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal && isPrivate(a.address)) out.push(a.address);
  }
  return [...new Set(out)];
}

// ---- Envelope encryption (same format as ui/phone/crypto.js) ----
// The envelope format has its own version, separate from the sync protocol version (SYNC_VERSION).
const ENVELOPE_VERSION = 1;
const aad = (device, op, ts, dir) => Buffer.from(`DA1|${device}|${op}|${ts}|${dir}`, 'utf8');

export function seal(key, device, op, dir, obj) {
  const iv = crypto.randomBytes(12);
  const ts = Date.now();
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad(device, op, ts, dir));
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final(), c.getAuthTag()]);
  return { v: ENVELOPE_VERSION, ts, iv: iv.toString('base64'), data: data.toString('base64') };
}

export function open(key, device, op, dir, env) {
  if (!env || env.v !== ENVELOPE_VERSION || typeof env.iv !== 'string' || typeof env.data !== 'string' || !Number.isFinite(env.ts)) throw httpError(400, 'Bad message.');
  const iv = Buffer.from(env.iv, 'base64');
  const buf = Buffer.from(env.data, 'base64');
  if (iv.length !== 12 || buf.length < 17) throw httpError(400, 'Bad message.');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(aad(device, op, env.ts, dir));
  d.setAuthTag(buf.subarray(buf.length - 16));
  let text;
  try { text = Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8'); } catch { throw httpError(401, 'Not authorised.'); }
  return JSON.parse(text);
}

export const pairKey = (code) => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(code, 'utf8'), Buffer.from('driveatlas-pair-v1', 'utf8'), Buffer.alloc(0), 32));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cleanText = (v, max) => String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);

export function createLan({ db, onChange = () => {} }) {
  const servers = [];
  let addresses = [];
  const pairings = new Map(); // code -> { expires, failures }
  const seen = new Map(); // `${device}:${iv}` -> expires (replay protection)
  const rate = new Map(); // ip -> { n, reset }
  const columns = new Map();

  const cols = (t) => {
    if (!columns.has(t)) columns.set(t, db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
    return columns.get(t);
  };
  const hubId = () => {
    let id = getSetting(db, 'hubId');
    if (!id) { id = crypto.randomUUID(); setSetting(db, 'hubId', id); }
    return id;
  };
  const account = () => db.prepare('SELECT account_id AS id, name FROM owner WHERE id = 1').get() || null;
  const maxSeq = (exceptDevice = null) => db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM change_log WHERE device_id IS NULL OR device_id != ?').get(exceptDevice ?? '').n;
  const maxEditSeq = (exceptDevice = null) => db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM entry_log WHERE device_id IS NULL OR device_id != ?').get(exceptDevice ?? '').n;
  // Changed entries are kept for 60 days; a device that has been away longer gets whole file lists again.
  {
    const old = db.prepare('SELECT MAX(seq) AS s FROM entry_log WHERE changed_at < ?').get(Date.now() - 60 * 86400000).s;
    if (old) { db.prepare('DELETE FROM entry_log WHERE seq <= ?').run(old); setSetting(db, 'entryLogFloor', old); }
  }
  const activeDevices = () => db.prepare('SELECT COUNT(*) AS n FROM linked_devices WHERE revoked_at IS NULL AND device_key IS NOT NULL').get().n;

  function prune() {
    const now = Date.now();
    for (const [code, p] of pairings) if (p.expires < now) pairings.delete(code);
    for (const [k, exp] of seen) if (exp < now) seen.delete(k);
  }

  async function startServers() {
    if (servers.length) return;
    addresses = homeAddresses();
    if (!addresses.length) throw httpError(409, 'This PC is not connected to a home network right now, so a phone cannot reach it.');
    for (const host of addresses) {
      const server = http.createServer((req, res) => handle(req, res).catch(() => { if (!res.headersSent) { res.writeHead(500); res.end(); } }));
      server.headersTimeout = 15_000;
      server.requestTimeout = 120_000;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(SYNC_PORT, host, () => { server.off('error', reject); resolve(); });
      });
      servers.push(server);
    }
  }

  function stopServers() {
    for (const s of servers.splice(0)) { s.close(); s.closeAllConnections?.(); }
    addresses = [];
  }

  // Keeps the listener running only while a device is linked or a link code is waiting.
  async function update() {
    prune();
    if (activeDevices() > 0 || pairings.size > 0) await startServers();
    else stopServers();
  }

  async function beginPairing() {
    await startServers();
    prune();
    const code = codeFromBytes(crypto.randomBytes(10));
    pairings.set(code, { expires: Date.now() + PAIR_MINUTES * 60_000, failures: 0 });
    setTimeout(() => { prune(); update().catch(() => {}); }, PAIR_MINUTES * 60_000 + 1000).unref();
    return { code: formatCode(code), address: addresses[0], addresses, port: SYNC_PORT, expiresAt: Date.now() + PAIR_MINUTES * 60_000 };
  }

  function devices() {
    return db.prepare(`SELECT id, name, platform, role, created_at, last_sync_at, last_seen_at, revoked_at FROM linked_devices
      WHERE revoked_at IS NULL ORDER BY created_at`).all();
  }

  async function unlink(id) {
    const r = db.prepare('UPDATE linked_devices SET revoked_at = ?, device_key = NULL WHERE id = ? AND revoked_at IS NULL').run(Date.now(), id);
    if (!r.changes) throw httpError(404, 'That device is not linked.');
    await update();
    onChange('devices');
  }

  // ---- Requests from devices ----
  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) throw httpError(413, 'Too large.');
      chunks.push(c);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw httpError(400, 'Bad message.'); }
  }

  function limited(ip) {
    const now = Date.now();
    const r = rate.get(ip) || { n: 0, reset: now + 60_000 };
    if (now > r.reset) { r.n = 0; r.reset = now + 60_000; }
    r.n += 1;
    rate.set(ip, r);
    return r.n > 600;
  }

  async function handle(req, res) {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(TEST_MODE ? cors : {}) });
      res.end(JSON.stringify(body));
    };
    // Test catalogs only: lets the interface, served on another local port, reach this listener from a browser.
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-DA-Device', 'Access-Control-Allow-Methods': 'POST' };
    try {
      const ip = req.socket.remoteAddress || '';
      if (!isPrivate(ip)) return send(403, { error: 'Forbidden' });
      if (TEST_MODE && req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
      if (limited(ip)) return send(429, { error: 'Too many requests.' });
      const url = new URL(req.url, 'http://x');
      if (req.method !== 'POST') return send(405, { error: 'Method not allowed' });
      if (url.pathname === '/pair') return send(200, await pair(await readBody(req)));
      const m = /^\/sync\/([a-z-]+)$/.exec(url.pathname);
      if (!m) return send(404, { error: 'Not found' });
      const op = m[1];
      const deviceId = String(req.headers['x-da-device'] || '');
      const dev = UUID.test(deviceId) ? db.prepare('SELECT * FROM linked_devices WHERE id = ? AND revoked_at IS NULL AND device_key IS NOT NULL').get(deviceId) : null;
      if (!dev) return send(401, { error: 'This device is not linked.' });
      const key = Buffer.from(dev.device_key, 'base64');
      const env = await readBody(req);
      const body = open(key, deviceId, op, 'req', env);
      if (Math.abs(Date.now() - env.ts) > CLOCK_SKEW_MS) throw httpError(401, 'The phone’s clock is too far from this PC’s. Set both to automatic time.');
      prune();
      const replayKey = `${deviceId}:${env.iv}`;
      if (seen.has(replayKey)) throw httpError(401, 'Not authorised.');
      seen.set(replayKey, Date.now() + 2 * CLOCK_SKEW_MS);
      const out = await dispatch(op, body, deviceId);
      db.prepare('UPDATE linked_devices SET last_seen_at = ?, last_sync_at = CASE WHEN ? THEN ? ELSE last_sync_at END WHERE id = ?')
        .run(Date.now(), op === 'pull' || op === 'push' ? 1 : 0, Date.now(), deviceId);
      return send(200, seal(key, deviceId, op, 'res', out));
    } catch (err) {
      return send(err.status || 500, { error: err.status ? err.message : 'Something went wrong on the PC.' });
    }
  }

  async function pair(body) {
    prune();
    const deviceId = String(body?.deviceId || '');
    if (!UUID.test(deviceId) || !body.env) throw httpError(400, 'Bad message.');
    // Try each waiting code (there is rarely more than one); a wrong guess counts against all of them.
    for (const [code, p] of pairings) {
      const key = pairKey(code);
      let msg;
      try { msg = open(key, deviceId, 'pair', 'req', body.env); } catch { continue; }
      pairings.delete(code);
      const deviceKey = crypto.randomBytes(32);
      const t = Date.now();
      db.prepare(`INSERT INTO linked_devices (id, name, platform, role, token_hash, device_key, created_at, last_seen_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET name = excluded.name, platform = excluded.platform, role = excluded.role,
        token_hash = excluded.token_hash, device_key = excluded.device_key, last_seen_at = excluded.last_seen_at, revoked_at = NULL`)
        .run(deviceId, cleanText(msg.name, 60) || 'Phone', cleanText(msg.platform, 20) || 'android', msg.role === 'helper' ? 'helper' : 'phone',
          crypto.createHash('sha256').update(deviceKey).digest('hex'), deviceKey.toString('base64'), t, t);
      onChange('devices');
      return seal(key, deviceId, 'pair', 'res', {
        deviceKey: deviceKey.toString('base64'), hubId: hubId(), hubName: cleanText(os.hostname(), 60) || 'PC', account: account(), seq: maxSeq(deviceId),
        editSeq: maxEditSeq(deviceId), version: SYNC_VERSION
      });
    }
    for (const p of pairings.values()) if ((p.failures += 1) >= 10) p.expires = 0;
    throw httpError(401, 'That code is not right, or it has expired. Show a new code on the PC.');
  }

  // ---- Sync operations ----
  async function dispatch(op, body, deviceId) {
    if (op === 'hello') return { hubId: hubId(), hubName: cleanText(os.hostname(), 60) || 'PC', account: account(), seq: maxSeq(deviceId), editSeq: maxEditSeq(deviceId), version: SYNC_VERSION };
    if (op === 'pull') return pull(Number(body.since) || 0, Math.min(Number(body.limit) || 500, 2000), deviceId);
    if (op === 'push') return push(Array.isArray(body.changes) ? body.changes : [], deviceId);
    if (op === 'entries-get') return entriesGet(String(body.scanId || ''), Number(body.after ?? -1));
    if (op === 'entries-put') return entriesPut(String(body.scanId || ''), body.rows, body.done === true, deviceId);
    if (op === 'edits-get') return editsGet(Number(body.since) || 0, Math.min(Number(body.limit) || ENTRY_EDIT_CHUNK, ENTRY_EDIT_CHUNK), deviceId);
    if (op === 'edits-put') return editsPut(Array.isArray(body.edits) ? body.edits : [], deviceId);
    if (op === 'wait') return waitForChanges(Number(body.since) || 0, deviceId, Math.min(Math.max(Number(body.ms) || WAIT_MS, 1000), WAIT_MS));
    throw httpError(404, 'Unknown operation.');
  }

  function pull(since, limit, deviceId) {
    const rows = db.prepare(`SELECT table_name AS t, row_id AS id, MAX(seq) AS seq FROM change_log WHERE seq > ? AND (device_id IS NULL OR device_id != ?)
      GROUP BY table_name, row_id ORDER BY seq LIMIT ?`).all(since, deviceId, limit);
    const changes = [];
    for (const r of rows) {
      if (!SYNC_TABLES.has(r.t)) continue;
      const row = db.prepare(`SELECT * FROM ${r.t} WHERE id = ?`).get(r.id);
      if (r.t === 'scans' && row && row.status !== 'done') continue; // sent once it has finished
      if (row && r.t === 'scans') delete row.indexed;
      changes.push({ t: r.t, id: r.id, row: row || null });
    }
    const next = rows.length ? rows[rows.length - 1].seq : since;
    return { changes, next, more: rows.length === limit, seq: maxSeq(deviceId) };
  }

  function push(changes, deviceId) {
    if (changes.length > 5000) throw httpError(413, 'Too many changes at once.');
    const ordered = sortForApply(changes.filter((c) => c && SYNC_TABLES.has(c.t) && typeof c.id === 'string' && c.id.length <= 64));
    let applied = 0;
    tx(db, () => {
      db.prepare('UPDATE sync_ctx SET origin = ? WHERE id = 1').run(deviceId);
      try {
        for (const c of ordered) {
          const statements = c.row ? [upsertStatement(c.t, { ...c.row, id: c.id }, cols(c.t))] : deleteStatements(c.t, c.id);
          for (const s of statements) db.prepare(s.sql).run(...s.params);
          applied += 1;
        }
      } finally {
        db.prepare('UPDATE sync_ctx SET origin = NULL WHERE id = 1').run();
      }
    });
    if (applied) onChange('catalog');
    return { applied, seq: maxSeq(deviceId) };
  }

  function entriesGet(scanId, after) {
    const scan = db.prepare("SELECT id, indexed FROM scans WHERE id = ? AND status = 'done'").get(scanId);
    if (!scan || !scan.indexed) return { rows: [], done: true, missing: true };
    const rows = db.prepare(`SELECT ${ENTRY_COLUMNS.join(', ')} FROM entries WHERE scan_id = ? AND eid > ? ORDER BY eid LIMIT ?`)
      .all(scanId, after, ENTRY_CHUNK).map((r) => ENTRY_COLUMNS.map((c) => r[c]));
    return { rows, done: rows.length < ENTRY_CHUNK };
  }

  // Entries changed in place since `since` (live updates and catch-up scans), newest state of each.
  function editsGet(since, limit, deviceId) {
    const floor = Number(getSetting(db, 'entryLogFloor', 0)) || 0;
    if (since < floor) return { edits: [], next: maxEditSeq(deviceId), more: false, reset: true };
    const rows = db.prepare(`SELECT scan_id AS s, eid, MAX(seq) AS seq FROM entry_log WHERE seq > ? AND (device_id IS NULL OR device_id != ?)
      GROUP BY scan_id, eid ORDER BY seq LIMIT ?`).all(since, deviceId, limit);
    const get = db.prepare(`SELECT ${ENTRY_COLUMNS.join(', ')} FROM entries WHERE scan_id = ? AND eid = ?`);
    const edits = rows.map((r) => { const e = get.get(r.s, r.eid); return [r.s, r.eid, e ? ENTRY_COLUMNS.map((c) => e[c]) : null]; });
    return { edits, next: rows.length ? rows[rows.length - 1].seq : since, more: rows.length === limit };
  }

  // Entries a phone changed in place on its own scans.
  function editsPut(edits, deviceId) {
    if (edits.length > ENTRY_EDIT_CHUNK) throw httpError(413, 'Too many changes at once.');
    const known = new Map();
    const has = (s) => { if (!known.has(s)) known.set(s, Boolean(db.prepare("SELECT 1 FROM scans WHERE id = ? AND status = 'done'").get(s))); return known.get(s); };
    let applied = 0;
    tx(db, () => {
      for (const e of edits) {
        if (!Array.isArray(e) || typeof e[0] !== 'string' || e[0].length > 64 || !Number.isInteger(e[1]) || e[1] < 0) continue;
        const row = e[2];
        if (row !== null && (!Array.isArray(row) || row.length !== ENTRY_COLUMNS.length || row[0] !== e[1])) continue;
        if (!has(e[0])) continue; // the scan itself has not arrived yet; its whole file list follows
        for (const s of entryEditStatements(e[0], e[1], row, deviceId)) db.prepare(s.sql).run(...s.params);
        applied += 1;
      }
    });
    if (applied) onChange('catalog');
    return { applied };
  }

  function entriesPut(scanId, rows, done, deviceId) {
    const scan = db.prepare('SELECT id, status, indexed FROM scans WHERE id = ?').get(scanId);
    if (!scan) throw httpError(404, 'Send the scan before its file list.');
    if (!Array.isArray(rows) || rows.length > ENTRY_CHUNK) throw httpError(400, 'Bad file list.');
    const ins = db.prepare(`INSERT OR IGNORE INTO entries (scan_id, ${ENTRY_COLUMNS.join(', ')}) VALUES (?, ${ENTRY_COLUMNS.map(() => '?').join(', ')})`);
    tx(db, () => {
      for (const r of rows) if (Array.isArray(r) && r.length === ENTRY_COLUMNS.length) ins.run(scanId, ...r);
      if (done && !scan.indexed && scan.status === 'done') {
        db.prepare('INSERT INTO entries_fts(rowid, name) SELECT id, name FROM entries WHERE scan_id = ? AND eid > 0').run(scanId);
        // A local-only flag: no need to tell the phone, so the change log does not record it as the phone's change.
        db.prepare('UPDATE sync_ctx SET origin = ? WHERE id = 1').run(deviceId);
        db.prepare('UPDATE scans SET indexed = 1 WHERE id = ?').run(scanId);
        db.prepare('UPDATE sync_ctx SET origin = NULL WHERE id = 1').run();
      }
    });
    if (done) onChange('catalog');
    return { ok: true };
  }

  async function waitForChanges(since, deviceId, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const seq = maxSeq(deviceId);
      if (seq > since) return { seq, changed: true };
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { seq: maxSeq(deviceId), changed: false };
  }

  return {
    update, beginPairing, devices, unlink, stop: stopServers,
    status: () => ({ on: servers.length > 0, addresses, port: SYNC_PORT, pairing: pairings.size > 0 })
  };
}

export { normalizeCode };
