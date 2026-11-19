'use strict';
// What is inside an instance: mods, resource packs and shader packs. Listing, installing from Modrinth (with required
// dependencies, every file checked against the SHA-512 Modrinth publishes), enabling/disabling (a ".disabled" suffix),
// removing and updating. Everything stays inside the instance folder. Azure and Fabric API are "included": they are
// shown, but can never be removed, disabled or replaced.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { download } = require('./net');
const { bestVersion, fileOf, FABRIC_API_ID } = require('./modrinth');
const { readModInfo, readPackInfo } = require('./modmeta');
const { writeJsonAtomic, readJsonSafe } = require('./atomic');

const KINDS = {
  mod: { dir: 'mods', ext: '.jar', label: 'mod' },
  resourcepack: { dir: 'resourcepacks', ext: '.zip', label: 'resource pack' },
  shader: { dir: 'shaderpacks', ext: '.zip', label: 'shader pack' },
};
const AZURE_JAR = /^(azure|aurora)-client.*\.jar$/i;
const SAFE_NAME = /^[A-Za-z0-9._+~()[\] -]{1,150}$/;

class ContentError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** A file name that cannot point anywhere but the folder it is put in. */
function safeFileName(name) {
  const base = path.basename(String(name));
  if (base !== name || !SAFE_NAME.test(base) || base.includes('..') || base.startsWith('.')) throw new ContentError('BAD_NAME', 'That file name is not allowed.');
  return base;
}

const sha512Of = (file) => crypto.createHash('sha512').update(fs.readFileSync(file)).digest('hex');

class Content {
  /** instance: the launcher's instance record ({ mcVersion, loader, azure, mods }); client: a ModrinthClient. */
  constructor({ gameDir, instance, client, log = () => {}, allowedHosts = ['cdn.modrinth.com'] }) {
    this.allowedHosts = allowedHosts;
    this.gameDir = path.resolve(gameDir);
    this.instance = instance;
    this.client = client;
    this.log = log;
    this.manifestPath = path.join(this.gameDir, '.azure-launcher', 'content.json');
    this.manifest = this.#load();
  }

  #load() {
    // damaged: kept aside as <file>.broken-<time>; missing or locked: empty for now
    const r = readJsonSafe(this.manifestPath, (m) => m && typeof m.items === 'object' && !Array.isArray(m.items));
    return r.value || { items: {} };
  }

  save() {
    fs.mkdirSync(path.dirname(this.manifestPath), { recursive: true });
    writeJsonAtomic(this.manifestPath, this.manifest);
  }

  /** The loader Modrinth searches use for this instance (mods only). */
  get loader() { return this.instance.loader || null; }

  dir(kind) {
    if (!KINDS[kind]) throw new ContentError('BAD_KIND', 'Unknown content type.');
    const d = path.resolve(this.gameDir, KINDS[kind].dir);
    if (path.dirname(d) !== this.gameDir) throw new ContentError('BAD_KIND', 'Bad folder.');
    return d;
  }

  key(kind, base) { return kind + '/' + base; }

  isLocked(kind, base, info) {
    if (kind !== 'mod') return false;
    if (AZURE_JAR.test(base)) return true;
    if (info && (info.id === 'aurora' || info.id === 'fabric-api')) return true;
    return (this.instance.mods || []).some((m) => m.locked && m.file === base);
  }

  /** Everything in the instance, by kind. Reads each file's own information when the launcher has none. */
  list() {
    const out = { mod: [], resourcepack: [], shader: [] };
    for (const kind of Object.keys(KINDS)) {
      const dir = this.dir(kind);
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const disabled = entry.name.endsWith('.disabled');
        const base = disabled ? entry.name.slice(0, -'.disabled'.length) : entry.name;
        if (entry.isDirectory()) {
          if (kind !== 'mod') out[kind].push({ kind, file: entry.name, base, enabled: !disabled, name: base, version: '', icon: null, source: 'local', locked: false, folder: true });
          continue;
        }
        if (!base.toLowerCase().endsWith(KINDS[kind].ext)) continue;
        const rec = this.manifest.items[this.key(kind, base)] || null;
        const full = path.join(dir, entry.name);
        let info = null;
        if (kind === 'mod') info = readModInfo(full);
        else if (!rec || !rec.icon) info = readPackInfo(full);
        const locked = this.isLocked(kind, base, info);
        out[kind].push({
          kind, file: entry.name, base, enabled: !disabled, locked,
          name: (rec && rec.name) || (info && info.name) || base.replace(/\.(jar|zip)$/i, ''),
          version: (rec && rec.versionNumber) || (info && info.version) || '',
          icon: (rec && rec.icon) || (info && info.icon) || null,
          source: rec && rec.source === 'modrinth' ? 'modrinth' : 'local',
          projectId: rec ? rec.projectId || null : null,
          modId: info ? info.id || null : null,
          loader: info ? info.loader || null : null,
          size: fs.statSync(full).size,
        });
      }
      out[kind].sort((a, b) => Number(b.locked) - Number(a.locked) || a.name.localeCompare(b.name));
    }
    // What the launcher adds itself shows up as "included" even before the first launch has put the files there.
    const have = new Set(out.mod.map((m) => m.base));
    const virtual = (base, name) => ({ kind: 'mod', file: '', base, enabled: true, locked: true, virtual: true, name, version: '', icon: null, source: 'included', projectId: null, modId: null, loader: 'fabric', size: 0 });
    if (this.instance.azure && !out.mod.some((m) => AZURE_JAR.test(m.base))) out.mod.unshift(virtual('azure-client', 'Azure Client'));
    for (const m of this.instance.mods || []) if (m.locked && !have.has(m.file)) out.mod.splice(1, 0, virtual(m.file, m.name || m.file));
    return out;
  }

  #find(kind, base) {
    const dir = this.dir(kind);
    safeFileName(base);
    for (const name of [base, base + '.disabled']) {
      const full = path.join(dir, name);
      if (fs.existsSync(full)) return { full, name, disabled: name.endsWith('.disabled') };
    }
    return null;
  }

  /** Turns a file on or off by renaming it (.disabled). Included files cannot be touched. */
  toggle(kind, base) {
    const f = this.#find(kind, base);
    if (!f) throw new ContentError('NOT_FOUND', 'That file is gone.');
    if (this.isLocked(kind, base, kind === 'mod' ? readModInfo(f.full) : null)) throw new ContentError('LOCKED', 'This one is included with the instance and cannot be turned off.');
    const next = f.disabled ? f.full.slice(0, -'.disabled'.length) : f.full + '.disabled';
    if (fs.existsSync(next)) throw new ContentError('EXISTS', 'A file with that name already exists.');
    fs.renameSync(f.full, next);
    return !f.disabled ? false : true; // the new enabled state
  }

  remove(kind, base) {
    const f = this.#find(kind, base);
    if (!f) throw new ContentError('NOT_FOUND', 'That file is gone.');
    if (this.isLocked(kind, base, kind === 'mod' ? readModInfo(f.full) : null)) throw new ContentError('LOCKED', 'This one is included with the instance and cannot be removed.');
    fs.rmSync(f.full, { force: true });
    delete this.manifest.items[this.key(kind, base)];
    this.save();
  }

  #projectsInstalled(kind) {
    const out = new Set();
    for (const [k, v] of Object.entries(this.manifest.items)) {
      if (k.startsWith(kind + '/') && v.projectId && this.#find(kind, k.slice(kind.length + 1))) out.add(v.projectId);
    }
    return out;
  }

  /** What installing a project would do: the file for this instance and every required mod it needs. */
  async plan(kind, projectId, { versionId } = {}) {
    const mc = this.instance.mcVersion;
    const loader = kind === 'mod' ? this.loader : null;
    if (kind === 'mod' && !loader) throw new ContentError('NO_LOADER', 'This version has no Fabric, so mods are off.');
    const have = this.#projectsInstalled(kind);
    const lockedProjects = new Set();
    if ((this.instance.mods || []).some((m) => m.locked && /^fabric-api/i.test(m.file))) lockedProjects.add(FABRIC_API_ID);
    if (lockedProjects.has(projectId)) throw new ContentError('INCLUDED', 'Fabric API is already included with this instance.');
    const entries = [];
    const missing = [];
    const seen = new Set();
    const queue = [{ projectId, versionId, root: true }];
    while (queue.length && entries.length < 30) {
      const { projectId: pid, versionId: vid, root } = queue.shift();
      if (seen.has(pid)) continue;
      seen.add(pid);
      const version = vid ? await this.client.version(vid) : bestVersion(await this.client.versionsFor(pid, { mc, loader }));
      if (!version) {
        if (root) throw new ContentError('NO_VERSION', 'No version of this fits Minecraft ' + mc + (loader ? ' with ' + loader[0].toUpperCase() + loader.slice(1) : '') + '.');
        missing.push(pid);
        continue;
      }
      const file = fileOf(version);
      if (!file) throw new ContentError('NO_FILE', 'Modrinth has no safe download for this one.');
      entries.push({ projectId: version.project_id, versionId: version.id, versionNumber: version.version_number, file, required: !root });
      if (kind === 'mod') {
        for (const dep of version.dependencies || []) {
          if (dep.dependency_type !== 'required' || !dep.project_id) continue;
          if (lockedProjects.has(dep.project_id) || have.has(dep.project_id) || seen.has(dep.project_id)) continue;
          queue.push({ projectId: dep.project_id, versionId: dep.version_id || undefined });
        }
      }
    }
    const projects = await this.client.projects([...new Set(entries.map((e) => e.projectId))]);
    const byId = new Map(projects.map((p) => [p.id, p]));
    for (const e of entries) {
      const p = byId.get(e.projectId);
      e.name = p ? p.title : e.file.filename;
      e.icon = p ? p.icon_url || null : null;
    }
    return { entries, missing };
  }

  /** Files come only from Modrinth's file host (tests may allow their own local one). */
  #checkHost(url) {
    let u;
    try { u = new URL(url); } catch { throw new ContentError('BAD_URL', 'Bad download address.'); }
    if (!this.allowedHosts.includes(u.hostname) || (u.protocol !== 'https:' && u.hostname !== '127.0.0.1')) throw new ContentError('BAD_URL', 'Downloads are only allowed from ' + this.allowedHosts[0] + '.');
  }

  /** Downloads a plan. Each file is checked against its SHA-512; a file that does not match is not kept. */
  async apply(kind, entries, { onProgress = () => {} } = {}) {
    const dir = this.dir(kind);
    fs.mkdirSync(dir, { recursive: true });
    let n = 0;
    for (const e of entries) {
      const name = safeFileName(e.file.filename);
      const dest = path.join(dir, name);
      const known = this.manifest.items[this.key(kind, name)];
      const present = fs.existsSync(dest) || fs.existsSync(dest + '.disabled');
      if (present && (!known || known.projectId !== e.projectId)) {
        throw new ContentError('EXISTS', 'You already have a different file named ' + name + '. Remove or rename it first.');
      }
      this.#checkHost(e.file.url);
      onProgress('Downloading ' + e.name + ' (' + (++n) + '/' + entries.length + ')');
      const target = fs.existsSync(dest + '.disabled') && !fs.existsSync(dest) ? dest + '.disabled' : dest;
      await download(e.file.url, target, { sha512: e.file.sha512 });
      // an older file of the same project is replaced
      for (const [k, v] of Object.entries(this.manifest.items)) {
        if (k.startsWith(kind + '/') && v.projectId === e.projectId && k !== this.key(kind, name)) {
          const old = k.slice(kind.length + 1);
          const f = this.#find(kind, old);
          if (f) fs.rmSync(f.full, { force: true });
          delete this.manifest.items[k];
        }
      }
      this.manifest.items[this.key(kind, name)] = {
        source: 'modrinth', projectId: e.projectId, versionId: e.versionId, versionNumber: e.versionNumber, name: e.name, icon: e.icon,
        sha512: e.file.sha512, required: !!e.required, addedAt: new Date().toISOString(),
      };
      this.save();
    }
  }

  async install(kind, projectId, opts = {}) {
    const plan = await this.plan(kind, projectId, opts);
    await this.apply(kind, plan.entries, opts);
    return plan;
  }

  /** Which installed items have a newer version for this instance (Modrinth's own check, by file hash). */
  async checkUpdates() {
    const items = [];
    const all = this.list();
    for (const kind of Object.keys(KINDS)) {
      for (const it of all[kind]) {
        if (it.locked || it.folder) continue;
        const rec = this.manifest.items[this.key(kind, it.base)];
        if (!rec || rec.source !== 'modrinth' || !rec.versionId) continue;
        const full = path.join(this.dir(kind), it.file);
        items.push({ kind, base: it.base, rec, hash: rec.sha512 || sha512Of(full) });
      }
    }
    const result = {};
    const loader = this.loader;
    for (const kind of Object.keys(KINDS)) {
      const group = items.filter((i) => i.kind === kind);
      if (!group.length) continue;
      const latest = await this.client.latestByHashes(group.map((g) => g.hash), { mc: this.instance.mcVersion, loader: kind === 'mod' ? loader : null });
      for (const g of group) {
        const v = latest[g.hash];
        if (v && v.id !== g.rec.versionId) result[this.key(kind, g.base)] = { kind, base: g.base, projectId: v.project_id, from: g.rec.versionNumber, to: v.version_number, versionId: v.id };
      }
    }
    return result;
  }

  /** Updates one item (or the ones given): installs the new version with its dependencies, then removes the old file. */
  async update(kind, base, update, opts = {}) {
    const plan = await this.install(kind, update.projectId, { ...opts, versionId: update.versionId });
    return plan;
  }
}

module.exports = { Content, ContentError, KINDS, safeFileName, sha512Of, AZURE_JAR };
