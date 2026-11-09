// App root: sign-in gate, sidebar, routing, live updates and plug-in toasts.
import { html, render, useState, useEffect, useRef, api } from './lib.js';
import { Icon } from './components.js';
import { Setup, Login } from './screens/welcome.js';
import { Home } from './screens/home.js';
import { Drives } from './screens/drives.js';
import { AddDrive } from './screens/add.js';
import { DrivePage } from './screens/drive.js';

function parseRoute(hash) {
  const [path, qs] = (hash.replace(/^#/, '') || '/').split('?');
  const parts = path.split('/').filter(Boolean);
  return { name: parts[0] || 'home', id: parts[1], query: new URLSearchParams(qs || '') };
}

function useHashRoute() {
  const [hash, setHash] = useState(location.hash || '#/');
  useEffect(() => {
    const on = () => setHash(location.hash || '#/');
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return parseRoute(hash);
}

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function App() {
  const [state, setState] = useState(null);
  const [fatal, setFatal] = useState('');
  const loadState = () => api('GET', '/api/state').then((s) => { setState(s); applyTheme(s.settings.theme); }).catch((e) => setFatal(e.message));
  useEffect(() => { loadState(); }, []);

  if (fatal) return html`<main class="welcome"><div class="welcome-card"><h1>Can't reach the DriveAtlas hub</h1><p class="muted">${fatal}</p><p class="small muted">Start DriveAtlas again from the Start menu or <code>DriveAtlas.cmd</code>.</p></div></main>`;
  if (!state) return html`<main class="welcome"><p class="muted">Starting…</p></main>`;
  if (!state.hasOwner) return html`<${Setup} state=${state} onDone=${loadState} />`;
  if (!state.signedIn) return html`<${Login} onDone=${loadState} />`;
  return html`<${Main} state=${state} onSignedOut=${loadState} onTheme=${(t) => { applyTheme(t); setState({ ...state, settings: { ...state.settings, theme: t } }); }} />`;
}

function Main({ state, onSignedOut, onTheme }) {
  const route = useHashRoute();
  const [data, setData] = useState({ summary: null, connected: [], drives: [], ready: false, version: 0 });
  const [toasts, setToasts] = useState([]);
  const toastId = useRef(0);

  async function refresh() {
    try {
      const [summary, connected, drives] = await Promise.all([api('GET', '/api/summary'), api('GET', '/api/connected'), api('GET', '/api/drives')]);
      setData((d) => ({ summary, connected: connected.disks, drives: drives.drives, ready: connected.ready, version: d.version + 1 }));
    } catch (err) {
      if (err.status === 401) onSignedOut();
    }
  }

  const toast = (t) => {
    const id = ++toastId.current;
    setToasts((list) => [...list.slice(-2), { id, ...t }]);
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), t.sticky ? 20000 : 7000);
  };
  const dismiss = (id) => setToasts((list) => list.filter((x) => x.id !== id));

  useEffect(() => {
    refresh();
    const es = new EventSource('/api/events');
    es.addEventListener('disks', refresh);
    es.addEventListener('catalog', refresh);
    es.addEventListener('plugged', (e) => {
      const p = JSON.parse(e.data);
      const where = p.letters.length ? ` as ${p.letters.map((l) => `${l}:`).join(' ')}` : '';
      toast(p.changes.length
        ? { icon: 'sync', title: `${p.name} plugged in${where}`, body: `${p.changes.length} change${p.changes.length > 1 ? 's' : ''} found since last time. Review before updating.`, href: `#/drive/${p.driveId}`, action: 'Review changes', sticky: true }
        : { icon: 'check', title: `${p.name} plugged in${where}`, body: 'Recognised from your catalog.', href: `#/drive/${p.driveId}`, action: 'Open' });
    });
    es.addEventListener('new-disk', (e) => {
      const p = JSON.parse(e.data);
      toast({ icon: 'plus', title: 'New drive found', body: `${p.friendlyName}${p.letters.length ? ` on ${p.letters.map((l) => `${l}:`).join(' ')}` : ''}. Add it with its details filled in.`, href: `#/add?disk=${encodeURIComponent(p.key)}`, action: 'Add to DriveAtlas', sticky: true });
    });
    es.addEventListener('unplugged', (e) => {
      const p = JSON.parse(e.data);
      toast({ icon: 'drives', title: `${p.friendlyName} was unplugged`, body: 'Its record stays in your catalog.' });
    });
    return () => es.close();
  }, []);

  async function signOut() {
    await api('POST', '/api/logout').catch(() => {});
    onSignedOut();
  }

  async function setTheme(theme) {
    onTheme(theme);
    await api('PUT', '/api/settings', { theme }).catch(() => {});
  }

  let screen;
  if (route.name === 'drives') screen = html`<${Drives} data=${data} />`;
  else if (route.name === 'drive' && route.id) screen = html`<${DrivePage} id=${route.id} data=${data} onChanged=${refresh} />`;
  else if (route.name === 'add') screen = html`<${AddDrive} key=${route.query.get('disk') || 'manual'} data=${data} query=${route.query} onSaved=${refresh} />`;
  else screen = html`<${Home} data=${data} />`;

  const nav = [
    { id: 'home', label: 'Home', icon: 'home', href: '#/' },
    { id: 'drives', label: 'Drives', icon: 'drives', href: '#/drives', count: data.drives.length }
  ];
  const active = route.name === 'drive' || route.name === 'add' ? 'drives' : route.name;
  const pending = data.drives.filter((d) => d.hasPendingChanges).length + data.connected.filter((d) => !d.driveId).length;

  return html`<div class="shell">
    <aside class="sidebar">
      <a class="brand" href="#/"><span class="brand-mark"><${Icon} name="atlas" size=${18} /></span>DriveAtlas</a>
      <nav class="nav" aria-label="Main">
        ${nav.map((n) => html`<a class=${`nav-item ${active === n.id ? 'on' : ''}`} href=${n.href} aria-current=${active === n.id ? 'page' : undefined}>
          <${Icon} name=${n.icon} /><span class="grow">${n.label}</span>${n.count ? html`<span class="nav-count">${n.count}</span>` : null}
          ${n.id === 'home' && pending ? html`<span class="count count-warn">${pending}</span>` : null}</a>`)}
        <span class="nav-soon">Search, Scan and Health arrive in the next updates.</span>
      </nav>
      <div class="sidebar-foot">
        <label class="theme-pick" for="theme"><${Icon} name=${state.settings.theme === 'dark' ? 'moon' : 'sun'} size=${16} /><span class="grow">Theme</span>
          <select id="theme" value=${state.settings.theme} onChange=${(e) => setTheme(e.target.value)}>
            <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
          </select></label>
        <div class="hub-card">
          <div class="hub-line"><span class="dot dot-good"></span><strong>Hub running</strong></div>
          <div class="muted mono">${location.host} · v${state.version}</div>
          <div class="muted">${state.owner ? `Signed in as ${state.owner.name}` : ''}</div>
          <button type="button" class="link small" onClick=${signOut}>Sign out</button>
        </div>
      </div>
    </aside>
    <main class="content">${screen}</main>
    <div class="toasts" aria-live="polite">
      ${toasts.map((t) => html`<div class="toast" role="status" key=${t.id}>
        <span class="tile tile-accent"><${Icon} name=${t.icon} size=${18} /></span>
        <div class="grow"><div class="row-title">${t.title}</div><div class="small muted">${t.body}</div>
          ${t.href ? html`<a class="btn btn-primary btn-sm" href=${t.href} onClick=${() => dismiss(t.id)}>${t.action}</a>` : null}</div>
        <button type="button" class="icon-btn" aria-label="Dismiss" onClick=${() => dismiss(t.id)}><${Icon} name="x" size=${16} /></button>
      </div>`)}
    </div>
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
