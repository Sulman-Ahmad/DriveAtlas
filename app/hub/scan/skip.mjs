// Folders of the Windows drive that live updates leave alone: Windows, programs and app settings change them all
// the time. A full scan still records them (unless they are skipped folders); live updates and catch-up scans do not.
import fs from 'node:fs';
import path from 'node:path';

export const SKIP_TOP = new Set(['windows', 'program files', 'program files (x86)', 'programdata', '$recycle.bin', 'system volume information',
  'recovery', 'perflogs', '$winreagent', '$windows.~bt', '$windows.~ws', '$sysreset', 'config.msi', 'msocache', 'documents and settings',
  'onedrivetemp', 'windows.old', 'intel', 'amd', 'nvidia', 'xboxgames', 'msys64']);
export const SKIP_IN_USER = new Set(['appdata', 'application data', 'local settings', 'cookies', 'nethood', 'printhood', 'recent',
  'sendto', 'start menu', 'templates', 'my documents']);
export const SKIP_USERS = new Set(['all users', 'default', 'default user', 'defaultapppool']);

export const isDriveRoot = (root) => /^[A-Za-z]:\\?$/.test(String(root || ''));
export const isSystemDrive = (root) => isDriveRoot(root) && fs.existsSync(path.join(`${root.slice(0, 2)}\\`, 'Windows', 'System32'));

// rel: a path relative to the drive root, parts joined by "\".
export function systemSkip(rel) {
  const parts = String(rel || '').split('\\').filter(Boolean).map((p) => p.toLowerCase());
  if (!parts.length) return false;
  if (SKIP_TOP.has(parts[0])) return true;
  if (parts[0] === 'users' && parts.length > 1 && SKIP_USERS.has(parts[1])) return true;
  return parts[0] === 'users' && parts.length > 2 && SKIP_IN_USER.has(parts[2]);
}
