// Reads resolution, duration and date taken from the first bytes of photos and
// videos. Never reads a whole file: at most a few small chunks.
import fs from 'node:fs';

const HEAD = 128 * 1024;
const MAX_MOOV = 4 * 1024 * 1024;

function read(fd, pos, len) {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, pos);
  return n === len ? buf : buf.subarray(0, n);
}

// EXIF date "2019:12:14 18:42:07" kept as camera clock time (stored as UTC).
function exifDate(s) {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m || m[1] === '0000') return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function parseExif(buf, start) {
  const le = buf.toString('ascii', start, start + 2) === 'II';
  const u16 = (o) => (le ? buf.readUInt16LE(start + o) : buf.readUInt16BE(start + o));
  const u32 = (o) => (le ? buf.readUInt32LE(start + o) : buf.readUInt32BE(start + o));
  const ascii = (entry) => {
    const count = u32(entry + 4);
    const off = count > 4 ? u32(entry + 8) : entry + 8;
    return buf.toString('ascii', start + off, start + off + count - 1);
  };
  const ifd = (o, want) => {
    const n = u16(o);
    for (let i = 0; i < n; i++) {
      const e = o + 2 + i * 12;
      if (want.has(u16(e))) want.set(u16(e), e);
    }
    return want;
  };
  const root = ifd(u32(4), new Map([[0x8769, 0], [0x0132, 0]]));
  let taken = null;
  if (root.get(0x8769)) {
    const exif = ifd(u32(root.get(0x8769) + 8), new Map([[0x9003, 0]]));
    if (exif.get(0x9003)) taken = exifDate(ascii(exif.get(0x9003)));
  }
  if (!taken && root.get(0x0132)) taken = exifDate(ascii(root.get(0x0132)));
  return taken;
}

function jpeg(buf) {
  const out = {};
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return out;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (marker === 0xe1 && buf.toString('ascii', i + 4, i + 10) === 'Exif\0\0') {
      try { out.taken = parseExif(buf, i + 10); } catch { /* broken EXIF: ignore */ }
    }
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      out.height = buf.readUInt16BE(i + 5);
      out.width = buf.readUInt16BE(i + 7);
      break;
    }
    if (marker === 0xda) break;
    i += 2 + len;
  }
  return out;
}

function png(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) return {};
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function gif(buf) {
  if (buf.toString('ascii', 0, 3) !== 'GIF') return {};
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function bmp(buf) {
  if (buf.toString('ascii', 0, 2) !== 'BM') return {};
  return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
}

function webp(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return {};
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  return {};
}

// MP4 / MOV / 3GP: duration and date from 'mvhd', size from the first video 'tkhd'.
function isoBmff(fd, size) {
  let pos = 0;
  let moov = null;
  for (let guard = 0; pos + 8 <= size && guard < 64; guard++) {
    const h = read(fd, pos, 16);
    if (h.length < 8) break;
    let boxSize = h.readUInt32BE(0);
    const type = h.toString('ascii', 4, 8);
    let header = 8;
    if (boxSize === 1) { boxSize = Number(h.readBigUInt64BE(8)); header = 16; }
    if (boxSize === 0) boxSize = size - pos;
    if (boxSize < header) break;
    if (type === 'moov') { moov = read(fd, pos, Math.min(boxSize, MAX_MOOV)); break; }
    pos += boxSize;
  }
  if (!moov) return {};
  const out = {};
  const walk = (start, end, depth) => {
    let p = start;
    while (p + 8 <= end && p + 8 <= moov.length) {
      const sz = moov.readUInt32BE(p);
      const type = moov.toString('ascii', p + 4, p + 8);
      if (sz < 8) break;
      if (type === 'mvhd') {
        const v = moov[p + 8];
        const created = v === 1 ? Number(moov.readBigUInt64BE(p + 12)) : moov.readUInt32BE(p + 12);
        const scale = v === 1 ? moov.readUInt32BE(p + 28) : moov.readUInt32BE(p + 20);
        const dur = v === 1 ? Number(moov.readBigUInt64BE(p + 32)) : moov.readUInt32BE(p + 24);
        if (scale) out.duration = dur / scale;
        if (created > 2082844800) out.taken = (created - 2082844800) * 1000;
      } else if (type === 'tkhd' && !out.width) {
        const v = moov[p + 8];
        const w = moov.readUInt32BE(p + (v === 1 ? 96 : 84)) / 65536;
        const hgt = moov.readUInt32BE(p + (v === 1 ? 100 : 88)) / 65536;
        if (w > 0 && hgt > 0) { out.width = Math.round(w); out.height = Math.round(hgt); }
      } else if ((type === 'trak' || type === 'moov') && depth < 4) {
        walk(p + 8, Math.min(p + sz, end), depth + 1);
      }
      p += sz;
    }
  };
  walk(8, moov.length, 0);
  return out;
}

function avi(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'AVI ') return {};
  const i = buf.indexOf('avih');
  if (i < 0 || i + 48 > buf.length) return {};
  const usPerFrame = buf.readUInt32LE(i + 8);
  const frames = buf.readUInt32LE(i + 24);
  return { duration: usPerFrame && frames ? (usPerFrame * frames) / 1e6 : undefined, width: buf.readUInt32LE(i + 40), height: buf.readUInt32LE(i + 44) };
}

// Matroska / WebM: walks the EBML header area for Info and Tracks.
function mkv(buf) {
  if (buf.readUInt32BE(0) !== 0x1a45dfa3) return {};
  const out = {};
  let scale = 1e6;
  let rawDuration = null;
  const vint = (p, keepMarker) => {
    const first = buf[p];
    let len = 1;
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
    if (len > 8 || p + len > buf.length) return null;
    let value = keepMarker ? first : first & (0xff >> len);
    let allOnes = value === (0xff >> len);
    for (let i = 1; i < len; i++) { value = value * 256 + buf[p + i]; if (buf[p + i] !== 0xff) allOnes = false; }
    return { value, len, unknown: !keepMarker && allOnes };
  };
  const uint = (p, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + buf[p + i]; return v; };
  const MASTER = new Set([0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0xe0]);
  const walk = (start, end) => {
    let p = start;
    while (p < end && p < buf.length - 2) {
      const id = vint(p, true);
      if (!id) return;
      const size = vint(p + id.len, false);
      if (!size) return;
      const body = p + id.len + size.len;
      const bodyEnd = size.unknown ? end : Math.min(body + size.value, end);
      if (id.value === 0x1f43b675) return; // first Cluster: the header area is over
      if (MASTER.has(id.value)) walk(body, bodyEnd);
      else if (id.value === 0x2ad7b1) scale = uint(body, size.value);
      else if (id.value === 0x4489) rawDuration = size.value === 4 ? buf.readFloatBE(body) : buf.readDoubleBE(body);
      else if (id.value === 0xb0 && !out.width) out.width = uint(body, size.value);
      else if (id.value === 0xba && !out.height) out.height = uint(body, size.value);
      else if (id.value === 0x4461 && size.value === 8) out.taken = Date.UTC(2001, 0, 1) + Number(buf.readBigInt64BE(body) / 1000000n);
      p = bodyEnd;
    }
  };
  walk(vint(4, false) ? 4 + vint(4, false).len + vint(4, false).value : 0, buf.length);
  if (rawDuration != null) out.duration = (rawDuration * scale) / 1e9;
  return out;
}

// Returns { width, height, duration, taken } where known, or {} if unreadable.
export function readMedia(fd, size, ext, head) {
  try {
    const buf = head || read(fd, 0, Math.min(size, HEAD));
    let r = {};
    if (ext === 'jpg' || ext === 'jpeg') r = jpeg(buf);
    else if (ext === 'png') r = png(buf);
    else if (ext === 'gif') r = gif(buf);
    else if (ext === 'bmp') r = bmp(buf);
    else if (ext === 'webp') r = webp(buf);
    else if (ext === 'mp4' || ext === 'm4v' || ext === 'mov' || ext === '3gp') r = isoBmff(fd, size);
    else if (ext === 'avi') r = avi(buf);
    else if (ext === 'mkv' || ext === 'webm') r = mkv(buf);
    const clean = {};
    if (r.width > 0 && r.width < 100000) clean.width = r.width;
    if (r.height > 0 && r.height < 100000) clean.height = r.height;
    if (r.duration > 0 && r.duration < 1e7) clean.duration = Math.round(r.duration * 100) / 100;
    if (r.taken > 0 && r.taken < Date.now() + 864e5 * 366) clean.taken = r.taken;
    return clean;
  } catch {
    return {};
  }
}

export const HEAD_BYTES = HEAD;
