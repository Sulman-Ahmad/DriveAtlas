// A QR code drawn as an SVG (dark squares on white, with the quiet border scanners need), for linking a phone.
import { html, useMemo } from './lib.js';
import qrcode from '/vendor/qrcode.mjs';

export function QrCode({ text, size = 220, label = 'QR code' }) {
  const { d, n } = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const count = q.getModuleCount();
    let path = '';
    for (let y = 0; y < count; y++) for (let x = 0; x < count; x++) if (q.isDark(y, x)) path += `M${x + 4} ${y + 4}h1v1h-1z`;
    return { d: path, n: count + 8 };
  }, [text]);
  return html`<svg class="qr" role="img" aria-label=${label} width=${size} height=${size} viewBox=${`0 0 ${n} ${n}`} shape-rendering="crispEdges">
    <rect width=${n} height=${n} fill="#fff" /><path d=${d} fill="#000" /></svg>`;
}
