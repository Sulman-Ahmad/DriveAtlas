// The Android app's first start, unlock and linking screens.
import { html, useState, useEffect, api } from '../lib.js';
import { Icon, Field, ErrorNote } from '../components.js';
import { IntroContent, Shell } from './welcome.js';
import { RestorePanel } from './phone-backups.js';

// First start on the phone: the introduction, where the catalog lives, the PIN, then (if chosen) linking to a PC.
export function PhoneSetup({ state, onDone }) {
  const [step, setStep] = useState('intro');
  const [where, setWhere] = useState('phone');
  if (step === 'intro') {
    return html`<main class="welcome"><div class="welcome-card welcome-wide phone-card">
      <${IntroContent} />
      <div class="intro-actions"><button type="button" class="btn btn-primary btn-block" onClick=${() => setStep('where')}>Get started</button></div>
    </div></main>`;
  }
  if (step === 'where') {
    const option = (id, icon, title, body) => html`<button type="button" role="radio" aria-checked=${where === id} class=${`choice ${where === id ? 'on' : ''}`} onClick=${() => setWhere(id)}>
      <span class=${`tile ${where === id ? 'tile-solid' : 'tile-accent'}`}><${Icon} name=${icon} size=${22} /></span>
      <span class="min0"><strong>${title}</strong><span class="small muted">${body}</span></span></button>`;
    return html`<main class="welcome"><div class="welcome-card phone-card">
      <div class="brand brand-lg"><span class="brand-mark"><${Icon} name="atlas" size=${22} /></span>DriveAtlas</div>
      <h1>Where should your catalog live?</h1>
      <p class="muted">You can change your mind later: a phone catalog can be linked to a PC at any time, and nothing is lost.</p>
      <div class="stack" role="radiogroup" aria-label="Where your catalog lives">
        ${option('phone', 'phone', 'Keep my catalog on this phone', 'No PC needed. Record this phone’s storage and any USB drive or SSD you plug in, and search them anywhere.')}
        ${option('pc', 'laptop', 'Connect to DriveAtlas on my PC', 'Link with DriveAtlas on your PC. Both keep the whole catalog and sync on your Wi-Fi.')}
        ${option('restore', 'download', 'Restore from a backup', 'Bring back your catalog from a DriveAtlas backup file made on a phone or your PC.')}
      </div>
      <div class="callout callout-plain small"><${Icon} name="lock" size=${18} /><span class="grow">Next you’ll set a PIN${state.phone?.biometricAvailable ? ' and can turn on fingerprint unlock' : ''}. Only names, sizes and dates are recorded, never what is inside your files.</span></div>
      <button type="button" class="btn btn-primary btn-block" onClick=${() => setStep(where === 'restore' ? 'restore' : 'create')}>Continue</button>
      <button type="button" class="link small" onClick=${() => setStep('intro')}>Back</button>
    </div></main>`;
  }
  if (step === 'link') return html`<${PhoneLink} onDone=${onDone} onSkip=${onDone} />`;
  if (step === 'restore') {
    return html`<${Shell} title="Restore from a backup" lead="Pick a DriveAtlas backup file and type the password it was made with. Then set the PIN that opens DriveAtlas on this phone.">
      <${RestorePanel} first=${true} biometricAvailable=${Boolean(state.phone?.biometricAvailable)} onRestored=${onDone} />
      <button type="button" class="link small" onClick=${() => setStep('where')}>Back</button>
    </${Shell}>`;
  }
  return html`<${PhoneCreate} state=${state} onCreated=${where === 'pc' ? () => setStep('link') : onDone} onBack=${() => setStep('where')} />`;
}

const digits = (v) => v.replace(/\D/g, '');

function PhoneCreate({ state, onCreated, onBack }) {
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [bio, setBio] = useState(Boolean(state.phone?.biometricAvailable));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setError('');
    if (pin !== pin2) return setError('The two PINs do not match.');
    setBusy(true);
    try { await api('POST', '/api/setup', { name, pin, biometric: bio }); onCreated(); } catch (err) { setError(err.message); setBusy(false); }
  }
  return html`<${Shell} title="Set up DriveAtlas on this phone" lead="The PIN opens DriveAtlas on this phone; it never leaves the phone.">
    <form class="stack" onSubmit=${submit}>
      <${Field} label="Your name" id="ph-name"><input id="ph-name" autocomplete="name" value=${name} onInput=${(e) => setName(e.target.value)} required maxlength="60" /></${Field}>
      <${Field} label="PIN" id="ph-pin" hint="4 to 12 digits. Avoid easy ones like 1234 or 0000."><input id="ph-pin" type="password" inputmode="numeric" autocomplete="new-password" value=${pin} onInput=${(e) => setPin(digits(e.target.value))} required minlength="4" maxlength="12" /></${Field}>
      <${Field} label="PIN again" id="ph-pin2"><input id="ph-pin2" type="password" inputmode="numeric" autocomplete="new-password" value=${pin2} onInput=${(e) => setPin2(digits(e.target.value))} required minlength="4" maxlength="12" /></${Field}>
      ${state.phone?.biometricAvailable ? html`<label class="check-row" for="ph-bio"><input id="ph-bio" type="checkbox" checked=${bio} onChange=${(e) => setBio(e.target.checked)} />
        <span><strong>Unlock with fingerprint</strong><span class="small muted">Your PIN still works if the fingerprint doesn’t.</span></span></label>` : null}
      <${ErrorNote} error=${error} />
      <button class="btn btn-primary btn-block" type="submit" disabled=${busy}>${busy ? 'Setting up…' : 'Continue'}</button>
      <button type="button" class="link small" onClick=${onBack}>Back</button>
    </form>
  </${Shell}>`;
}

// Opening the app: fingerprint first (when turned on), PIN as the fallback.
export function PhoneUnlock({ state, onDone }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const bio = Boolean(state.phone?.biometric);
  async function tryBiometric() {
    setError('');
    try { await api('POST', '/api/login', { biometric: true }); onDone(); } catch (err) { setError(err.message); }
  }
  useEffect(() => { if (bio) tryBiometric(); }, []);
  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try { await api('POST', '/api/login', { pin }); onDone(); } catch (err) { setError(err.message); setPin(''); } finally { setBusy(false); }
  }
  return html`<${Shell} title="Welcome back" lead="Every drive you own, and every file on it.">
    <form class="stack" onSubmit=${submit}>
      ${bio ? html`<button type="button" class="btn btn-secondary btn-block" onClick=${tryBiometric}><${Icon} name="lock" size=${16} />Unlock with fingerprint</button>` : null}
      <${Field} label="PIN" id="ph-unlock"><input id="ph-unlock" type="password" inputmode="numeric" autocomplete="current-password" value=${pin} onInput=${(e) => setPin(digits(e.target.value))} required minlength="4" maxlength="12" /></${Field}>
      <${ErrorNote} error=${error} />
      <button class="btn btn-primary btn-block" type="submit" disabled=${busy}>${busy ? 'Unlocking…' : 'Unlock'}</button>
    </form>
  </${Shell}>`;
}

// Linking this phone with DriveAtlas on a PC: type the address and the one-time code the PC shows.
export function PhoneLink({ onDone, onBack, onSkip, embedded = false }) {
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function link(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try { await api('POST', '/api/phone/link', { address, code }); onDone(); } catch (err) { setError(err.message); setBusy(false); }
  }
  return html`<${Shell} embedded=${embedded} title="Link with your PC" lead="On your PC, open DriveAtlas, go to Settings, Phone and helper PCs, and choose Link a phone. Type what it shows here. Both must be on the same Wi-Fi.">
    <form class="stack" onSubmit=${link}>
      <${Field} label="PC address" id="ph-addr" hint="Like 192.168.1.20"><input id="ph-addr" value=${address} onInput=${(e) => setAddress(e.target.value)} inputmode="decimal" autocomplete="off" spellcheck="false" required maxlength="21" /></${Field}>
      <${Field} label="Link code" id="ph-code" hint="16 letters and numbers, valid for 2 minutes."><input id="ph-code" value=${code} onInput=${(e) => setCode(e.target.value)} autocomplete="off" autocapitalize="characters" spellcheck="false" required maxlength="24" /></${Field}>
      <${ErrorNote} error=${error} />
      <button class="btn btn-primary btn-block" type="submit" disabled=${busy}>${busy ? 'Linking and syncing…' : 'Link'}</button>
      ${onSkip ? html`<button type="button" class="btn btn-secondary btn-block" onClick=${onSkip} disabled=${busy}>Link later</button>` : null}
      ${onBack ? html`<button type="button" class="link small" onClick=${onBack}>Back</button>` : null}
    </form>
  </${Shell}>`;
}
