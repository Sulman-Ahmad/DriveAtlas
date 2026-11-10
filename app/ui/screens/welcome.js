// First run: the introduction, then account setup (or restore). Also sign-in, and the introduction on its own page.
import { html, useState, api } from '../lib.js';
import { Icon, Field, ErrorNote } from '../components.js';
import { RestoreForm } from './restore-form.js';

export function Shell({ title, lead, children, embedded = false }) {
  const Wrap = embedded ? 'div' : 'main';
  return html`<${Wrap} class=${embedded ? 'welcome welcome-embedded' : 'welcome'}>
    <div class="welcome-card">
      <div class="brand brand-lg"><span class="brand-mark"><${Icon} name="atlas" size=${22} /></span>DriveAtlas</div>
      <h1>${title}</h1>
      <p class="muted">${lead}</p>
      ${children}
    </div>
  </${Wrap}>`;
}

const BENEFITS = [
  { icon: 'search', title: 'Find any file, on any drive', body: 'Search names across every drive you have scanned. Each result tells you which drive has the file and where you keep that drive.' },
  { icon: 'folder', title: 'See inside drives in a drawer', body: 'Browse the folders and sizes of a drive that is unplugged and put away, as if it were plugged in.' },
  { icon: 'pulse', title: 'Catch failing drives early', body: 'Health, temperature and wear for your hard drives and SSDs, with a warning before a drive gives up.' },
  { icon: 'pin', title: 'Know where every drive is', body: 'Its shelf or box, who you lent it to, and when it is due back.' },
  { icon: 'sync', title: 'Notices what changed', body: 'Plug a drive in and DriveAtlas spots what is different since last time, then asks before updating anything.' },
  { icon: 'lock', title: 'Private by design', body: 'Only names, sizes and dates are recorded, never what is inside your files. Everything stays on your PC, and backups are encrypted.' }
];

const STEPS = [
  ['Create your account', 'It stays on this PC. Nothing is sent online.'],
  ['Add your drives', 'Plug one in and pick it. Model, size, partitions and health are filled in for you.'],
  ['Scan once, search forever', 'A scan records the drive’s file list, so you can search and browse it even when it is unplugged.']
];

// The introduction itself: used before the first account and on its own page later.
export function IntroContent() {
  return html`<div class="intro">
    <div class="brand brand-lg"><span class="brand-mark"><${Icon} name="atlas" size=${22} /></span>DriveAtlas</div>
    <h1 class="intro-title">Know every drive you own, and every file on it.</h1>
    <p class="intro-lead">DriveAtlas keeps one private catalog of your USB sticks, memory cards, hard drives and SSDs. Find any file, check any drive’s health and know where each one is, even when it is unplugged and sitting in a drawer.</p>
    <ul class="intro-grid" aria-label="What DriveAtlas does">
      ${BENEFITS.map((b) => html`<li class="intro-item"><span class="tile tile-accent"><${Icon} name=${b.icon} size=${18} /></span>
        <div><strong>${b.title}</strong><p class="small muted">${b.body}</p></div></li>`)}
    </ul>
    <h2 class="intro-h2">How it works</h2>
    <ol class="intro-steps">
      ${STEPS.map(([t, d], i) => html`<li><span class="step-n" aria-hidden="true">${i + 1}</span><div><strong>${t}</strong><p class="small muted">${d}</p></div></li>`)}
    </ol>
    <p class="small muted">Look for the <span class="help-btn help-btn-static" aria-hidden="true">?</span> signs in the app: hover over or tap one to see what an option means.</p>
  </div>`;
}

// The introduction as a page inside the app (Settings > About).
export function AboutPage() {
  return html`<div class="page"><section class="card card-body intro-page"><${IntroContent} />
    <div class="form-actions"><a class="btn btn-primary" href="#/">Go to Home</a></div></section></div>`;
}

export function Setup({ state, onDone }) {
  const [mode, setMode] = useState('intro');
  if (mode === 'intro') {
    return html`<main class="welcome"><div class="welcome-card welcome-wide">
      <${IntroContent} />
      <div class="intro-actions">
        <button type="button" class="btn btn-primary" onClick=${() => setMode('fresh')}>Get started</button>
        <button type="button" class="btn btn-secondary" onClick=${() => setMode('restore')}><${Icon} name="sync" size=${16} />Restore from a backup</button>
      </div>
    </div></main>`;
  }
  if (mode === 'restore') {
    return html`<${Shell} title="Restore from a backup" lead="Moving to a new laptop? Bring back your whole catalog and account from a DriveAtlas backup file.">
      <${RestoreForm} />
      <button type="button" class="link small" onClick=${() => setMode('fresh')}>Start fresh instead</button>
    </${Shell}>`;
  }
  return html`<${CreateAccount} state=${state} onDone=${onDone} onBack=${() => setMode('intro')} onRestore=${() => setMode('restore')} />`;
}

function CreateAccount({ state, onDone, onBack, onRestore }) {
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
      <button type="button" class="link small" onClick=${onBack}>Back to the introduction</button>
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

  return html`<${Shell} title="Welcome back" lead="Every drive you own, and every file on it. Enter your password to open your catalog.">
    <form class="stack" onSubmit=${submit}>
      <${Field} label="Password" id="login-pw"><input id="login-pw" type="password" autocomplete="current-password" value=${pw} onInput=${(e) => setPw(e.target.value)} required autofocus /></${Field}>
      <${ErrorNote} error=${error} />
      <button class="btn btn-primary btn-block" type="submit" disabled=${busy}>${busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
  </${Shell}>`;
}
