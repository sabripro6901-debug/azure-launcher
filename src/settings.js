'use strict';
// Launcher settings: one JSON file in the user data folder. Reading is forgiving (bad values fall back to the defaults);
// writing goes through validate() so the renderer can never store anything odd.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeJsonAtomic, readJsonSafe, setAsideBroken } = require('./atomic');

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
    autoUpdateLauncher: true, // launcher updates install themselves when nothing is running
    bedrockKeepBackups: 5,   // backups kept per Bedrock world (older ones are deleted when a new one is made); 0 = keep all
    language: 'system',      // 'system' (follows Windows), 'en' or 'fr' (AUDIT M8)
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
  // '' (the default folder) or a full path (AUDIT M9): a relative path would depend on where the launcher was started.
  if (typeof i.gameRoot === 'string' && i.gameRoot.length < 400 && !i.gameRoot.includes('\0') && (i.gameRoot === '' || require('node:path').isAbsolute(i.gameRoot))) s.gameRoot = i.gameRoot;
  if (typeof i.javaArgs === 'string' && i.javaArgs.length < 1000) s.javaArgs = i.javaArgs;
  if (Number.isFinite(i.ram)) s.ram = Math.min(BOUNDS.ram[1], Math.max(BOUNDS.ram[0], Math.round(i.ram / 256) * 256));
  if (typeof i.closeOnLaunch === 'boolean') s.closeOnLaunch = i.closeOnLaunch;
  if (typeof i.openLogOnLaunch === 'boolean') s.openLogOnLaunch = i.openLogOnLaunch;
  if (typeof i.autoUpdateLauncher === 'boolean') s.autoUpdateLauncher = i.autoUpdateLauncher;
  if (Number.isInteger(i.bedrockKeepBackups) && i.bedrockKeepBackups >= 0 && i.bedrockKeepBackups <= 100) s.bedrockKeepBackups = i.bedrockKeepBackups;
  if (['system', 'en', 'fr'].includes(i.language)) s.language = i.language;
  if (typeof i.selectedInstance === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(i.selectedInstance)) s.selectedInstance = i.selectedInstance;
  return s;
}

class SettingsStore {
  constructor(file) {
    this.file = file;
    let saved = {};
    // damaged: kept aside as settings.json.broken-<time>; missing or locked: defaults for now
    const r = readJsonSafe(file, (v) => v && typeof v === 'object' && !Array.isArray(v));
    this.unreadable = r.state === 'unreadable';
    saved = r.value || {};
    this.data = validate(saved);
  }

  get() { return { ...this.data }; }

  set(patch) {
    this.data = validate(patch, this.data);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (this.unreadable) { setAsideBroken(this.file); this.unreadable = false; } // keep a copy of what we couldn't read
    writeJsonAtomic(this.file, this.data);
    return this.get();
  }
}

module.exports = { SettingsStore, validate, splitArgs, defaults, defaultRam };
