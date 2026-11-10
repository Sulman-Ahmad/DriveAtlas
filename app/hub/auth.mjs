// Owner account, password hashing and sign-in sessions.
import crypto from 'node:crypto';

const SESSION_DAYS = 30;
// scrypt cost parameters (OWASP: N=2^17, r=8, p=1). Stored with each hash so they can be raised later.
const CURRENT = { N: 131072, r: 8, p: 1 };
const encodeParams = (p) => `scrypt:${p.N}:${p.r}:${p.p}`;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseParams(s) {
  const m = /^scrypt:(\d+):(\d+):(\d+)$/.exec(s || '');
  if (!m) return { N: 16384, r: 8, p: 1 };
  return { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]) };
}

// Asynchronous, so a sign-in never freezes the hub while the hash is computed.
function hash(password, salt, p) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 64, { N: p.N, r: p.r, p: p.p, maxmem: 160 * p.N * p.r + 16 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

// A fresh password hash with today's settings, for writing into a catalog (for example a restored one).
export async function passwordRecord(password) {
  const salt = crypto.randomBytes(16);
  return { salt, hash: await hash(password, salt, CURRENT), params: encodeParams(CURRENT) };
}

export function httpError(status, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

export function hasOwner(db) {
  return Boolean(db.prepare('SELECT 1 FROM owner WHERE id = 1').get());
}

export function getOwner(db) {
  const row = db.prepare('SELECT name, created_at FROM owner WHERE id = 1').get();
  return row ? { name: row.name, createdAt: row.created_at } : null;
}

export function checkNewPassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw httpError(400, 'Use a password of at least 8 characters.');
  if (password.length > 200) throw httpError(400, 'That password is too long (200 characters at most).');
  if (/^(.)\1+$/.test(password) || ['password', '12345678', 'driveatlas', 'qwertyui'].includes(password.toLowerCase())) {
    throw httpError(400, 'That password is too easy to guess. Pick something less common.');
  }
}

export async function createOwner(db, name, password) {
  if (hasOwner(db)) throw httpError(409, 'An account already exists on this PC.');
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 60 || /[\u0000-\u001F\u007F]/.test(name)) {
    throw httpError(400, 'Enter a name between 1 and 60 characters.');
  }
  checkNewPassword(password);
  const salt = crypto.randomBytes(16);
  const key = await hash(password, salt, CURRENT);
  if (hasOwner(db)) throw httpError(409, 'An account already exists on this PC.');
  db.prepare('INSERT INTO owner (id, name, pw_salt, pw_hash, pw_params, created_at) VALUES (1, ?, ?, ?, ?, ?)')
    .run(name.trim(), salt, key, encodeParams(CURRENT), Date.now());
}

// Checks the password; quietly upgrades old hashes to the current parameters.
export async function verifyPassword(db, password) {
  const row = db.prepare('SELECT pw_salt, pw_hash, pw_params FROM owner WHERE id = 1').get();
  if (!row || typeof password !== 'string' || password.length > 200) return false;
  // An account restored from a phone backup has no PC password until one is set.
  if (!row.pw_hash || !row.pw_hash.length || row.pw_params === 'none') return false;
  const params = parseParams(row.pw_params);
  const ok = crypto.timingSafeEqual(Buffer.from(row.pw_hash), await hash(password, row.pw_salt, params));
  if (ok && encodeParams(params) !== encodeParams(CURRENT)) {
    const salt = crypto.randomBytes(16);
    const key = await hash(password, salt, CURRENT);
    db.prepare('UPDATE owner SET pw_salt = ?, pw_hash = ?, pw_params = ? WHERE id = 1').run(salt, key, encodeParams(CURRENT));
  }
  return ok;
}

export async function changePassword(db, current, next) {
  if (!(await verifyPassword(db, current))) throw httpError(401, 'Your current password is not right.');
  checkNewPassword(next);
  if (current === next) throw httpError(400, 'The new password must be different from the current one.');
  const salt = crypto.randomBytes(16);
  const key = await hash(next, salt, CURRENT);
  db.prepare('UPDATE owner SET pw_salt = ?, pw_hash = ?, pw_params = ? WHERE id = 1').run(salt, key, encodeParams(CURRENT));
  db.prepare('DELETE FROM sessions').run();
}

export function createSession(db, device = 'This PC') {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, device, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(sha256(token), device, now, now, now + SESSION_DAYS * 864e5);
  return token;
}

export function getSession(db, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const row = db.prepare('SELECT token_hash, expires_at, last_seen_at FROM sessions WHERE token_hash = ?').get(sha256(token));
  if (!row || row.expires_at < Date.now()) return null;
  if (Date.now() - row.last_seen_at > 60_000) {
    db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?').run(Date.now(), Date.now() + SESSION_DAYS * 864e5, row.token_hash);
  }
  return row;
}

export function deleteSession(db, token) {
  if (typeof token === 'string') db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function deleteExpiredSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}
