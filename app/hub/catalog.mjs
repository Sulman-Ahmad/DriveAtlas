// Drive records: create, update, match to connected disks, and detect changes.
import crypto from 'node:crypto';
import { tx } from './db.mjs';
import { matchIdsFor, diskKey } from './disks.mjs';
import { httpError } from './auth.mjs';
import { guessType, bootKindFrom, typeById, BOOT_KINDS, brandFromModel } from '../shared/drive-types.js';
import { advertisedFromSize, fmtBytes } from '../shared/format.js';

const JSON_FIELDS = ['tags', 'match_ids'];
const EDITABLE = ['name', 'type', 'other_kind', 'form_factor', 'brand', 'model', 'serial', 'advertised_bytes', 'interface',
  'rated_read_mbs', 'rated_write_mbs', 'speed_class', 'status', 'location', 'lent_to', 'lent_since', 'due_back', 'colour',
  'tags', 'notes', 'purchase_price', 'purchase_date', 'shop', 'warranty_until', 'bootable_override'];
const STATUSES = new Set(['inpc', 'stored', 'lent', 'retired']);

const now = () => Date.now();

// Changes are recorded in change_log automatically by database triggers (schema migration 4).

function rowToDrive(row) {
  if (!row) return null;
  const d = { ...row };
  for (const f of JSON_FIELDS) d[f] = JSON.parse(d[f] || '[]');
  return d;
}

function newLabelCode(db) {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  for (;;) {
    const bytes = crypto.randomBytes(4);
    const code = 'DA-' + [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
    if (!db.prepare('SELECT 1 FROM drives WHERE label_code = ?').get(code)) return code;
  }
}

export function listDrives(db) {
  return db.prepare('SELECT * FROM drives ORDER BY name COLLATE NOCASE').all().map(rowToDrive);
}

export function getDrive(db, id) {
  const drive = rowToDrive(db.prepare('SELECT * FROM drives WHERE id = ?').get(id));
  if (!drive) return null;
  drive.partitions = db.prepare('SELECT * FROM partitions WHERE drive_id = ? ORDER BY idx').all(id)
    .map((p) => ({ ...p, signals: JSON.parse(p.signals || '[]') }));
  const pending = db.prepare('SELECT detected_at, changes FROM pending_changes WHERE drive_id = ?').get(id);
  drive.pendingChanges = pending ? { detectedAt: pending.detected_at, changes: JSON.parse(pending.changes) } : null;
  return drive;
}

// Finds the catalog drive a connected disk belongs to, by shared identity strings.
export function matchDisk(drives, disk) {
  const ids = new Set(matchIdsFor(disk));
  let best = null;
  let bestScore = 0;
  for (const d of drives) {
    const score = d.match_ids.filter((x) => ids.has(x)).length;
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

function cleanBrand(disk) {
  const name = disk.friendlyName || '';
  const known = ['Samsung', 'Toshiba', 'Kioxia', 'Western Digital', 'WD', 'Seagate', 'Crucial', 'Kingston', 'SanDisk', 'Intel',
    'SK hynix', 'Micron', 'Lexar', 'Transcend', 'ADATA', 'PNY', 'Corsair', 'Sabrent', 'Hitachi', 'HGST', 'Verbatim', 'Sony'];
  const hit = known.find((b) => new RegExp(`\\b${b}\\b`, 'i').test(name) || (disk.manufacturer || '').toLowerCase().includes(b.toLowerCase()));
  return hit || brandFromModel(disk.model) || brandFromModel(name) || '';
}

function partitionRows(driveId, disk) {
  return disk.partitions.map((p) => ({
    id: crypto.randomUUID(),
    drive_id: driveId,
    idx: p.number,
    label: p.label || null,
    last_letter: p.letter,
    filesystem: p.fileSystem,
    size: p.size,
    used: p.capacity != null && p.free != null ? p.capacity - p.free : null,
    free: p.free,
    partition_type: p.type,
    gpt_type: p.gptType || null,
    guid: p.guid,
    volume_serial: p.volumeSerial,
    signals: JSON.stringify(p.signals || []),
    has_windows: (p.signals || []).includes('Windows\\System32') ? 1 : 0,
    updated_at: now()
  }));
}

function writePartitions(db, driveId, disk) {
  db.prepare('DELETE FROM partitions WHERE drive_id = ?').run(driveId);
  const ins = db.prepare(`INSERT INTO partitions (id, drive_id, idx, label, last_letter, filesystem, size, used, free, partition_type,
    gpt_type, guid, volume_serial, signals, has_windows, updated_at) VALUES (@id, @drive_id, @idx, @label, @last_letter, @filesystem,
    @size, @used, @free, @partition_type, @gpt_type, @guid, @volume_serial, @signals, @has_windows, @updated_at)`);
  for (const row of partitionRows(driveId, disk)) ins.run(row);
}

// What the Add drive form is pre-filled with for a detected disk.
export function suggestionFor(disk) {
  const type = guessType(disk);
  const brand = cleanBrand(disk);
  let model = disk.model || disk.friendlyName;
  // "SAMSUNG MZVLB512HAJQ-000H1" -> "MZVLB512HAJQ-000H1" when the brand is known.
  if (brand && model.toLowerCase().startsWith(brand.toLowerCase() + ' ')) model = model.slice(brand.length + 1).trim();
  if (brand && model.toLowerCase().endsWith(' ' + brand.toLowerCase())) model = model.slice(0, -brand.length - 1).trim();
  return {
    type,
    name: '',
    brand,
    model,
    serial: disk.serial || '',
    advertised_bytes: advertisedFromSize(disk.size),
    actual_bytes: disk.size,
    status: disk.internal ? 'inpc' : 'stored',
    bus: disk.busType,
    media: disk.mediaType,
    partition_style: disk.partitionStyle,
    bootable_kind: bootKindFrom(disk.partitions, disk.partitionStyle)
  };
}

export function createDrive(db, input, disk = null) {
  const id = crypto.randomUUID();
  const base = disk ? suggestionFor(disk) : {};
  const d = { ...base, ...pick(input, EDITABLE) };
  d.name = String(d.name || '').trim();
  if (!d.name) throw httpError(400, 'Give the drive a name.');
  if (!typeById(d.type) || !d.type) throw httpError(400, 'Pick a drive type.');
  if (d.status && !STATUSES.has(d.status)) throw httpError(400, 'Unknown status.');
  const t = now();
  tx(db, () => {
    db.prepare(`INSERT INTO drives (id, name, type, other_kind, form_factor, brand, model, serial, advertised_bytes, actual_bytes,
      interface, rated_read_mbs, rated_write_mbs, speed_class, status, location, lent_to, lent_since, due_back, colour, tags, notes,
      label_code, purchase_price, purchase_date, shop, warranty_until, match_ids, bus, media, partition_style, bootable_kind,
      health_status, created_at, updated_at, last_seen_at)
      VALUES (@id, @name, @type, @other_kind, @form_factor, @brand, @model, @serial, @advertised_bytes, @actual_bytes, @interface,
      @rated_read_mbs, @rated_write_mbs, @speed_class, @status, @location, @lent_to, @lent_since, @due_back, @colour, @tags, @notes,
      @label_code, @purchase_price, @purchase_date, @shop, @warranty_until, @match_ids, @bus, @media, @partition_style, @bootable_kind,
      @health_status, @created_at, @updated_at, @last_seen_at)`).run({
      id, name: d.name, type: d.type, other_kind: d.other_kind || null, form_factor: d.form_factor || null, brand: d.brand || null,
      model: d.model || null, serial: d.serial || null, advertised_bytes: num(d.advertised_bytes), actual_bytes: num(base.actual_bytes),
      interface: d.interface || null, rated_read_mbs: num(d.rated_read_mbs), rated_write_mbs: num(d.rated_write_mbs),
      speed_class: d.speed_class || null, status: d.status || 'stored', location: d.location || null, lent_to: d.lent_to || null,
      lent_since: d.lent_since || null, due_back: d.due_back || null, colour: d.colour || null,
      tags: JSON.stringify(Array.isArray(d.tags) ? d.tags : []), notes: d.notes || null, label_code: newLabelCode(db),
      purchase_price: d.purchase_price || null, purchase_date: d.purchase_date || null, shop: d.shop || null,
      warranty_until: d.warranty_until || null, match_ids: JSON.stringify(disk ? matchIdsFor(disk) : []),
      bus: base.bus || null, media: base.media || null, partition_style: base.partition_style || null,
      bootable_kind: base.bootable_kind || null, health_status: disk?.health || null,
      created_at: t, updated_at: t, last_seen_at: disk ? t : null
    });
    if (disk) writePartitions(db, id, disk);
  });
  return getDrive(db, id);
}

export function updateDrive(db, id, patch) {
  const current = getDrive(db, id);
  if (!current) throw httpError(404, 'That drive is not in your catalog.');
  const fields = pick(patch, EDITABLE);
  if ('name' in fields && !String(fields.name).trim()) throw httpError(400, 'A drive needs a name.');
  if ('status' in fields && !STATUSES.has(fields.status)) throw httpError(400, 'Unknown status.');
  if ('type' in fields && !typeById(fields.type)) throw httpError(400, 'Unknown drive type.');
  const keys = Object.keys(fields);
  if (!keys.length) return current;
  const values = keys.map((k) => (k === 'tags' ? JSON.stringify(fields[k] || []) : fields[k] === '' ? null : fields[k]));
  db.prepare(`UPDATE drives SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...values, now(), id);
  return getDrive(db, id);
}

export function deleteDrive(db, id) {
  tx(db, () => {
    // Entries go with the drive (ON DELETE CASCADE); their search index rows must go too, or a later scan
    // that reuses the same row numbers would be found under these old names.
    db.prepare(`INSERT INTO entries_fts(entries_fts, rowid, name) SELECT 'delete', e.id, e.name FROM entries e JOIN scans s ON s.id = e.scan_id
      WHERE s.drive_id = ? AND s.indexed = 1 AND e.eid > 0`).run(id);
    db.prepare('DELETE FROM entry_log WHERE scan_id IN (SELECT id FROM scans WHERE drive_id = ?)').run(id);
    const r = db.prepare('DELETE FROM drives WHERE id = ?').run(id);
    if (!r.changes) throw httpError(404, 'That drive is not in your catalog.');
  });
}

// Differences between a drive's record and the disk now plugged in. Each one is
// shown to you with a tick box; nothing is applied until you approve it.
export function detectChanges(drive, partitions, disk) {
  const changes = [];
  const add = (key, text, extra = {}) => changes.push({ key, text, ...extra });

  if (drive.status === 'inpc' && !disk.internal) {
    add('connection', 'Connection changed: was inside the PC, now connected by USB.', { suggestStatus: 'stored', suggestText: 'Set status to Stored (external)' });
  } else if (drive.status !== 'inpc' && disk.internal && drive.status !== 'retired') {
    add('connection', 'Now installed inside this PC.', { suggestStatus: 'inpc', suggestText: 'Set status to In PC' });
  }

  if (drive.actual_bytes && Math.abs(disk.size - drive.actual_bytes) / drive.actual_bytes > 0.01) {
    add('capacity', `Capacity changed from ${fmtBytes(drive.actual_bytes)} to ${fmtBytes(disk.size)}.`);
  }

  const hadWindows = partitions.some((p) => p.has_windows);
  const hasWindows = disk.partitions.some((p) => (p.signals || []).includes('Windows\\System32'));
  if (hadWindows && !hasWindows) add('windows', 'Windows installation no longer found.');
  if (!hadWindows && hasWindows) add('windows', 'A Windows installation was found.');

  const oldBoot = drive.bootable_kind || 'none';
  const newBoot = bootKindFrom(disk.partitions, disk.partitionStyle);
  if (oldBoot !== newBoot && !(oldBoot === 'windows-installed' || newBoot === 'windows-installed')) {
    add('bootable', `Bootable changed from "${BOOT_KINDS[oldBoot] || oldBoot}" to "${BOOT_KINDS[newBoot] || newBoot}".`);
  }

  if (drive.partition_style && disk.partitionStyle && drive.partition_style !== disk.partitionStyle) {
    add('style', `Partition style changed from ${drive.partition_style} to ${disk.partitionStyle}.`);
  }

  const visible = (list, fs) => list.filter((p) => (fs ? p.filesystem : p.fileSystem) || (fs ? p.label : p.label));
  const oldParts = visible(partitions, true);
  const newParts = visible(disk.partitions, false);
  if (oldParts.length !== newParts.length) {
    add('partitions', `Partitions with a file system changed from ${oldParts.length} to ${newParts.length}.`);
  } else {
    oldParts.forEach((op, i) => {
      const np = newParts[i];
      if ((op.filesystem || '') !== (np.fileSystem || '')) add(`fs-${i}`, `Partition ${i + 1} reformatted from ${op.filesystem || 'none'} to ${np.fileSystem || 'none'}.`);
      if ((op.label || '') !== (np.label || '')) add(`label-${i}`, `Partition ${i + 1} renamed from "${op.label || 'no name'}" to "${np.label || 'no name'}".`);
    });
  }
  return changes;
}

// Applies approved changes: refreshes the partition snapshot and, if chosen, the status.
export function applyChanges(db, id, disk, { status } = {}) {
  const drive = getDrive(db, id);
  if (!drive) throw httpError(404, 'That drive is not in your catalog.');
  tx(db, () => {
    if (disk) {
      writePartitions(db, id, disk);
      const ids = new Set([...drive.match_ids, ...matchIdsFor(disk)]);
      db.prepare(`UPDATE drives SET actual_bytes = ?, partition_style = ?, bootable_kind = ?, match_ids = ?, bus = ?, media = COALESCE(?, media),
        health_status = ?, updated_at = ? WHERE id = ?`).run(disk.size, disk.partitionStyle, bootKindFrom(disk.partitions, disk.partitionStyle),
        JSON.stringify([...ids]), disk.busType, disk.mediaType, disk.health, now(), id);
    }
    if (status && STATUSES.has(status)) db.prepare('UPDATE drives SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
    db.prepare('DELETE FROM pending_changes WHERE drive_id = ?').run(id);
  });
  return getDrive(db, id);
}

export function dismissChanges(db, id) {
  db.prepare('DELETE FROM pending_changes WHERE drive_id = ?').run(id);
}

// Called after every disk refresh: marks drives as seen, keeps free space fresh,
// and records differences that need your approval. Returns what happened.
export function syncConnected(db, disks) {
  const drives = listDrives(db);
  const result = { matched: [], unknown: [], changed: [] };
  for (const disk of disks) {
    const drive = matchDisk(drives, disk);
    if (!drive) { result.unknown.push(disk); continue; }
    result.matched.push({ drive, disk });
    const partitions = db.prepare('SELECT * FROM partitions WHERE drive_id = ? ORDER BY idx').all(drive.id);
    tx(db, () => {
      db.prepare('UPDATE drives SET last_seen_at = ?, health_status = ?, actual_bytes = COALESCE(actual_bytes, ?) WHERE id = ?')
        .run(now(), disk.health, disk.size, drive.id);
      // Free space and drive letters change all the time; refresh them without asking.
      const upd = db.prepare('UPDATE partitions SET used = ?, free = ?, last_letter = ?, updated_at = ? WHERE drive_id = ? AND idx = ? AND COALESCE(filesystem, \'\') = ?');
      for (const p of disk.partitions) {
        if (p.capacity != null && p.free != null) upd.run(p.capacity - p.free, p.free, p.letter, now(), drive.id, p.number, p.fileSystem || '');
      }
      const changes = detectChanges(drive, partitions, disk);
      if (changes.length) {
        db.prepare('INSERT INTO pending_changes (drive_id, detected_at, changes) VALUES (?, ?, ?) ON CONFLICT(drive_id) DO UPDATE SET changes = excluded.changes')
          .run(drive.id, now(), JSON.stringify(changes));
        result.changed.push({ drive, disk, changes });
      } else {
        db.prepare('DELETE FROM pending_changes WHERE drive_id = ?').run(drive.id);
      }
    });
  }
  return result;
}

// Drive list enriched with live connection info, for the interface.
export function withLive(db, disks) {
  const drives = listDrives(db);
  const parts = db.prepare('SELECT drive_id, SUM(COALESCE(used, 0)) AS used, SUM(CASE WHEN filesystem IS NOT NULL THEN size ELSE 0 END) AS fs_size FROM partitions GROUP BY drive_id').all();
  const usage = new Map(parts.map((p) => [p.drive_id, p]));
  const pending = new Set(db.prepare('SELECT drive_id FROM pending_changes').all().map((r) => r.drive_id));
  const scanned = new Map(db.prepare('SELECT drive_id, SUM(file_count) AS files, COUNT(*) AS partitions FROM scans WHERE is_current = 1 GROUP BY drive_id').all()
    .map((r) => [r.drive_id, r]));
  const live = new Map();
  for (const disk of disks) {
    const d = matchDisk(drives, disk);
    if (d) live.set(d.id, disk);
  }
  return drives.map((d) => {
    const disk = live.get(d.id);
    const u = usage.get(d.id);
    const letters = disk ? disk.partitions.map((p) => p.letter).filter(Boolean) : [];
    const total = d.actual_bytes || d.advertised_bytes || null;
    return {
      ...d,
      connected: Boolean(disk),
      internal: disk ? disk.internal : d.status === 'inpc',
      letters,
      diskNumber: disk ? disk.number : null,
      used: u ? u.used : null,
      total,
      hasPendingChanges: pending.has(d.id),
      files: scanned.get(d.id)?.files ?? null,
      scannedPartitions: scanned.get(d.id)?.partitions ?? 0,
      liveStatus: disk ? (disk.internal ? 'inpc' : 'plugged') : d.status
    };
  });
}

// Connected disks with the drive each belongs to (or none yet).
export function connectedView(db, disks) {
  const drives = listDrives(db);
  return disks.map((disk) => {
    const d = matchDisk(drives, disk);
    const used = disk.partitions.reduce((s, p) => s + (p.capacity != null && p.free != null ? p.capacity - p.free : 0), 0);
    return {
      key: diskKey(disk),
      number: disk.number,
      friendlyName: disk.friendlyName,
      busType: disk.busType,
      mediaType: disk.mediaType,
      internal: disk.internal,
      size: disk.size,
      used,
      health: disk.health,
      letters: disk.partitions.map((p) => p.letter).filter(Boolean),
      partitions: disk.partitions,
      partitionStyle: disk.partitionStyle,
      driveId: d ? d.id : null,
      driveName: d ? d.name : null,
      driveType: d ? d.type : guessType(disk),
      suggestion: d ? null : suggestionFor(disk)
    };
  });
}

export function summary(db, disks) {
  const drives = withLive(db, disks);
  const counts = { total: drives.length, inpc: 0, plugged: 0, stored: 0, lent: 0, retired: 0 };
  let capacity = 0;
  let used = 0;
  for (const d of drives) {
    counts[d.liveStatus] = (counts[d.liveStatus] || 0) + 1;
    if (d.liveStatus === 'retired') continue;
    capacity += d.total || 0;
    used += d.used || 0;
  }
  const full = drives.filter((d) => d.total && d.used && d.used / d.total > 0.9).length;
  return { counts, capacity, used, free: Math.max(0, capacity - used), overNinety: full };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  return out;
}

function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
