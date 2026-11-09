// First-run account setup and sign-in.
import { html, useState, api } from '../lib.js';
import { Icon, Field, ErrorNote } from '../components.js';
import { RestoreForm } from './restore-form.js';

function Shell({ title, lead, children }) {
  return html`<main class="welcome">
    <div class="welcome-card">
      <div class="brand brand-lg"><span class="brand-mark"><${Icon} name="atlas" size=${22} /></span>DriveAtlas</div>
      <h1>${title}</h1>
      <p class="muted">${lead}</p>
      ${children}
    </div>
  </main>`;
}

export function Setup({ state, onDone }) {
  const [mode, setMode] = useState('fresh');
  if (mode === 'restore') {
    return html`<${Shell} title="Restore from a backup" lead="Moving to a new laptop? Bring back your whole catalog and account from a DriveAtlas backup file.">
      <${RestoreForm} />
      <button type="button" class="link small" onClick=${() => setMode('fresh')}>Start fresh instead</button>
    </${Shell}>`;
  }
  return html`<${CreateAccount} state=${state} onDone=${onDone} onRestore=${() => setMode('restore')} />`;
}

function CreateAccount({ state, onDone, onRestore }) {
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (pw !== pw2) return setError('The two passwords do not match.');
    setBusy(true);
    try {
      await api('POST', '/api/setup', { name, password: pw });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return html`<${Shell} title="Create your account" lead="One account for all your devices. It stays on this PC; nothing is sent online.">
    <form class="stack" onSubmit=${submit}>
      <${Field} label="Your name" id="setup-name"><input id="setup-name" autocomplete="name" value=${name} onInput=${(e) => setName(e.target.value)} required maxlength="60" autofocus /></${Field}>
      <${Field} label="Password" id="setup-pw" hint="At least 8 characters. You will use it to sign in, pair your phone and open your backups. There is no reset by email, so keep it safe."><input id="setup-pw" type="password" autocomplete="new-password" value=${pw} onInput=${(e) => setPw(e.target.value)} required minlength="8" maxlength="200" /></${Field}>
      <${Field} label="Password again" id="setup-pw2"><input id="setup-pw2" type="password" autocomplete="new-password" value=${pw2} onInput=${(e) => setPw2(e.target.value)} required minlength="8" maxlength="200" /></${Field}>
      <${ErrorNote} error=${error} />
      <button class="btn btn-primary btn-block" type="submit" disabled=${busy}>${busy ? 'Creating…' : 'Create account'}</button>
      <button type="button" class="btn btn-secondary btn-block" onClick=${onRestore}><${Icon} name="sync" size=${16} />Restore from a backup</button>
      <p class="small muted">Your catalog is saved in <code>${state.dataDir}</code>.</p>
    </form>
  </${Shell}>`;
}

export function Login({ onDone }) {
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('POST', '/api/login', { password: pw });
      onDone();
    } catch (err) {
      setError(err.message);
      setPw('');
    } finally {
      setBusy(false);
    }
  }

  return html`<${Shell} title="Welcome back" lead="Enter your password to open your catalog.">
    <form class="stack" onSubmit=${submit}>
      <${Field} label="Password" id="login-pw"><input id="login-pw" type="password" autocomplete="current-password" value=${pw} onInput=${(e) => setPw(e.target.value)} required autofocus /></${Field}>
      <${ErrorNote} error=${error} />
      <button class="btn btn-primary btn-block" type="submit" disabled=${busy}>${busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
  </${Shell}>`;
}
