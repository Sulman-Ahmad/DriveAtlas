// The phone's lock: a PIN, kept only as a salted PBKDF2-SHA-256 hash in the phone's catalog, and the
// fingerprint (or face unlock) through Android when the phone has it. Wrong PINs make you wait longer each time.
import { getSetting, setSetting } from './db.js';
import { plugin } from './native.js';

const ITERATIONS = 310000;
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(pin, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export function checkNewPin(pin) {
  const s = String(pin || '');
  if (!/^\d{4,12}$/.test(s)) return 'Use 4 to 12 digits for your PIN.';
  if (/^(\d)\1+$/.test(s) || '0123456789012'.includes(s) || '9876543210987'.includes(s)) return 'That PIN is too easy to guess. Avoid repeated or running digits.';
  return null;
}

export async function setPin(pin) {
  const problem = checkNewPin(pin);
  if (problem) throw Object.assign(new Error(problem), { status: 400 });
  const salt = crypto.getRandomValues(new Uint8Array(16));
  await setSetting('phoneLock', { salt: b64(salt), hash: b64(await derive(pin, salt, ITERATIONS)), iterations: ITERATIONS });
}

// Grows the wait after the 5th wrong PIN in a row: 30 s, then doubling up to 15 minutes. Survives restarts.
async function guard() {
  return getSetting('phoneLockGuard', { fails: 0, until: 0 });
}

export async function checkPin(pin) {
  const g = await guard();
  const wait = Math.ceil((g.until - Date.now()) / 1000);
  if (wait > 0) throw Object.assign(new Error(`Too many wrong PINs. Try again in ${wait} seconds.`), { status: 429 });
  const rec = await getSetting('phoneLock');
  if (!rec) throw Object.assign(new Error('No PIN is set on this phone.'), { status: 409 });
  const got = await derive(pin, unb64(rec.salt), rec.iterations);
  const want = unb64(rec.hash);
  let diff = got.length ^ want.length;
  for (let i = 0; i < Math.min(got.length, want.length); i++) diff |= got[i] ^ want[i];
  if (diff === 0) { await setSetting('phoneLockGuard', { fails: 0, until: 0 }); return true; }
  const fails = g.fails + 1;
  const until = fails >= 5 ? Date.now() + Math.min(30000 * 2 ** (fails - 5), 15 * 60000) : 0;
  await setSetting('phoneLockGuard', { fails, until });
  throw Object.assign(new Error('That PIN is not right.'), { status: 401 });
}

export async function biometricStatus() {
  const p = plugin();
  if (!p) return { available: false };
  return p.biometricStatus().catch(() => ({ available: false }));
}

// Shows Android's own fingerprint prompt. Resolves true only when Android confirms it.
export async function unlockWithBiometric() {
  const p = plugin();
  if (!p || !(await getSetting('phoneBiometric', false))) return false;
  try {
    const r = await p.unlock({ title: 'Open DriveAtlas', subtitle: 'Use your fingerprint', cancel: 'Use PIN' });
    return Boolean(r && r.ok);
  } catch {
    return false;
  }
}
