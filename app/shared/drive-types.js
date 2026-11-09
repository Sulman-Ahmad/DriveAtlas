// Drive types, statuses and the best-guess type for a detected disk.
// Shared by the hub (Node) and the interface (browser).

export const DRIVE_TYPES = [
  { id: 'usb', name: 'USB flash drive', icon: 'usb', hint: 'Standard, mini, dual A + C' },
  { id: 'sd', name: 'SD card', icon: 'sd', hint: 'SDHC · SDXC · SDUC' },
  { id: 'microsd', name: 'microSD card', icon: 'microsd', hint: 'With or without adapter' },
  { id: 'cf', name: 'CFexpress / CF', icon: 'cf', hint: 'Type A · B · CFast' },
  { id: 'hdd35', name: 'HDD 3.5"', icon: 'hdd', hint: 'Desktop · 5400 / 7200 rpm', internal: true },
  { id: 'hdd25', name: 'HDD 2.5"', icon: 'hdd', hint: 'Laptop · 7 / 9.5 mm', internal: true },
  { id: 'hddext', name: 'External HDD', icon: 'hddext', hint: 'Portable or desktop' },
  { id: 'sata-ssd', name: 'SATA SSD 2.5"', icon: 'ssd', hint: 'TLC or QLC · DRAM', internal: true },
  { id: 'msata', name: 'mSATA SSD', icon: 'ssd', hint: 'Full or half size', internal: true },
  { id: 'm2-sata', name: 'M.2 SATA SSD', icon: 'nvme', hint: '2242 · 2260 · 2280', internal: true },
  { id: 'nvme', name: 'M.2 NVMe SSD', icon: 'nvme', hint: '2230 · 2242 · 2280 · 22110', internal: true },
  { id: 'u2', name: 'U.2 / PCIe card', icon: 'ssd', hint: 'Desktop and server NVMe', internal: true },
  { id: 'portable', name: 'Portable SSD', icon: 'portable', hint: 'USB-C · Thunderbolt' },
  { id: 'enclosure', name: 'Enclosure or dock', icon: 'enclosure', hint: 'Holds another drive' },
  { id: 'other', name: 'Other', icon: 'disc', hint: 'Optical, tape, legacy cards' }
];

const BY_ID = new Map(DRIVE_TYPES.map((t) => [t.id, t]));
export const typeById = (id) => BY_ID.get(id) || BY_ID.get('other');

// Statuses you set yourself. "Plugged in" is never stored: it is worked out live.
export const STATUSES = [
  { id: 'inpc', name: 'In PC' },
  { id: 'stored', name: 'Stored' },
  { id: 'lent', name: 'Lent out' },
  { id: 'retired', name: 'Retired' }
];
export const statusName = (id) => (STATUSES.find((s) => s.id === id) || STATUSES[1]).name;

export const BOOT_KINDS = {
  'windows-installed': 'Windows installed',
  'windows-installer': 'Windows installer',
  ventoy: 'Ventoy multi-boot',
  'linux-live': 'Linux live / installer',
  hirens: "Hiren's BootCD PE",
  uefi: 'Bootable (UEFI)',
  legacy: 'Bootable (legacy BIOS)',
  none: 'Not bootable'
};

const READER = /generic|storage device|card ?reader|multi.?card|sd\/mmc/i;

// Best guess of the drive type for a disk Windows reports. You can always change it.
export function guessType(disk) {
  const name = `${disk.friendlyName || ''} ${disk.model || ''}`;
  if (disk.busType === 'NVMe') return 'nvme';
  if (disk.busType === 'SD' || disk.busType === 'MMC') return 'sd';
  if (disk.internal) return disk.mediaType === 'HDD' ? 'hdd25' : 'sata-ssd';
  if (disk.busType === 'USB') {
    if (READER.test(name)) return 'sd';
    if (disk.mediaType === 'HDD') return 'hddext';
    if (disk.mediaType === 'SSD') return /\bT[579]\b|portable|extreme|ssd/i.test(name) ? 'portable' : 'enclosure';
    return 'usb';
  }
  return 'other';
}

// Works out what a drive is bootable as, from partitions and the files found on them.
export function bootKindFrom(partitions, partitionStyle) {
  const signals = new Set(partitions.flatMap((p) => p.signals || []));
  const labels = partitions.map((p) => String(p.label || '').toUpperCase());
  if (signals.has('ventoy') || labels.includes('VTOYEFI')) return 'ventoy';
  if (signals.has('sources\\install.wim') || signals.has('sources\\install.esd')) return 'windows-installer';
  if (signals.has('HBCD_PE.ini')) return 'hirens';
  if (['casper', 'live', 'isolinux', 'boot\\grub'].some((s) => signals.has(s))) return 'linux-live';
  if (signals.has('Windows\\System32')) return 'windows-installed';
  if (signals.has('EFI\\BOOT\\BOOTX64.EFI') || partitions.some((p) => String(p.gptType || p.gpt_type || '').includes('c12a7328'))) return 'uefi';
  if (partitionStyle === 'MBR' && partitions.some((p) => p.isActive)) return 'legacy';
  return 'none';
}
