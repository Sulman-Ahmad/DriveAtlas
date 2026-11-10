// Every help (?) text and section line in one place, shared by the Windows and Android apps.
// Keep them short and in plain words: say what the thing is and why it matters.

const STATUS_TEXT = 'In PC: built into this computer. Connected: plugged in right now. Stored: kept somewhere, like a shelf or a box. Lent out: someone else has it. Retired: no longer used, kept so you can still search its files.';

// One light line under each section's title: what you can do there.
export const LEADS = {
  home: 'Your storage at a glance: what is plugged in now, how much space you have, and anything that needs your attention.',
  drives: 'Every drive you own, plugged in or not. Filter by status, search by name, brand, place or tag, and open a drive to see its space, files, health and partitions.',
  add: 'Plug the drive in first and pick it to have its details filled in for you, or describe any drive by hand.',
  drive: 'Everything about this drive: where it is, how full it is, its files, its health and how it is split into partitions.',
  search: 'Find any file or folder on all your scanned drives, even ones that are unplugged. Each result shows which drive has it and where you keep that drive.',
  files: 'Browse this drive’s folders as they were at its last scan, even while it is unplugged.',
  scan: 'Record a drive’s folders and files (names, sizes and dates, never their contents) so you can browse and search it later.',
  settings: 'Backups, moving to a new laptop, where your catalog is kept, your password, drive health tools and how DriveAtlas looks.'
};

export const HELP = {
  // Home
  capacity: 'All your drives’ usable space added together, as Windows measures it. It is a little less than the sizes printed on the boxes, because Windows counts in a different unit (a 1 TB drive shows as about 931 GB).',
  used: 'Space in use on each drive, from the last time it was plugged in.',
  connectedNow: 'Drives Windows can see right now, inside this PC or plugged in. Click one to open it, or to add it if it is new.',
  attention: 'Things worth doing: drives that were never scanned, changes found when a drive was plugged in, new drives to add, health warnings, and drives that are nearly full.',

  // Drives and the drive form
  statuses: STATUS_TEXT,
  status: STATUS_TEXT,
  capacityLabel: 'The size printed on the box, like 1 TB. Windows shows less (a 1 TB drive appears as about 931 GB) because it counts in a different unit. Both are right.',
  serial: 'The maker’s unique number for this drive. Detected drives fill it in, and it helps DriveAtlas recognise the drive when you plug it in again.',
  location: 'Where the drive lives when it is not plugged in, like a shelf, box or drawer. Search results show it, so you know where to look.',
  tags: 'Short words to group drives, like photos, work or backup. Type one in the Drives filter to see that group.',
  interface: 'How the drive connects to a computer, for example USB 3.2 Gen 2, SATA III or PCIe 4.0 x4 (NVMe). A faster connection allows faster copying.',
  speedClass: 'Markings on SD and microSD cards. U3 and V30 promise at least 30 MB/s when recording video; A1 and A2 mean apps run smoothly from the card on a phone.',
  ratedSpeed: 'The top speed the maker advertises, in megabytes per second. Real copies are usually slower, especially with many small files.',

  // Drive page
  space: 'Live from Windows while the drive is plugged in. Otherwise it shows what DriveAtlas saw the last time it was connected.',
  files: 'A scan records the names, folders, sizes and dates on this drive, so you can browse and search them later without plugging it in. Files are never copied.',
  health: 'A score from 100% (like new) downwards. Good: nothing to worry about. Watch: early signs of wear or errors, so keep a backup. Bad: copy important files off soon. Windows asks for permission each time, because only administrators can read these details.',
  healthSource: 'Windows gives temperature and wear for most drives. The free smartmontools tool reads the drive’s own records (called S.M.A.R.T.) for more: power-on hours, data written and bad sectors.',
  partitions: 'A drive can be split into parts called partitions. Each has its own file system and, usually, a drive letter. GPT and MBR are the two ways a drive records this split. EFI and Recovery partitions are small hidden parts Windows uses to start up and repair itself.',
  fileSystem: 'How files are organised on a partition. NTFS is Windows’ own; exFAT and FAT32 work on Windows, Mac, cameras and phones; ext4 is used by Linux.',
  bootable: 'A bootable drive can start a computer on its own, like a Windows installer, Ventoy or a Linux live USB. DriveAtlas recognises these from what is on the drive.',
  changes: 'When a known drive is plugged in, DriveAtlas compares it with its record: drive letters, partitions, file systems, whether Windows is installed, and how it is connected. Nothing is changed until you choose Update.',
  labelCode: 'This drive’s own ID in DriveAtlas. It never changes, and it will go on the drive’s QR sticker when labels arrive.',

  // Scan
  scanOptions: 'What each scan records. More options give more detail but take a little longer on very large drives.',
  mediaDetails: 'Reads the first few kilobytes of each photo and video for its resolution, length and the date it was taken. The rest of the file is never read.',
  fingerprints: 'A quick fingerprint of each file (its size plus its first and last 64 KB), used to spot the same file on different drives. It is a strong hint, not a full comparison.',
  hiddenFiles: 'Also records files Windows normally hides, such as system folders. They stay out of search results unless you ask for them.',
  exclude: 'Folders you never want recorded, like node_modules or Windows\\WinSxS. They are listed as skipped, and nothing inside them is read.',
  keepScans: 'How many past scans to keep for each partition, so you can compare what changed. Older scans are deleted automatically.',

  // Search and file details
  kind: 'File types grouped into families: photos, videos, music, documents, archives, apps and code.',
  hiddenResults: 'Show files and folders Windows normally hides, such as system files, if the scan recorded them.',
  latestScan: 'Results come from each drive’s latest scan. Files added after that scan appear once you scan the drive again.',
  copies: 'Files on any of your drives with the same size and the same quick fingerprint. They are almost certainly the same file.',
  fingerprint: 'A short code made from the file’s size and its first and last 64 KB. Two files with the same code are almost certainly the same.',

  // Settings
  backups: 'A backup is one file holding your whole catalog and account, locked with your password. Keep it on another drive or a cloud folder, so a lost or broken laptop never takes your catalog with it.',
  keepBackups: 'How many automatic backups to keep in the folder. When there are more, the oldest ones are deleted. Files you put there yourself are never touched.',
  downloadBackup: 'Makes a backup right now and saves it through this window, wherever you choose, without changing your backup folder.',
  restore: 'Replaces your current catalog with the one in a backup file, for example on a new laptop. Your current catalog is kept aside as a safety copy.',
  backupPassword: 'Each backup is locked with the password you had when it was made. If you changed your password since then, use the old one.',
  catalogFolder: 'The catalog is the file that holds your drives, scans and settings. Move it if your Windows drive is short of space. Your drives themselves are not affected.',
  smartmontools: 'A free, widely used tool that reads a drive’s own health records (S.M.A.R.T.). Installing it adds power-on hours, data written, NVMe wear and bad sectors to health readings.',
  allFiles: 'Android only lets an app see whole drives with this permission. DriveAtlas uses it to record names, sizes and dates; it never opens, copies or changes your files. Without it you pick the drive or folder each time you scan.',
  phoneLock: 'The PIN and fingerprint only open DriveAtlas on this phone. The PIN is stored as a scrambled check value, never as the PIN itself, and it never leaves the phone.',
  liveUpdates: 'After a drive has been scanned once, DriveAtlas keeps its file list up to date. On the PC, Windows says when something changes in a folder, so nothing is checked over and over; only the changed files are read. When a drive is plugged in, a quick check picks up changes made elsewhere. On the phone this happens while the app is open. Windows’ own folders and app settings are left as the last full scan recorded them.',
  phoneBackups: 'A backup is one file holding your whole catalog, locked with your backup password. Save it to an SD card, a USB drive or a cloud app’s folder, so a lost phone never takes your catalog with it. DriveAtlas on your PC can restore it too.',
  phoneBackupPassword: 'Locks every backup made from now on. You need it to restore a backup, on this phone or on your PC, and nobody can recover it for you, so keep it somewhere safe. It is separate from your PIN.',
  phoneRestore: 'Replaces the catalog on this phone with the one in a backup file made on this phone, another phone or your PC. Your PIN and fingerprint setting stay as they are. If you use a PC, link with it again afterwards.',
  linkPc: 'Linking keeps the same catalog on this phone and your PC. Both work on their own; when they are on the same Wi-Fi they swap changes, and the phone shows up in the PC’s drive list.',
  firewall: 'Your phone reaches DriveAtlas over your Wi-Fi only if Windows allows it. Windows must treat your Wi-Fi as a private network (Windows Settings › Network & internet › your Wi-Fi’s properties › Private network), and Windows Firewall must allow Node.js JavaScript Runtime, the program DriveAtlas runs in, on private networks. If you chose Cancel when Windows asked, allow it in Windows Security › Firewall & network protection › Allow an app through firewall. Both must be on the same Wi-Fi; guest Wi-Fi often keeps devices apart.',
  phoneCantConnect: 'Check that the PC address and code match what DriveAtlas on your PC shows, and that both are on the same Wi-Fi (not a guest network). If it still fails, Windows on the PC is probably keeping the phone out: DriveAtlas on the PC shows the fix under Settings › Phone and helper PCs.',
  devices: 'Link your phone once and both keep the whole catalog. When they are on the same Wi-Fi they swap changes; the phone and its storage show up in Drives here. Linking opens a Wi-Fi-only connection on this PC that answers linked devices only.',
  stop: 'DriveAtlas runs quietly in the background so it can notice drives you plug in and make daily backups. Stopping it ends that until you start it again.'
};
