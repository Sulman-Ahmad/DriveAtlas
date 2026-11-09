// Where DriveAtlas keeps its data and how the hub listens.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = new Set(process.argv.slice(2));
const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PORT = Number(process.env.DRIVEATLAS_PORT || 7420);
// Phase 1 listens on this PC only. Phase 2 opens it to your Wi-Fi for the phone and helpers.
export const HOST = '127.0.0.1';

// Settings that live outside the catalog (where the catalog is).
const ENV_DATA = process.env.DRIVEATLAS_DATA || null;
export const BASE_DIR = ENV_DATA ? path.dirname(path.resolve(ENV_DATA)) : path.join(LOCAL, 'DriveAtlas');
export const CONFIG_PATH = path.join(BASE_DIR, 'config.json');

export function readConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return c && typeof c === 'object' ? c : {};
  } catch {
    return {};
  }
}

export function writeConfig(patch) {
  fs.mkdirSync(BASE_DIR, { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...readConfig(), ...patch }, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

const configured = readConfig().dataDir;
export const DATA_DIR = ENV_DATA ? path.resolve(ENV_DATA)
  : (typeof configured === 'string' && path.isAbsolute(configured) ? configured : path.join(BASE_DIR, 'data'));
export const DB_PATH = path.join(DATA_DIR, 'driveatlas.db');
export const OPEN_WINDOW = args.has('--open');
export const RESTARTED = args.has('--restarted');
// Started hidden (DriveAtlas.vbs): write the log to a file instead of a console.
export const BACKGROUND = args.has('--background');
export const LOG_PATH = path.join(BASE_DIR, 'hub.log');
export const WINDOW_PROFILE = path.join(BASE_DIR, 'window');
// Test mode lets the smoke test scan a sample folder. It only switches on together with a
// separate test catalog (DRIVEATLAS_DATA), so it can never run against your real catalog.
export const TEST_MODE = process.env.DRIVEATLAS_TEST === '1' && Boolean(ENV_DATA);
export const VERSION = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;

fs.mkdirSync(DATA_DIR, { recursive: true });
