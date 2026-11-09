// Where DriveAtlas keeps its data and how the hub listens.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = new Set(process.argv.slice(2));

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PORT = Number(process.env.DRIVEATLAS_PORT || 7420);
// Phase 1 listens on this PC only. Phase 2 opens it to your Wi-Fi for the phone and helpers.
export const HOST = process.env.DRIVEATLAS_HOST || '127.0.0.1';
export const DATA_DIR = process.env.DRIVEATLAS_DATA || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'DriveAtlas', 'data');
export const DB_PATH = path.join(DATA_DIR, 'driveatlas.db');
export const OPEN_WINDOW = args.has('--open');
// Started hidden (DriveAtlas.vbs): write the log to a file instead of a console.
export const BACKGROUND = args.has('--background');
export const LOG_PATH = path.join(path.dirname(DATA_DIR), 'hub.log');
export const VERSION = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;

fs.mkdirSync(DATA_DIR, { recursive: true });
