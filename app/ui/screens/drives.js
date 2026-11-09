// Drives: every drive in your catalog, grouped by status, with filters.
import { html, useState } from '../lib.js';
import { TypeTile, StatusPill, HealthPill, BootPill, CapacityBar, UsageLine, LinkButton, Empty, Icon } from '../components.js';
import { typeById } from '/shared/drive-types.js';
import { fmtAdvertised } from '/shared/format.js';

const FILTERS = [
  { id: 'all', name: 'All', test: () => true },
  { id: 'connected', name: 'Connected', test: (d) => d.connected },
  { id: 'inpc', name: 'In PC', test: (d) => d.liveStatus === 'inpc' },
  { id: 'stored', name: 'Stored', test: (d) => d.liveStatus === 'stored' },
  { id: 'lent', name: 'Lent out', test: (d) => d.liveStatus === 'lent' },
  { id: 'retired', name: 'Retired', test: (d) => d.liveStatus === 'retired' }
];

const GROUPS = [
  { title: 'Connected', test: (d) => d.connected },
  { title: 'Stored', test: (d) => !d.connected && d.liveStatus === 'stored' },
  { title: 'In a PC, not connected', test: (d) => !d.connected && d.liveStatus === 'inpc' },
  { title: 'Lent out', test: (d) => !d.connected && d.liveStatus === 'lent' },
  { title: 'Retired', test: (d) => !d.connected && d.liveStatus === 'retired' }
];

export function Drives({ data }) {
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const f = FILTERS.find((x) => x.id === filter);
  const shown = data.drives.filter((d) => f.test(d) && (!query || [d.name, d.brand, d.model, d.location, d.serial, d.label_code, d.other_kind, ...(d.tags || [])].some((v) => v && String(v).toLowerCase().includes(query))));

  return html`<div class="page">
    <header class="page-head">
      <div><h1>Drives</h1><p class="muted">${data.drives.length} ${data.drives.length === 1 ? 'drive' : 'drives'} · grouped by status</p></div>
      <label class="search" for="drives-q"><${Icon} name="search" size=${18} />
        <input id="drives-q" type="search" placeholder="Filter by name, brand, location or tag" value=${q} onInput=${(e) => setQ(e.target.value)} aria-label="Filter drives" /></label>
      <${LinkButton} kind="primary" icon="plus" href="#/add">Add drive</${LinkButton}>
    </header>

    <div class="chips" role="group" aria-label="Status">
      ${FILTERS.map((x) => {
        const n = data.drives.filter(x.test).length;
        return html`<button type="button" class=${`chip ${filter === x.id ? 'chip-on' : ''}`} aria-pressed=${filter === x.id} onClick=${() => setFilter(x.id)}>${x.name}<span class="chip-n">${n}</span></button>`;
      })}
    </div>

    ${!data.drives.length ? html`<div class="card card-body"><${Empty} title="No drives yet">Add a drive yourself, or plug one in and add it from Home with its details filled in.</${Empty}></div>` : null}
    ${data.drives.length && !shown.length ? html`<p class="muted">No drives match this filter.</p>` : null}

    ${GROUPS.map((g) => {
      const list = shown.filter(g.test);
      if (!list.length) return null;
      return html`<section class="group">
        <h2 class="group-title">${g.title} <span>· ${list.length}</span></h2>
        <div class="grid-cards">${list.map((d) => html`<${DriveCard} d=${d} key=${d.id} />`)}</div>
      </section>`;
    })}
  </div>`;
}

export function DriveCard({ d }) {
  const t = typeById(d.type);
  const kind = d.type === 'other' && d.other_kind ? d.other_kind : t.name;
  return html`<a class="card drive-card" href=${`#/drive/${d.id}`}>
    <div class="drive-card-head">
      <${TypeTile} type=${d.type} />
      <div class="min0"><div class="drive-name">${d.name}</div><div class="small muted">${kind}${d.advertised_bytes ? ` · ${fmtAdvertised(d.advertised_bytes)}` : ''}</div></div>
      ${d.hasPendingChanges ? html`<span class="badge-dot" title="Changes waiting for review"></span>` : null}
    </div>
    <div><${CapacityBar} used=${d.used} total=${d.total} /><div class="mt6"><${UsageLine} used=${d.used} total=${d.total} /></div></div>
    <div class="pills">
      <${StatusPill} drive=${d} />
      <${HealthPill} health=${d.health_status} type=${d.type} state=${d.health_state} pct=${d.health_pct} />
      <${BootPill} kind=${d.bootable_override || (d.bootable_kind === 'windows-installed' || d.bootable_kind === 'uefi' ? null : d.bootable_kind)} />
    </div>
  </a>`;
}
