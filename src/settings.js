'use strict';
// Launcher settings: one JSON file in the user data folder. Reading is forgiving (bad values fall back to the defaults);
// writing goes through validate() so the renderer can never store anything odd.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 4 GB on a PC with 16 GB or more (Windows reports a "16 GB" PC as about 15.9), otherwise 2 GB. */
function defaultRam(totalBytes = os.totalmem()) {
  return totalBytes >= 15 * 1024 ** 3 ? 4096 : 2048;
}

function defaults() {
  return {
    gameRoot: '',            // '' = <user data>/data
    javaArgs: '',            // extra JVM arguments
    ram: defaultRam(),       // MB
    closeOnLaunch: false,    // hide the launcher while the game runs
    openLogOnLaunch: false,  // open the logs drawer when the game starts
    selectedInstance: 'default',
  };
}

const BOUNDS = { ram: [1024, 32768] };

function splitArgs(text) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(text || ''))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

/** Keeps only known keys with the right type and range. */
function validate(input, base = defaults()) {
  const s = { ...base };
  const i = input || {};
  if (typeof i.gameRoot === 'string' && i.gameRoot.length < 400 && !i.gameRoot.includes('\0')) s.gameRoot = i.gameRoot;
  if (typeof i.javaArgs === 'string' && i.javaArgs.length < 1000) s.javaArgs = i.javaArgs;
  if (Number.isFinite(i.ram)) s.ram = Math.min(BOUNDS.ram[1], Math.max(BOUNDS.ram[0], Math.round(i.ram / 256) * 256));
  if (typeof i.closeOnLaunch === 'boolean') s.closeOnLaunch = i.closeOnLaunch;
  if (typeof i.openLogOnLaunch === 'boolean') s.openLogOnLaunch = i.openLogOnLaunch;
  if (typeof i.selectedInstance === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(i.selectedInstance)) s.selectedInstance = i.selectedInstance;
  return s;
}

class SettingsStore {
  constructor(file) {
    this.file = file;
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
    this.data = validate(saved);
  }

  get() { return { ...this.data }; }

  set(patch) {
    this.data = validate(patch, this.data);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    return this.get();
  }
}

module.exports = { SettingsStore, validate, splitArgs, defaults, defaultRam };
