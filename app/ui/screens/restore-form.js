// Restore from a backup file. Used on the first screen and in Settings.
import { html, useState, api } from '../lib.js';
import { Field, ErrorNote, Icon } from '../components.js';
import { HELP } from '../help.js';

// Waits for the hub to come back after it restarts, then reloads the window.
async function waitForHub() {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { const r = await fetch('/api/state', { credentials: 'same-origin' }); if (r.ok) { location.hash = '#/'; location.reload(); return; } } catch { /* still restarting */ }
  }
}

export function RestoreForm({ needsCurrentPassword = false }) {
  const [file, setFile] = useState(null);
  const [path, setPath] = useState('');
  const [pw, setPw] = useState('');
  const [current, setCurrent] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);

  async function pick() {
    setError('');
    try { const r = await api('POST', '/api/pick', { kind: 'backup' }); if (r.path) { setPath(r.path); setFile(null); } } catch (e) { setError(e.message); }
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!file && !path) return setError('Choose a backup file first.');
    try {
      let uploadId;
      if (file) {
        setBusy('Uploading the backup…');
        const res = await fetch('/api/restore/upload', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', 'X-DriveAtlas': '1' }, body: file });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || 'The upload did not finish.');
        uploadId = j.uploadId;
      }
      setBusy('Checking the password and the backup…');
      const r = await api('POST', '/api/restore', { uploadId, path: uploadId ? undefined : path, password: pw, currentPassword: needsCurrentPassword ? current : undefined });
      setDone(r);
      setBusy('Restored. DriveAtlas is restarting…');
      waitForHub();
    } catch (err) {
      setError(err.message);
      setBusy('');
    }
  }

  if (done) {
    return html`<div class="stack-sm" role="status">
      <strong>Backup restored: ${done.drives} drive${done.drives === 1 ? '' : 's'} for ${done.owner}.</strong>
      <span class="small muted">${busy} Sign in with the password the backup was made with. Your previous catalog was kept as a safety copy.</span>
    </div>`;
  }

  return html`<form class="stack" onSubmit=${submit}>
    <div class="field">
      <span class="field-label">Backup file</span>
      <div class="inline-form">
        <input type="file" accept=".dabackup" aria-label="Backup file" onChange=${(e) => { setFile(e.target.files[0] || null); setPath(''); }} />
        <button type="button" class="btn btn-secondary" onClick=${pick}><${Icon} name="folder" size=${16} />Browse…</button>
      </div>
      <span class="field-hint">${path ? html`Chosen: <span class="mono">${path}</span>` : 'A file named like DriveAtlas-backup-2026-11-10-0930.dabackup'}</span>
    </div>
    <${Field} label="Password the backup was made with" id="rs-pw" help=${HELP.backupPassword}><input id="rs-pw" type="password" autocomplete="off" value=${pw} onInput=${(e) => setPw(e.target.value)} required maxlength="200" /></${Field}>
    ${needsCurrentPassword ? html`<${Field} label="Your current password" id="rs-cur" hint="Confirms it is you. Your current catalog is replaced, but kept as a safety copy.">
      <input id="rs-cur" type="password" autocomplete="current-password" value=${current} onInput=${(e) => setCurrent(e.target.value)} required maxlength="200" /></${Field}>` : null}
    <${ErrorNote} error=${error} />
    ${busy ? html`<p class="small muted" role="status">${busy}</p>` : null}
    <button type="submit" class="btn btn-primary" disabled=${Boolean(busy)}>Restore this backup</button>
  </form>`;
}

export { waitForHub };
