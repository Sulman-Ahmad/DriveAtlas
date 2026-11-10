// App root: sign-in gate, sidebar, routing, live updates and plug-in toasts.
import { html, render, useState, useEffect, useRef, api, openEvents, useLocalBackend } from './lib.js';
import { Icon } from './components.js';
import { Setup, Login, AboutPage } from './screens/welcome.js';
import { PhoneSetup, PhoneUnlock, PhoneLink } from './screens/phone-welcome.js';
import { Home } from './screens/home.js';
import { Drives } from './screens/drives.js';
import { AddDrive } from './screens/add.js';
import { DrivePage } from './screens/drive.js';
import { Search } from './screens/search.js';
import { Files } from './screens/files.js';
import { Scan } from './screens/scan.js';
import { Settings } from './screens/settings.js';
import { fmtNumber, fmtBytes } from '/shared/format.js';

const IS_PHONE_APP = Boolean(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());

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

// Shown in every open window after DriveAtlas is stopped from Settings.
function Stopped() {
  return html`<main class="welcome"><div class="welcome-card">
    <div class="brand brand-lg"><span class="brand-mark"><${Icon} name="atlas" size=${22} /></span>DriveAtlas</div>
    <h1>DriveAtlas has stopped</h1>
    <p class="muted">Nothing is running in the background now. You can close this window.</p>
    <p class="small muted">To start it again, double-click <code>DriveAtlas.vbs</code>, or use the DriveAtlas shortcut in the Start menu if you added it.</p>
  </div></main>`;
}

function App() {
  const [state, setState] = useState(null);
  const [fatal, setFatal] = useState('');
  const [stopped, setStopped] = useState(false);
  const loadState = () => api('GET', '/api/state').then((s) => { setState(s); applyTheme(s.settings.theme); }).catch((e) => setFatal(e.message));
  useEffect(() => { loadState(); }, []);

  if (stopped) return html`<${Stopped} />`;
  if (fatal) return html`<main class="welcome"><div class="welcome-card"><h1>Can't reach the DriveAtlas hub</h1><p class="muted">${fatal}</p><p class="small muted">Start DriveAtlas again from the Start menu or <code>DriveAtlas.cmd</code>.</p></div></main>`;
  if (!state) return html`<main class="boot" aria-label="Starting DriveAtlas"><span class="boot-mark"><${Icon} name="atlas" size=${40} /></span><span class="boot-name">DriveAtlas</span></main>`;
  if (!state.hasOwner) return IS_PHONE_APP ? html`<${PhoneSetup} state=${state} onDone=${loadState} />` : html`<${Setup} state=${state} onDone=${loadState} />`;
  if (!state.signedIn) return IS_PHONE_APP ? html`<${PhoneUnlock} state=${state} onDone=${loadState} />` : html`<${Login} onDone=${loadState} />`;
  return html`<${Main} state=${state} onSignedOut=${loadState} onStopped=${() => setStopped(true)} onTheme=${(t) => { applyTheme(t); setState({ ...state, settings: { ...state.settings, theme: t } }); }} />`;
}

function Main({ state, onSignedOut, onStopped, onTheme }) {
  const route = useHashRoute();
  const [data, setData] = useState({ summary: null, connected: [], drives: [], ready: false, version: 0, scanStatus: null, lastScan: null });
  const [toasts, setToasts] = useState([]);
  const toastId = useRef(0);

  async function refresh() {
    try {
      const [summary, connected, drives, scanStatus] = await Promise.all([api('GET', '/api/summary'), api('GET', '/api/connected'), api('GET', '/api/drives'), api('GET', '/api/scans')]);
      setData((d) => ({ ...d, summary, connected: connected.disks, drives: drives.drives, ready: connected.ready, scanStatus, version: d.version + 1 }));
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
    const es = openEvents();
    es.addEventListener('locked', () => onSignedOut());
    es.addEventListener('stopping', () => { es.close(); onStopped(); });
    es.addEventListener('disks', refresh);
    es.addEventListener('catalog', refresh);
    es.addEventListener('plugged', (e) => {
      const p = JSON.parse(e.data);
      const where = p.letters.length ? ` as ${p.letters.map((l) => `${l}:`).join(' ')}` : '';
      toast(p.changes.length
        ? { icon: 'sync', title: `${p.name} plugged in${where}`, body: `${p.changes.length} change${p.changes.length > 1 ? 's' : ''} found since last time. Review before updating.`, href: `#/drive/${p.driveId}`, action: 'Review changes', sticky: true }
        : { icon: 'check', title: `${p.name} plugged in${where}`, body: p.lastScannedAt ? 'Recognised from your catalog. Checking its files for changes since last time.' : 'Recognised from your catalog.', href: `#/drive/${p.driveId}`, action: 'Open' });
    });
    es.addEventListener('new-disk', (e) => {
      const p = JSON.parse(e.data);
      toast({ icon: 'plus', title: 'New drive found', body: `${p.friendlyName}${p.letters.length ? ` on ${p.letters.map((l) => `${l}:`).join(' ')}` : ''}. Add it with its details filled in.`, href: `#/add?disk=${encodeURIComponent(p.key)}`, action: 'Add to DriveAtlas', sticky: true });
    });
    es.addEventListener('scan-progress', (e) => {
      const view = JSON.parse(e.data);
      setData((d) => ({ ...d, scanStatus: { ...(d.scanStatus || { queue: [] }), active: view } }));
    });
    es.addEventListener('scan-update', (e) => setData((d) => ({ ...d, scanStatus: JSON.parse(e.data) })));
    es.addEventListener('scan-finished', (e) => {
      const v = JSON.parse(e.data);
      setData((d) => ({ ...d, lastScan: v }));
      if (v.state === 'done') toast({ icon: 'check', title: `Scan finished${v.label ? `: ${v.label}` : ''}`, body: `${fmtNumber(v.files)} files and ${fmtNumber(v.folders)} folders, ${fmtBytes(v.bytes)}.`, href: `#/files/${v.driveId}`, action: 'Browse files' });
      else if (v.state === 'failed') toast({ icon: 'alert', title: 'Scan stopped', body: v.error || 'The scan could not finish.', sticky: true });
      else if (v.state === 'cancelled') toast({ icon: 'x', title: 'Scan cancelled', body: 'Nothing from this scan was kept. The previous scan, if any, is still there.' });
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
  else if (route.name === 'search') screen = html`<${Search} data=${data} query=${route.query} />`;
  else if (route.name === 'files' && route.id) screen = html`<${Files} driveId=${route.id} data=${data} query=${route.query} />`;
  else if (route.name === 'scan') screen = html`<${Scan} data=${data} />`;
  else if (route.name === 'about') screen = html`<${AboutPage} />`;
  else if (route.name === 'link' && IS_PHONE_APP) screen = html`<div class="page"><${PhoneLink} embedded onDone=${() => { refresh(); location.hash = '#/settings'; }} onBack=${() => { location.hash = '#/settings'; }} /></div>`;
  else if (route.name === 'settings') screen = html`<${Settings} onTheme=${setTheme} onSignedOut=${onSignedOut} onStopped=${onStopped} />`;
  else screen = html`<${Home} data=${data} />`;

  const activeScan = data.scanStatus?.active;
  const nav = [
    { id: 'home', label: 'Home', icon: 'home', href: '#/' },
    { id: 'drives', label: 'Drives', icon: 'drives', href: '#/drives', count: data.drives.length },
    { id: 'search', label: 'Search', icon: 'search', href: '#/search' },
    { id: 'scan', label: 'Scan', icon: 'scan', href: '#/scan', note: activeScan ? (activeScan.state === 'paused' ? 'Paused' : activeScan.percent != null ? `${activeScan.percent}%` : 'Running') : null }
  ];
  const active = route.name === 'drive' || route.name === 'add' || route.name === 'files' ? 'drives' : route.name;
  const pending = data.drives.filter((d) => d.hasPendingChanges).length + data.connected.filter((d) => !d.driveId).length;

  return html`<div class="shell">
    <aside class="sidebar">
      <a class="brand" href="#/"><span class="brand-mark"><${Icon} name="atlas" size=${18} /></span>DriveAtlas</a>
      <nav class="nav" aria-label="Main">
        ${nav.map((n) => html`<a class=${`nav-item ${active === n.id ? 'on' : ''}`} href=${n.href} aria-current=${active === n.id ? 'page' : undefined}>
          <${Icon} name=${n.icon} /><span class="grow">${n.label}</span>${n.count ? html`<span class="nav-count">${n.count}</span>` : null}
          ${n.note ? html`<span class="nav-note">${n.note}</span>` : null}
          ${n.id === 'home' && pending ? html`<span class="count count-warn">${pending}</span>` : null}</a>`)}
        <a class=${`nav-item ${active === 'settings' ? 'on' : ''}`} href="#/settings" aria-current=${active === 'settings' ? 'page' : undefined}><${Icon} name="settings" /><span class="grow">Settings</span></a>
      </nav>
      <div class="sidebar-foot">
        <label class="theme-pick" for="theme"><${Icon} name=${state.settings.theme === 'dark' ? 'moon' : 'sun'} size=${16} /><span class="grow">Theme</span>
          <select id="theme" value=${state.settings.theme} onChange=${(e) => setTheme(e.target.value)}>
            <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
          </select></label>
        <div class="hub-card">
          <div class="hub-line"><span class="dot dot-good"></span><strong>Hub running</strong></div>
          <div class="muted mono">${location.host} · <span class="nowrap">v${state.version}</span></div>
          <div class="muted">${state.owner ? `Signed in as ${state.owner.name}` : ''}</div>
          <button type="button" class="link small" onClick=${signOut}>Sign out</button>
        </div>
      </div>
    </aside>
    <main class="content" key=${`${route.name}/${route.id || ''}`}>${screen}</main>
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

// Inside the Android app the catalog lives on the phone itself, answered by the phone's local API.
if (IS_PHONE_APP) {
  document.documentElement.classList.add('is-phone');
  const local = await import('./phone/local-api.js');
  useLocalBackend(local.handle, local.openEvents);
  local.startPhone().catch((err) => console.error(err));
}
render(html`<${App} />`, document.getElementById('app'));
