// Settings in the Android app: this phone, storage access, the lock, linking with a PC, look and about.
import { html, useState, useEffect, api } from '../lib.js';
import { Card, Field, ErrorNote, Button, Icon, Lead, Pill } from '../components.js';
import { HELP } from '../help.js';
import { timeAgo } from '/shared/format.js';

export function PhoneSettings({ onTheme, onSignedOut }) {
  const [s, setS] = useState(null);
  const [error, setError] = useState('');
  const load = () => api('GET', '/api/settings/all').then(setS).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    // Coming back from Android's settings screen: refresh the access status.
    const on = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  if (!s) return html`<div class="page"><h1>Settings</h1>${error ? html`<${ErrorNote} error=${error} />` : html`<p class="muted">Loading…</p>`}</div>`;
  const p = s.phone || {};

  return html`<div class="page">
    <h1>Settings</h1>
    <${Lead}>This phone, storage access, how DriveAtlas opens, linking with your PC, and how it looks.</${Lead}>
    <div class="columns">
      <div class="col-main stack-lg">
        <${Card} id="ps-phone" title="This phone">
          <dl class="kv"><dt>Phone</dt><dd>${p.name || 'This phone'}</dd>${p.android ? html`<dt>Android</dt><dd>${p.android}</dd>` : null}<dt>Catalog</dt><dd>Stored on this phone</dd></dl>
        </${Card}>
        <${AccessCard} access=${p.access || {}} reload=${load} />
        <${LinkCard} link=${p.link || null} reload=${load} />
      </div>
      <div class="col-side stack-lg">
        <${LockCard} p=${p} reload=${load} />
        <${Card} id="ps-look" title="Appearance">
          <label class="check-row" for="ps-theme"><span><strong>Theme</strong><span class="small muted">System follows your phone’s setting.</span></span>
            <select id="ps-theme" value=${s.theme} onChange=${(e) => { onTheme(e.target.value); setS({ ...s, theme: e.target.value }); }}>
              <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
        </${Card}>
        <${Card} id="ps-about" title="About" pad=${false}>
          <dl class="kv kv-rows">
            <div class="kv-row"><dt>Version</dt><dd>${s.version}</dd></div>
            <div class="kv-row"><dt>Account</dt><dd>${s.owner?.name || ''}</dd></div>
          </dl>
          <div class="card-body about-intro"><a class="link" href="#/about">What DriveAtlas does and how to use it</a>
            <button type="button" class="link small" onClick=${async () => { await api('POST', '/api/logout').catch(() => {}); onSignedOut(); }}>Lock now</button></div>
        </${Card}>
      </div>
    </div>
  </div>`;
}

function AccessCard({ access, reload }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function allow() {
    setBusy(true); setError('');
    try { await api('POST', '/api/phone/access'); await reload(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return html`<${Card} id="ps-access" title="Storage access" help=${HELP.allFiles}>
    <div class="stack-sm">
      <div>${access.allFiles ? html`<${Pill} tone="good" icon="check">All files access is on</${Pill}>` : html`<${Pill} tone="warn" icon="alert">All files access is off</${Pill}>`}</div>
      <p class="small muted mt0">${access.allFiles
        ? 'DriveAtlas can record the phone’s storage, its SD card and any USB drive or SSD you plug in. It reads names, sizes and dates only.'
        : 'Without it, you pick the drive or folder each time you scan. For a USB drive or SSD, pick the drive itself so the whole drive is recorded.'}</p>
      ${access.allFiles ? null : html`<div><${Button} kind="primary" icon="lock" disabled=${busy} onClick=${allow}>Allow All files access</${Button}></div>`}
      <${ErrorNote} error=${error} />
    </div>
  </${Card}>`;
}

function LockCard({ p, reload }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const digits = (v) => v.replace(/\D/g, '');
  async function changePin(e) {
    e.preventDefault();
    setError(''); setMsg('');
    if (next !== again) return setError('The new PINs do not match.');
    try { await api('POST', '/api/phone/pin', { current: cur, next }); setCur(''); setNext(''); setAgain(''); setMsg('PIN changed.'); } catch (err) { setError(err.message); }
  }
  async function setBio(enabled) {
    setError(''); setMsg('');
    try { await api('PUT', '/api/phone/biometric', { enabled }); await reload(); } catch (err) { setError(err.message); }
  }
  return html`<${Card} id="ps-lock" title="Opening DriveAtlas" help=${HELP.phoneLock}>
    <div class="stack">
      ${p.biometricAvailable ? html`<label class="check-row" for="ps-bio"><input id="ps-bio" type="checkbox" checked=${p.biometric} onChange=${(e) => setBio(e.target.checked)} />
        <span><strong>Unlock with fingerprint</strong><span class="small muted">Your PIN still works if the fingerprint doesn’t.</span></span></label>`
        : html`<p class="small muted mt0">Set up a fingerprint or face unlock in your phone’s settings to open DriveAtlas with it.</p>`}
      <form class="stack-sm" onSubmit=${changePin}>
        <strong class="small">Change PIN</strong>
        <${Field} label="Current PIN" id="ps-cur"><input id="ps-cur" type="password" inputmode="numeric" autocomplete="current-password" value=${cur} onInput=${(e) => setCur(digits(e.target.value))} required maxlength="12" /></${Field}>
        <${Field} label="New PIN" id="ps-new" hint="4 to 12 digits."><input id="ps-new" type="password" inputmode="numeric" autocomplete="new-password" value=${next} onInput=${(e) => setNext(digits(e.target.value))} required minlength="4" maxlength="12" /></${Field}>
        <${Field} label="New PIN again" id="ps-again"><input id="ps-again" type="password" inputmode="numeric" autocomplete="new-password" value=${again} onInput=${(e) => setAgain(digits(e.target.value))} required minlength="4" maxlength="12" /></${Field}>
        <div><button type="submit" class="btn btn-secondary">Change PIN</button></div>
      </form>
      ${msg ? html`<p class="small muted" role="status">${msg}</p>` : null}
      <${ErrorNote} error=${error} />
    </div>
  </${Card}>`;
}

function LinkCard({ link, reload }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  async function act(path, label) {
    setBusy(label); setError('');
    try { await api('POST', path); await reload(); } catch (e) { setError(e.message); } finally { setBusy(''); }
  }
  return html`<${Card} id="ps-link" title="Link with a PC" help=${HELP.linkPc}>
    ${link ? html`<div class="stack-sm">
        <div class="row-title"><${Icon} name="laptop" size=${18} /> ${link.name}</div>
        <p class="small muted mt0">${link.lastSyncAt ? `Last synced ${timeAgo(link.lastSyncAt)}.` : 'Not synced yet.'} ${link.state === 'unreachable' ? 'Your PC is not reachable right now; changes wait here until you are on the same Wi-Fi.' : ''}</p>
        <div class="inline-form">
          <${Button} kind="primary" icon="sync" disabled=${Boolean(busy)} onClick=${() => act('/api/phone/sync', 'sync')}>${busy === 'sync' ? 'Syncing…' : 'Sync now'}</${Button}>
          <${Button} disabled=${Boolean(busy)} onClick=${() => { if (window.confirm('Unlink this phone from your PC? Both keep their catalog; they just stop syncing.')) act('/api/phone/unlink', 'unlink'); }}>Unlink</${Button}>
        </div>
      </div>`
      : html`<div class="stack-sm">
        <p class="small muted mt0">Use DriveAtlas on your PC too? Link them once and both keep the whole catalog, syncing on your Wi-Fi.</p>
        <div><a class="btn btn-primary" href="#/link"><${Icon} name="qr" size=${17} />Link with a PC</a></div>
      </div>`}
    <${ErrorNote} error=${error} />
  </${Card}>`;
}
