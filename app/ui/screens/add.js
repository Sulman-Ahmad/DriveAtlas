// Add drive: pick the type, fill in details. Detected drives come pre-filled.
import { html, useState, api, go } from '../lib.js';
import { Icon, Card, TypeTile, HealthPill, Lead } from '../components.js';
import { LEADS } from '../help.js';
import { DriveForm } from './drive-form.js';
import { DRIVE_TYPES, BOOT_KINDS } from '/shared/drive-types.js';
import { fmtBytes, fmtAdvertised } from '/shared/format.js';

export function AddDrive({ data, query, onSaved }) {
  const diskKey = query.get('disk');
  const disk = diskKey ? data.connected.find((d) => d.key === diskKey && !d.driveId) : null;
  const suggestion = disk ? disk.suggestion : null;
  const [type, setType] = useState(suggestion ? suggestion.type : 'usb');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const others = data.connected.filter((d) => !d.driveId && d.key !== diskKey);

  async function save(values) {
    setBusy(true);
    setError('');
    try {
      const { drive } = await api('POST', '/api/drives', { ...values, type, fromDiskKey: disk ? disk.key : undefined });
      await onSaved();
      go(`#/drive/${drive.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return html`<div class="page">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="#/drives">Drives</a><${Icon} name="right" size=${14} /><span>Add drive</span></nav>
    <h1>Add drive</h1>
    <${Lead}>${LEADS.add}</${Lead}>
    <div class="columns">
      <div class="col-main stack-lg">
        <${Card} id="h-type" title="What kind of drive is it?">
          <p class="muted small mt0">Pick the closest match. You can change it later.</p>
          <div class="type-grid" role="radiogroup" aria-label="Drive type">
            ${DRIVE_TYPES.map((t) => html`<button type="button" role="radio" aria-checked=${type === t.id} class=${`type-option ${type === t.id ? 'on' : ''}`} onClick=${() => setType(t.id)}>
              <${TypeTile} type=${t.id} size=${36} accent=${type === t.id} />
              <span class="min0"><span class="type-name">${t.name}</span><span class="type-hint">${t.hint}</span></span>
              ${type === t.id ? html`<span class="type-check"><${Icon} name="check" size=${12} /></span>` : null}
            </button>`)}
          </div>
        </${Card}>
        <${Card} id="h-details" title="Details">
          <${DriveForm} key=${diskKey || 'manual'} initial=${suggestion || {}} typeOverride=${type} submitLabel="Add to catalog" busy=${busy} error=${error}
            onSubmit=${save} onCancel=${() => history.back()} />
        </${Card}>
      </div>
      <div class="col-side stack-lg">
        ${disk ? html`<section class="card card-accent" aria-labelledby="h-detected">
          <div class="card-head"><span class="tile tile-accent"><${Icon} name="laptop" size=${18} /></span>
            <div><h2 id="h-detected">Detected on this PC</h2><div class="small muted">${disk.letters.length ? `Plugged in as ${disk.letters.map((l) => `${l}:`).join(' ')}` : 'Connected, no drive letter'}</div></div></div>
          <div class="card-body"><dl class="kv">
            <dt>Model</dt><dd>${disk.friendlyName}</dd>
            <dt>Size</dt><dd>${fmtAdvertised(suggestion.advertised_bytes)} · ${fmtBytes(disk.size)} usable</dd>
            <dt>Connection</dt><dd>${disk.busType}${disk.mediaType ? `, ${disk.mediaType}` : ''}</dd>
            <dt>Partitions</dt><dd>${disk.partitionStyle} · ${disk.partitions.filter((p) => p.fileSystem).map((p) => `${p.fileSystem}${p.label ? ` "${p.label}"` : ''}`).join(', ') || 'none readable'}</dd>
            <dt>Bootable</dt><dd>${BOOT_KINDS[suggestion.bootable_kind] || 'Not bootable'}</dd>
            <dt>Health</dt><dd><${HealthPill} health=${disk.health} type=${type} /></dd>
          </dl>
          <p class="small muted">These details are saved with the drive, so DriveAtlas recognises it every time you plug it in.</p></div>
        </section>` : null}
        ${others.length ? html`<${Card} id="h-others" title="Also connected, not in your catalog" pad=${false}>
          ${others.map((d) => html`<a class="row row-link" href=${`#/add?disk=${encodeURIComponent(d.key)}`}>
            <${TypeTile} type=${d.driveType} size=${32} />
            <div class="grow"><div class="row-title">${d.friendlyName}</div><div class="small muted">${fmtBytes(d.size)} · ${d.busType}${d.letters.length ? ` · ${d.letters.map((l) => `${l}:`).join(' ')}` : ''}</div></div>
            <${Icon} name="right" size=${16} />
          </a>`)}
        </${Card}>` : null}
        ${!disk ? html`<${Card} id="h-tip" title="Tip">
          <p class="small muted mt0">Plug the drive in first and DriveAtlas fills in its model, size, partitions and bootable state for you, and recognises it next time.</p>
        </${Card}>` : null}
      </div>
    </div>
  </div>`;
}
