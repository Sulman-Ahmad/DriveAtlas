// Why a phone might not reach this PC: Windows treating the Wi-Fi as a public network, or Windows Firewall
// blocking Node.js (the program DriveAtlas runs in). Read-only checks, plus opening the right Windows settings page.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { APP_DIR } from './config.mjs';

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];
const PROFILE_OF = { Public: 'Public', Private: 'Private', DomainAuthenticated: 'Domain' };

function runCheck() {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [...PS_ARGS, path.join(APP_DIR, 'hub', 'ps', 'network.ps1'), '-Node', process.execPath], { windowsHide: true });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('The network check took too long.')); }, 30000);
    child.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out.replace(/^﻿/, '').trim())); } catch { reject(new Error('The network check gave no answer.')); }
    });
  });
}

const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

// Turns what Windows reports into one verdict for the networks the phone would use.
export function assess(raw, addresses = []) {
  const networks = list(raw && raw.networks).map((n) => ({ name: n.name || n.alias || 'This network', category: n.category, ipv4: list(n.ipv4) }));
  const used = networks.filter((n) => n.ipv4.some((ip) => addresses.includes(ip)));
  const home = used.length ? used : networks.filter((n) => n.ipv4.some((ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)));
  const publicNet = home.find((n) => n.category === 'Public') || null;
  const rules = list(raw && raw.rules);
  const profiles = (raw && raw.profiles) || {};
  let firewall = 'unknown';
  if (raw && raw.checked && home.length) {
    const wanted = [...new Set(home.map((n) => PROFILE_OF[n.category]).filter(Boolean))];
    const applies = (r) => r.profile === 'Any' || wanted.some((p) => String(r.profile).split(/,\s*/).includes(p));
    if (wanted.length && wanted.every((p) => profiles[p] === false)) firewall = 'off';
    else if (rules.some((r) => r.action === 'Block' && applies(r))) firewall = 'blocked';
    else if (rules.some((r) => r.action === 'Allow' && applies(r))) firewall = 'allowed';
    else firewall = 'ask';
  }
  return { network: home[0] ? home[0].name : null, publicNetwork: publicNet ? publicNet.name : null, firewall };
}

let cache = { at: 0, value: null, pending: null };
export async function networkCheck(addresses, { fresh = false } = {}) {
  if (!fresh && cache.value && Date.now() - cache.at < 15000) return assess(cache.value, addresses);
  if (!cache.pending) {
    cache.pending = runCheck().then((v) => { cache = { at: Date.now(), value: v, pending: null }; return v; })
      .catch((e) => { cache.pending = null; throw e; });
  }
  return assess(await cache.pending, addresses);
}

// Opens a Windows settings page on this PC's screen. Only these two fixed pages can be opened.
const PAGES = {
  network: ['explorer.exe', ['ms-settings:network']],
  firewall: ['control.exe', ['/name', 'Microsoft.WindowsFirewall', '/page', 'pageConfigureApps']]
};
export function openWindowsPage(name) {
  const page = PAGES[name];
  if (!page) return false;
  spawn(page[0], page[1], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  return true;
}
