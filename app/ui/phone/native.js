// The Android side of the app (the DriveAtlasStorage plugin), and the phone's own storage and plugged-in
// drives described in the same "disk" shape the PC hub uses, so the same catalog logic applies.
import { getSetting, setSetting } from './db.js';

export const plugin = () => (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.DriveAtlasStorage) || null;

// Windows writes a FAT/exFAT volume serial as 1A2B3C4D, Android as 1A2B-3C4D: compare them without the dash.
export const normSerial = (uuid) => (uuid ? String(uuid).replace(/[^0-9a-f]/gi, '').toUpperCase() || null : null);

export async function deviceId() {
  let id = await getSetting('deviceId');
  if (!id) { id = crypto.randomUUID(); await setSetting('deviceId', id); }
  return id;
}

let infoCache = null;
export async function phoneInfo() {
  if (infoCache) return infoCache;
  const p = plugin();
  const i = p ? await p.info().catch(() => ({})) : {};
  const manufacturer = String(i.manufacturer || '').trim();
  const model = String(i.model || '').trim();
  const brand = manufacturer && !model.toLowerCase().startsWith(manufacturer.toLowerCase()) ? `${manufacturer[0].toUpperCase()}${manufacturer.slice(1)} ` : '';
  infoCache = { manufacturer, model, android: i.android || null, name: `${brand}${model}`.trim() || 'This phone' };
  return infoCache;
}

// Identity strings, like the hub's matchIdsFor().
export function phoneMatchIds(disk) {
  if (disk.kind === 'phone') return [disk.key];
  const ids = [];
  for (const p of disk.partitions) if (p.volumeSerial) ids.push(`volserial:${p.volumeSerial}`);
  if (!ids.length) ids.push(disk.key);
  return ids;
}

let cache = { at: 0, disks: [] };
export async function readPhoneDisks({ fresh = false } = {}) {
  const p = plugin();
  if (!p) return [];
  if (!fresh && Date.now() - cache.at < 2000) return cache.disks;
  const [{ volumes = [] }, info, id] = await Promise.all([p.getVolumes(), phoneInfo(), deviceId()]);
  const mounted = volumes.filter((v) => !v.state || v.state === 'mounted' || v.state === 'mounted_ro');
  const part = (v, number, label) => ({
    number, letter: null, label, fileSystem: v.fsType || null, size: v.total || null, capacity: v.total || null, free: v.free ?? null,
    volumeSerial: normSerial(v.uuid), guid: null, type: v.primary ? 'internal' : v.usb ? 'usb' : 'sd', path: v.path || null, volumeId: v.id, signals: []
  });
  const own = mounted.filter((v) => !v.usb);
  const disks = [];
  if (own.length) {
    disks.push({
      kind: 'phone', key: `phone:${id}`, number: 0, friendlyName: info.name, manufacturer: info.manufacturer, model: info.model,
      busType: 'Phone', mediaType: null, internal: true, serial: '', partitionStyle: null, health: null,
      size: own.reduce((s, v) => s + (v.total || 0), 0),
      partitions: own.map((v, i) => part(v, i + 1, v.primary ? 'Internal storage' : (v.description || 'SD card')))
    });
  }
  mounted.filter((v) => v.usb).forEach((v, i) => {
    const serial = normSerial(v.uuid);
    disks.push({
      kind: 'usb', key: serial ? `volserial:${serial}` : `usbvol:${v.id}:${Math.round((v.total || 0) / 1e6)}`, number: i + 1,
      friendlyName: v.description || 'USB drive', manufacturer: '', model: v.description || '', busType: 'USB', mediaType: null,
      internal: false, serial: '', partitionStyle: null, health: null, size: v.total || null,
      partitions: [part(v, 1, v.description || 'USB drive')]
    });
  });
  cache = { at: Date.now(), disks };
  return disks;
}

export async function accessStatus() {
  const p = plugin();
  if (!p) return { allFiles: false, needed: false };
  return p.accessStatus().catch(() => ({ allFiles: false, needed: true }));
}
