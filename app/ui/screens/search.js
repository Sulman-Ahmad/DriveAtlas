// Search: finds files and folders by name across every scanned drive.
import { html, useState, useEffect, useRef, api } from '../lib.js';
import { Icon, TypeTile, StatusPill, Empty, ErrorNote, Lead, HelpTip } from '../components.js';
import { LEADS, HELP } from '../help.js';
import { FileDetail } from './file-detail.js';
import { KINDS, kindIcon } from '/shared/kinds.js';
import { fmtBytes, fmtNumber, fmtDuration } from '/shared/format.js';

const SIZES = [
  { v: '', name: 'Any size' },
  { v: String(100 * 2 ** 20), name: 'Over 100 MB' },
  { v: String(2 ** 30), name: 'Over 1 GB' },
  { v: String(10 * 2 ** 30), name: 'Over 10 GB' }
];

export function Search({ data, query }) {
  const [f, setF] = useState(() => ({
    q: query.get('q') || '', kind: query.get('kind') || '', minSize: query.get('min') || '', drive: query.get('drive') || '', hidden: query.get('hidden') === '1'
  }));
  const [res, setRes] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const seq = useRef(0);

  useEffect(() => {
    const p = new URLSearchParams();
    if (f.q) p.set('q', f.q);
    if (f.kind) p.set('kind', f.kind);
    if (f.minSize) p.set('min', f.minSize);
    if (f.drive) p.set('drive', f.drive);
    if (f.hidden) p.set('hidden', '1');
    history.replaceState(null, '', `#/search${p.toString() ? `?${p}` : ''}`);
    if (!f.q.trim()) { setRes(null); return; }
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const api_p = new URLSearchParams({ q: f.q, kind: f.kind, minSize: f.minSize, drive: f.drive, hidden: f.hidden ? '1' : '0' });
        const r = await api('GET', `/api/search?${api_p}`);
        if (mine === seq.current) { setRes(r); setError(''); setSelected(r.results[0]?.id ?? null); }
      } catch (e) { if (mine === seq.current) setError(e.message); }
    }, 220);
    return () => clearTimeout(t);
  }, [f.q, f.kind, f.minSize, f.drive, f.hidden, data.version]);

  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const scannedDrives = data.drives.filter((d) => d.files != null);
  const groups = [];
  if (res) {
    const byDrive = new Map();
    for (const r of res.results) {
      if (!byDrive.has(r.drive_id)) { byDrive.set(r.drive_id, []); groups.push(r.drive_id); }
      byDrive.get(r.drive_id).push(r);
    }
    groups.splice(0, groups.length, ...groups.map((id) => ({ drive: data.drives.find((d) => d.id === id), items: byDrive.get(id) })));
  }

  return html`<div class="page">
    <h1>Search</h1>
    <${Lead}>${LEADS.search}</${Lead}>
    <label class="search search-big" for="search-q"><${Icon} name="search" size=${20} />
      <input id="search-q" type="search" placeholder="Search file and folder names on all your drives" value=${f.q} onInput=${set('q')} autofocus aria-label="Search files on all drives" />
      ${f.q ? html`<button type="button" class="icon-btn" aria-label="Clear search" onClick=${() => setF({ ...f, q: '' })}><${Icon} name="x" size=${16} /></button>` : null}
    </label>
    <div class="toolbar">
      <select aria-label="Kind" value=${f.kind} onChange=${set('kind')}><option value="">Any kind</option><option value="folder">Folders</option>${KINDS.map((k) => html`<option value=${k.id}>${k.name}</option>`)}</select><${HelpTip} text=${HELP.kind} label="About file kinds" />
      <select aria-label="Size" value=${f.minSize} onChange=${set('minSize')}>${SIZES.map((s) => html`<option value=${s.v}>${s.name}</option>`)}</select>
      <select aria-label="Drive" value=${f.drive} onChange=${set('drive')}><option value="">All drives</option>${scannedDrives.map((d) => html`<option value=${d.id}>${d.name}</option>`)}</select>
      <label class="check" for="search-hidden"><input id="search-hidden" type="checkbox" checked=${f.hidden} onChange=${set('hidden')} />Include hidden files</label><${HelpTip} text=${HELP.hiddenResults} label="About hidden files" />
      ${res ? html`<span class="push small muted num">${fmtNumber(res.total)}${res.total >= 10000 ? '+' : ''} result${res.total === 1 ? '' : 's'} on ${groups.length} drive${groups.length === 1 ? '' : 's'} · ${fmtNumber(res.namesSearched)} names searched in ${res.tookMs} ms<${HelpTip} text=${HELP.latestScan} label="Where results come from" /></span>` : null}
    </div>
    <${ErrorNote} error=${error} />

    ${!f.q.trim() ? html`<div class="card card-body">${scannedDrives.length
      ? html`<${Empty} icon="search" title="Type part of a file or folder name">Every word must match the start of a word in the name, so "wedding 19" finds "2019 Wedding". Results include drives that are not plugged in.</${Empty}>`
      : html`<${Empty} icon="scan" title="Scan a drive first">Search looks through the file lists made by scans. <a class="link" href="#/scan">Scan a drive</a> and its files show up here, even after you unplug it.</${Empty}>`}</div>` : null}

    ${res && !res.total ? html`<div class="card card-body"><${Empty} icon="search" title="Nothing found">No file or folder name matches "${f.q}". Try fewer or shorter words, or include hidden files.</${Empty}></div>` : null}

    ${res && res.total ? html`<div class="columns">
      <div class="col-main stack">
        ${groups.map((g) => html`<section class="card">
          <div class="group-head">
            ${g.drive ? html`<${TypeTile} type=${g.drive.type} size=${30} />` : null}
            <h2>${g.drive ? g.drive.name : 'Unknown drive'}</h2>
            ${g.drive ? html`<${StatusPill} drive=${g.drive} />` : null}
            <span class="push small muted">${g.items.length}${g.items.length >= 200 ? '+' : ''}</span>
          </div>
          ${g.items.map((r) => html`<button type="button" class=${`result ${selected === r.id ? 'on' : ''}`} onClick=${() => setSelected(r.id)}>
            <span class="tile"><${Icon} name=${kindIcon(r.is_dir ? 'folder' : r.kind)} size=${18} /></span>
            <span class="grow"><span class="result-name">${r.name}</span><span class="result-path mono">${r.folderPath}</span></span>
            <span class="small muted num">${resultMeta(r)}</span>
          </button>`)}
        </section>`)}
      </div>
      <div class="col-side">${selected ? html`<${FileDetail} key=${selected} entryId=${selected} data=${data} />` : null}</div>
    </div>` : null}
  </div>`;
}

function resultMeta(r) {
  const parts = [r.is_dir ? `${fmtNumber(r.items || 0)} files · ${fmtBytes(r.size)}` : fmtBytes(r.size)];
  if (r.width) parts.push(`${r.width}×${r.height}`);
  if (r.duration_s) parts.push(fmtDuration(r.duration_s));
  return parts.join(' · ');
}
