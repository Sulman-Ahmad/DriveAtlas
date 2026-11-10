// Starts a scan of a drive. On the PC it simply asks the hub. In the Android app, a scan needs storage access:
// DriveAtlas asks for "All files access" (whole drives), and if that is refused, Android's folder picker is used
// instead (for a USB drive or SSD, pick the drive itself so the whole drive is recorded).
import { api, isLocalBackend } from './lib.js';

export async function startScan(driveId) {
  try {
    return await api('POST', `/api/drives/${driveId}/scan`, {});
  } catch (err) {
    if (!isLocalBackend() || err.message !== 'NEED_ACCESS') throw err;
  }
  const open = window.confirm('To record whole drives, DriveAtlas needs Android’s “All files access”. It only reads names, sizes and dates.\n\nOpen the setting now? (Choose Cancel to pick a folder or drive instead.)');
  if (open) {
    const r = await api('POST', '/api/phone/access').catch(() => ({ allFiles: false }));
    if (r && r.allFiles) return api('POST', `/api/drives/${driveId}/scan`, {});
  }
  const storage = window.Capacitor?.Plugins?.DriveAtlasStorage;
  const picked = storage ? await storage.pickFolder({}).catch(() => null) : null;
  if (!picked || !picked.uri) throw new Error('DriveAtlas needs access to the drive to scan it. Allow All files access, or pick the drive or folder to scan.');
  return api('POST', `/api/drives/${driveId}/scan`, { uri: picked.uri });
}
