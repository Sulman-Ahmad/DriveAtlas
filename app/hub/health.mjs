// Drive health: reads Windows and smartctl data (with your permission) and keeps a history.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR, DATA_DIR } from './config.mjs';
import { httpError } from './auth.mjs';
import { listDrives, matchDisk } from './catalog.mjs';

const PS = 'powershell.exe';
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];
const ps = (name) => path.join(APP_DIR, 'hub', 'ps', name);
const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

export function findSmartctl() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const candidates = [path.join(APP_DIR, 'tools', 'smartctl.exe'), path.join(pf, 'smartmontools', 'bin', 'smartctl.exe')];
  for (const dir of String(process.env.Path || process.env.PATH || '').split(';')) if (dir.trim()) candidates.push(path.join(dir.trim(), 'smartctl.exe'));
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

// Opens a visible window that installs smartmontools with winget. You see and answer its prompts.
export function installSmartctl() {
  spawn('cmd.exe', ['/c start "Install smartmontools" winget install --id smartmontools.smartmontools -e --source winget'], {
    windowsVerbatimArguments: true, detached: true, stdio: 'ignore', windowsHide: false
  }).unref();
}

// Runs health.ps1 with administrator rights (Windows asks you first). Resolves with the raw result.
export function readHealthElevated(smartctl = findSmartctl()) {
  return new Promise((resolve, reject) => {
    const out = path.join(DATA_DIR, `.health-${crypto.randomBytes(8).toString('hex')}.json`);
    const args = [...PS_ARGS, ps('elevate.ps1'), '-Script', ps('health.ps1'), '-Out', out];
    if (smartctl) args.push('-Smartctl', smartctl);
    const child = spawn(PS, args, { windowsHide: true });
    let err = '';
    child.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
    const timer = setTimeout(() => { child.kill(); reject(httpError(504, 'Reading drive health took too long. Try again.')); }, 180000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 2) return reject(httpError(409, 'Windows asked for permission to read drive health, and it was not given. Nothing was read.'));
      try {
        const data = JSON.parse(fs.readFileSync(out, 'utf8').replace(/^\uFEFF/, ''));
        resolve(data);
      } catch {
        reject(httpError(500, `Drive health could not be read${err ? `: ${err.trim().slice(0, 200)}` : '.'}`));
      } finally {
        fs.rm(out, { force: true }, () => {});
      }
    });
  });
}

// Runs health.ps1 without asking for permission (used by the smoke test; Windows shares less this way).
export function readHealthPlain(smartctl = null) {
  return new Promise((resolve, reject) => {
    const out = path.join(DATA_DIR, `.health-${crypto.randomBytes(8).toString('hex')}.json`);
    const args = [...PS_ARGS, ps('health.ps1'), '-Out', out];
    if (smartctl) args.push('-Smartctl', smartctl);
    const child = spawn(PS, args, { windowsHide: true });
    child.on('close', () => {
      try { resolve(JSON.parse(fs.readFileSync(out, 'utf8').replace(/^\uFEFF/, ''))); } catch (e) { reject(e); } finally { fs.rm(out, { force: true }, () => {}); }
    });
  });
}

const attr = (table, ids) => { for (const id of ids) { const a = table.find((x) => x.id === id); if (a) return a; } return null; };
const rawOf = (table, ids) => { const a = attr(table, ids); const v = a ? Number(a.raw?.value) : NaN; return Number.isFinite(v) ? v : null; };

// Turns one disk's raw readings into a health summary.
export function summarize(d) {
  const out = {
    source: null, pct: null, state: null, temp: null, powerOnHours: null, powerCycles: null, tbWritten: null, tbRead: null,
    reallocated: null, pending: null, uncorrectable: null, mediaErrors: null, smartPassed: null, criticalWarning: null,
    windows: d.healthStatus || null
  };
  let smart = null;
  if (d.smart && d.smart.json) { try { smart = JSON.parse(d.smart.json); } catch { smart = null; } }

  if (smart && (smart.smart_status || smart.nvme_smart_health_information_log || smart.ata_smart_attributes)) {
    out.source = 'smartctl';
    out.smartPassed = smart.smart_status ? Boolean(smart.smart_status.passed) : null;
    out.temp = smart.temperature?.current ?? null;
    out.powerOnHours = smart.power_on_time?.hours ?? null;
    out.powerCycles = smart.power_cycle_count ?? null;
    const nv = smart.nvme_smart_health_information_log;
    if (nv) {
      out.pct = clamp(100 - (Number(nv.percentage_used) || 0));
      if (nv.available_spare != null && nv.available_spare_threshold != null && nv.available_spare <= nv.available_spare_threshold) out.pct = Math.min(out.pct, 10);
      if (nv.data_units_written != null) out.tbWritten = Math.round((nv.data_units_written * 512000) / 1e10) / 100;
      if (nv.data_units_read != null) out.tbRead = Math.round((nv.data_units_read * 512000) / 1e10) / 100;
      out.mediaErrors = nv.media_errors ?? null;
      out.criticalWarning = nv.critical_warning || null;
    }
    const table = smart.ata_smart_attributes?.table || [];
    if (table.length) {
      out.reallocated = rawOf(table, [5]);
      out.pending = rawOf(table, [197]);
      out.uncorrectable = rawOf(table, [198]);
      if (out.powerOnHours == null) out.powerOnHours = rawOf(table, [9]);
      if (out.powerCycles == null) out.powerCycles = rawOf(table, [12]);
      const lbas = rawOf(table, [241]);
      if (lbas != null && out.tbWritten == null) out.tbWritten = Math.round((lbas * 512) / 1e10) / 100;
      const isSsd = smart.rotation_rate === 0 || d.mediaType === 'SSD';
      const wear = isSsd ? attr(table, [231, 233, 177, 202, 169]) : null;
      if (wear && out.pct == null) out.pct = clamp(wear.value);
    }
    if (out.pct == null) {
      let score = 100;
      if (out.reallocated > 0) score -= Math.min(40, 5 + out.reallocated / 10);
      if (out.pending > 0) score -= Math.min(40, 10 + out.pending * 2);
      if (out.uncorrectable > 0) score -= Math.min(30, 10 + out.uncorrectable * 2);
      out.pct = clamp(Math.max(1, score));
    }
    if (out.smartPassed === false) out.pct = Math.min(out.pct, 10);
  } else if (d.reliability) {
    out.source = 'windows';
    const r = d.reliability;
    out.temp = r.temperature || null;
    out.powerOnHours = r.powerOnHours ?? null;
    out.powerCycles = r.startStopCycles ?? null;
    out.uncorrectable = r.readErrorsUncorrected ?? null;
    if (r.wear != null && d.mediaType === 'SSD') out.pct = clamp(100 - r.wear);
  } else if (d.healthStatus) {
    out.source = 'windows-basic';
  }
  out.state = stateFrom(out);
  return out;
}

function stateFrom(s) {
  const w = String(s.windows || '').toLowerCase();
  if (s.smartPassed === false || w === 'unhealthy' || (s.pct != null && s.pct < 50)) return 'bad';
  if ((s.pct != null && s.pct < 80) || s.pending > 0 || s.reallocated > 0 || s.criticalWarning || w === 'warning') return 'watch';
  if (s.pct != null || w === 'healthy') return 'good';
  return null;
}

// Saves readings for drives in your catalog and returns what changed.
export function applyHealth(db, result, liveDisks) {
  const drives = listDrives(db);
  const updated = [];
  let unmatched = 0;
  const now = Date.now();
  const insert = db.prepare(`INSERT INTO health_snapshots (id, drive_id, taken_at, source, status, health_pct, temp_c, power_on_hours, power_cycles,
    tb_written, tb_read, reallocated, pending, media_errors, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const upd = db.prepare('UPDATE drives SET health_pct = ?, health_state = ?, health_checked_at = ?, health_status = COALESCE(?, health_status) WHERE id = ?');
  for (const d of result.disks || []) {
    const live = liveDisks.find((x) => x.number === d.number);
    const drive = live && matchDisk(drives, live);
    if (!drive) { unmatched += 1; continue; }
    const s = summarize(d);
    if (!s.source) continue;
    const raw = JSON.stringify({ summary: s, smart: d.smart && d.smart.json ? d.smart.json.slice(0, 65536) : null, reliability: d.reliability || null });
    insert.run(crypto.randomUUID(), drive.id, now, s.source, s.state, s.pct, s.temp, s.powerOnHours, s.powerCycles, s.tbWritten, s.tbRead,
      s.reallocated, s.pending, s.mediaErrors ?? s.uncorrectable, raw);
    upd.run(s.pct, s.state, now, s.windows, drive.id);
    updated.push({ driveId: drive.id, name: drive.name, ...s });
  }
  return { updated, unmatched, admin: Boolean(result.admin), smartctl: Boolean(result.smartctl) };
}

export function healthHistory(db, driveId) {
  return db.prepare(`SELECT taken_at, source, status, health_pct, temp_c, power_on_hours, power_cycles, tb_written, tb_read, reallocated, pending, media_errors
    FROM health_snapshots WHERE drive_id = ? ORDER BY taken_at DESC LIMIT 60`).all(driveId);
}
