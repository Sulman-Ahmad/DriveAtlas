// Settings: account, backups, catalog folder, drive health tools, appearance.
import { html, useState, useEffect, api, isLocalBackend } from '../lib.js';
import { PhoneSettings } from './phone-settings.js';
import { Card, Field, ErrorNote, Button, Icon, Lead, HelpTip } from '../components.js';
import { LEADS, HELP } from '../help.js';
import { RestoreForm, waitForHub } from './restore-form.js';
import { fmtBytes, fmtDateTime, timeAgo } from '/shared/format.js';

export function Settings(props) {
  return isLocalBackend() ? html`<${PhoneSettings} ...${props} />` : html`<${PcSettings} ...${props} />`;
}

function PcSettings({ onTheme, onSignedOut, onStopped }) {
  const [s, setS] = useState(null);
  const [error, setError] = useState('');
  const load = () => api('GET', '/api/settings/all').then(setS).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  if (!s) return html`<div class="page"><h1>Settings</h1>${error ? html`<${ErrorNote} error=${error} />` : html`<p class="muted">Loading…</p>`}</div>`;

  return html`<div class="page">
    <h1>Settings</h1>
    <${Lead}>${LEADS.settings}</${Lead}>
    <div class="columns">
      <div class="col-main stack-lg">
        <${BackupCard} s=${s} reload=${load} />
        <${Card} id="h-restore" title="Restore from a backup" help=${HELP.restore}>
          <p class="small muted mt0">Brings back a catalog exactly as it was when the backup was made. Use it on a new laptop, or to undo a mistake.</p>
          <${RestoreForm} needsCurrentPassword />
        </${Card}>
        <${FolderCard} s=${s} />
        <${DevicesCard} />
      </div>
      <div class="col-side stack-lg">
        <${PasswordCard} onSignedOut=${onSignedOut} />
        <${HealthCard} s=${s} reload=${load} />
        <${Card} id="h-look" title="Appearance">
          <label class="check-row" for="set-theme"><span><strong>Theme</strong><span class="small muted">System follows your Windows setting.</span></span>
            <select id="set-theme" value=${s.theme} onChange=${(e) => { onTheme(e.target.value); setS({ ...s, theme: e.target.value }); }}>
              <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
        </${Card}>
        <${Card} id="h-about" title="About" pad=${false}>
          <dl class="kv kv-rows">
            <div class="kv-row"><dt>Version</dt><dd>${s.version}</dd></div>
            <div class="kv-row"><dt>Account</dt><dd>${s.owner?.name}</dd></div>
            <div class="kv-row"><dt>Catalog</dt><dd class="mono small break">${s.dataDir}</dd></div>
            <div class="kv-row"><dt>Log file</dt><dd class="mono small break">${s.logPath}</dd></div>
          </dl>
          <div class="card-body about-intro"><a class="link" href="#/about">What DriveAtlas does and how to use it</a>
            <button type="button" class="link small sign-out" onClick=${async () => { await api('POST', '/api/logout').catch(() => {}); onSignedOut(); }}>Sign out</button></div>
          <${StopHub} onStopped=${onStopped} />
        </${Card}>
      </div>
    </div>
  </div>`;
}

// Linked phones (and later helper PCs): link with a one-time code, see when each last synced, unlink.
function DevicesCard() {
  const [d, setD] = useState(null);
  const [pair, setPair] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const load = () => api('GET', '/api/devices').then((r) => { setD(r); return r; }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!pair) return undefined;
    const t = setInterval(async () => {
      setNow(Date.now());
      const r = await load();
      if (r && r.devices.length > pair.before) {
        const fresh = r.devices[r.devices.length - 1];
        setPair(null);
        setMsg(`Linked ${fresh.name}. It is syncing now.`);
      } else if (Date.now() > pair.expiresAt) setPair(null);
    }, 2000);
    return () => clearInterval(t);
  }, [pair]);
  async function start() {
    setError(''); setMsg('');
    try { const r = await api('POST', '/api/devices/link'); setPair({ ...r, before: d ? d.devices.length : 0 }); setNow(Date.now()); } catch (e) { setError(e.message); }
  }
  async function unlink(dev) {
    if (!window.confirm(`Unlink ${dev.name}? It keeps its own copy of the catalog but stops syncing with this PC.`)) return;
    setError(''); setMsg('');
    try { await api('POST', `/api/devices/${dev.id}/unlink`); await load(); } catch (e) { setError(e.message); }
  }
  const left = pair ? Math.max(0, Math.round((pair.expiresAt - now) / 1000)) : 0;
  return html`<${Card} id="h-devices" title="Phone and helper PCs" help=${HELP.devices}>
    <div class="stack">
      ${d && d.devices.length ? html`<div class="stack-sm">${d.devices.map((dev) => html`<div class="row row-flat">
          <span class="tile tile-accent"><${Icon} name=${dev.role === 'helper' ? 'laptop' : 'phone'} size=${18} /></span>
          <div class="grow"><div class="row-title">${dev.name}</div><div class="small muted">${dev.last_sync_at ? `Last synced ${timeAgo(dev.last_sync_at)}` : 'Not synced yet'}</div></div>
          <${Button} kind="danger" onClick=${() => unlink(dev)}>Unlink</${Button}>
        </div>`)}</div>` : html`<p class="small muted mt0">No phone linked yet. Install DriveAtlas on your Android phone, then link it here to keep both in sync on your Wi-Fi.</p>`}
      ${pair ? html`<div class="link-code" role="status">
          <div class="small muted">On your phone, open DriveAtlas, choose Link with a PC, and type:</div>
          <div class="kv"><dt>PC address</dt><dd class="mono big">${pair.address}</dd><dt>Link code</dt><dd class="mono big">${pair.code}</dd></div>
          <div class="small muted">Valid for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}. Windows may ask whether DriveAtlas (Node.js) may use private networks: choose Allow.</div>
        </div>`
        : html`<div><${Button} kind="primary" icon="phone" onClick=${start}>Link a phone</${Button}></div>`}
      ${msg ? html`<p class="small" role="status">${msg}</p>` : null}
      <${ErrorNote} error=${error} />
    </div>
  </${Card}>`;
}

// Stops the hub after a confirm step. Open windows switch to the "stopped" screen.
function StopHub({ onStopped }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function stop() {
    setError(''); setBusy(true);
    try { await api('POST', '/api/hub/stop'); onStopped(); } catch (e) { setError(e.message); setBusy(false); }
  }
  return html`<div class="card-body stack-sm">
    <p class="small muted mt0">DriveAtlas keeps running in the background so it can spot drives you plug in and make daily backups. Stop it when you don't need it.</p>
    ${confirm
      ? html`<div class="inline-form">
          <${Button} kind="danger" icon="x" onClick=${stop} disabled=${busy}>${busy ? 'Stopping…' : 'Yes, stop DriveAtlas'}</${Button}>
          <${Button} onClick=${() => setConfirm(false)} disabled=${busy}>Keep running</${Button}>
        </div>`
      : html`<div><${Button} icon="x" onClick=${() => setConfirm(true)}>Stop DriveAtlas</${Button}></div>`}
    <${ErrorNote} error=${error} />
  </div>`;
}

function BackupCard({ s, reload }) {
  const [folder, setFolder] = useState(s.backup.folder || '');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save(patch) {
    setError(''); setMsg('');
    try { await api('PUT', '/api/settings/backup', patch); await reload(); setMsg('Saved.'); } catch (e) { setError(e.message); }
  }
  async function pick() {
    setError('');
    try { const r = await api('POST', '/api/pick', { kind: 'folder' }); if (r.path) { setFolder(r.path); await save({ folder: r.path }); } } catch (e) { setError(e.message); }
  }
  async function now() {
    setBusy(true); setError(''); setMsg('Making a backup…');
    try { const r = await api('POST', '/api/backup/now'); setMsg(`Backup saved: ${r.path} (${fmtBytes(r.size)}).`); await reload(); } catch (e) { setError(e.message); setMsg(''); } finally { setBusy(false); }
  }

  const last = s.recentBackups.find((b) => b.status === 'ok');
  return html`<${Card} id="h-backup" title="Backups" help=${HELP.backups}>
    <div class="stack">
      <p class="small muted mt0">Each backup is one file holding your whole catalog and account, encrypted with your password (AES-256-GCM). Keep it on another drive or in a cloud folder; it is safe to store there.</p>
      ${!s.backupKeyReady ? html`<p class="callout callout-warn small">Sign out and sign in once so DriveAtlas can prepare your backup key.</p>` : null}
      <div class="field">
        <span class="field-label">Backup folder</span>
        <div class="inline-form">
          <input aria-label="Backup folder" placeholder="e.g. E:\\DriveAtlas backups" value=${folder} onInput=${(e) => setFolder(e.target.value)} />
          <button type="button" class="btn btn-secondary" onClick=${pick}><${Icon} name="folder" size=${16} />Choose…</button>
          <button type="button" class="btn btn-secondary" onClick=${() => save({ folder })}>Save</button>
        </div>
        <span class="field-hint">Best on another drive, or in a OneDrive or Google Drive folder, so a lost laptop never takes your catalog with it.</span>
      </div>
      <label class="check-row" for="bk-daily"><input id="bk-daily" type="checkbox" checked=${s.backup.enabled} disabled=${!s.backup.folder} onChange=${(e) => save({ enabled: e.target.checked })} />
        <span><strong>Back up every day</strong><span class="small muted">Runs in the background while DriveAtlas is open.</span></span></label>
      <label class="check-row" for="bk-keep"><span><strong>Keep</strong><span class="small muted">Older backups in the folder are removed.</span></span>
        <select id="bk-keep" value=${s.backup.keep} onChange=${(e) => save({ keep: Number(e.target.value) })}>${[3, 7, 14, 30].map((n) => html`<option value=${n}>${n} backups</option>`)}</select></label>
      <div class="actions">
        <${Button} kind="primary" icon="download" disabled=${busy || !s.backup.folder || !s.backupKeyReady} onClick=${now}>Back up now</${Button}>
        <a class="btn btn-secondary" href="/api/backup/download" download><${Icon} name="download" size=${17} />Download a backup</a><${HelpTip} text=${HELP.downloadBackup} label="About downloading a backup" />
      </div>
      ${msg ? html`<p class="small muted break" role="status">${msg}</p>` : null}
      <${ErrorNote} error=${error} />
      <div class="small muted">${last ? `Last backup ${timeAgo(last.created_at)} (${fmtBytes(last.size)}).` : 'No backup yet.'}
        ${s.recentBackups.some((b) => b.status === 'failed') ? html` <span class="warn-text">A recent backup failed: ${s.recentBackups.find((b) => b.status === 'failed').error}</span>` : null}</div>
    </div>
  </${Card}>`;
}

function FolderCard({ s }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  async function move() {
    setError('');
    try {
      const r = await api('POST', '/api/pick', { kind: 'folder' });
      if (!r.path) return;
      setBusy(`Moving your catalog to ${r.path}\\DriveAtlas Data…`);
      const m = await api('POST', '/api/settings/catalog-folder', { folder: r.path });
      setBusy(`Moved to ${m.target}. ${m.restricted ? 'Only your Windows account can open that folder.' : ''} DriveAtlas is restarting…`);
      waitForHub();
    } catch (e) { setError(e.message); setBusy(''); }
  }
  return html`<${Card} id="h-folder" title="Catalog folder" help=${HELP.catalogFolder}>
    <div class="stack-sm">
      <div class="mono small break">${s.dataDir}</div>
      <p class="small muted mt0">Move the catalog to another drive if your Windows drive is small. DriveAtlas copies it into a new "DriveAtlas Data" folder that only your account can open, then restarts. The old copy stays where it is until you delete it.</p>
      ${busy ? html`<p class="small" role="status">${busy}</p>` : null}
      <${ErrorNote} error=${error} />
      <div><${Button} icon="folder" disabled=${Boolean(busy)} onClick=${move}>Move catalog…</${Button}></div>
    </div>
  </${Card}>`;
}

function PasswordCard({ onSignedOut }) {
  const [v, setV] = useState({ current: '', next: '', again: '' });
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault();
    setError(''); setMsg('');
    if (v.next !== v.again) return setError('The new passwords do not match.');
    try {
      await api('POST', '/api/account/password', { current: v.current, next: v.next });
      setV({ current: '', next: '', again: '' });
      setMsg('Password changed. Other windows and devices are signed out. Backups made before today still open with your old password.');
    } catch (err) {
      if (err.status === 401 && /sign in/i.test(err.message)) onSignedOut();
      setError(err.message);
    }
  }
  return html`<${Card} id="h-pw" title="Password">
    <form class="stack" onSubmit=${submit}>
      <${Field} label="Current password" id="pw-cur"><input id="pw-cur" type="password" autocomplete="current-password" value=${v.current} onInput=${set('current')} required maxlength="200" /></${Field}>
      <${Field} label="New password" id="pw-new" hint="At least 8 characters."><input id="pw-new" type="password" autocomplete="new-password" value=${v.next} onInput=${set('next')} required minlength="8" maxlength="200" /></${Field}>
      <${Field} label="New password again" id="pw-again"><input id="pw-again" type="password" autocomplete="new-password" value=${v.again} onInput=${set('again')} required minlength="8" maxlength="200" /></${Field}>
      <${ErrorNote} error=${error} />
      ${msg ? html`<p class="small muted" role="status">${msg}</p>` : null}
      <div><button type="submit" class="btn btn-primary">Change password</button></div>
    </form>
  </${Card}>`;
}

function HealthCard({ s, reload }) {
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function read() {
    setBusy(true); setError(''); setMsg('Windows will ask for permission. Choose Yes to read drive health.');
    try {
      const r = await api('POST', '/api/health/read');
      setMsg(`Read ${r.updated.length} drive${r.updated.length === 1 ? '' : 's'} in your catalog${r.smartctl ? ' with smartctl' : ''}.${r.unmatched ? ` ${r.unmatched} connected drive${r.unmatched === 1 ? ' is' : 's are'} not in your catalog yet.` : ''}`);
    } catch (e) { setError(e.message); setMsg(''); } finally { setBusy(false); }
  }
  async function install() {
    setError('');
    try { await api('POST', '/api/health/install-smartctl'); setMsg('An install window opened. Follow it, then come back and press Refresh.'); } catch (e) { setError(e.message); }
  }
  return html`<${Card} id="h-health" title="Drive health" help=${HELP.health}>
    <div class="stack-sm small">
      <p class="muted mt0">Windows only shares wear, temperature and error counts with administrator permission, so each reading shows a Windows prompt. Nothing on your drives is changed.</p>
      <div>${s.smartctl ? html`<span class="inline"><${Icon} name="check" size=${16} />smartctl found: <span class="mono break">${s.smartctl}</span></span>`
        : html`<span>For full details (bad sectors, total written, NVMe wear), install the free smartmontools tool.<${HelpTip} text=${HELP.smartmontools} label="About smartmontools" /></span>`}</div>
      ${msg ? html`<p class="muted" role="status">${msg}</p>` : null}
      <${ErrorNote} error=${error} />
      <div class="actions">
        <${Button} kind="primary" icon="pulse" disabled=${busy} onClick=${read}>${busy ? 'Reading…' : 'Read health now'}</${Button}>
        ${!s.smartctl ? html`<${Button} icon="download" onClick=${install}>Install smartmontools</${Button}><${Button} onClick=${reload}>Refresh</${Button}>` : null}
      </div>
    </div>
  </${Card}>`;
}
