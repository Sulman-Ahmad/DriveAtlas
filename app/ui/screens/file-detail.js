// Details of one file or folder, used by Search and Files.
import { html, useState, useEffect, api, isLocalBackend } from '../lib.js';
import { Icon, Button, StatusPill, ErrorNote, HelpTip } from '../components.js';
import { HELP } from '../help.js';
import { kindName, kindIcon } from '/shared/kinds.js';
import { fmtBytes, fmtNumber, fmtDuration, fmtCameraDate, fmtDateTime, fmtDate } from '/shared/format.js';

export function FileDetail({ entryId, data, showFolderLink = true }) {
  const [entry, setEntry] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    setEntry(null); setError(''); setNote('');
    api('GET', `/api/entries/${entryId}`).then((r) => setEntry(r.entry)).catch((e) => setError(e.message));
  }, [entryId]);

  if (error) return html`<aside class="card card-body detail"><${ErrorNote} error=${error} /></aside>`;
  if (!entry) return html`<aside class="card card-body detail"><p class="muted small">Loading…</p></aside>`;

  const drive = data.drives.find((d) => d.id === entry.drive_id);
  const kind = entry.is_dir ? 'folder' : entry.kind;

  async function copyPath() {
    try { await navigator.clipboard.writeText(entry.path); setNote('Path copied.'); } catch { setNote(entry.path); }
  }
  async function open() {
    try { await api('POST', `/api/entries/${entry.id}/open`); setNote('Opened in Explorer.'); } catch (e) { setNote(e.message); }
  }
  const folderHref = `#/files/${entry.drive_id}?scan=${entry.scan_id}&dir=${entry.is_dir ? entry.eid : entry.parent_eid}`;

  return html`<aside class="card detail" aria-labelledby="fd-name">
    <div class="card-head">
      <span class="tile tile-accent" style="width:44px;height:44px;border-radius:12px"><${Icon} name=${kindIcon(kind)} size=${22} /></span>
      <div class="min0"><h2 id="fd-name" class="break">${entry.name}</h2>
        <div class="small muted">${kindName(kind)}${entry.ext ? ` · ${entry.ext.toUpperCase()}` : ''} · ${fmtBytes(entry.size)}${entry.is_dir && entry.items != null ? ` · ${fmtNumber(entry.items)} files` : ''}</div></div>
    </div>
    <div class="card-body stack">
      <dl class="kv">
        ${entry.width ? html`<dt>Resolution</dt><dd>${entry.width} × ${entry.height}</dd>` : null}
        ${entry.duration_s ? html`<dt>Duration</dt><dd>${fmtDuration(entry.duration_s)}</dd>` : null}
        ${entry.taken_at ? html`<dt>Taken</dt><dd>${fmtCameraDate(entry.taken_at)}</dd>` : null}
        <dt>Modified</dt><dd>${fmtDateTime(entry.modified_at)}</dd>
        ${entry.fingerprint ? html`<dt>Fingerprint<${HelpTip} text=${HELP.fingerprint} label="About fingerprints" /></dt><dd class="mono">${entry.fingerprint.slice(0, 4)}…${entry.fingerprint.slice(-4)}</dd>` : null}
      </dl>
      <div class="path-box mono">${entry.path}</div>
      ${drive ? html`<div class="where">
        <span class="eyebrow">Where this drive is</span>
        <a class="inline row-title" href=${`#/drive/${drive.id}`}><${Icon} name="drives" size=${18} />${drive.name}</a>
        <div class="pills"><${StatusPill} drive=${drive} /></div>
        <div class="small muted">Scanned ${fmtDate(entry.scanned_at)}.${drive.connected ? '' : ' Plug the drive in to open the file.'}</div>
      </div>` : null}
      ${!entry.is_dir ? html`<div class="small">${entry.copies.length
        ? html`<span class="eyebrow">Also stored on<${HelpTip} text=${HELP.copies} label="How copies are found" /></span><ul class="copies">${entry.copies.map((c) => {
            const d = data.drives.find((x) => x.id === c.drive_id);
            return html`<li><strong>${d ? d.name : 'Another drive'}</strong> <span class="mono muted">${c.path}</span></li>`;
          })}</ul>`
        : html`<span class="muted">${entry.fingerprint ? 'No other copies found on your drives.' : 'Fingerprints were off for this scan, so copies are not checked.'}</span>`}</div>` : null}
      ${note ? html`<p class="small muted break">${note}</p>` : null}
      <div class="actions">
        <${Button} icon="copy" onClick=${copyPath}>Copy path</${Button}>
        ${drive?.connected && !isLocalBackend() ? html`<${Button} kind="primary" icon="external" onClick=${open}>Open in Explorer</${Button}>` : null}
        ${showFolderLink ? html`<a class="btn btn-secondary" href=${folderHref}><${Icon} name="folder" size=${17} />Show in folder</a>` : null}
      </div>
    </div>
  </aside>`;
}
