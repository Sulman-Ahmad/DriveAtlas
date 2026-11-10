// Files: browse a drive's folders from its latest scan, plugged in or not.
import { html, useState, useEffect, api, go } from '../lib.js';
import { startScan } from '../scan-start.js';
import { Icon, Pill, Empty, ErrorNote, Button, Lead } from '../components.js';
import { LEADS } from '../help.js';
import { FileDetail } from './file-detail.js';
import { kindName, kindIcon } from '/shared/kinds.js';
import { fmtBytes, fmtNumber, fmtDate, fmtDateTime } from '/shared/format.js';

const COLS = [
  { id: 'name', name: 'Name' },
  { id: 'size', name: 'Size' },
  { id: 'modified', name: 'Modified' },
  { id: 'kind', name: 'Kind' }
];

export function Files({ driveId, data, query }) {
  const drive = data.drives.find((d) => d.id === driveId);
  const scanId = query.get('scan') || '';
  const dir = query.get('dir') || '0';
  const [sort, setSort] = useState({ by: 'name', order: 'asc' });
  const [hidden, setHidden] = useState(false);
  const [res, setRes] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const p = new URLSearchParams({ dir, sort: sort.by, order: sort.order, hidden: hidden ? '1' : '0' });
    if (scanId) p.set('scan', scanId);
    api('GET', `/api/drives/${driveId}/browse?${p}`).then((r) => { setRes(r); setError(''); }).catch((e) => setError(e.message));
    setSelected(null);
  }, [driveId, scanId, dir, sort.by, sort.order, hidden, data.version]);

  const here = (s, d) => `#/files/${driveId}?scan=${s}&dir=${d}`;
  const toggleSort = (by) => setSort(sort.by === by ? { by, order: sort.order === 'asc' ? 'desc' : 'asc' } : { by, order: by === 'name' || by === 'kind' ? 'asc' : 'desc' });

  async function scanNow() {
    setBusy(true);
    try { await startScan(driveId); go('#/scan'); } catch (e) { setError(e.message); setBusy(false); }
  }

  if (!drive) return html`<div class="page"><${ErrorNote} error="That drive is not in your catalog." /></div>`;
  const scan = res?.scan;

  return html`<div class="page">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="#/drives">Drives</a><${Icon} name="right" size=${14} /><a href=${`#/drive/${drive.id}`}>${drive.name}</a><${Icon} name="right" size=${14} /><span>Files</span></nav>
    <header class="page-head">
      <div><h1>${drive.name}</h1>
        <p class="muted">${scan ? html`${fmtNumber(scan.file_count)} files · ${fmtNumber(scan.folder_count)} folders · ${fmtBytes(scan.total_bytes)} · scanned ${fmtDate(scan.finished_at)}` : 'No scan yet'}</p></div>
      ${drive.connected ? html`<${Pill} tone="good" dot>Connected${drive.letters.length ? ` as ${drive.letters.map((l) => `${l}:`).join(' ')}` : ''}</${Pill}>` : html`<${Pill} tone="muted" icon="pin">Offline · ${drive.location || 'not plugged in'}</${Pill}>`}
      ${drive.connected ? html`<${Button} icon="scan" disabled=${busy} onClick=${scanNow}>${scan ? 'Scan again' : 'Scan now'}</${Button}>` : null}
    </header>
    <${Lead}>${LEADS.files}</${Lead}>
    <${ErrorNote} error=${error} />

    ${res && !scan ? html`<div class="card card-body"><${Empty} icon="scan" title="This drive has not been scanned yet">${drive.connected ? 'Scan it to record its folders and files. Nothing is copied: only names, sizes and dates.' : 'Plug it in and scan it to record its folders and files.'}</${Empty}></div>` : null}

    ${scan ? html`
      ${res.scans.length > 1 ? html`<div class="chips" role="group" aria-label="Partition">${res.scans.map((s) => html`<a class=${`chip ${s.id === scan.id ? 'chip-on' : ''}`} href=${here(s.id, 0)}>${s.partition_label || `Partition ${s.partition_idx}`}</a>`)}</div>` : null}
      <div class="toolbar">
        <nav class="path-crumbs" aria-label="Folder path">
          <a href=${here(scan.id, 0)}><${Icon} name="drives" size=${16} />${scan.partition_label || res.folder.name}</a>
          ${res.path.map((p) => html`<${Icon} name="right" size=${14} /><a href=${here(scan.id, p.eid)}>${p.name}</a>`)}
        </nav>
        <label class="check push" for="files-hidden"><input id="files-hidden" type="checkbox" checked=${hidden} onChange=${(e) => setHidden(e.target.checked)} />Show hidden${!hidden && res.hiddenCount ? ` (${res.hiddenCount})` : ''}</label>
      </div>
      <div class="columns">
        <div class="col-main">
          <section class="card">
            <div class="table-wrap"><table class="table files-table">
              <thead><tr>${COLS.map((c) => html`<th><button type="button" class="th-btn" onClick=${() => toggleSort(c.id)}>${c.name}${sort.by === c.id ? html`<${Icon} name=${sort.order === 'asc' ? 'down' : 'right'} size=${12} />` : null}</button></th>`)}</tr></thead>
              <tbody>
                ${!res.entries.length ? html`<tr><td colspan="4" class="muted">This folder is empty${!hidden && res.hiddenCount ? ' (hidden items not shown)' : ''}.</td></tr>` : null}
                ${res.entries.map((e) => html`<tr class=${selected === e.id ? 'on' : ''}>
                  <td>${e.is_dir && !(e.flags & 16)
                    ? html`<a class="file-name" href=${here(scan.id, e.eid)}><${Icon} name="folder" size=${18} />${e.name}</a>`
                    : html`<button type="button" class="file-name" onClick=${() => setSelected(e.id)}><${Icon} name=${kindIcon(e.is_dir ? 'folder' : e.kind)} size=${18} />${e.name}${e.flags & 16 ? html` <span class="muted small">(skipped)</span>` : null}</button>`}</td>
                  <td class="num">${fmtBytes(e.size)}${e.is_dir && e.items != null ? html`<span class="muted small"> · ${fmtNumber(e.items)}</span>` : null}</td>
                  <td class="num muted">${fmtDateTime(e.modified_at)}</td>
                  <td class="muted">${kindName(e.is_dir ? 'folder' : e.kind)}</td>
                </tr>`)}
              </tbody>
            </table></div>
          </section>
        </div>
        <div class="col-side">${selected ? html`<${FileDetail} key=${selected} entryId=${selected} data=${data} showFolderLink=${false} />`
          : html`<div class="card card-body small muted">Select a file to see its details. Folder sizes include everything inside them.</div>`}</div>
      </div>` : null}
  </div>`;
}
