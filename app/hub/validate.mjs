// Server-side input validation. Every value from a request is checked here before
// it reaches the database or the file system; the interface's checks are only a convenience.
import { httpError } from './auth.mjs';
import { DRIVE_TYPES, STATUSES, BOOT_KINDS } from '../shared/drive-types.js';
import { KINDS } from '../shared/kinds.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const LINE_BREAKS = /[\r\n\t]/;

export const isUuid = (v) => typeof v === 'string' && UUID.test(v);

export function uuid(v, what = 'item') {
  if (!isUuid(v)) throw httpError(404, `That ${what} does not exist.`);
  return v.toLowerCase();
}

export function plainObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'The request body must be a JSON object.');
  return body;
}

// Text field: undefined = not sent, null = cleared. Rejects control characters.
export function text(v, field, max, { multiline = false, required = false } = {}) {
  if (v === undefined) return undefined;
  if (v === null || v === '') {
    if (required) throw httpError(400, `${field} is required.`);
    return null;
  }
  if (typeof v !== 'string') throw httpError(400, `${field} must be text.`);
  const s = multiline ? v.replace(/\r\n/g, '\n').trim() : v.trim();
  if (CONTROL.test(s) || (!multiline && LINE_BREAKS.test(s))) throw httpError(400, `${field} contains characters that are not allowed.`);
  if (s.length > max) throw httpError(400, `${field} can be at most ${max} characters.`);
  if (required && !s) throw httpError(400, `${field} is required.`);
  return s || null;
}

export function int(v, field, min, max) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < min || n > max) throw httpError(400, `${field} must be a number between ${min} and ${max}.`);
  return Math.round(n);
}

export function date(v, field) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    throw httpError(400, `${field} must be a date (YYYY-MM-DD).`);
  }
  return v;
}

export function oneOf(v, field, allowed, { nullable = false } = {}) {
  if (v === undefined) return undefined;
  if ((v === null || v === '') && nullable) return null;
  if (!allowed.includes(v)) throw httpError(400, `${field} is not a valid choice.`);
  return v;
}

export function bool(v, field) {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw httpError(400, `${field} must be true or false.`);
  return v;
}

export function tags(v) {
  if (v === undefined) return undefined;
  if (v === null) return [];
  if (!Array.isArray(v) || v.length > 20) throw httpError(400, 'Tags must be a list of at most 20 items.');
  return [...new Set(v.map((t) => text(t, 'A tag', 30)).filter(Boolean))];
}

const TYPE_IDS = DRIVE_TYPES.map((t) => t.id);
const STATUS_IDS = STATUSES.map((s) => s.id);
const BOOT_IDS = Object.keys(BOOT_KINDS);

// Cleans the editable drive fields. Unknown keys are ignored. With `create`, the name is required, and the type too
// unless it comes from a detected drive (`typeFromDisk`).
export function driveInput(body, { create = false, typeFromDisk = false } = {}) {
  plainObject(body);
  const out = {
    name: text(body.name, 'Name', 80, { required: create || body.name !== undefined }),
    type: oneOf(body.type, 'Drive type', TYPE_IDS),
    other_kind: text(body.other_kind, 'Kind', 40),
    form_factor: text(body.form_factor, 'Form factor', 40),
    brand: text(body.brand, 'Brand', 60),
    model: text(body.model, 'Model', 80),
    serial: text(body.serial, 'Serial number', 80),
    advertised_bytes: int(body.advertised_bytes, 'Capacity', 0, 1e15),
    interface: text(body.interface, 'Interface', 60),
    rated_read_mbs: int(body.rated_read_mbs, 'Rated read speed', 0, 100000),
    rated_write_mbs: int(body.rated_write_mbs, 'Rated write speed', 0, 100000),
    speed_class: text(body.speed_class, 'Speed class', 30),
    status: oneOf(body.status, 'Status', STATUS_IDS),
    location: text(body.location, 'Location', 80),
    lent_to: text(body.lent_to, 'Lent to', 60),
    lent_since: date(body.lent_since, 'Lent since'),
    due_back: date(body.due_back, 'Due back'),
    colour: text(body.colour, 'Colour', 30),
    tags: tags(body.tags),
    notes: text(body.notes, 'Notes', 2000, { multiline: true }),
    purchase_price: text(body.purchase_price, 'Price', 30),
    purchase_date: date(body.purchase_date, 'Purchase date'),
    shop: text(body.shop, 'Shop', 60),
    warranty_until: date(body.warranty_until, 'Warranty end date'),
    bootable_override: oneOf(body.bootable_override, 'Bootable', BOOT_IDS, { nullable: true })
  };
  if (create && !typeFromDisk && !out.type) throw httpError(400, 'Pick a drive type.');
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

export function searchInput(q) {
  const query = q.get('q') || '';
  if (query.length > 200) throw httpError(400, 'Search for at most 200 characters.');
  const kind = q.get('kind') || null;
  if (kind && kind !== 'folder' && !KINDS.some((k) => k.id === kind)) throw httpError(400, 'Unknown file kind.');
  const drive = q.get('drive') || null;
  if (drive && !isUuid(drive)) throw httpError(400, 'Unknown drive.');
  return { q: query, kind, minSize: int(q.get('minSize') || null, 'Minimum size', 0, 1e15), driveId: drive, hidden: q.get('hidden') === '1' };
}

export function browseInput(q) {
  const scan = q.get('scan') || null;
  if (scan && !isUuid(scan)) throw httpError(400, 'Unknown scan.');
  return {
    scanId: scan,
    dir: int(q.get('dir') || '0', 'Folder', 0, 2 ** 31),
    sort: oneOf(q.get('sort') || 'name', 'Sort', ['name', 'size', 'modified', 'kind']),
    order: oneOf(q.get('order') || 'asc', 'Order', ['asc', 'desc']),
    hidden: q.get('hidden') === '1'
  };
}

// A folder path chosen in Settings: absolute, normal characters, not inside Windows itself.
export function folderPath(v, field = 'Folder') {
  const s = text(v, field, 240, { required: true });
  if (!/^[a-zA-Z]:\\/.test(s) || /["<>|?*]/.test(s.slice(2)) || s.includes('\\..')) throw httpError(400, `${field} must be a full folder path such as D:\\Backups.`);
  const low = s.toLowerCase();
  const windir = (process.env.WINDIR || 'C:\\Windows').toLowerCase();
  const pf = [(process.env.ProgramFiles || 'C:\\Program Files').toLowerCase(), (process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)').toLowerCase()];
  if (low.startsWith(windir) || pf.some((p) => low.startsWith(p))) throw httpError(400, `${field} cannot be inside the Windows or Program Files folders.`);
  return s.replace(/\\+$/, '');
}
