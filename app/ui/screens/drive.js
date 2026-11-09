// Drive page: details, partitions, changes to review, edit and delete.
import { html, useState, useEffect, api, go } from '../lib.js';
import { Icon, Card, TypeTile, StatusPill, HealthPill, BootPill, CapacityBar, UsageLine, Button, Pill, ErrorNote } from '../components.js';
import { DriveForm } from './drive-form.js';
import { typeById, BOOT_KINDS, statusName } from '/shared/drive-types.js';
import { fmtBytes, fmtAdvertised, fmtDate, fmtNumber, timeAgo } from '/shared/format.js';

export function DrivePage({ id, data, onChanged }) {
  const [state, setState] = useState({ loading: true });
  const [mode, setMode] = useState('view');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => Promise.all([api('GET', `/api/drives/${id}`), api('GET', `/api/drives/${id}/scans`)])
    .then(([r, s]) => setState({ drive: r.drive, disk: r.disk, scans: s.current })).catch((err) => setState({ error: err.message }));
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
    try { await api('POST', `/api/drives/${id}/scan`, {}); go('#/scan'); } catch (err) { setError(err.message); setBusy(false); }
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
        <div class="muted">${brandModel || kind} · ${kind}${d.advertised_bytes ? ` · ${fmtAdvertised(d.advertised_bytes)}` : ''}${d.actual_bytes ? ` (${fmtBytes(d.actual_bytes)} usable)` : ''}</div>
        <div class="pills"><${StatusPill} drive=${d} /><${HealthPill} health=${d.health_status} type=${d.type} /><${BootPill} kind=${boot} />
          ${d.label_code ? html`<${Pill} tone="plain" icon="qr">${d.label_code}</${Pill}>` : null}</div>
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
        <${Card} id="h-space" title="Space">
          <${CapacityBar} used=${d.used} total=${d.total} thick />
          <div class="mt6"><${UsageLine} used=${d.used} total=${d.total} /></div>
          <p class="small muted">${d.connected ? 'Live from Windows right now.' : `Last seen ${timeAgo(d.last_seen_at)}.`}</p>
        </${Card}>
        <${Card} id="h-files" title="Files" extra=${state.scans.length ? html`<a class="link push small" href=${`#/files/${d.id}`}>Browse files</a>` : null}>
          ${state.scans.length ? html`<div class="stack-sm">${state.scans.map((s) => html`<a class="scan-line" href=${`#/files/${d.id}?scan=${s.id}&dir=0`}>
              <${Icon} name="folder" size=${18} /><strong>${s.partition_label || `Partition ${s.partition_idx}`}</strong>
              <span class="muted small num">${fmtNumber(s.file_count)} files · ${fmtNumber(s.folder_count)} folders · ${fmtBytes(s.total_bytes)} · scanned ${timeAgo(s.finished_at)}</span>
            </a>`)}</div>`
          : html`<p class="small muted mt0">${d.connected ? 'Not scanned yet. Scan it to record its folders and files; nothing is copied.' : 'Not scanned yet. Plug it in to scan it.'}</p>`}
        </${Card}>
        <${Card} id="h-parts" title="Partitions" extra=${html`<span class="muted small">${d.partition_style || ''}${d.partitions.length ? ` · ${d.partitions.length}` : ''}</span>`}>
          ${d.partitions.length ? html`<div class="table-wrap"><table class="table">
            <thead><tr><th>#</th><th>Name</th><th>File system</th><th>Size</th><th>Used</th><th>Notes</th></tr></thead>
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
            ${row('Bootable', boot ? BOOT_KINDS[boot] : null)}
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
      <div><h2 id="h-changes">Changes found when this drive was plugged in</h2><div class="small muted">Nothing is changed until you choose Update record.</div></div></div>
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

// "Samsung" + "SAMSUNG MZVLB512" shows once, not twice.
function brandAndModel(d) {
  const brand = (d.brand || '').trim();
  const model = (d.model || '').trim();
  if (brand && model.toLowerCase().includes(brand.toLowerCase())) return model;
  return [brand, model].filter(Boolean).join(' ');
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
