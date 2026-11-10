// The phone's own "hub": answers the same /api requests the screens make on the PC, from the catalog
// database on the phone. Used when DriveAtlas runs as the Android app.
import { db, getSetting, setSetting } from './db.js';
import { plugin, readPhoneDisks, phoneMatchIds, normSerial, deviceId, phoneInfo, accessStatus } from './native.js';
import { emit, openEvents } from './events.js';
import { setPin, checkPin, checkNewPin, biometricStatus, unlockWithBiometric } from './lock.js';
import { backupStatus, setBackupPassword, chooseFolder, updateBackupSettings, backupNow, autoBackupIfDue, pickRestoreFile, restorePicked } from './backups.js';
import { scans, deleteScanStatements } from './scanner.js';
import { live } from './live.js';
import { link as linkPc, linkFromQr, unlink as unlinkPc, syncNow, startSync, currentLink, syncState } from './sync.js';
import { DRIVE_TYPES, STATUSES, typeById, guessType, BOOT_KINDS, brandFromModel } from '/shared/drive-types.js';
import { advertisedFromSize } from '/shared/format.js';
import { FLAG } from '/shared/kinds.js';

export const VERSION = '0.4.0-beta.1';
export { openEvents };

const HIDDEN_MASK = FLAG.HIDDEN | FLAG.SYSTEM;
const ENTRY_COLS = `e.id, e.scan_id, e.eid, e.parent_eid, e.name, e.is_dir, e.size, e.items, e.modified_at, e.created_at, e.ext, e.kind,
  e.flags, e.fingerprint, e.width, e.height, e.duration_s, e.taken_at`;
const SCAN_DEFAULTS = { media: true, fingerprint: true, hidden: true, keepScans: 3, exclude: [], live: true };
const EDITABLE = ['name', 'type', 'other_kind', 'form_factor', 'brand', 'model', 'serial', 'advertised_bytes', 'interface',
  'rated_read_mbs', 'rated_write_mbs', 'speed_class', 'status', 'location', 'lent_to', 'lent_since', 'due_back', 'colour',
  'tags', 'notes', 'purchase_price', 'purchase_date', 'shop', 'warranty_until', 'bootable_override'];
const TYPE_IDS = new Set(DRIVE_TYPES.map((t) => t.id));
const STATUS_IDS = new Set(STATUSES.map((s) => s.id));

const fail = (status, message) => Object.assign(new Error(message), { status });
const now = () => Date.now();
let unlocked = false;

// ---------- Small helpers ----------
function text(v, field, max, { required = false, multiline = false } = {}) {
  if (v === undefined || v === null || v === '') { if (required) throw fail(400, `${field} is required.`); return v === undefined ? undefined : null; }
  if (typeof v !== 'string') throw fail(400, `${field} must be text.`);
  const s = v.trim();
  if (s.length > max) throw fail(400, `${field} can be at most ${max} characters.`);
  if ((multiline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/ : /[\u0000-\u001F\u007F]/).test(s)) throw fail(400, `${field} contains characters that are not allowed.`);
  return s;
}

function driveInput(body, create) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'Send the drive details.');
  const out = {};
  for (const k of EDITABLE) if (Object.prototype.hasOwnProperty.call(body, k)) out[k] = body[k];
  if (create || 'name' in out) out.name = text(out.name, 'Name', 80, { required: true });
  for (const [k, max] of [['other_kind', 40], ['form_factor', 40], ['brand', 60], ['model', 80], ['serial', 80], ['interface', 60], ['speed_class', 30],
    ['location', 80], ['lent_to', 60], ['colour', 30], ['purchase_price', 30], ['shop', 60]]) if (k in out) out[k] = text(out[k], k, max);
  if ('notes' in out) out.notes = text(out.notes, 'Notes', 2000, { multiline: true });
  if ('type' in out && out.type != null && !TYPE_IDS.has(out.type)) throw fail(400, 'Unknown drive type.');
  if ('status' in out && out.status != null && !STATUS_IDS.has(out.status)) throw fail(400, 'Unknown status.');
  if ('tags' in out) {
    if (!Array.isArray(out.tags) || out.tags.length > 20) throw fail(400, 'Tags must be a list of up to 20.');
    out.tags = out.tags.map((t) => text(t, 'Tag', 30)).filter(Boolean);
  }
  for (const k of ['due_back', 'lent_since', 'purchase_date', 'warranty_until']) {
    if (k in out && out[k]) { if (!/^\d{4}-\d{2}-\d{2}$/.test(out[k]) || Number.isNaN(Date.parse(out[k]))) throw fail(400, 'Use a date like 2026-11-10.'); }
  }
  for (const k of ['advertised_bytes', 'rated_read_mbs', 'rated_write_mbs']) {
    if (k in out && out[k] !== null && out[k] !== '') { const n = Number(out[k]); if (!Number.isFinite(n) || n < 0) throw fail(400, `${k} must be a number.`); out[k] = Math.round(n); }
  }
  if ('bootable_override' in out && out.bootable_override != null && !(out.bootable_override in BOOT_KINDS)) throw fail(400, 'Unknown bootable kind.');
  return out;
}

const rowToDrive = (r) => (r ? { ...r, tags: JSON.parse(r.tags || '[]'), match_ids: JSON.parse(r.match_ids || '[]') } : null);

async function newLabelCode() {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    const code = 'DA-' + [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
    if (!(await db.value('SELECT 1 FROM drives WHERE label_code = ?', [code]))) return code;
  }
}

// Folders from the scan's top level down to each requested entry (top level itself left out), in one query.
async function chains(scanId, eids) {
  const out = new Map();
  const want = [...new Set(eids.filter((e) => e != null))];
  if (!want.length) return out;
  const rows = await db.all(`WITH RECURSIVE up(start, eid, parent_eid, name, depth) AS (
      SELECT eid, eid, parent_eid, name, 0 FROM entries WHERE scan_id = ? AND eid IN (${want.map(() => '?').join(',')})
      UNION ALL SELECT up.start, e.eid, e.parent_eid, e.name, up.depth + 1 FROM entries e JOIN up ON e.scan_id = ? AND e.eid = up.parent_eid WHERE up.depth < 512)
    SELECT start, eid, parent_eid, name, depth FROM up ORDER BY start, depth DESC`, [scanId, ...want, scanId]);
  for (const r of rows) {
    if (!out.has(r.start)) out.set(r.start, []);
    if (r.parent_eid != null) out.get(r.start).push({ eid: r.eid, name: r.name });
  }
  for (const e of want) if (!out.has(e)) out.set(e, []);
  return out;
}
const relPath = (chain) => '/' + chain.map((c) => c.name).join('/');

// ---------- Drives ----------
async function listDrives() {
  return (await db.all('SELECT * FROM drives ORDER BY name COLLATE NOCASE')).map(rowToDrive);
}

async function getDrive(id) {
  const d = rowToDrive(await db.get('SELECT * FROM drives WHERE id = ?', [id]));
  if (!d) return null;
  d.partitions = (await db.all('SELECT * FROM partitions WHERE drive_id = ? ORDER BY idx', [id])).map((p) => ({ ...p, signals: JSON.parse(p.signals || '[]') }));
  d.pendingChanges = null;
  return d;
}

// Finds the catalog drive a phone disk belongs to: by identity strings, or (for drives added on a PC) by volume serial.
function matchPhoneDisk(drives, serialsByDrive, disk) {
  const ids = new Set(phoneMatchIds(disk));
  let best = null;
  let bestScore = 0;
  for (const d of drives) {
    const score = d.match_ids.filter((x) => ids.has(x)).length;
    if (score > bestScore) { best = d; bestScore = score; }
  }
  if (best || disk.kind === 'phone') return best;
  const serials = disk.partitions.map((p) => p.volumeSerial).filter(Boolean);
  return drives.find((d) => (serialsByDrive.get(d.id) || []).some((s) => serials.includes(s))) || null;
}

async function serialMap() {
  const rows = await db.all('SELECT drive_id, volume_serial FROM partitions WHERE volume_serial IS NOT NULL');
  const m = new Map();
  for (const r of rows) { const s = normSerial(r.volume_serial); if (!s) continue; if (!m.has(r.drive_id)) m.set(r.drive_id, []); m.get(r.drive_id).push(s); }
  return m;
}

async function liveDrives(disks) {
  const [drives, serials, parts, scanned] = await Promise.all([
    listDrives(), serialMap(),
    db.all('SELECT drive_id, SUM(COALESCE(used, 0)) AS used FROM partitions GROUP BY drive_id'),
    db.all('SELECT drive_id, SUM(file_count) AS files, COUNT(*) AS partitions FROM scans WHERE is_current = 1 GROUP BY drive_id')
  ]);
  const usage = new Map(parts.map((p) => [p.drive_id, p.used]));
  const counts = new Map(scanned.map((r) => [r.drive_id, r]));
  const live = new Map();
  for (const disk of disks) { const d = matchPhoneDisk(drives, serials, disk); if (d) live.set(d.id, disk); }
  return drives.map((d) => {
    const disk = live.get(d.id);
    const used = disk ? disk.partitions.reduce((s, p) => s + (p.capacity != null && p.free != null ? p.capacity - p.free : 0), 0) : usage.get(d.id) ?? null;
    return {
      ...d, connected: Boolean(disk), internal: Boolean(disk && disk.kind === 'phone'), letters: [], diskNumber: disk ? disk.number : null,
      used, total: d.actual_bytes || d.advertised_bytes || (disk ? disk.size : null), hasPendingChanges: false,
      files: counts.get(d.id)?.files ?? null, scannedPartitions: counts.get(d.id)?.partitions ?? 0,
      liveStatus: disk ? (disk.kind === 'phone' ? 'thisphone' : 'plugged') : d.status
    };
  });
}

function suggestionFor(disk) {
  return {
    type: guessType(disk), name: '', brand: disk.kind === 'phone' && disk.manufacturer ? disk.manufacturer[0].toUpperCase() + disk.manufacturer.slice(1) : (brandFromModel(disk.model || disk.friendlyName) || ''),
    model: disk.model || disk.friendlyName || '', serial: '', advertised_bytes: advertisedFromSize(disk.size), actual_bytes: disk.size,
    status: 'stored', bus: disk.busType, media: disk.mediaType, partition_style: disk.partitionStyle, bootable_kind: 'none'
  };
}

async function connectedView(disks) {
  const [drives, serials] = await Promise.all([listDrives(), serialMap()]);
  return disks.map((disk) => {
    const d = matchPhoneDisk(drives, serials, disk);
    const used = disk.partitions.reduce((s, p) => s + (p.capacity != null && p.free != null ? p.capacity - p.free : 0), 0);
    return {
      key: disk.key, number: disk.number, friendlyName: disk.friendlyName, busType: disk.busType, mediaType: disk.mediaType, internal: disk.internal,
      size: disk.size, used, health: null, letters: [], partitions: disk.partitions, partitionStyle: null, kind: disk.kind,
      driveId: d ? d.id : null, driveName: d ? d.name : null, driveType: d ? d.type : guessType(disk), suggestion: d ? null : suggestionFor(disk)
    };
  });
}

function partitionRows(driveId, disk) {
  return disk.partitions.map((p) => [crypto.randomUUID(), driveId, p.number, p.label || null, null, p.fileSystem || null, p.size || null,
    p.capacity != null && p.free != null ? p.capacity - p.free : null, p.free ?? null, p.type || null, null, null, p.volumeSerial || null, '[]', 0, now()]);
}
const PART_INSERT = `INSERT INTO partitions (id, drive_id, idx, label, last_letter, filesystem, size, used, free, partition_type, gpt_type, guid,
  volume_serial, signals, has_windows, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

async function createDrive(body) {
  const fields = driveInput(body, true);
  let disk = null;
  if (body.fromDiskKey !== undefined) {
    disk = (await readPhoneDisks({ fresh: true })).find((d) => d.key === body.fromDiskKey);
    if (!disk) throw fail(409, 'That drive is no longer connected. Plug it in again, or add it without detection.');
    const [drives, serials] = await Promise.all([listDrives(), serialMap()]);
    if (matchPhoneDisk(drives, serials, disk)) throw fail(409, 'That drive is already in your catalog.');
  }
  const base = disk ? suggestionFor(disk) : {};
  const d = { ...base, ...fields };
  if (!d.type || !typeById(d.type)) throw fail(400, 'Pick a drive type.');
  const id = crypto.randomUUID();
  const t = now();
  const me = await deviceId();
  const statements = [{
    sql: `INSERT INTO drives (id, name, type, other_kind, form_factor, brand, model, serial, advertised_bytes, actual_bytes, interface, rated_read_mbs,
      rated_write_mbs, speed_class, status, location, lent_to, lent_since, due_back, colour, tags, notes, label_code, purchase_price, purchase_date,
      shop, warranty_until, match_ids, bus, media, partition_style, bootable_kind, created_at, updated_at, last_seen_at, seen_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [id, d.name, d.type, d.other_kind || null, d.form_factor || null, d.brand || null, d.model || null, d.serial || null,
      d.advertised_bytes ?? null, base.actual_bytes ?? null, d.interface || null, d.rated_read_mbs ?? null, d.rated_write_mbs ?? null, d.speed_class || null,
      d.status || 'stored', d.location || null, d.lent_to || null, d.lent_since || null, d.due_back || null, d.colour || null,
      JSON.stringify(d.tags || []), d.notes || null, await newLabelCode(), d.purchase_price || null, d.purchase_date || null, d.shop || null,
      d.warranty_until || null, JSON.stringify(disk ? phoneMatchIds(disk) : []), base.bus || null, base.media || null, null, base.bootable_kind || null,
      t, t, disk ? t : null, disk ? me : null]
  }];
  if (disk) statements.push({ sql: PART_INSERT, rows: partitionRows(id, disk) });
  await db.tx(statements);
  emit('catalog', { reason: 'created', id });
  return getDrive(id);
}

async function updateDrive(id, body) {
  const current = await getDrive(id);
  if (!current) throw fail(404, 'That drive is not in your catalog.');
  const fields = driveInput(body, false);
  const keys = Object.keys(fields);
  if (!keys.length) return current;
  const values = keys.map((k) => (k === 'tags' ? JSON.stringify(fields[k] || []) : fields[k] === '' ? null : fields[k]));
  await db.run(`UPDATE drives SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [...values, now(), id]);
  emit('catalog', { reason: 'updated', id });
  return getDrive(id);
}

async function deleteDrive(id) {
  if (scans.active?.driveId === id) throw fail(409, 'This drive is being scanned. Cancel the scan first.');
  const own = await db.all("SELECT id, status FROM scans WHERE drive_id = ?", [id]);
  const statements = own.flatMap((s) => deleteScanStatements(s.id));
  statements.push({ sql: 'DELETE FROM drives WHERE id = ?', params: [id] });
  const res = await db.tx(statements);
  if (!res.at(-1).changes) throw fail(404, 'That drive is not in your catalog.');
  emit('catalog', { reason: 'deleted', id });
}

// Keeps space and "last seen" fresh for drives the phone can see right now.
async function refreshSeen(disks) {
  const [drives, serials] = await Promise.all([listDrives(), serialMap()]);
  const statements = [];
  const me = await deviceId();
  for (const disk of disks) {
    const d = matchPhoneDisk(drives, serials, disk);
    if (!d) continue;
    statements.push({ sql: 'UPDATE drives SET last_seen_at = ?, seen_by = ? WHERE id = ?', params: [now(), me, d.id] });
    for (const p of disk.partitions) {
      if (p.capacity != null && p.free != null) statements.push({ sql: 'UPDATE partitions SET used = ?, free = ?, updated_at = ? WHERE drive_id = ? AND idx = ?', params: [p.capacity - p.free, p.free, now(), d.id, p.number] });
    }
  }
  if (statements.length) await db.tx(statements);
}

// ---------- Files ----------
async function currentScans(driveId) {
  return (await db.all(`SELECT id, partition_idx, partition_label, root, finished_at, updated_at, file_count, folder_count, total_bytes, skipped, options
    FROM scans WHERE drive_id = ? AND is_current = 1 ORDER BY partition_idx`, [driveId])).map((s) => ({ ...s, options: JSON.parse(s.options || '{}') }));
}

const SORTS = { name: 'e.name COLLATE NOCASE', size: 'e.size', modified: 'e.modified_at', kind: 'e.kind' };

async function browse(driveId, q) {
  const scanId = q.get('scan');
  const dir = Number(q.get('dir') || 0) || 0;
  const sort = SORTS[q.get('sort')] ? q.get('sort') : 'name';
  const order = q.get('order') === 'desc' ? 'DESC' : 'ASC';
  const hidden = q.get('hidden') === '1';
  const list = await currentScans(driveId);
  const scan = scanId ? list.find((s) => s.id === scanId) || (await db.get("SELECT * FROM scans WHERE id = ? AND drive_id = ? AND status = 'done'", [scanId, driveId])) : list[0];
  if (!scan) return { scans: list, scan: null, folder: null, path: [], entries: [] };
  const folder = await db.get(`SELECT ${ENTRY_COLS} FROM entries e WHERE e.scan_id = ? AND e.eid = ?`, [scan.id, dir]);
  if (!folder || !folder.is_dir) throw fail(404, 'That folder is not in this scan.');
  const entries = await db.all(`SELECT ${ENTRY_COLS} FROM entries e WHERE e.scan_id = ? AND e.parent_eid = ? ${hidden ? '' : `AND (e.flags & ${HIDDEN_MASK}) = 0`}
    ORDER BY e.is_dir DESC, ${SORTS[sort]} ${order}, e.name COLLATE NOCASE LIMIT 5000`, [scan.id, folder.eid]);
  const hiddenCount = hidden ? 0 : await db.value(`SELECT COUNT(*) FROM entries WHERE scan_id = ? AND parent_eid = ? AND (flags & ${HIDDEN_MASK}) != 0`, [scan.id, folder.eid]);
  const path = (await chains(scan.id, [folder.eid])).get(folder.eid);
  return { scans: list, scan, folder, path, entries, hiddenCount };
}

function ftsQuery(q) {
  const words = String(q || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return words.slice(0, 8).map((w) => `"${w}"*`).join(' ');
}

async function search(q) {
  const query = q.get('q') || '';
  if (query.length > 200) throw fail(400, 'Search for at most 200 characters.');
  const match = ftsQuery(query);
  if (!match) return { total: 0, results: [], tookMs: 0, namesSearched: 0 };
  const t0 = now();
  const where = ['entries_fts MATCH ?', 's.is_current = 1'];
  const args = [match];
  const kind = q.get('kind');
  if (kind === 'folder') where.push('e.is_dir = 1');
  else if (kind) { where.push('e.kind = ?'); args.push(kind); }
  const minSize = Number(q.get('minSize') || 0);
  if (minSize > 0) { where.push('e.size >= ?'); args.push(minSize); }
  if (q.get('drive')) { where.push('s.drive_id = ?'); args.push(q.get('drive')); }
  if (q.get('hidden') !== '1') where.push(`(e.flags & ${HIDDEN_MASK}) = 0`);
  const from = `FROM entries_fts f JOIN entries e ON e.id = f.rowid JOIN scans s ON s.id = e.scan_id WHERE ${where.join(' AND ')}`;
  const rows = await db.all(`SELECT ${ENTRY_COLS}, s.drive_id, s.partition_idx, s.finished_at AS scanned_at ${from}
    ORDER BY e.is_dir DESC, bm25(entries_fts), e.size DESC LIMIT 200`, args);
  const total = await db.value(`SELECT COUNT(*) FROM (SELECT 1 ${from} LIMIT 10000)`, args);
  const byScan = new Map();
  for (const r of rows) { if (!byScan.has(r.scan_id)) byScan.set(r.scan_id, []); byScan.get(r.scan_id).push(r.parent_eid); }
  const paths = new Map();
  for (const [scanId, parents] of byScan) paths.set(scanId, await chains(scanId, parents));
  const results = rows.map((r) => {
    const chain = paths.get(r.scan_id).get(r.parent_eid) || [];
    return { ...r, folderPath: relPath(chain) + (chain.length ? '/' : '') };
  });
  const namesSearched = await db.value('SELECT COALESCE(SUM(file_count + folder_count), 0) FROM scans WHERE is_current = 1');
  return { total, results, tookMs: now() - t0, namesSearched };
}

async function entryDetail(id) {
  const e = await db.get(`SELECT ${ENTRY_COLS}, s.drive_id, s.partition_idx, s.partition_label, s.finished_at AS scanned_at, s.is_current
    FROM entries e JOIN scans s ON s.id = e.scan_id WHERE e.id = ?`, [Number(id)]);
  if (!e) throw fail(404, 'That file is not in your catalog any more. Try searching again.');
  const chain = (await chains(e.scan_id, [e.eid])).get(e.eid);
  let copies = [];
  if (e.fingerprint && !e.is_dir) {
    const found = await db.all(`SELECT e.id, e.scan_id, e.eid, e.name, s.drive_id FROM entries e JOIN scans s ON s.id = e.scan_id
      WHERE e.fingerprint = ? AND e.size = ? AND e.id != ? AND s.is_current = 1 LIMIT 20`, [e.fingerprint, e.size, e.id]);
    for (const c of found) copies.push({ ...c, path: relPath((await chains(c.scan_id, [c.eid])).get(c.eid)) });
  }
  return { ...e, path: relPath(chain), chain, copies };
}

// ---------- Settings, state and the lock ----------
async function owner() {
  return db.get('SELECT name, account_id, created_at FROM owner WHERE id = 1');
}

async function scanDefaults() {
  return { ...SCAN_DEFAULTS, ...(await getSetting('scanDefaults', {})) };
}

async function state() {
  const o = await owner();
  return {
    version: VERSION, hasOwner: Boolean(o), signedIn: Boolean(o) && unlocked, owner: o && unlocked ? { name: o.name } : null,
    dataDir: 'On this phone', settings: { theme: await getSetting('theme', 'system') },
    phone: { biometric: await getSetting('phoneBiometric', false), biometricAvailable: (await biometricStatus()).available === true }
  };
}

async function setup(body) {
  if (await owner()) throw fail(409, 'This phone already has a DriveAtlas catalog. Unlock it instead.');
  const name = text(body.name, 'Your name', 60, { required: true });
  await setPin(body.pin);
  await deviceId();
  await db.run(`INSERT INTO owner (id, name, pw_salt, pw_hash, created_at, pw_params, account_id) VALUES (1, ?, X'', X'', ?, 'none', ?)`,
    [name, now(), crypto.randomUUID().replace(/-/g, '')]);
  await setSetting('phoneBiometric', Boolean(body.biometric) && (await biometricStatus()).available === true);
  await setSetting('phoneMode', 'local');
  unlocked = true;
  return { ok: true };
}

async function login(body) {
  if (!(await owner())) throw fail(409, 'Set up DriveAtlas on this phone first.');
  if (body.biometric === true) {
    if (!(await unlockWithBiometric())) throw fail(401, 'Fingerprint not confirmed. Use your PIN instead.');
  } else {
    await checkPin(String(body.pin || ''));
  }
  unlocked = true;
  backupSoon();
  return { ok: true };
}

// The daily backup runs a little after you open the app, so it never slows down unlocking.
let backupTimer = null;
function backupSoon() {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => { if (unlocked) autoBackupIfDue(VERSION).catch(() => {}); }, 8000);
}

// Restoring replaces the whole catalog: on first start (nothing to lose yet), or when unlocked.
async function mayRestore() {
  if ((await owner()) && !unlocked) throw fail(401, 'Please unlock DriveAtlas.');
}

async function restore(body) {
  await mayRestore();
  const first = !(await owner());
  const needPin = first || !(await getSetting('phoneLock'));
  if (needPin) { const problem = checkNewPin(body.pin); if (problem) throw fail(400, problem); }
  if (scans.status().active || scans.status().queue.length) throw fail(409, 'Wait for the scan to finish, or cancel it, before restoring.');
  const info = await restorePicked(body.password);
  if (needPin) await setPin(body.pin);
  await deviceId();
  if (first) {
    await setSetting('phoneBiometric', Boolean(body.biometric) && (await biometricStatus()).available === true);
    await setSetting('phoneMode', 'local');
  }
  unlocked = true;
  return { ok: true, ...info };
}

async function settingsAll() {
  const [o, theme, scan, info, access, bio] = await Promise.all([owner(), getSetting('theme', 'system'), scanDefaults(), phoneInfo(), accessStatus(), biometricStatus()]);
  return {
    theme, scan, version: VERSION, owner: o ? { name: o.name } : null, dataDir: 'On this phone', logPath: null, smartctl: null, testMode: false,
    backup: null, recentBackups: [], phone: { name: info.name, android: info.android, access, biometric: await getSetting('phoneBiometric', false), biometricAvailable: bio.available === true, link: await linkInfo() }
  };
}

async function linkInfo() {
  const l = await currentLink();
  return l ? { name: l.name, address: l.address, lastSyncAt: l.last_sync_at, state: syncState() } : null;
}

// ---------- Router ----------
const routes = [];
const on = (method, pattern, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, opts });
};

on('GET', '/api/state', () => state(), { open: true });
on('POST', '/api/setup', (c) => setup(c.body), { open: true });
on('POST', '/api/login', (c) => login(c.body), { open: true });
on('POST', '/api/logout', () => { unlocked = false; return { ok: true }; }, { open: true });
on('PUT', '/api/settings', async (c) => {
  if (!['system', 'light', 'dark'].includes(c.body.theme)) throw fail(400, 'Unknown theme.');
  await setSetting('theme', c.body.theme);
  return { ok: true };
});
on('GET', '/api/settings/all', () => settingsAll());
on('GET', '/api/settings/scan', () => scanDefaults());
on('PUT', '/api/settings/scan', async (c) => {
  const next = await scanDefaults();
  for (const k of ['media', 'fingerprint', 'hidden', 'live']) if (typeof c.body[k] === 'boolean') next[k] = c.body[k];
  if (Number.isInteger(c.body.keepScans) && c.body.keepScans >= 1 && c.body.keepScans <= 20) next.keepScans = c.body.keepScans;
  if (Array.isArray(c.body.exclude)) next.exclude = c.body.exclude.slice(0, 50).map((x) => text(x, 'Folder', 200)).filter(Boolean);
  await setSetting('scanDefaults', next);
  live.start().catch(() => {});
  return next;
});
on('POST', '/api/phone/pin', async (c) => { await checkPin(String(c.body.current || '')); await setPin(c.body.next); return { ok: true }; });
on('PUT', '/api/phone/biometric', async (c) => {
  const want = c.body.enabled === true;
  if (want && (await biometricStatus()).available !== true) throw fail(409, 'This phone has no fingerprint or face unlock set up.');
  await setSetting('phoneBiometric', want);
  return { ok: true };
});
on('GET', '/api/phone/access', () => accessStatus());
on('POST', '/api/phone/link', async (c) => (typeof c.body.qr === 'string' ? linkFromQr(c.body.qr) : linkPc({ address: c.body.address, code: c.body.code })));
on('POST', '/api/phone/scan-qr', async () => {
  const p = plugin();
  if (!p || !p.scanQr) throw fail(409, 'Scanning a QR code needs the DriveAtlas app on Android.');
  return p.scanQr({ prompt: 'Point the camera at the QR code on your PC' });
});
on('POST', '/api/phone/sync', async () => syncNow());
on('POST', '/api/phone/unlink', async () => { await unlinkPc(); return { ok: true }; });
on('POST', '/api/phone/access', async () => { const p = plugin(); if (!p) throw fail(409, 'Only in the Android app.'); return p.requestAllFilesAccess(); });
on('GET', '/api/phone/backups', () => backupStatus());
on('PUT', '/api/phone/backups', (c) => updateBackupSettings(c.body));
on('POST', '/api/phone/backups/password', async (c) => { await setBackupPassword(c.body.password); return { ok: true }; });
on('POST', '/api/phone/backups/folder', () => chooseFolder());
on('POST', '/api/phone/backups/now', () => backupNow('manual', VERSION));
on('POST', '/api/phone/restore/pick', async (c) => { await mayRestore(); return pickRestoreFile(typeof c.body.uri === 'string' ? c.body.uri : null); }, { open: true });
on('POST', '/api/phone/restore', (c) => restore(c.body), { open: true });

on('GET', '/api/summary', async () => {
  const drives = await liveDrives(await readPhoneDisks());
  const counts = { total: drives.length, inpc: 0, plugged: 0, stored: 0, lent: 0, retired: 0, thisphone: 0 };
  let capacity = 0;
  let used = 0;
  for (const d of drives) {
    counts[d.liveStatus] = (counts[d.liveStatus] || 0) + 1;
    if (d.liveStatus === 'retired') continue;
    capacity += d.total || 0;
    used += d.used || 0;
  }
  const full = drives.filter((d) => d.total && d.used && d.used / d.total > 0.9).length;
  return { counts, capacity, used, free: Math.max(0, capacity - used), overNinety: full, ready: true };
});
on('GET', '/api/connected', async () => ({ ready: true, disks: await connectedView(await readPhoneDisks()) }));
on('POST', '/api/connected/refresh', async () => {
  const disks = await readPhoneDisks({ fresh: true });
  await refreshSeen(disks);
  return { ready: true, disks: await connectedView(disks) };
});
on('GET', '/api/drives', async () => { const w = live.status().drives; return { drives: (await liveDrives(await readPhoneDisks())).map((d) => ({ ...d, watch: w[d.id] || null })) }; });
on('GET', '/api/live', () => live.status());
on('POST', '/api/drives/:id/catch-up', async (c) => {
  if (!(await scanDefaults()).live) throw fail(409, 'Turn on “Keep file lists up to date” in Settings first.');
  if (!(await live.catchUp(c.params.id))) throw fail(409, 'Scan this drive once on this phone with All files access; after that DriveAtlas keeps its file list up to date.');
  return { ok: true };
});
on('POST', '/api/drives', async (c) => ({ __status: 201, drive: await createDrive(c.body) }));
on('GET', '/api/drives/:id', async (c) => {
  const drive = await getDrive(c.params.id);
  if (!drive) throw fail(404, 'That drive is not in your catalog.');
  const live = (await liveDrives(await readPhoneDisks())).find((d) => d.id === drive.id) || {};
  const { connected, internal, letters, diskNumber, used, total, liveStatus, hasPendingChanges, files } = live;
  return { drive: { ...drive, connected, internal, letters, diskNumber, used, total, liveStatus, hasPendingChanges, files, watch: live.status().drives[drive.id] || null }, disk: null };
});
on('PATCH', '/api/drives/:id', async (c) => ({ drive: await updateDrive(c.params.id, c.body) }));
on('DELETE', '/api/drives/:id', async (c) => { await deleteDrive(c.params.id); return { ok: true }; });
on('POST', '/api/drives/:id/changes/apply', async (c) => ({ drive: await getDrive(c.params.id) }));
on('POST', '/api/drives/:id/changes/dismiss', () => ({ ok: true }));

on('GET', '/api/scans', () => scans.status());
on('POST', '/api/drives/:id/scan', async (c) => {
  const drive = await getDrive(c.params.id);
  if (!drive) throw fail(404, 'That drive is not in your catalog.');
  const disks = await readPhoneDisks({ fresh: true });
  const [drives, serials] = await Promise.all([listDrives(), serialMap()]);
  const disk = disks.find((d) => matchPhoneDisk(drives, serials, d)?.id === drive.id);
  if (!disk) throw fail(409, 'Plug this drive into the phone to scan it.');
  const access = await accessStatus();
  const opts = await scanDefaults();
  const wanted = Array.isArray(c.body.partitions) ? new Set(c.body.partitions.map(Number)) : null;
  const uri = typeof c.body.uri === 'string' && c.body.uri.startsWith('content://') ? c.body.uri : null;
  if (!access.allFiles && !uri) throw fail(409, 'NEED_ACCESS');
  const parts = disk.partitions.filter((p) => (uri || p.path) && (!wanted || wanted.has(p.number)));
  if (!parts.length) throw fail(409, 'Android does not show a folder for this drive, so there is nothing to scan.');
  const ids = parts.map((p) => scans.enqueue({
    driveId: drive.id, partitionIdx: p.number, label: p.label || `Part ${p.number}`, path: uri ? null : p.path, uri,
    bytesEstimate: p.capacity != null && p.free != null ? p.capacity - p.free : null,
    options: { media: opts.media, fingerprint: opts.fingerprint, hidden: opts.hidden, exclude: opts.exclude }, keep: opts.keepScans
  }));
  return { ids };
});
for (const action of ['pause', 'resume', 'cancel']) {
  on('POST', `/api/scans/:id/${action}`, async (c) => {
    if (!(await scans.control(c.params.id, action))) throw fail(409, 'That scan is not running or queued.');
    return scans.status();
  });
}
on('GET', '/api/drives/:id/scans', async (c) => ({
  current: await currentScans(c.params.id),
  history: await db.all(`SELECT id, partition_idx, partition_label, root, started_at, finished_at, file_count, folder_count, total_bytes, status, is_current
    FROM scans WHERE drive_id = ? AND status = 'done' ORDER BY finished_at DESC`, [c.params.id])
}));
on('GET', '/api/drives/:id/browse', (c) => browse(c.params.id, c.query));
on('GET', '/api/search', (c) => search(c.query));
on('GET', '/api/entries/:id', async (c) => ({ entry: await entryDetail(c.params.id) }));
on('POST', '/api/entries/:id/open', () => { throw fail(409, 'Open this file from your phone’s Files app.'); });
on('GET', '/api/health', () => ({ smartctl: null, phone: true }));
on('GET', '/api/drives/:id/health', async (c) => ({
  history: await db.all(`SELECT taken_at, source, status, health_pct, temp_c, power_on_hours, power_cycles, tb_written, tb_read, reallocated, pending, media_errors
    FROM health_snapshots WHERE drive_id = ? ORDER BY taken_at DESC LIMIT 60`, [c.params.id])
}));

// Same contract as fetch-based api(): resolves with the JSON body, or throws an Error with .status.
export async function handle(method, url, body) {
  const u = new URL(url, 'https://localhost');
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(u.pathname);
    if (!m) continue;
    if (!r.opts.open && !unlocked) throw fail(401, 'Please unlock DriveAtlas.');
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const out = await r.handler({ params, query: u.searchParams, body: body && typeof body === 'object' ? body : {} });
    if (out && typeof out === 'object' && '__status' in out) { const { __status, ...rest } = out; return rest; }
    return out ?? { ok: true };
  }
  throw fail(404, 'Not found');
}

// Called once when the app starts: watches for drives plugged into the phone, and locks again after
// the app has been in the background for a while.
export async function startPhone() {
  startSync();
  const p = plugin();
  let hiddenAt = 0;
  // File lists stay up to date only while the app is on screen: a catch-up when it opens, live updates meanwhile.
  live.isBusy = (driveId) => scans.active?.driveId === driveId || scans.queue.some((j) => j.driveId === driveId);
  const startLive = () => { owner().then((o) => { if (o) live.start().catch(() => {}); }); };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); live.stop().catch(() => {}); }
    else {
      if (hiddenAt && Date.now() - hiddenAt > 5 * 60000 && unlocked) { unlocked = false; emit('locked', {}); }
      else if (unlocked) backupSoon();
      startLive();
    }
  });
  openEvents().addEventListener('scan-finished', startLive);
  if (!p) return;
  startLive();
  let known = new Set((await readPhoneDisks({ fresh: true })).map((d) => d.key));
  await p.addListener('volumesChanged', async () => {
    const disks = await readPhoneDisks({ fresh: true });
    const keys = new Set(disks.map((d) => d.key));
    if (!(await owner())) { known = keys; return; }
    await refreshSeen(disks);
    const view = await connectedView(disks);
    for (const d of view) {
      if (known.has(d.key) || d.kind === 'phone') continue;
      if (d.driveId) emit('plugged', { driveId: d.driveId, name: d.driveName, letters: [], changes: [] });
      else emit('new-disk', { key: d.key, friendlyName: d.friendlyName, letters: [] });
    }
    for (const k of known) if (!keys.has(k)) emit('unplugged', { friendlyName: 'A drive' });
    known = keys;
    emit('disks', {});
    startLive();
  });
}
