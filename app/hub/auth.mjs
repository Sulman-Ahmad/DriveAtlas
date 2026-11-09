// Owner account, password checks and login sessions.
import crypto from 'node:crypto';

const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function hasOwner(db) {
  return Boolean(db.prepare('SELECT 1 FROM owner WHERE id = 1').get());
}

export function getOwner(db) {
  const row = db.prepare('SELECT name, created_at FROM owner WHERE id = 1').get();
  return row ? { name: row.name, createdAt: row.created_at } : null;
}

export function createOwner(db, name, password) {
  if (hasOwner(db)) throw httpError(409, 'An account already exists on this PC.');
  name = String(name || '').trim();
  if (name.length < 1 || name.length > 60) throw httpError(400, 'Enter a name between 1 and 60 characters.');
  checkPassword(password);
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, SCRYPT);
  db.prepare('INSERT INTO owner (id, name, pw_salt, pw_hash, created_at) VALUES (1, ?, ?, ?, ?)').run(name, salt, hash, Date.now());
}

export function verifyPassword(db, password) {
  const row = db.prepare('SELECT pw_salt, pw_hash FROM owner WHERE id = 1').get();
  if (!row) return false;
  const hash = crypto.scryptSync(String(password || ''), row.pw_salt, 64, SCRYPT);
  return crypto.timingSafeEqual(Buffer.from(row.pw_hash), hash);
}

export function createSession(db, device = 'This PC') {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, device, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(sha256(token), device, now, now, now + SESSION_DAYS * 864e5);
  return token;
}

export function getSession(db, token) {
  if (!token) return null;
  const row = db.prepare('SELECT token_hash, expires_at, last_seen_at FROM sessions WHERE token_hash = ?').get(sha256(token));
  if (!row || row.expires_at < Date.now()) return null;
  if (Date.now() - row.last_seen_at > 60_000) {
    db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?').run(Date.now(), Date.now() + SESSION_DAYS * 864e5, row.token_hash);
  }
  return row;
}

export function deleteSession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 6) throw httpError(400, 'Use a password of at least 6 characters.');
  if (password.length > 200) throw httpError(400, 'That password is too long.');
}

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
