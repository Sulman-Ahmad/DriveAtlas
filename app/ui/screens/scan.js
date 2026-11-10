// Scan: run and watch scans, pick drives, and set what scans record.
import { html, useState, useEffect, api } from '../lib.js';
import { Icon, TypeTile, Card, Button, Empty, ErrorNote, CapacityBar, Lead, HelpTip } from '../components.js';
import { LEADS, HELP } from '../help.js';
import { fmtBytes, fmtNumber, fmtSeconds, timeAgo } from '/shared/format.js';

export function Scan({ data }) {
  const status = data.scanStatus || { active: null, queue: [] };
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState('');
  const [newSkip, setNewSkip] = useState('');
  const [starting, setStarting] = useState('');

  useEffect(() => { api('GET', '/api/settings/scan').then(setSettings).catch((e) => setError(e.message)); }, []);

  async function save(patch) {
    try { setSettings(await api('PUT', '/api/settings/scan', patch)); } catch (e) { setError(e.message); }
  }
  async function control(id, action) {
    try { await api('POST', `/api/scans/${id}/${action}`); } catch (e) { setError(e.message); }
  }
  async function start(driveId) {
    setStarting(driveId);
    setError('');
    try { await api('POST', `/api/drives/${driveId}/scan`, {}); } catch (e) { setError(e.message); } finally { setStarting(''); }
  }

  const name = (id) => data.drives.find((d) => d.id === id)?.name || 'Drive';
  const scannable = data.drives.filter((d) => d.connected);
  const unknown = data.connected.filter((d) => !d.driveId);
  const busyIds = new Set([status.active?.driveId, ...status.queue.map((q) => q.driveId)].filter(Boolean));
  const a = status.active;

  return html`<div class="page">
    <div><h1>Scan</h1><${Lead}>${LEADS.scan}</${Lead}></div>
    <${ErrorNote} error=${error} />
    <div class="columns">
      <div class="col-main">
        ${a ? html`<section class="card" aria-labelledby="h-now">
          <div class="card-head">
            <${TypeTile} type=${data.drives.find((d) => d.id === a.driveId)?.type || 'usb'} size=${40} accent />
            <div class="grow"><h2 id="h-now">${a.state === 'paused' ? 'Paused:' : a.state === 'cancelling' ? 'Cancelling:' : 'Scanning'} ${name(a.driveId)} ${a.label ? html`<span class="muted">(${a.label})</span>` : null}</h2>
              <div class="small muted">${a.etaSeconds != null && a.state === 'running' ? `${fmtSeconds(a.etaSeconds)} left` : `Running for ${fmtSeconds(a.elapsedSeconds).replace('about ', '')}`}</div></div>
            ${a.state === 'paused'
              ? html`<${Button} icon="play" onClick=${() => control(a.id, 'resume')}>Resume</${Button}>`
              : html`<${Button} icon="pause" disabled=${a.state === 'cancelling'} onClick=${() => control(a.id, 'pause')}>Pause</${Button}>`}
            <${Button} kind="danger" disabled=${a.state === 'cancelling'} onClick=${() => control(a.id, 'cancel')}>Cancel</${Button}>
          </div>
          <div class="card-body stack">
            <div>
              <div class="usage small"><strong>${a.percent != null ? `${a.percent}%` : `${fmtNumber(a.files)} files`}</strong>
                <span>${a.bytesEstimate ? `${fmtBytes(a.bytes)} of about ${fmtBytes(a.bytesEstimate)}` : a.filesEstimate ? `last time: ${fmtNumber(a.filesEstimate)} files` : ''}</span></div>
              <${CapacityBar} used=${a.percent ?? 0} total=${100} thick />
            </div>
            <div class="stat-grid">
              <div class="mini-stat"><span>Files</span><strong>${fmtNumber(a.files)}</strong></div>
              <div class="mini-stat"><span>Folders</span><strong>${fmtNumber(a.folders)}</strong></div>
              <div class="mini-stat"><span>Size so far</span><strong>${fmtBytes(a.bytes)}</strong></div>
              <div class="mini-stat"><span>Speed</span><strong>${fmtNumber(a.filesPerSecond)} /s</strong></div>
            </div>
            <div><span class="small muted">Now reading</span><div class="path-box mono">${a.current}</div></div>
            <div class="pills">
              ${a.options.media ? html`<span class="pill pill-accent"><${Icon} name="check" size=${12} />Photo and video details</span>` : null}
              ${a.options.fingerprint ? html`<span class="pill pill-accent"><${Icon} name="check" size=${12} />Quick fingerprint</span>` : null}
              ${a.options.hidden ? html`<span class="pill pill-accent"><${Icon} name="check" size=${12} />Hidden and system files</span>` : null}
            </div>
            ${status.queue.length ? html`<div class="small muted">Next: ${status.queue.map((q) => `${name(q.driveId)}${q.label ? ` (${q.label})` : ''}`).join(', ')}</div>` : null}
          </div>
        </section>` : html`<div class="card card-body"><${Empty} icon="scan" title="No scan running">Pick a connected drive below. Scans run in the background, so you can keep using DriveAtlas.</${Empty}></div>`}

        <${Card} id="h-can" title="Drives you can scan now" pad=${false}>
          ${!scannable.length && !unknown.length ? html`<div class="card-body muted small">Plug in a drive to scan it.</div>` : null}
          ${scannable.map((d) => html`<div class="row">
            <${TypeTile} type=${d.type} size=${34} />
            <div class="grow"><div class="row-title">${d.name} <span class="muted">${d.letters.map((l) => `${l}:`).join(' ')}</span></div>
              <div class="small muted">${d.last_scanned_at ? `Last scanned ${timeAgo(d.last_scanned_at)} · ${fmtNumber(d.files)} files` : 'Not scanned yet'}${d.used ? ` · ${fmtBytes(d.used)} to read` : ''}</div></div>
            ${busyIds.has(d.id) ? html`<span class="small link">Scanning…</span>`
              : html`<${Button} kind=${d.last_scanned_at ? 'secondary' : 'primary'} icon="scan" disabled=${starting === d.id} onClick=${() => start(d.id)}>${d.last_scanned_at ? 'Rescan' : 'Scan'}</${Button}>`}
          </div>`)}
          ${unknown.map((d) => html`<div class="row">
            <${TypeTile} type=${d.driveType} size=${34} />
            <div class="grow"><div class="row-title">${d.friendlyName} <span class="muted">${d.letters.map((l) => `${l}:`).join(' ')}</span></div><div class="small muted">Add it to your catalog first, then scan it.</div></div>
            <a class="btn btn-secondary" href=${`#/add?disk=${encodeURIComponent(d.key)}`}>Add drive</a>
          </div>`)}
        </${Card}>
      </div>

      <div class="col-side">
        <${Card} id="h-opts" title="Scan options" help=${HELP.scanOptions}>
          ${settings ? html`<div class="stack">
            ${[['media', 'Photo and video details', 'Reads small file headers: resolution, duration, date taken.', HELP.mediaDetails],
               ['fingerprint', 'Quick fingerprint', 'Reads up to 128 KB per file to spot the same file on other drives.', HELP.fingerprints],
               ['hidden', 'Hidden and system files', 'Listed, but hidden in the file browser until you show them.', HELP.hiddenFiles]].map(([k, label, hint, help]) => html`
              <div class="check-line"><label class="check-row" for=${`opt-${k}`}><input id=${`opt-${k}`} type="checkbox" checked=${settings[k]} onChange=${(e) => save({ [k]: e.target.checked })} />
                <span><strong>${label}</strong><span class="small muted">${hint}</span></span></label><${HelpTip} text=${help} label=${`About ${label}`} /></div>`)}
            <div class="check-line"><label class="check-row" for="opt-keep"><span><strong>Scan history</strong><span class="small muted">Older scans of a drive are removed automatically.</span></span>
              <select id="opt-keep" value=${settings.keepScans} onChange=${(e) => save({ keepScans: Number(e.target.value) })}>${[1, 2, 3, 5, 10].map((n) => html`<option value=${n}>Keep ${n}</option>`)}</select></label><${HelpTip} text=${HELP.keepScans} label="About scan history" /></div>
            <div class="divider"></div>
            <strong class="small">Skip these folders<${HelpTip} text=${HELP.exclude} label="About skipped folders" /></strong>
            <div class="pills">
              ${settings.exclude.map((x) => html`<span class="tag tag-x mono">${x}<button type="button" class="icon-btn icon-btn-xs" aria-label=${`Stop skipping ${x}`} onClick=${() => save({ exclude: settings.exclude.filter((y) => y !== x) })}><${Icon} name="x" size=${12} /></button></span>`)}
              ${!settings.exclude.length ? html`<span class="small muted">Nothing skipped.</span>` : null}
            </div>
            <form class="inline-form" onSubmit=${(e) => { e.preventDefault(); if (newSkip.trim()) { save({ exclude: [...settings.exclude, newSkip.trim()] }); setNewSkip(''); } }}>
              <input aria-label="Folder to skip" placeholder="e.g. node_modules or Windows\\WinSxS" value=${newSkip} onInput=${(e) => setNewSkip(e.target.value)} />
              <button type="submit" class="btn btn-secondary">Add</button>
            </form>
            <p class="small muted mt0">A plain name is skipped wherever it appears. A path with \\ is skipped from the drive's top folder.</p>
          </div>` : html`<p class="muted small">Loading…</p>`}
        </${Card}>
        ${data.lastScan ? html`<${Card} id="h-last" title="Last finished scan">
          <div class="stack-sm small">
            <div><strong>${name(data.lastScan.driveId)}</strong> <span class="muted">${data.lastScan.label ? `(${data.lastScan.label})` : ''} · ${data.lastScan.state === 'done' ? `took ${fmtSeconds(data.lastScan.elapsedSeconds).replace('about ', '')}` : data.lastScan.state}</span></div>
            <div class="muted num">${fmtNumber(data.lastScan.files)} files · ${fmtNumber(data.lastScan.folders)} folders · ${fmtBytes(data.lastScan.bytes)}${data.lastScan.skipped ? ` · ${fmtNumber(data.lastScan.skipped)} folders could not be opened` : ''}</div>
            ${data.lastScan.state === 'done' ? html`<a class="link" href=${`#/files/${data.lastScan.driveId}`}>Browse files</a>` : null}
          </div>
        </${Card}>` : null}
      </div>
    </div>
  </div>`;
}
