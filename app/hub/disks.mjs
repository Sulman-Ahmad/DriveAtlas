// Reads connected disks through PowerShell and watches for plug-in changes.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { APP_DIR, TEST_MODE } from './config.mjs';

const PS = 'powershell.exe';
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];
const script = (name) => path.join(APP_DIR, 'hub', 'ps', name);

function runPs(name, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(PS, [...PS_ARGS, script(name)], { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${name} timed out`)); }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) return reject(new Error(err.trim() || `${name} exited with ${code}`));
      resolve(out.replace(/^﻿/, ''));
    });
  });
}

// Disk serials from card readers belong to the reader, not the card inside it.
const WEAK_NAME = /generic|storage device|card ?reader|multi.?card|sd\/mmc|mass storage/i;
export const isWeakSerial = (disk) => disk.busType === 'USB' && WEAK_NAME.test(`${disk.friendlyName} ${disk.model}`);
export const normSerial = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const ZERO_GUID = /^\{?0{8}-0{4}-0{4}-0{4}-0{12}\}?$/;

function normalize(raw) {
  return {
    number: raw.number,
    friendlyName: raw.friendlyName || raw.model || `Disk ${raw.number}`,
    model: raw.model || '',
    manufacturer: raw.manufacturer || '',
    serial: normSerial(raw.serial),
    uniqueId: raw.uniqueId || '',
    busType: raw.busType || 'Unknown',
    size: raw.size || 0,
    partitionStyle: raw.partitionStyle || 'Unknown',
    isBoot: Boolean(raw.isBoot),
    isSystem: Boolean(raw.isSystem),
    isOffline: Boolean(raw.isOffline),
    mediaType: raw.mediaType && raw.mediaType !== 'Unspecified' ? raw.mediaType : null,
    spindleSpeed: raw.spindleSpeed || null,
    health: raw.health || null,
    reliability: raw.reliability || null,
    internal: ['NVMe', 'SATA', 'RAID', 'SAS', 'ATA', 'SCSI'].includes(raw.busType),
    partitions: (raw.partitions || []).map((p) => ({
      number: p.number,
      letter: p.letter || null,
      size: p.size || 0,
      type: p.type || '',
      gptType: (p.gptType || '').toLowerCase(),
      guid: p.guid && !ZERO_GUID.test(p.guid) ? p.guid.toLowerCase() : null,
      isActive: Boolean(p.isActive),
      label: p.label || '',
      fileSystem: p.fileSystem || null,
      capacity: p.capacity || null,
      free: p.free ?? null,
      volumeSerial: p.volumeSerial || null,
      signals: p.signals || []
    }))
  };
}

// Identity strings used to recognise the same physical drive later.
export function matchIdsFor(disk) {
  const ids = [];
  const weak = isWeakSerial(disk);
  if (!weak && disk.serial.length >= 4) ids.push(`serial:${disk.serial}`);
  for (const p of disk.partitions) {
    if (p.guid) ids.push(`pguid:${p.guid}`);
    if (p.volumeSerial) ids.push(`vol:${p.volumeSerial}:${Math.round(p.size / 1e6)}`);
    // Size-free form, so the same USB drive recorded on a phone (which sees a slightly different size) matches.
    if (p.volumeSerial) ids.push(`volserial:${p.volumeSerial}`);
  }
  return [...new Set(ids)];
}

// Stable key for a connected disk within this session (used by the interface).
export const diskKey = (disk) => matchIdsFor(disk)[0] || `n:${disk.number}:${disk.size}`;

// Test catalogs only: drives described in a file (DRIVEATLAS_DEMO_DISKS) instead of the PC's own, for demos and screenshots.
const DEMO_DISKS = TEST_MODE ? process.env.DRIVEATLAS_DEMO_DISKS || null : null;

export async function readDisks() {
  if (DEMO_DISKS) return JSON.parse(fs.readFileSync(DEMO_DISKS, 'utf8')).map(normalize);
  const out = await runPs('inventory.ps1');
  const parsed = JSON.parse(out || '[]');
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean).map(normalize);
}

// Keeps the current disk list fresh and emits 'change' with { disks, added, removed, changed }.
export class DiskWatcher extends EventEmitter {
  constructor() {
    super();
    this.disks = [];
    this.ready = false;
    this.refreshing = null;
    this.again = false;
    this.child = null;
    this.timer = null;
  }

  key(d) { return diskKey(d); }
  sig(d) { return JSON.stringify([d.size, d.partitionStyle, d.partitions.map((p) => [p.letter, p.label, p.fileSystem, p.size])]); }

  async refresh() {
    if (this.refreshing) { this.again = true; return this.refreshing; }
    this.refreshing = (async () => {
      try {
        const next = await readDisks();
        const before = new Map(this.disks.map((d) => [this.key(d), d]));
        const after = new Map(next.map((d) => [this.key(d), d]));
        const added = next.filter((d) => !before.has(this.key(d)));
        const removed = this.disks.filter((d) => !after.has(this.key(d)));
        const changed = next.filter((d) => before.has(this.key(d)) && this.sig(before.get(this.key(d))) !== this.sig(d));
        this.disks = next;
        const first = !this.ready;
        this.ready = true;
        if (first || added.length || removed.length || changed.length) this.emit('change', { disks: next, added: first ? [] : added, removed, changed, first });
      } catch (err) {
        this.emit('error', err);
      } finally {
        this.refreshing = null;
        if (this.again) { this.again = false; this.refresh(); }
      }
    })();
    return this.refreshing;
  }

  start() {
    this.refresh();
    if (DEMO_DISKS) return;
    this.spawnWatcher();
    // Safety net in case the watcher process stops: full refresh every 60 s.
    this.timer = setInterval(() => this.refresh(), 60000);
  }

  spawnWatcher() {
    const child = spawn(PS, [...PS_ARGS, script('watch.ps1')], { windowsHide: true });
    this.child = child;
    let debounce = null;
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      if (!chunk.includes('changed')) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => this.refresh(), 1200);
    });
    child.on('close', () => {
      if (this.stopped) return;
      setTimeout(() => this.spawnWatcher(), 5000);
    });
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    if (this.child) this.child.kill();
  }
}
