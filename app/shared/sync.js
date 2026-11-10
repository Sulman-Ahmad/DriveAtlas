// Two-way sync between DriveAtlas catalogs (the PC hub and linked phones): constants and pure helpers used
// on both sides. Encryption lives in hub/lan.mjs (Node crypto) and ui/phone/crypto.js (Web Crypto); both use
// the same format: AES-256-GCM, 12-byte IV, tag appended, authenticated data "DA1|device|op|time|direction".

export const SYNC_PORT = 7421;
// 2: file-list edits travel on their own (entry log), so both sides need DriveAtlas 0.4 or newer.
export const SYNC_VERSION = 2;
export const ENTRY_EDIT_CHUNK = 2000;

// Tables whose rows travel between catalogs, in the order changes are applied (parents before children).
export const APPLY_ORDER = ['drives', 'collections', 'partitions', 'scans', 'health_snapshots', 'reminders'];
export const SYNC_TABLES = new Set(APPLY_ORDER);
// Rows that may be edited on either side keep the newer edit (by updated_at).
const NEWER_WINS = new Set(['drives', 'partitions']);
// Columns that describe this catalog only and never travel.
const LOCAL_ONLY = { scans: new Set(['indexed']) };
export const syncedColumns = (table, columns) => columns.filter((c) => !(LOCAL_ONLY[table] && LOCAL_ONLY[table].has(c)));

// Columns of one entry row as sent between catalogs (scan_id travels once per request, the local id never).
export const ENTRY_COLUMNS = ['eid', 'parent_eid', 'name', 'is_dir', 'size', 'items', 'modified_at', 'created_at', 'ext', 'kind', 'flags',
  'fingerprint', 'width', 'height', 'duration_s', 'taken_at'];
export const ENTRY_CHUNK = 4000;

// File lists bigger than this stay on the PC instead of being copied to a phone.
export const PHONE_ENTRY_LIMIT = 300000;

// ---- Link codes: 16 characters (80 random bits), valid for 2 minutes, used once. ----
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const LINK_CODE_LENGTH = 16;

export function codeFromBytes(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out.slice(0, LINK_CODE_LENGTH);
}

// Accepts what a person types: any case, spaces or dashes, O for 0 and I or L for 1.
export function normalizeCode(text) {
  const s = String(text || '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V').replace(/[^0-9A-Z]/g, '');
  return s.length === LINK_CODE_LENGTH && [...s].every((c) => ALPHABET.includes(c)) ? s : null;
}

export const formatCode = (code) => code.match(/.{1,4}/g).join('-');

// What the PC's QR code holds: driveatlas://link?v=1&a=192.168.1.20:7421,10.0.0.5:7421&c=K7Q2M9XD4TPAHW3C
export function linkUri({ addresses, port = SYNC_PORT, code }) {
  const list = addresses.map((a) => (String(a).includes(':') ? a : `${a}:${port}`)).join(',');
  return `driveatlas://link?v=1&a=${list}&c=${normalizeCode(code)}`;
}

// -> { addresses: [{ host, port }], code } or null when the text is not a DriveAtlas link code.
export function parseLinkUri(text) {
  const m = /^driveatlas:\/\/link\?(.+)$/i.exec(String(text || '').trim());
  if (!m) return null;
  const params = {};
  for (const part of m[1].split('&')) { const i = part.indexOf('='); if (i > 0) params[part.slice(0, i).toLowerCase()] = part.slice(i + 1); }
  const code = normalizeCode(params.c);
  const addresses = String(params.a || '').split(',').slice(0, 8).map(parseAddress).filter(Boolean);
  return code && addresses.length ? { addresses, code } : null;
}

// "192.168.1.20", "192.168.1.20:7421" or with spaces -> { host, port }, private or loopback IPv4 only.
export function parseAddress(text) {
  const m = /^\s*(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{2,5}))?\s*$/.exec(String(text || ''));
  if (!m) return null;
  const parts = m[1].split('.').map(Number);
  if (parts.some((n) => n > 255)) return null;
  const [a, b] = parts;
  const ok = a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  const port = m[2] ? Number(m[2]) : SYNC_PORT;
  return ok && port > 0 && port < 65536 ? { host: m[1], port } : null;
}

// ---- Applying changes from another catalog ----
// columns: the columns this catalog's table really has (from PRAGMA table_info), so unknown keys are ignored.
export function upsertStatement(table, row, columns) {
  if (!SYNC_TABLES.has(table)) throw new Error(`Not a synced table: ${table}`);
  const cols = syncedColumns(table, columns).filter((c) => Object.prototype.hasOwnProperty.call(row, c));
  if (!cols.includes('id')) throw new Error('A synced row needs an id.');
  const params = cols.map((c) => (row[c] === undefined ? null : row[c]));
  const marks = cols.map(() => '?').join(', ');
  if (table === 'health_snapshots') return { sql: `INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${marks})`, params };
  const set = cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ');
  const guard = NEWER_WINS.has(table) && cols.includes('updated_at') ? ` WHERE excluded.updated_at >= ${table}.updated_at` : '';
  // An upsert, never INSERT OR REPLACE: replacing a drive would cascade-delete its partitions and scans.
  return { sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${marks}) ON CONFLICT(id) DO ${set ? `UPDATE SET ${set}${guard}` : 'NOTHING'}`, params };
}

// Deleting keeps the search index in step (entries vanish with their scan or drive).
export function deleteStatements(table, id) {
  if (!SYNC_TABLES.has(table)) throw new Error(`Not a synced table: ${table}`);
  if (table === 'drives') {
    return [
      { sql: `INSERT INTO entries_fts(entries_fts, rowid, name) SELECT 'delete', e.id, e.name FROM entries e JOIN scans s ON s.id = e.scan_id
        WHERE s.drive_id = ? AND s.indexed = 1 AND e.eid > 0`, params: [id] },
      { sql: 'DELETE FROM entry_log WHERE scan_id IN (SELECT id FROM scans WHERE drive_id = ?)', params: [id] },
      { sql: 'DELETE FROM drives WHERE id = ?', params: [id] }
    ];
  }
  if (table === 'scans') {
    return [
      { sql: `INSERT INTO entries_fts(entries_fts, rowid, name) SELECT 'delete', e.id, e.name FROM entries e JOIN scans s ON s.id = e.scan_id
        WHERE s.id = ? AND s.indexed = 1 AND e.eid > 0`, params: [id] },
      { sql: 'DELETE FROM entries WHERE scan_id = ?', params: [id] },
      { sql: 'DELETE FROM entry_log WHERE scan_id = ?', params: [id] },
      { sql: 'DELETE FROM scans WHERE id = ?', params: [id] }
    ];
  }
  return [{ sql: `DELETE FROM ${table} WHERE id = ?`, params: [id] }];
}

// One changed entry of a file list kept up to date in place: row (ENTRY_COLUMNS order) or null when it was removed.
// Keeps the search index in step when the scan is indexed. origin: the device the edit came from (or null).
export function entryEditStatements(scanId, eid, row, origin = null) {
  const indexed = 'EXISTS (SELECT 1 FROM scans WHERE id = ? AND indexed = 1)';
  const out = [
    { sql: `INSERT INTO entries_fts(entries_fts, rowid, name) SELECT 'delete', id, name FROM entries WHERE scan_id = ? AND eid = ? AND eid > 0 AND ${indexed}`, params: [scanId, eid, scanId] }
  ];
  if (row) {
    const set = ENTRY_COLUMNS.filter((c) => c !== 'eid').map((c) => `${c} = excluded.${c}`).join(', ');
    out.push({ sql: `INSERT INTO entries (scan_id, ${ENTRY_COLUMNS.join(', ')}) VALUES (?, ${ENTRY_COLUMNS.map(() => '?').join(', ')})
      ON CONFLICT(scan_id, eid) DO UPDATE SET ${set}`, params: [scanId, ...row] });
    out.push({ sql: `INSERT INTO entries_fts(rowid, name) SELECT id, name FROM entries WHERE scan_id = ? AND eid = ? AND eid > 0 AND ${indexed}`, params: [scanId, eid, scanId] });
  } else {
    out.push({ sql: 'DELETE FROM entries WHERE scan_id = ? AND eid = ?', params: [scanId, eid] });
  }
  out.push({ sql: 'INSERT INTO entry_log (scan_id, eid, deleted, device_id, changed_at) VALUES (?, ?, ?, ?, ?)', params: [scanId, eid, row ? 0 : 1, origin, Date.now()] });
  return out;
}

// Sorts changes so parents are applied before children, keeping each table's own order.
export function sortForApply(changes) {
  const rank = new Map(APPLY_ORDER.map((t, i) => [t, i]));
  return changes.map((c, i) => [c, i]).sort((a, b) => (rank.get(a[0].t) - rank.get(b[0].t)) || (a[1] - b[1])).map(([c]) => c);
}
