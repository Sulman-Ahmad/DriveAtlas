// Copies the shared interface from ../app into www/ for the Android app, using the same paths the PC hub serves:
//   /index.html  /ui/*  /vendor/*  /shared/*
//   node build-www.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '..', 'app');
const www = path.join(here, 'www');

fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(www, { recursive: true });
fs.cpSync(path.join(app, 'ui'), path.join(www, 'ui'), { recursive: true, filter: (src) => !src.includes(`${path.sep}vendor${path.sep}`) && !src.endsWith(`${path.sep}vendor`) });
fs.cpSync(path.join(app, 'ui', 'vendor'), path.join(www, 'vendor'), { recursive: true });
fs.cpSync(path.join(app, 'shared'), path.join(www, 'shared'), { recursive: true });
fs.copyFileSync(path.join(app, 'ui', 'index.html'), path.join(www, 'index.html'));

const count = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).length;
console.log(`www ready: ${count(www)} files`);
