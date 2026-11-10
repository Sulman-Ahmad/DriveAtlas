// Building blocks shared by every screen.
import { html, useState, useEffect, useLayoutEffect, useMemo, useRef } from './lib.js';
import { Icon } from './icons.js';
import { typeById, statusName, BOOT_KINDS } from '/shared/drive-types.js';
import { fmtBytes, percent } from '/shared/format.js';

export { Icon };

export function TypeTile({ type, size = 40, accent = false }) {
  const t = typeById(type);
  return html`<span class=${`tile ${accent ? 'tile-accent' : ''}`} style=${`width:${size}px;height:${size}px`}><${Icon} name=${t.icon} size=${Math.round(size * 0.55)} /></span>`;
}

export const NO_HEALTH_TYPES = ['usb', 'sd', 'microsd', 'cf', 'other'];

// Uses a full health reading (state + %) when there is one, else Windows' Healthy / Warning / Unhealthy.
export function healthInfo(health, type, state, pct) {
  if (state) {
    const name = { good: 'Good', watch: 'Watch', bad: 'Bad' }[state] || state;
    return { tone: { good: 'good', watch: 'warn', bad: 'bad' }[state] || 'muted', text: pct != null ? `${name} · ${Math.round(pct)}%` : name };
  }
  if (NO_HEALTH_TYPES.includes(type)) return { tone: 'muted', text: 'No health data' };
  if (!health) return { tone: 'muted', text: 'Not checked yet' };
  if (/healthy/i.test(health) && !/un/i.test(health)) return { tone: 'good', text: 'Good' };
  if (/warning/i.test(health)) return { tone: 'warn', text: 'Watch' };
  if (/unhealthy/i.test(health)) return { tone: 'bad', text: 'Bad' };
  return { tone: 'muted', text: health };
}

export function Pill({ tone = 'muted', icon, children, dot }) {
  return html`<span class=${`pill pill-${tone}`}>${dot ? html`<span class="dot"></span>` : null}${icon ? html`<${Icon} name=${icon} size=${13} />` : null}${children}</span>`;
}

export function HealthPill({ health, type, state, pct }) {
  const h = healthInfo(health, type, state, pct);
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

export function Card({ title, help, extra, children, pad = true, id }) {
  return html`<section class="card" aria-labelledby=${id}>
    ${title ? html`<div class="card-head"><h2 id=${id}>${title}</h2>${help ? html`<${HelpTip} text=${help} label=${`About ${title}`} />` : null}${extra}</div>` : null}
    <div class=${pad ? 'card-body' : ''}>${children}</div>
  </section>`;
}

export function Empty({ icon = 'drives', title, children }) {
  return html`<div class="empty"><span class="tile"><${Icon} name=${icon} size=${22} /></span><div><strong>${title}</strong><p class="muted">${children}</p></div></div>`;
}

// With `help`, the label sits next to a (?) tip; the tip stays outside the <label> so it is not read as part of the field's name.
export function Field({ label, hint, help, children, id }) {
  if (help) {
    return html`<div class="field"><span class="field-label-row"><label class="field-label" for=${id}>${label}</label><${HelpTip} text=${help} label=${`About ${label}`} /></span>${children}${hint ? html`<span class="field-hint">${hint}</span>` : null}</div>`;
  }
  return html`<label class="field" for=${id}><span class="field-label">${label}</span>${children}${hint ? html`<span class="field-hint">${hint}</span>` : null}</label>`;
}

export function ErrorNote({ error }) {
  if (!error) return null;
  return html`<p class="error-note" role="alert"><${Icon} name="alert" size=${16} />${error}</p>`;
}

// One light line under a page title saying what you can do there.
export function Lead({ children }) {
  return html`<p class="page-lead">${children}</p>`;
}

// A small (?) that explains a term or option. Shows on hover or keyboard focus, and stays open on click or tap.
let tipSeq = 0;
export function HelpTip({ text, label = 'What does this mean?' }) {
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  const btn = useRef(null);
  const tip = useRef(null);
  const id = useMemo(() => `help-tip-${++tipSeq}`, []);
  const shown = pinned || hover;

  // Places the tip under the (?) (or above it near the bottom of the window), kept inside the window.
  useLayoutEffect(() => {
    if (!shown || !btn.current || !tip.current) return;
    const b = btn.current.getBoundingClientRect();
    const t = tip.current.getBoundingClientRect();
    const edge = 8;
    const left = Math.max(edge, Math.min(b.left + b.width / 2 - t.width / 2, innerWidth - t.width - edge));
    let top = b.bottom + 8;
    if (top + t.height > innerHeight - edge) top = Math.max(edge, b.top - 8 - t.height);
    Object.assign(tip.current.style, { left: `${Math.round(left)}px`, top: `${Math.round(top)}px`, visibility: 'visible' });
  }, [shown]);

  useEffect(() => {
    if (!shown) return undefined;
    const close = () => { setPinned(false); setHover(false); };
    const outside = (e) => { if (!btn.current?.contains(e.target) && !tip.current?.contains(e.target)) close(); };
    const key = (e) => { if (e.key === 'Escape') close(); };
    addEventListener('pointerdown', outside, true);
    addEventListener('keydown', key);
    addEventListener('scroll', close, true);
    addEventListener('resize', close);
    return () => {
      removeEventListener('pointerdown', outside, true);
      removeEventListener('keydown', key);
      removeEventListener('scroll', close, true);
      removeEventListener('resize', close);
    };
  }, [shown]);

  return html`<span class="help">
    <button type="button" class="help-btn" ref=${btn} aria-label=${label} aria-expanded=${shown ? 'true' : 'false'} aria-describedby=${shown ? id : undefined}
      onClick=${(e) => { e.preventDefault(); e.stopPropagation(); setPinned((p) => !p); }}
      onMouseEnter=${() => setHover(true)} onMouseLeave=${() => setHover(false)}
      onFocus=${() => setHover(true)} onBlur=${() => setHover(false)}>?</button>
    ${shown ? html`<span class="help-tip" role="tooltip" id=${id} ref=${tip}>${text}</span>` : null}
  </span>`;
}
