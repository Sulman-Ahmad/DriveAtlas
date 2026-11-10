// Home: totals, drives connected right now, and what needs attention.
import { html, go } from '../lib.js';
import { Icon, TypeTile, Card, CapacityBar, HealthPill, Pill, LinkButton, Empty, healthInfo, Lead, HelpTip } from '../components.js';
import { LEADS, HELP } from '../help.js';
import { fmtBytes, percent } from '/shared/format.js';

export function Home({ data }) {
  const { summary, connected, drives } = data;
  const s = summary || { counts: { total: 0 }, capacity: 0, used: 0, free: 0, overNinety: 0 };
  const c = s.counts;
  const unknown = connected.filter((d) => !d.driveId);
  const pending = drives.filter((d) => d.hasPendingChanges);
  const unhealthy = connected.filter((d) => d.health && !/^healthy$/i.test(d.health));
  const badHealth = drives.filter((d) => d.health_state === 'bad' || d.health_state === 'watch');
  const full = drives.filter((d) => d.total && d.used && d.used / d.total > 0.9);
  const neverScanned = drives.filter((d) => d.connected && !d.last_scanned_at);
  const attention = [
    ...neverScanned.map((d) => ({ tone: 'accent', icon: 'scan', title: `${d.name} has not been scanned`, body: 'Scan it once to search its files later, even when it is unplugged.', href: `#/drive/${d.id}`, action: 'Open drive' })),
    ...pending.map((d) => ({ tone: 'accent', icon: 'sync', title: `Changes found on ${d.name}`, body: 'Plugged in with differences from its record. Review them before anything is updated.', href: `#/drive/${d.id}`, action: 'Review changes' })),
    ...unknown.map((d) => ({ tone: 'accent', icon: 'plus', title: `${d.friendlyName} is not in your catalog`, body: `${fmtBytes(d.size)} ${d.busType} drive${d.letters.length ? ` on ${d.letters.map((l) => `${l}:`).join(' ')}` : ''}.`, href: `#/add?disk=${encodeURIComponent(d.key)}`, action: 'Add to DriveAtlas' })),
    ...badHealth.map((d) => ({ tone: d.health_state === 'bad' ? 'bad' : 'warn', icon: 'pulse', title: `${d.name} health is ${d.health_state === 'bad' ? 'Bad' : 'Watch'}${d.health_pct != null ? ` (${Math.round(d.health_pct)}%)` : ''}`, body: d.health_state === 'bad' ? 'Copy anything important off this drive soon.' : 'Keep an eye on it and make sure it is backed up.', href: `#/drive/${d.id}`, action: 'Open drive' })),
    ...unhealthy.map((d) => ({ tone: 'bad', icon: 'alert', title: `${d.driveName || d.friendlyName}: Windows reports ${d.health}`, body: 'Copy anything important off this drive soon.', href: d.driveId ? `#/drive/${d.driveId}` : null, action: 'Open drive' })),
    ...full.map((d) => ({ tone: 'warn', icon: 'drives', title: `${d.name} is ${percent(d.used, d.total)}% full`, body: `${fmtBytes(d.total - d.used)} free of ${fmtBytes(d.total)}.`, href: `#/drive/${d.id}`, action: 'Open drive' }))
  ];
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  return html`<div class="page">
    <header class="page-head">
      <div><h1>Home</h1><p class="muted">${today} · ${c.total} ${c.total === 1 ? 'drive' : 'drives'} in your catalog</p></div>
      <form class="search" role="search" onSubmit=${(e) => { e.preventDefault(); const q = e.target.elements.q.value.trim(); go(`#/search${q ? `?q=${encodeURIComponent(q)}` : ''}`); }}>
        <${Icon} name="search" size=${18} /><input name="q" type="search" placeholder="Search files on all drives" aria-label="Search files on all drives" />
      </form>
      <${LinkButton} kind="primary" icon="plus" href="#/add">Add drive</${LinkButton}>
    </header>
    <${Lead}>${LEADS.home}${!c.total ? html` <a class="link" href="#/about">New here? See what DriveAtlas does.</a>` : null}</${Lead}>

    <section class="card summary" aria-label="Storage summary">
      <div class="stats">
        <div class="stat"><span class="stat-label">Drives</span><span class="stat-value">${c.total}</span>
          <span class="stat-sub">${[c.inpc && `${c.inpc} in PC`, c.plugged && `${c.plugged} plugged in`, c.stored && `${c.stored} stored`, c.lent && `${c.lent} lent`].filter(Boolean).join(' · ') || 'Add your first drive'}</span></div>
        <div class="stat"><span class="stat-label">Capacity<${HelpTip} text=${HELP.capacity} label="About Capacity" /></span><span class="stat-value">${fmtBytes(s.capacity)}</span><span class="stat-sub">across your drives</span></div>
        <div class="stat"><span class="stat-label">Used<${HelpTip} text=${HELP.used} label="About Used" /></span><span class="stat-value">${fmtBytes(s.used)}</span><span class="stat-sub">${percent(s.used, s.capacity)}% of capacity</span></div>
        <div class="stat"><span class="stat-label">Free</span><span class="stat-value">${fmtBytes(s.free)}</span><span class="stat-sub">${s.overNinety ? `${s.overNinety} drive${s.overNinety > 1 ? 's' : ''} over 90% full` : 'No drive over 90% full'}</span></div>
      </div>
      <${CapacityBar} used=${s.used} total=${s.capacity} thick />
    </section>

    <div class="columns">
      <div class="col-main">
        <${Card} id="h-connected" title="Connected now" help=${HELP.connectedNow} pad=${false} extra=${html`<span class="muted small">${connected.length} ${connected.length === 1 ? 'drive' : 'drives'}</span><a class="link push" href="#/drives">View all drives</a>`}>
          ${!data.ready ? html`<p class="card-body muted">Reading your drives…</p>` : null}
          ${data.ready && !connected.length ? html`<div class="card-body"><${Empty} title="No drives detected">Plug in a drive and it appears here within a few seconds.</${Empty}></div>` : null}
          ${connected.map((d) => html`<${ConnectedRow} d=${d} drive=${drives.find((x) => x.id === d.driveId)} key=${d.key} />`)}
        </${Card}>
      </div>
      <div class="col-side">
        <${Card} id="h-attention" title="Needs attention" help=${HELP.attention} pad=${false} extra=${attention.length ? html`<span class="count count-warn push">${attention.length}</span>` : null}>
          ${!attention.length ? html`<div class="card-body"><${Empty} icon="check" title="All good">Nothing needs your attention right now.</${Empty}></div>` : null}
          ${attention.map((a) => html`<div class="row">
            <span class=${`tile tile-${a.tone}`}><${Icon} name=${a.icon} size=${18} /></span>
            <div class="grow"><div class="row-title">${a.title}</div><div class="small muted">${a.body}</div>
              ${a.href ? html`<a class="link small" href=${a.href}>${a.action}</a>` : null}</div>
          </div>`)}
        </${Card}>
      </div>
    </div>
  </div>`;
}

function ConnectedRow({ d, drive }) {
  const h = healthInfo(d.health, d.driveType, drive?.health_state, drive?.health_pct);
  const href = d.driveId ? `#/drive/${d.driveId}` : `#/add?disk=${encodeURIComponent(d.key)}`;
  return html`<a class="row row-link" href=${href}>
    <${TypeTile} type=${d.driveType} size=${36} />
    <div class="grow">
      <div class="row-title">${d.driveName || d.friendlyName}
        <span class="muted small"> ${[d.letters.map((l) => `${l}:`).join(' '), d.busType, d.mediaType].filter(Boolean).join(' · ')}</span></div>
      <${CapacityBar} used=${d.used} total=${d.size} />
    </div>
    <span class="row-num small muted">${fmtBytes(d.used)} of ${fmtBytes(d.size)}</span>
    ${d.driveId ? html`<${Pill} tone=${h.tone}>${h.text}</${Pill}>` : html`<${Pill} tone="accent" icon="plus">Add</${Pill}>`}
  </a>`;
}
