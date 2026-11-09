// Building blocks shared by every screen.
import { html } from './lib.js';
import { Icon } from './icons.js';
import { typeById, statusName, BOOT_KINDS } from '/shared/drive-types.js';
import { fmtBytes, percent } from '/shared/format.js';

export { Icon };

export function TypeTile({ type, size = 40, accent = false }) {
  const t = typeById(type);
  return html`<span class=${`tile ${accent ? 'tile-accent' : ''}`} style=${`width:${size}px;height:${size}px`}><${Icon} name=${t.icon} size=${Math.round(size * 0.55)} /></span>`;
}

// Windows reports Healthy / Warning / Unhealthy until full SMART data arrives.
export function healthInfo(health, type) {
  const noHealth = ['usb', 'sd', 'microsd', 'cf', 'other'].includes(type);
  if (noHealth) return { tone: 'muted', text: 'No health data' };
  if (!health) return { tone: 'muted', text: 'Not checked yet' };
  if (/healthy/i.test(health) && !/un/i.test(health)) return { tone: 'good', text: 'Good' };
  if (/warning/i.test(health)) return { tone: 'warn', text: 'Watch' };
  if (/unhealthy/i.test(health)) return { tone: 'bad', text: 'Bad' };
  return { tone: 'muted', text: health };
}

export function Pill({ tone = 'muted', icon, children, dot }) {
  return html`<span class=${`pill pill-${tone}`}>${dot ? html`<span class="dot"></span>` : null}${icon ? html`<${Icon} name=${icon} size=${13} />` : null}${children}</span>`;
}

export function HealthPill({ health, type }) {
  const h = healthInfo(health, type);
  return html`<${Pill} tone=${h.tone}>${h.text}</${Pill}>`;
}

export function StatusPill({ drive }) {
  const letters = drive.letters && drive.letters.length ? ` · ${drive.letters.map((l) => `${l}:`).join(' ')}` : '';
  if (drive.liveStatus === 'plugged') return html`<${Pill} tone="good" dot>Plugged in${letters}</${Pill}>`;
  if (drive.liveStatus === 'inpc') return html`<${Pill} tone="plain">In PC${letters}</${Pill}>`;
  if (drive.liveStatus === 'lent') return html`<${Pill} tone="warn" icon="user">${drive.lent_to ? `Lent to ${drive.lent_to}` : 'Lent out'}</${Pill}>`;
  if (drive.liveStatus === 'retired') return html`<${Pill} tone="muted">Retired</${Pill}>`;
  return html`<${Pill} tone="muted" icon="pin">${drive.location || statusName(drive.liveStatus)}</${Pill}>`;
}

export function BootPill({ kind }) {
  if (!kind || kind === 'none') return null;
  return html`<${Pill} tone="accent" icon="power">${BOOT_KINDS[kind] || kind}</${Pill}>`;
}

export function CapacityBar({ used, total, thick }) {
  const p = percent(used || 0, total || 0);
  const warn = total && used && used / total > 0.9;
  return html`<div class=${`bar ${thick ? 'bar-thick' : ''}`} role="img" aria-label=${`${p}% used`}>
    <div class=${`bar-fill ${warn ? 'bar-warn' : ''}`} style=${`width:${p}%`}></div>
  </div>`;
}

export function UsageLine({ used, total }) {
  if (!total) return html`<span class="muted small">Size unknown</span>`;
  if (used == null) return html`<span class="muted small">${fmtBytes(total)} · not scanned yet</span>`;
  const p = percent(used, total);
  return html`<span class="usage small"><span>${fmtBytes(used)} of ${fmtBytes(total)}</span><span class=${used / total > 0.9 ? 'warn-text' : 'muted'}>${p}%</span></span>`;
}

export function Button({ kind = 'secondary', icon, children, ...rest }) {
  return html`<button type="button" class=${`btn btn-${kind}`} ...${rest}>${icon ? html`<${Icon} name=${icon} size=${17} />` : null}${children}</button>`;
}

export function LinkButton({ kind = 'secondary', icon, href, children }) {
  return html`<a class=${`btn btn-${kind}`} href=${href}>${icon ? html`<${Icon} name=${icon} size=${17} />` : null}${children}</a>`;
}

export function Card({ title, extra, children, pad = true, id }) {
  return html`<section class="card" aria-labelledby=${id}>
    ${title ? html`<div class="card-head"><h2 id=${id}>${title}</h2>${extra}</div>` : null}
    <div class=${pad ? 'card-body' : ''}>${children}</div>
  </section>`;
}

export function Empty({ icon = 'drives', title, children }) {
  return html`<div class="empty"><span class="tile"><${Icon} name=${icon} size=${22} /></span><div><strong>${title}</strong><p class="muted">${children}</p></div></div>`;
}

export function Field({ label, hint, children, id }) {
  return html`<label class="field" for=${id}><span class="field-label">${label}</span>${children}${hint ? html`<span class="field-hint">${hint}</span>` : null}</label>`;
}

export function ErrorNote({ error }) {
  if (!error) return null;
  return html`<p class="error-note" role="alert"><${Icon} name="alert" size=${16} />${error}</p>`;
}
