// Backups and restore in the Android app: a backup password, a folder picked with Android's picker, daily
// backups when the app opens, and restoring a backup made on this phone, another phone or the PC.
import { html, useState, useEffect, api } from '../lib.js';
import { Card, Field, ErrorNote, Button, Icon } from '../components.js';
import { HELP } from '../help.js';
import { timeAgo, fmtBytes } from '/shared/format.js';

function useBackups() {
  const [b, setB] = useState(null);
  const [error, setError] = useState('');
  const load = () => api('GET', '/api/phone/backups').then((r) => { setB(r); setError(''); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  return [b, load, error];
}

function BackupPasswordForm({ first, onSaved, onCancel }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setError('');
    if (pw !== pw2) return setError('The two passwords do not match.');
    setBusy(true);
    try { await api('POST', '/api/phone/backups/password', { password: pw }); setPw(''); setPw2(''); onSaved(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return html`<form class="stack-sm" onSubmit=${submit}>
    <${Field} label=${first ? 'Backup password' : 'New backup password'} id="pb-pw" help=${HELP.phoneBackupPassword} hint="At least 8 characters. Nobody can recover it, so keep it somewhere safe.">
      <input id="pb-pw" type="password" autocomplete="new-password" value=${pw} onInput=${(e) => setPw(e.target.value)} required minlength="8" maxlength="200" /></${Field}>
    <${Field} label="Password again" id="pb-pw2"><input id="pb-pw2" type="password" autocomplete="new-password" value=${pw2} onInput=${(e) => setPw2(e.target.value)} required minlength="8" maxlength="200" /></${Field}>
    ${first ? null : html`<p class="small muted mt0">Backups made before keep their old password.</p>`}
    <${ErrorNote} error=${error} />
    <div class="inline-form">
      <button type="submit" class="btn btn-primary" disabled=${busy}>${busy ? 'Saving…' : first ? 'Set backup password' : 'Change password'}</button>
      ${onCancel ? html`<button type="button" class="btn btn-secondary" onClick=${onCancel}>Cancel</button>` : null}
    </div>
  </form>`;
}

// Both cards share one status, so a backup made now shows up in the restore list straight away.
export function PhoneBackups() {
  const [b, load, error] = useBackups();
  return [
    html`<${PhoneBackupCard} key="backup" b=${b} load=${load} loadError=${error} />`,
    html`<${PhoneRestoreCard} key="restore" files=${(b && b.files) || []} />`
  ];
}

function PhoneBackupCard({ b, load, loadError }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [changing, setChanging] = useState(false);
  async function act(fn) {
    setError(''); setMsg('');
    try { await fn(); await load(); } catch (e) { setError(e.message); }
  }
  const save = (patch) => act(() => api('PUT', '/api/phone/backups', patch));
  const choose = () => act(async () => { const r = await api('POST', '/api/phone/backups/folder'); if (r.picked) setMsg(`Backups will be saved in “${r.name}”.`); });
  async function now() {
    setBusy(true); setError(''); setMsg('Making a backup…');
    try { const r = await api('POST', '/api/phone/backups/now'); setMsg(`Backup saved: ${r.name} (${fmtBytes(r.size)}).`); await load(); } catch (e) { setError(e.message); setMsg(''); } finally { setBusy(false); }
  }
  if (!b) return html`<${Card} id="ps-backup" title="Backups" help=${HELP.phoneBackups}>${loadError ? html`<${ErrorNote} error=${loadError} />` : html`<p class="small muted mt0">Loading…</p>`}</${Card}>`;

  const last = b.recent.find((r) => r.status === 'ok');
  const failed = b.recent[0] && b.recent[0].status === 'error' ? b.recent[0] : null;
  return html`<${Card} id="ps-backup" title="Backups" help=${HELP.phoneBackups}>
    <div class="stack">
      <p class="small muted mt0">Each backup is one encrypted file holding your whole catalog. Save it off this phone, on an SD card, a USB drive or a cloud app’s folder. DriveAtlas on your PC can restore it too.</p>
      ${!b.hasPassword ? html`<${BackupPasswordForm} first=${true} onSaved=${load} />` : html`
        <div class="field">
          <span class="field-label">Backup folder</span>
          <div class="inline-form">
            <span class="grow min0">${b.folder ? html`<span class="with-icon break"><${Icon} name="folder" size=${16} /><span>${b.folder.name}</span></span>` : html`<span class="muted">Not chosen yet</span>`}</span>
            <${Button} icon="folder" onClick=${choose}>${b.folder ? 'Change…' : 'Choose folder…'}</${Button}>
          </div>
          ${b.folderLost ? html`<span class="field-hint warn-text">DriveAtlas can no longer use that folder. Choose it again.</span>` : html`<span class="field-hint">Android asks you to pick a folder once. For a cloud app, pick a folder it offers in the picker.</span>`}
        </div>
        <label class="check-row" for="pb-daily"><input id="pb-daily" type="checkbox" checked=${b.auto} disabled=${!b.folder} onChange=${(e) => save({ auto: e.target.checked })} />
          <span><strong>Back up every day</strong><span class="small muted">Made when you open DriveAtlas, at most once a day, so nothing runs in the background.</span></span></label>
        <label class="check-row" for="pb-keep"><span><strong>Keep</strong><span class="small muted">Older DriveAtlas backups in the folder are removed.</span></span>
          <select id="pb-keep" value=${b.keep} onChange=${(e) => save({ keep: Number(e.target.value) })}>${[3, 7, 14, 30].map((n) => html`<option value=${n}>${n} backups</option>`)}</select></label>
        <div class="inline-form">
          <${Button} kind="primary" icon="download" disabled=${busy || b.running || !b.folder} onClick=${now}>${busy ? 'Backing up…' : 'Back up now'}</${Button}>
          ${changing ? null : html`<button type="button" class="link small" onClick=${() => setChanging(true)}>Change backup password</button>`}
        </div>
        ${changing ? html`<${BackupPasswordForm} first=${false} onSaved=${() => { setChanging(false); setMsg('Backup password changed.'); load(); }} onCancel=${() => setChanging(false)} />` : null}
        ${msg ? html`<p class="small muted break" role="status">${msg}</p>` : null}
        <${ErrorNote} error=${error} />
        <div class="small muted">${last ? `Last backup ${timeAgo(last.created_at)} (${fmtBytes(last.size)}).` : 'No backup yet.'}
          ${failed ? html` <span class="warn-text">The latest backup failed: ${failed.error}</span>` : null}</div>`}
    </div>
  </${Card}>`;
}

function PhoneRestoreCard({ files }) {
  const [done, setDone] = useState(null);
  return html`<${Card} id="ps-restore" title="Restore from a backup" help=${HELP.phoneRestore}>
    ${done ? html`<p class="small" role="status">Restored ${done.drives} drives and ${done.files.toLocaleString()} files. DriveAtlas is reopening…</p>`
      : html`<${RestorePanel} files=${files} onRestored=${(r) => { setDone(r); setTimeout(() => { location.hash = '#/'; location.reload(); }, 1500); }} />`}
  </${Card}>`;
}

const digits = (v) => v.replace(/\D/g, '');

// Picking a backup file, its password and (on first start) the PIN for this phone.
export function RestorePanel({ first = false, biometricAvailable = false, files = [], onRestored }) {
  const [picked, setPicked] = useState(null);
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [bio, setBio] = useState(Boolean(biometricAvailable));
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  async function pick(uri) {
    setError(''); setBusy('Reading the backup…');
    try {
      const r = await api('POST', '/api/phone/restore/pick', uri ? { uri } : {});
      if (r.picked) { setPicked(r); setPassword(''); }
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  }
  async function restore(e) {
    e.preventDefault();
    setError('');
    if (first && pin !== pin2) return setError('The two PINs do not match.');
    if (!first && !window.confirm('Replace the catalog on this phone with this backup? Drives and scans recorded on this phone since that backup was made will be gone. If this phone is linked with a PC, link it again afterwards.')) return;
    setBusy('Opening the backup…');
    try { const r = await api('POST', '/api/phone/restore', { password, pin, biometric: bio }); onRestored(r); } catch (err) { setError(err.message); setBusy(''); }
  }
  return html`<div class="stack">
    ${picked ? null : html`
      ${files.length ? html`<div class="stack-sm">
        <span class="field-label">In your backup folder</span>
        ${files.slice(0, 5).map((f) => html`<div class="row row-flat">
          <span class="tile tile-accent"><${Icon} name="file" size=${18} /></span>
          <div class="grow min0"><div class="row-title break">${f.name}</div><div class="small muted">${[f.modified ? timeAgo(f.modified) : null, f.size ? fmtBytes(f.size) : null].filter(Boolean).join(' · ')}</div></div>
          <${Button} disabled=${Boolean(busy)} onClick=${() => pick(f.uri)}>Restore…</${Button}>
        </div>`)}
      </div>` : null}
      <div><${Button} kind=${files.length ? 'secondary' : 'primary'} icon="folder" disabled=${Boolean(busy)} onClick=${() => pick(null)}>Choose a backup file…</${Button}></div>
      <p class="small muted mt0">Backups end in .dabackup. Pick one from this phone, an SD card, a USB drive, or a cloud app such as Google Drive.</p>`}
    ${picked ? html`<form class="stack" onSubmit=${restore}>
      <div class="row row-flat">
        <span class="tile tile-accent"><${Icon} name="file" size=${18} /></span>
        <div class="grow min0"><div class="row-title break">${picked.name}</div>
          <div class="small muted">${[picked.created ? `Made ${new Date(picked.created).toLocaleString()}` : null, picked.size ? fmtBytes(picked.size) : null].filter(Boolean).join(' · ')}</div></div>
        <button type="button" class="link small nowrap" onClick=${() => { setPicked(null); setError(''); }} disabled=${Boolean(busy)}>Other file</button>
      </div>
      <${Field} label="Backup password" id="rs-pw" help=${HELP.backupPassword}><input id="rs-pw" type="password" autocomplete="current-password" value=${password} onInput=${(e) => setPassword(e.target.value)} required maxlength="200" /></${Field}>
      ${first ? html`
        <${Field} label="PIN for this phone" id="rs-pin" hint="4 to 12 digits. It opens DriveAtlas on this phone."><input id="rs-pin" type="password" inputmode="numeric" autocomplete="new-password" value=${pin} onInput=${(e) => setPin(digits(e.target.value))} required minlength="4" maxlength="12" /></${Field}>
        <${Field} label="PIN again" id="rs-pin2"><input id="rs-pin2" type="password" inputmode="numeric" autocomplete="new-password" value=${pin2} onInput=${(e) => setPin2(digits(e.target.value))} required minlength="4" maxlength="12" /></${Field}>
        ${biometricAvailable ? html`<label class="check-row" for="rs-bio"><input id="rs-bio" type="checkbox" checked=${bio} onChange=${(e) => setBio(e.target.checked)} />
          <span><strong>Unlock with fingerprint</strong><span class="small muted">Your PIN still works if the fingerprint doesn’t.</span></span></label>` : null}` : null}
      <${ErrorNote} error=${error} />
      <button type="submit" class=${first ? 'btn btn-primary btn-block' : 'btn btn-primary'} disabled=${Boolean(busy)}>${busy || 'Restore'}</button>
    </form>` : html`${busy ? html`<p class="small muted" role="status">${busy}</p>` : null}<${ErrorNote} error=${error} />`}
  </div>`;
}
