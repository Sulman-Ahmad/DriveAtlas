// Drive page: details, partitions, changes to review, edit and delete.
import { html, useState, useEffect, api, go, isLocalBackend } from '../lib.js';
import { startScan } from '../scan-start.js';
import { Icon, Card, TypeTile, StatusPill, HealthPill, BootPill, CapacityBar, UsageLine, Button, Pill, ErrorNote, NO_HEALTH_TYPES, HelpTip } from '../components.js';
import { HELP } from '../help.js';
import { DriveForm } from './drive-form.js';
import { typeById, BOOT_KINDS, statusName, brandAndModel } from '/shared/drive-types.js';
import { fmtBytes, fmtAdvertised, fmtDate, fmtNumber, timeAgo } from '/shared/format.js';

export function DrivePage({ id, data, onChanged }) {
  const [state, setState] = useState({ loading: true });
  const [mode, setMode] = useState('view');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => Promise.all([api('GET', `/api/drives/${id}`), api('GET', `/api/drives/${id}/scans`), api('GET', `/api/drives/${id}/health`)])
    .then(([r, s, h]) => setState({ drive: r.drive, disk: r.disk, scans: s.current, health: h.history })).catch((err) => setState({ error: err.message }));
  useEffect(() => { setMode('view'); load(); }, [id, data.version]);

  if (state.loading) return html`<div class="page"><p class="muted">Loading…</p></div>`;
  if (state.error) return html`<div class="page"><nav class="crumbs"><a href="#/drives">Drives</a></nav><${ErrorNote} error=${state.error} /></div>`;
  const d = state.drive;
  const t = typeById(d.type);
  const kind = d.type === 'other' && d.other_kind ? d.other_kind : t.name;
  const boot = d.bootable_override || d.bootable_kind;
  const brandModel = brandAndModel(d);

  async function save(values) {
    setBusy(true);
    setError('');
    try {
      await api('PATCH', `/api/drives/${id}`, values);
      await onChanged();
      setMode('view');
      await load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function scanNow() {
    setBusy(true);
    setError('');
    try { await startScan(id); go('#/scan'); } catch (err) { setError(err.message); setBusy(false); }
  }

  async function checkChanges() {
    setError('');
    try { await api('POST', `/api/drives/${id}/catch-up`); await load(); } catch (err) { setError(err.message); }
  }

  async function remove() {
    setBusy(true);
    try {
      await api('DELETE', `/api/drives/${id}`);
      await onChanged();
      go('#/drives');
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return html`<div class="page">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="#/drives">Drives</a><${Icon} name="right" size=${14} /><span>${d.name}</span></nav>
    <header class="drive-head">
      <${TypeTile} type=${d.type} size=${56} />
      <div class="grow stack-sm">
        <h1>${d.name}</h1>
        ${brandModel ? html`<div class="drive-brand">${brandModel}</div>` : null}
        <div class="muted">${kind}${d.advertised_bytes ? ` · ${fmtAdvertised(d.advertised_bytes)}` : ''}${d.actual_bytes ? ` (${fmtBytes(d.actual_bytes)} usable)` : ''}</div>
        <div class="pills"><${StatusPill} drive=${d} /><${HealthPill} health=${d.health_status} type=${d.type} state=${d.health_state} pct=${d.health_pct} /><${BootPill} kind=${boot} />
          ${d.label_code ? html`<span class="pill-help"><${Pill} tone="plain" icon="qr">${d.label_code}</${Pill}><${HelpTip} text=${HELP.labelCode} label="About the label code" /></span>` : null}</div>
      </div>
      ${mode === 'view' ? html`<div class="actions">
        ${d.connected ? html`<${Button} kind="primary" icon="scan" disabled=${busy} onClick=${scanNow}>${state.scans.length ? 'Scan again' : 'Scan now'}</${Button}>` : null}
        <${Button} icon="edit" onClick=${() => setMode('edit')}>Edit</${Button}>
        <${Button} icon="trash" kind="danger" onClick=${() => setMode('delete')}>Delete</${Button}>
      </div>` : null}
    </header>

    ${d.pendingChanges ? html`<${ChangesPanel} drive=${d} connected=${Boolean(state.disk)} onDone=${async () => { await onChanged(); await load(); }} />` : null}

    ${mode === 'delete' ? html`<div class="callout callout-bad" role="alert">
      <${Icon} name="alert" size=${20} />
      <div class="grow"><strong>Delete ${d.name} from your catalog?</strong><div class="small">Its record and partition details are removed from DriveAtlas. The drive itself and its files are not touched.</div></div>
      <${Button} kind="secondary" onClick=${() => setMode('view')}>Cancel</${Button}>
      <${Button} kind="danger-solid" disabled=${busy} onClick=${remove}>Delete from catalog</${Button}>
    </div>` : null}

    ${mode === 'edit' ? html`<${Card} id="h-edit" title="Edit drive">
      <${DriveForm} initial=${d} showType submitLabel="Save changes" busy=${busy} error=${error} onSubmit=${save} onCancel=${() => setMode('view')} />
    </${Card}>` : html`
    <div class="columns">
      <div class="col-main stack-lg">
        ${mode === 'view' && error ? html`<${ErrorNote} error=${error} />` : null}
        <${Card} id="h-space" title="Space" help=${HELP.space}>
          <${CapacityBar} used=${d.used} total=${d.total} thick />
          <div class="mt6"><${UsageLine} used=${d.used} total=${d.total} /></div>
          <p class="small muted">${d.connected ? 'Live from Windows right now.' : `Last seen ${timeAgo(d.last_seen_at)}.`}</p>
        </${Card}>
        <${Card} id="h-files" title="Files" help=${HELP.files} extra=${state.scans.length ? html`<a class="link push small" href=${`#/files/${d.id}`}>Browse files</a>` : null}>
          ${state.scans.length ? html`<div class="stack-sm">${state.scans.map((s) => html`<a class="scan-line" href=${`#/files/${d.id}?scan=${s.id}&dir=0`}>
              <${Icon} name="folder" size=${18} /><strong>${s.partition_label || `Partition ${s.partition_idx}`}</strong>
              <span class="muted small num">${fmtNumber(s.file_count)} files · ${fmtNumber(s.folder_count)} folders · ${fmtBytes(s.total_bytes)} · scanned ${timeAgo(s.finished_at)}${s.updated_at && s.updated_at > s.finished_at ? ` · updated ${timeAgo(s.updated_at)}` : ''}</span>
            </a>`)}<${LiveLine} d=${d} onCheck=${checkChanges} busy=${busy} /></div>`
          : html`<p class="small muted mt0">${d.connected ? 'Not scanned yet. Scan it to record its folders and files; nothing is copied.' : 'Not scanned yet. Plug it in to scan it.'}</p>`}
        </${Card}>
        <${HealthSection} d=${d} history=${state.health} onRead=${async () => { await onChanged(); await load(); }} />
        <${Card} id="h-parts" title="Partitions" help=${HELP.partitions} extra=${html`<span class="muted small">${d.partition_style || ''}${d.partitions.length ? ` · ${d.partitions.length}` : ''}</span>`}>
          ${d.partitions.length ? html`<div class="table-wrap"><table class="table">
            <thead><tr><th>#</th><th>Name</th><th>File system<${HelpTip} text=${HELP.fileSystem} label="About file systems" /></th><th>Size</th><th>Used</th><th>Notes</th></tr></thead>
            <tbody>${d.partitions.map((p) => html`<tr>
              <td class="muted">${p.idx}</td>
              <td><strong>${p.label || partName(p)}</strong>${p.last_letter ? html` <span class="muted">${p.last_letter}:</span>` : null}</td>
              <td>${p.filesystem || html`<span class="muted">—</span>`}</td>
              <td class="num">${fmtBytes(p.size)}</td>
              <td class="num">${p.used != null ? fmtBytes(p.used) : html`<span class="muted">—</span>`}</td>
              <td class="muted">${partNote(p)}</td></tr>`)}</tbody></table></div>`
          : html`<p class="muted small mt0">No partition details yet. Plug the drive in once and they are read automatically.</p>`}
        </${Card}>
      </div>
      <div class="col-side stack-lg">
        <${Card} id="h-details" title="Details" pad=${false}>
          <dl class="kv kv-rows">
            ${row('Type', kind)}
            ${row('Brand and model', brandModel)}
            ${row('Serial', d.serial)}
            ${row('Capacity', d.advertised_bytes ? `${fmtAdvertised(d.advertised_bytes)} · ${fmtBytes(d.actual_bytes || d.advertised_bytes)} usable` : null)}
            ${row('Connection', [d.bus, d.media].filter(Boolean).join(', '))}
            ${row('Interface', d.interface)}
            ${row('Speed', d.rated_read_mbs || d.rated_write_mbs ? `${d.rated_read_mbs || '?'} / ${d.rated_write_mbs || '?'} MB/s` : d.speed_class)}
            ${row(html`Bootable<${HelpTip} text=${HELP.bootable} label="About bootable drives" />`, boot ? BOOT_KINDS[boot] : null)}
            ${row('Added', fmtDate(d.created_at))}
            ${row('Last seen', d.connected ? 'Connected now' : timeAgo(d.last_seen_at))}
          </dl>
        </${Card}>
        <${Card} id="h-where" title="Where it is">
          <div class="stack-sm small">
            <div class="inline"><${Icon} name="pin" size=${16} />${d.location || html`<span class="muted">No location set</span>`}</div>
            <div class="muted">Status: ${statusName(d.status)}${d.status === 'lent' && d.lent_to ? ` to ${d.lent_to}${d.due_back ? `, due ${d.due_back}` : ''}` : ''}</div>
            ${d.tags?.length ? html`<div class="pills">${d.tags.map((tag) => html`<span class="tag">${tag}</span>`)}</div>` : null}
            ${d.notes ? html`<p class="notes">${d.notes}</p>` : null}
          </div>
        </${Card}>
        ${d.purchase_price || d.purchase_date || d.shop || d.warranty_until ? html`<${Card} id="h-buy" title="Purchase and warranty" pad=${false}>
          <dl class="kv kv-rows">${row('Price', d.purchase_price)}${row('Bought', d.purchase_date)}${row('Shop', d.shop)}${row('Warranty ends', d.warranty_until)}</dl>
        </${Card}>` : null}
      </div>
    </div>`}
  </div>`;
}

function ChangesPanel({ drive, connected, onDone }) {
  const changes = drive.pendingChanges.changes;
  const suggestion = changes.find((c) => c.suggestStatus);
  const [useStatus, setUseStatus] = useState(Boolean(suggestion));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function act(kind) {
    setBusy(true);
    setError('');
    try {
      if (kind === 'apply') await api('POST', `/api/drives/${drive.id}/changes/apply`, { status: useStatus && suggestion ? suggestion.suggestStatus : undefined });
      else await api('POST', `/api/drives/${drive.id}/changes/dismiss`);
      await onDone();
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return html`<section class="card card-accent" aria-labelledby="h-changes">
    <div class="card-head"><span class="tile tile-accent"><${Icon} name="sync" size=${18} /></span>
      <div><h2 id="h-changes">Changes found when this drive was plugged in<${HelpTip} text=${HELP.changes} label="About change detection" /></h2><div class="small muted">Nothing is changed until you choose Update record.</div></div></div>
    <div class="card-body stack-sm">
      <ul class="change-list">${changes.map((c) => html`<li><${Icon} name="right" size=${14} />${c.text}</li>`)}</ul>
      ${suggestion ? html`<label class="check" for="chg-status"><input id="chg-status" type="checkbox" checked=${useStatus} onChange=${(e) => setUseStatus(e.target.checked)} />${suggestion.suggestText}</label>` : null}
      ${!connected ? html`<p class="small muted">Plug the drive in again to update its partition details.</p>` : null}
      <${ErrorNote} error=${error} />
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" disabled=${busy} onClick=${() => act('dismiss')}>Not now</button>
        <button type="button" class="btn btn-primary" disabled=${busy} onClick=${() => act('apply')}>Update record</button>
      </div>
    </div>
  </section>`;
}

function HealthSection({ d, history, onRead }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const last = history[0];
  const flash = NO_HEALTH_TYPES.includes(d.type);
  const onPhone = isLocalBackend();

  async function read() {
    setBusy(true);
    setMsg('Windows will ask for permission. Choose Yes to read drive health.');
    try { await api('POST', '/api/health/read'); setMsg(''); await onRead(); } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }

  const stat = (label, value) => (value == null ? null : html`<div class="mini-stat"><span>${label}</span><strong>${value}</strong></div>`);
  return html`<${Card} id="h-health" title="Health" help=${HELP.health} extra=${last ? html`<span class="muted small push">Read ${timeAgo(last.taken_at)} · ${last.source === 'smartctl' ? 'smartctl' : 'Windows'}</span><${HelpTip} text=${HELP.healthSource} label="Where health readings come from" />` : null}>
    ${last ? html`<div class="stack">
      <div class="health-head">
        <span class=${`health-big health-${last.status || 'none'}`}>${last.health_pct != null ? `${Math.round(last.health_pct)}%` : '—'}</span>
        <${HealthPill} health=${d.health_status} type=${d.type} state=${last.status} />
        ${history.length > 1 ? html`<${Sparkline} points=${history.slice().reverse().map((h) => h.health_pct).filter((v) => v != null)} />` : null}
      </div>
      <div class="stat-grid">
        ${stat('Temperature', last.temp_c != null ? `${Math.round(last.temp_c)} °C` : null)}
        ${stat('Power-on hours', last.power_on_hours != null ? `${fmtNumber(last.power_on_hours)} h` : null)}
        ${stat('Power cycles', last.power_cycles != null ? fmtNumber(last.power_cycles) : null)}
        ${stat('Written', last.tb_written != null ? `${last.tb_written} TB` : null)}
        ${stat('Reallocated sectors', last.reallocated)}
        ${stat('Pending sectors', last.pending)}
        ${stat('Media errors', last.media_errors)}
      </div>
    </div>` : html`<p class="small muted mt0">${d.type === 'phone'
      ? 'Phones do not share their storage health with apps. DriveAtlas shows the phone’s space and file list instead.'
      : flash
      ? 'USB sticks and memory cards do not report health. DriveAtlas shows their age and last scan instead.'
      : onPhone ? 'Drive health is read on a PC. Link a PC in Settings and plug the drive in there; the reading then syncs to this phone.'
      : d.connected ? 'Not read yet. Reading health needs Windows permission: a prompt appears and you choose Yes. Nothing on the drive is changed.' : 'Not read yet. Plug the drive in to read its health.'}</p>`}
    ${msg ? html`<p class="small muted" role="status">${msg}</p>` : null}
    ${d.connected && !flash && !onPhone ? html`<div class="mt6"><${Button} icon="pulse" disabled=${busy} onClick=${read}>${busy ? 'Reading…' : 'Read health now'}</${Button}></div>` : null}
  </${Card}>`;
}

// Small trend line of health readings, oldest to newest.
function Sparkline({ points }) {
  if (points.length < 2) return null;
  const w = 160;
  const h = 40;
  const min = Math.min(...points, 50);
  const max = Math.max(...points, 100);
  const xy = points.map((p, i) => [Math.round((i / (points.length - 1)) * (w - 8)) + 4, Math.round(h - 4 - ((p - min) / (max - min || 1)) * (h - 8))]);
  const last = xy.at(-1);
  return html`<svg class="spark" viewBox=${`0 0 ${w} ${h}`} width=${w} height=${h} role="img" aria-label=${`Health trend from ${Math.round(points[0])}% to ${Math.round(points.at(-1))}%`}>
    <polyline fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points=${xy.map((p) => p.join(',')).join(' ')}></polyline>
    <circle cx=${last[0]} cy=${last[1]} r="3.5" fill="currentColor"></circle>
  </svg>`;
}


// Whether DriveAtlas is keeping this drive's file list up to date right now.
function LiveLine({ d, onCheck, busy }) {
  const w = d.watch;
  if (!d.connected) return null;
  if (!w) return html`<p class="small muted mt0 live-line">Plugged in. Scan it again to update its file list.</p>`;
  const text = w.state === 'catching-up' ? `Checking for changes since the last scan…${w.progress ? ` ${fmtNumber(w.progress.folders)} folders checked` : ''}`
    : w.state === 'updating' ? 'Saving changes…'
      : `Watching for changes${w.lastChangeAt ? ` · last change ${timeAgo(w.lastChangeAt)}` : ''}`;
  return html`<div class="live-line small">
    <span class=${`live-dot ${w.state === 'watching' ? '' : 'live-dot-busy'}`} aria-hidden="true"></span>
    <span class="grow muted">${text}${w.error ? html` <span class="warn-text">${w.error}</span>` : null}</span>
    ${w.state === 'watching' ? html`<button type="button" class="link small" disabled=${busy} onClick=${onCheck}>Check for changes</button><${HelpTip} text=${HELP.liveUpdates} label="About keeping file lists up to date" />` : null}
  </div>`;
}

const row = (k, v) => (v ? html`<div class="kv-row"><dt>${k}</dt><dd>${v}</dd></div>` : null);

function partName(p) {
  if ((p.gpt_type || '').includes('c12a7328')) return 'EFI System';
  if (p.partition_type === 'Reserved') return 'Microsoft Reserved';
  if (p.partition_type === 'Recovery') return 'Recovery';
  return p.filesystem ? 'No name' : p.partition_type || 'Partition';
}

function partNote(p) {
  const notes = [];
  if (p.has_windows) notes.push('Windows installed');
  if ((p.gpt_type || '').includes('c12a7328')) notes.push('Boot files (UEFI)');
  if (p.partition_type === 'Recovery') notes.push('Windows recovery');
  if (p.signals?.includes('ventoy')) notes.push('Ventoy');
  return notes.join(' · ') || '';
}
