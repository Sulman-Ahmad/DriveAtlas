// The DriveAtlas backup file, readable and writable with plain Web Crypto, so the Android app can make backups the
// PC can restore and restore the PC's backups (Node runs the same code in tests). Same format as hub/backup-worker.mjs:
//   "DRIVEATLAS-BACKUP 1\n" + header JSON line + AES-256-GCM(gzip(SQLite database)) + 16-byte tag,
// with the magic line and header authenticated as additional data. The key comes from the password with scrypt.

export const MAGIC = 'DRIVEATLAS-BACKUP 1\n';
// Strong but quick enough on a phone (32 MB of memory); the PC uses N = 131072 and accepts 16384 to 1048576.
export const PHONE_KDF = { N: 32768, r: 8, p: 1 };
const MAX_HEADER = 4096;

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;
const fail = (code, message) => Object.assign(new Error(message), { code });

export function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- scrypt (RFC 7914) ----------
async function pbkdf2(password, salt, bytes) {
  const key = await subtle().importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 1 }, key, bytes * 8));
}

function salsa208(B, x) {
  for (let i = 0; i < 16; i++) x[i] = B[i];
  const R = (a, b) => (a << b) | (a >>> (32 - b));
  for (let i = 0; i < 8; i += 2) {
    x[4] ^= R(x[0] + x[12], 7); x[8] ^= R(x[4] + x[0], 9); x[12] ^= R(x[8] + x[4], 13); x[0] ^= R(x[12] + x[8], 18);
    x[9] ^= R(x[5] + x[1], 7); x[13] ^= R(x[9] + x[5], 9); x[1] ^= R(x[13] + x[9], 13); x[5] ^= R(x[1] + x[13], 18);
    x[14] ^= R(x[10] + x[6], 7); x[2] ^= R(x[14] + x[10], 9); x[6] ^= R(x[2] + x[14], 13); x[10] ^= R(x[6] + x[2], 18);
    x[3] ^= R(x[15] + x[11], 7); x[7] ^= R(x[3] + x[15], 9); x[11] ^= R(x[7] + x[3], 13); x[15] ^= R(x[11] + x[7], 18);
    x[1] ^= R(x[0] + x[3], 7); x[2] ^= R(x[1] + x[0], 9); x[3] ^= R(x[2] + x[1], 13); x[0] ^= R(x[3] + x[2], 18);
    x[6] ^= R(x[5] + x[4], 7); x[7] ^= R(x[6] + x[5], 9); x[4] ^= R(x[7] + x[6], 13); x[5] ^= R(x[4] + x[7], 18);
    x[11] ^= R(x[10] + x[9], 7); x[8] ^= R(x[11] + x[10], 9); x[9] ^= R(x[8] + x[11], 13); x[10] ^= R(x[9] + x[8], 18);
    x[12] ^= R(x[15] + x[14], 7); x[13] ^= R(x[12] + x[15], 9); x[14] ^= R(x[13] + x[12], 13); x[15] ^= R(x[14] + x[13], 18);
  }
  for (let i = 0; i < 16; i++) B[i] = (B[i] + x[i]) | 0;
}

// BlockMix with salsa20/8: B (32r words) -> Y, even blocks first then odd blocks.
function blockMix(B, Y, r, X, tmp) {
  X.set(B.subarray((2 * r - 1) * 16, 2 * r * 16));
  for (let i = 0; i < 2 * r; i++) {
    for (let k = 0; k < 16; k++) X[k] ^= B[i * 16 + k];
    salsa208(X, tmp);
    Y.set(X, ((i & 1) * r + (i >> 1)) * 16);
  }
}

function roMix(B, N, r) {
  const words = 32 * r;
  const V = new Int32Array(words * N);
  let X = new Int32Array(B);
  let Y = new Int32Array(words);
  const T = new Int32Array(16);
  const tmp = new Int32Array(16);
  for (let i = 0; i < N; i++) { V.set(X, i * words); blockMix(X, Y, r, T, tmp); [X, Y] = [Y, X]; }
  for (let i = 0; i < N; i++) {
    const j = X[(2 * r - 1) * 16] & (N - 1);
    for (let k = 0; k < words; k++) X[k] ^= V[j * words + k];
    blockMix(X, Y, r, T, tmp);
    [X, Y] = [Y, X];
  }
  B.set(X);
}

export async function scrypt(password, salt, { N, r, p }, dkLen = 32) {
  if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0) throw new Error('scrypt N must be a power of two.');
  const pw = typeof password === 'string' ? enc.encode(password) : password;
  const B = await pbkdf2(pw, salt, p * 128 * r);
  const dv = new DataView(B.buffer, B.byteOffset, B.byteLength);
  for (let i = 0; i < p; i++) {
    const words = new Int32Array(32 * r);
    for (let k = 0; k < words.length; k++) words[k] = dv.getInt32((i * 32 * r + k) * 4, true);
    roMix(words, N, r);
    for (let k = 0; k < words.length; k++) dv.setInt32((i * 32 * r + k) * 4, words[k], true);
  }
  return pbkdf2(pw, B, dkLen);
}

// The key backups are encrypted with, remembered so later backups need no password (like the PC does).
export async function deriveBackupKey(password, kdf = PHONE_KDF) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const key = await scrypt(password, salt, kdf);
  return { salt: toB64(salt), key: toB64(key), N: kdf.N, r: kdf.r, p: kdf.p };
}

// ---------- gzip ----------
async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

// ---------- Writing and reading backup files ----------
export async function makeBackup(dbBytes, keyInfo, { version = null, created = Date.now() } = {}) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const header = { app: 'DriveAtlas', format: 1, version, created, kdf: { name: 'scrypt', N: keyInfo.N, r: keyInfo.r, p: keyInfo.p, salt: keyInfo.salt },
    cipher: 'aes-256-gcm', iv: toB64(iv), compression: 'gzip' };
  const head = enc.encode(MAGIC + JSON.stringify(header) + '\n');
  const key = await subtle().importKey('raw', fromB64(keyInfo.key), 'AES-GCM', false, ['encrypt']);
  const body = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: head }, key, await pipe(dbBytes, new CompressionStream('gzip'))));
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

export function readBackupHeader(file) {
  const magic = enc.encode(MAGIC);
  if (file.length < magic.length + 40 || magic.some((b, i) => file[i] !== b)) throw fail('NOT_BACKUP', 'This is not a DriveAtlas backup file.');
  const nl = file.indexOf(0x0a, magic.length);
  if (nl < 0 || nl - magic.length > MAX_HEADER) throw fail('NOT_BACKUP', 'This backup file is damaged (its header is missing).');
  let h;
  try { h = JSON.parse(dec.decode(file.subarray(magic.length, nl))); } catch { throw fail('NOT_BACKUP', 'This backup file is damaged (its header cannot be read).'); }
  const N = h?.kdf?.N;
  let saltOk = false;
  let ivOk = false;
  try { saltOk = fromB64(String(h.kdf.salt)).length === 16; ivOk = fromB64(String(h.iv)).length === 12; } catch { /* checked below */ }
  const valid = h && h.app === 'DriveAtlas' && h.format === 1 && h.cipher === 'aes-256-gcm' && h.compression === 'gzip' && h.kdf?.name === 'scrypt'
    && Number.isInteger(N) && N >= 16384 && N <= 1048576 && (N & (N - 1)) === 0 && h.kdf.r === 8 && h.kdf.p === 1 && saltOk && ivOk;
  if (!valid) throw fail('NOT_BACKUP', 'This backup was made by an unknown version of DriveAtlas, or it is damaged.');
  return { h, headerEnd: nl + 1 };
}

// Returns the SQLite database inside the backup, or throws with code NOT_BACKUP or BAD_PASSWORD.
export async function openBackup(file, password) {
  const { h, headerEnd } = readBackupHeader(file);
  const keyBytes = await scrypt(String(password), fromB64(h.kdf.salt), h.kdf);
  const key = await subtle().importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  let zipped;
  try {
    zipped = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(h.iv), additionalData: file.subarray(0, headerEnd) }, key, file.subarray(headerEnd)));
  } catch {
    // A wrong password and a changed file look the same to AES-GCM.
    throw fail('BAD_PASSWORD', 'The password is wrong, or the backup file was changed or damaged.');
  }
  const db = await pipe(zipped, new DecompressionStream('gzip'));
  return { db, header: h };
}
