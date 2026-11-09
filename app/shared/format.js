// Number, size and date formatting shared by the hub and the interface.

// Sizes the way Windows shows them (1 GB = 1,073,741,824 bytes).
export function fmtBytes(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  const digits = i === 0 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${units[i]}`;
}

const STANDARD_GB = [1, 2, 4, 8, 16, 32, 64, 120, 128, 240, 250, 256, 320, 480, 500, 512, 640, 750, 960, 1000, 1500, 2000,
  3000, 4000, 5000, 6000, 8000, 10000, 12000, 14000, 16000, 18000, 20000, 22000, 24000];

// The capacity printed on the label, from the exact size Windows reports.
export function advertisedFromSize(bytes) {
  const gb = bytes / 1e9;
  let best = null;
  for (const c of STANDARD_GB) {
    if (c >= gb * 0.93 && c <= gb * 1.1 && (best === null || Math.abs(c - gb) < Math.abs(best - gb))) best = c;
  }
  return Math.round((best ?? Math.round(gb)) * 1e9);
}

// Label capacity, e.g. "512 GB" or "2 TB" (makers count 1 GB = 1,000,000,000 bytes).
export function fmtAdvertised(bytes) {
  if (!bytes) return '—';
  const gb = bytes / 1e9;
  if (gb >= 1000) return `${+(gb / 1000).toFixed(gb % 1000 === 0 ? 0 : 1)} TB`;
  return `${Math.round(gb)} GB`;
}

// Usable size before the first scan: the label bytes shown Windows-style,
// e.g. fmtBytes(64e9) gives "59.6 GB".
export const percent = (used, total) => (total > 0 ? Math.min(100, Math.max(0, Math.round((used / total) * 100))) : 0);

export function fmtNumber(n) {
  return n == null ? '—' : Number(n).toLocaleString('en-GB');
}

export function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function timeAgo(ms, now = Date.now()) {
  if (!ms) return 'never';
  const s = Math.round((now - ms) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  return fmtDate(ms);
}
