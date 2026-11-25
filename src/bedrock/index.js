'use strict';
// The Bedrock service the app talks to. It only launches the game the player already owns and manages their own
// content folders: no injection, no memory access, no changes to game files, no downloading or switching builds.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const detectMod = require('./detect');
const packs = require('./packs');
const worlds = require('./worlds');
const { BedrockError } = require('./archive');
const { runJob } = require('./jobs');
const { moveToRemoved } = require('./trash');

class Bedrock {
  /**
   * opts: backupRoot (launcher folder for world backups), trash(path) (to the recycle bin), and for tests:
   * appdata, localappdata, exec (runs a program, returns its output or null), spawn.
   */
  constructor(opts = {}) {
    this.o = opts;
    this.info = null;
  }

  async detect() {
    this.info = await detectMod.detect({ appdata: this.o.appdata, localappdata: this.o.localappdata, exec: this.o.exec });
    return this.info;
  }

  async running() { return detectMod.isRunning(this.o.exec); }

  profile(id) {
    const p = this.info && this.info.profiles.find((x) => x.id === String(id));
    if (!p) throw new BedrockError('NO_PROFILE', 'That Minecraft folder was not found. Reload the page.');
    return p;
  }

  /** Throws unless the game is closed (or could not be checked: then it is treated as running). */
  async mustBeClosed() {
    const r = await this.running();
    if (r !== false) throw new BedrockError('RUNNING', r ? 'Close Minecraft Bedrock first, then try again.' : 'Could not check whether Minecraft Bedrock is running. Close it, then try again.');
  }

  /** Removes what an interrupted add, restore or backup left behind (only our own temporary names). Not while the game runs. */
  sweep() {
    const old = Date.now() - 10 * 60 * 1000;
    const clean = (dir, re) => {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { return; }
      for (const n of names) {
        if (!re.test(n)) continue;
        const f = path.join(dir, n);
        try { if (fs.statSync(f).mtimeMs < old) fs.rmSync(f, { recursive: true, force: true }); } catch { /* in use: next time */ }
      }
    };
    for (const p of (this.info && this.info.profiles) || []) {
      for (const sub of ['minecraftWorlds', 'resource_packs', 'behavior_packs', 'skin_packs']) clean(path.join(p.root, sub), /^\.azure-(tmp|old)-/);
      clean(this.backupDir(p), /\.tmp$/);
    }
  }

  backupDir(profile) { return path.join(this.o.backupRoot, profile.id); }
  trash(p) { return (this.o.trash || ((x) => moveToRemoved(this.o.removedDir || path.join(this.o.backupRoot, '..', 'bedrock-removed'), x)))(p); }
  removedDir() { return this.o.removedDir || path.join(this.o.backupRoot, '..', 'bedrock-removed'); }
  /** How many backups of one world to keep: the setting (5 unless told otherwise); 0 means keep all. Anything unusable counts as 5. */
  keep() {
    const n = this.o.keep ? Number(this.o.keep()) : 5;
    if (n === 0) return 0;
    return n >= 1 ? Math.floor(n) : 5;
  }

  /** Opens the game the way the Start menu does (no sign-in here: the game asks for that itself). */
  async launch() {
    if (!this.info) await this.detect();
    if (!this.info.installed) throw new BedrockError('NOT_INSTALLED', 'Minecraft Bedrock is not installed.');
    if (await this.running()) throw new BedrockError('RUNNING', 'Minecraft Bedrock is already running.');
    const family = /^[A-Za-z0-9.]+_[a-z0-9]+$/.test(this.info.family) ? this.info.family : detectMod.FAMILY;
    const child = (this.o.spawn || spawn)('explorer.exe', ['shell:AppsFolder\\' + family + '!' + (/^[A-Za-z0-9._-]{1,64}$/.test(this.info.appId) ? this.info.appId : 'Game')], { detached: true, stdio: 'ignore', windowsHide: true });
    if (child && child.unref) child.unref();
    return true;
  }

  // ----- packs -----
  listPacks(id) { return packs.listInstalled(this.profile(id)); }
  inspectPacks(id, files) { return packs.inspect(files, { profile: this.profile(id), gameVersion: this.info && this.info.gameVersion }); }
  async addPacks(id, candidates, ids, onProgress) {
    await this.mustBeClosed();
    return runJob('packs', { root: this.profile(id).root, candidates, ids, removedDir: this.removedDir() }, onProgress);
  }
  async removePack(id, kind, folder) {
    await this.mustBeClosed();
    packs.remove(this.profile(id), kind, folder, { trash: (p) => this.trash(p) });
  }

  // ----- worlds (reading the list is always allowed; changing anything needs the game closed) -----
  listWorlds(id) { return runJob('worlds', { root: this.profile(id).root }); }
  listBackups(id) { return worlds.listBackups(this.backupDir(this.profile(id))); }
  async backupWorld(id, folder, onProgress) {
    await this.mustBeClosed();
    const p = this.profile(id);
    const name = await runJob('backup', { root: p.root, folder: String(folder), backupDir: this.backupDir(p), keep: this.keep() }, onProgress);
    return path.join(this.backupDir(p), name);
  }
  async exportWorld(id, folder, dest, onProgress) { await this.mustBeClosed(); return runJob('export', { root: this.profile(id).root, folder: String(folder), dest: String(dest) }, onProgress); }
  async inspectWorld(id, file) {
    const names = (await this.listWorlds(id)).map((w) => w.name);
    return worlds.inspectWorld(file, { gameVersion: this.info && this.info.gameVersion, existingNames: names });
  }
  async importWorld(id, file, onProgress) { await this.mustBeClosed(); return runJob('import', { root: this.profile(id).root, file: String(file) }, onProgress); }
  async restoreWorld(id, backupFile, folder, onProgress) {
    await this.mustBeClosed();
    const p = this.profile(id);
    const r = await runJob('restore', { root: p.root, file: String(backupFile), folder: String(folder), backupDir: this.backupDir(p), removedDir: this.removedDir(), keep: this.keep() }, onProgress);
    return { folder: r.folder, safety: r.safety ? path.join(this.backupDir(p), r.safety) : null };
  }
}

module.exports = { Bedrock, BedrockError };
