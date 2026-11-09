// Heavy backup work in a background thread: snapshot + compress + encrypt, or
// decrypt + decompress + check a backup before it may replace your catalog.
import { parentPort, workerData } from 'node:worker_threads';
import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';

export const MAGIC = Buffer.from('DRIVEATLAS-BACKUP 1\n');
const MAX_HEADER = 4096;
const MAX_OUTPUT = 64 * 2 ** 30; // refuses to unpack more than 64 GB (protects against crafted files)

const scrypt = (password, salt, p) => new Promise((resolve, reject) => {
  crypto.scrypt(String(password), salt, 32, { N: p.N, r: p.r, p: p.p, maxmem: 160 * p.N * p.r + 16 * 2 ** 20 }, (e, k) => (e ? reject(e) : resolve(k)));
});

const fail = (code, message) => Object.assign(new Error(message), { code });

async function create({ dbPath, dest, snapshot, key, header }) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    db.prepare('VACUUM INTO ?').run(snapshot);
  } finally {
    db.close();
  }
  // Sign-ins belong to this PC's browser, not to the backup: drop them from the copy (overwriting the freed space).
  const snap = new DatabaseSync(snapshot);
  try { snap.exec('PRAGMA secure_delete = ON; DELETE FROM sessions;'); } finally { snap.close(); }
  const headerBuf = Buffer.from(JSON.stringify(header) + '\n');
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), Buffer.from(header.iv, 'base64'));
  cipher.setAAD(Buffer.concat([MAGIC, headerBuf]));
  const appendTag = new Transform({
    transform(chunk, _enc, cb) { cb(null, chunk); },
    flush(cb) { this.push(cipher.getAuthTag()); cb(); }
  });
  const part = `${dest}.part`;
  const out = fs.createWriteStream(part, { flags: 'wx' });
  out.write(MAGIC);
  out.write(headerBuf);
  await pipeline(fs.createReadStream(snapshot), zlib.createGzip({ level: 6 }), cipher, appendTag, out);
  fs.renameSync(part, dest);
  return { size: fs.statSync(dest).size };
}

function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < MAGIC.length + 40) throw fail('NOT_BACKUP', 'This is not a DriveAtlas backup file.');
    const head = Buffer.alloc(Math.min(size, MAGIC.length + MAX_HEADER));
    fs.readSync(fd, head, 0, head.length, 0);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw fail('NOT_BACKUP', 'This is not a DriveAtlas backup file.');
    const nl = head.indexOf(0x0a, MAGIC.length);
    if (nl < 0) throw fail('NOT_BACKUP', 'This backup file is damaged (its header is missing).');
    const headerBuf = head.subarray(MAGIC.length, nl + 1);
    let h;
    try { h = JSON.parse(headerBuf.toString('utf8')); } catch { throw fail('NOT_BACKUP', 'This backup file is damaged (its header cannot be read).'); }
    const salt = Buffer.from(String(h?.kdf?.salt || ''), 'base64');
    const iv = Buffer.from(String(h?.iv || ''), 'base64');
    const N = h?.kdf?.N;
    const valid = h && h.app === 'DriveAtlas' && h.format === 1 && h.cipher === 'aes-256-gcm' && h.compression === 'gzip' && h.kdf?.name === 'scrypt'
      && Number.isInteger(N) && N >= 16384 && N <= 1048576 && (N & (N - 1)) === 0 && h.kdf.r === 8 && h.kdf.p === 1 && salt.length === 16 && iv.length === 12;
    if (!valid) throw fail('NOT_BACKUP', 'This backup was made by an unknown version of DriveAtlas, or it is damaged.');
    const tag = Buffer.alloc(16);
    fs.readSync(fd, tag, 0, 16, size - 16);
    return { h, headerBuf, salt, iv, tag, bodyStart: nl + 1, bodyEnd: size - 17, size };
  } finally {
    fs.closeSync(fd);
  }
}

async function restore({ file, password, outFile, schemaVersion }) {
  const { h, headerBuf, salt, iv, tag, bodyStart, bodyEnd } = readHeader(file);
  const key = await scrypt(password, salt, h.kdf);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.concat([MAGIC, headerBuf]));
  decipher.setAuthTag(tag);
  let total = 0;
  const limit = new Transform({
    transform(chunk, _enc, cb) {
      total += chunk.length;
      cb(total > MAX_OUTPUT ? fail('TOO_BIG', 'This backup unpacks to more than 64 GB, so it was refused.') : null, chunk);
    }
  });
  try {
    await pipeline(fs.createReadStream(file, { start: bodyStart, end: bodyEnd }), decipher, zlib.createGunzip(), limit, fs.createWriteStream(outFile, { flags: 'wx' }));
  } catch (err) {
    fs.rmSync(outFile, { force: true });
    if (err.code === 'TOO_BIG') throw err;
    // A wrong password and a changed file look the same to AES-GCM: both fail authentication.
    throw fail('BAD_PASSWORD', 'The password is wrong, or the backup file was changed or damaged.');
  }
  // The decrypted catalog must be a healthy DriveAtlas database before it can be used.
  let info;
  try {
    const db = new DatabaseSync(outFile, { readOnly: true });
    try {
      const check = db.prepare('PRAGMA quick_check').get();
      const version = db.prepare('PRAGMA user_version').get().user_version;
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
      const required = ['owner', 'drives', 'partitions', 'scans', 'entries', 'settings', 'sessions'];
      if (Object.values(check)[0] !== 'ok' || version < 1 || version > schemaVersion || !required.every((t) => tables.has(t))) {
        throw fail('NOT_CATALOG', 'The backup opened, but it does not contain a usable DriveAtlas catalog.');
      }
      const owner = db.prepare('SELECT name FROM owner WHERE id = 1').get();
      if (!owner) throw fail('NOT_CATALOG', 'The backup does not contain an account.');
      info = { owner: owner.name, drives: db.prepare('SELECT COUNT(*) AS n FROM drives').get().n, created: h.created, version: h.version };
    } finally {
      db.close();
    }
  } catch (err) {
    fs.rmSync(outFile, { force: true });
    throw err.code ? err : fail('NOT_CATALOG', 'The backup does not contain a usable DriveAtlas catalog.');
  }
  return info;
}

async function copy({ dbPath, dest }) {
  const db = new DatabaseSync(dbPath);
  try { db.exec('PRAGMA busy_timeout = 10000'); db.prepare('VACUUM INTO ?').run(dest); } finally { db.close(); }
  return { size: fs.statSync(dest).size };
}

if (parentPort && workerData) {
  const ops = { create, restore, copy };
  ops[workerData.op](workerData)
    .then((result) => parentPort.postMessage({ ok: true, result }))
    .catch((err) => parentPort.postMessage({ ok: false, code: err.code || 'ERROR', message: err.message }))
    .finally(() => {
      if (workerData.snapshot) fs.rm(workerData.snapshot, { force: true }, () => {});
    });
}
