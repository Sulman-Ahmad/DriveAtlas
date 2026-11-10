// Encryption for talking to the PC hub (same format as hub/lan.mjs): AES-256-GCM with a 12-byte IV, the tag
// appended, and "DA1|device|op|time|direction" as authenticated data. Link codes become keys with HKDF-SHA-256.
const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const aad = (device, op, ts, dir) => enc.encode(`DA1|${device}|${op}|${ts}|${dir}`);

export const importKey = (b64) => crypto.subtle.importKey('raw', fromB64(b64), 'AES-GCM', false, ['encrypt', 'decrypt']);

export async function pairKey(code) {
  const base = await crypto.subtle.importKey('raw', enc.encode(code), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('driveatlas-pair-v1'), info: new Uint8Array(0) }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function seal(key, device, op, dir, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ts = Date.now();
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(device, op, ts, dir) }, key, enc.encode(JSON.stringify(obj))));
  return { v: 1, ts, iv: toB64(iv), data: toB64(data) };
}

export async function open(key, device, op, dir, env) {
  if (!env || env.v !== 1 || typeof env.iv !== 'string' || typeof env.data !== 'string') throw new Error('The PC sent a message this phone cannot read.');
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(env.iv), additionalData: aad(device, op, env.ts, dir) }, key, fromB64(env.data));
  } catch {
    throw new Error('The PC’s reply could not be verified.');
  }
  return JSON.parse(dec.decode(plain));
}
