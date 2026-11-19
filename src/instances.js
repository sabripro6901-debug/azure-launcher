'use strict';
// Instances: each one is a Minecraft version (Fabric or vanilla, with or without Azure) with its own game folder (mods,
// resource packs, shader packs, options, saves) and its own memory setting. Jars, libraries, assets and Java are kept
// once, in the shared game root. The list lives in one JSON file; the folders live in <root>/instances/<id>.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomic, setAsideBroken } = require('./atomic');

const RAM_MIN = 1024;
const RAM_MAX = 32768;
const SUBFOLDERS = ['mods', 'resourcepacks', 'shaderpacks', 'saves'];

class InstanceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function cleanName(input) {
  const name = String(input === undefined || input === null ? '' : input).replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/\s+/g, ' ');
  if (!name) throw new InstanceError('BAD_NAME', 'Give the instance a name.');
  if (name.length > 40) throw new InstanceError('BAD_NAME', 'Names can be up to 40 characters.');
  return name;
}

function cleanRam(input) {
  if (input === null || input === undefined || input === '') return null; // null = use the launcher's memory setting
  const n = Number(input);
  if (!Number.isFinite(n)) throw new InstanceError('BAD_RAM', 'Memory must be a number.');
  return Math.min(RAM_MAX, Math.max(RAM_MIN, Math.round(n / 256) * 256));
}

function slug(name) {
  return (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'instance').slice(0, 28);
}

/** The folder of an instance, always inside <root>/instances (the id is checked, so nothing can point elsewhere). */
function instanceDir(root, id) {
  if (!/^[a-z0-9-]{1,40}$/.test(id)) throw new InstanceError('BAD_ID', 'Bad instance id.');
  const base = path.resolve(root, 'instances');
  const dir = path.resolve(base, id);
  if (path.dirname(dir) !== base) throw new InstanceError('BAD_ID', 'Bad instance id.');
  return dir;
}

class InstanceStore {
  /** seed: the instance created on first run (the default Azure instance). */
  constructor(file, seed) {
    this.file = file;
    let saved = null;
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      setAsideBroken(file); // first run, or a damaged file: kept as instances.json.broken-<time>, never overwritten
    }
    this.items = Array.isArray(saved && saved.instances) ? saved.instances.filter((i) => i && /^[a-z0-9-]{1,40}$/.test(i.id)) : [];
    if (this.items.length === 0 && seed) {
      this.items = [{ id: 'default', ram: null, lastPlayed: null, created: new Date().toISOString(), ...seed }];
      this.#save();
    }
  }

  #save() {
    writeJsonAtomic(this.file, { instances: this.items });
  }

  list() { return this.items.map((i) => ({ ...i })); }

  get(id) {
    const i = this.items.find((x) => x.id === id);
    return i ? { ...i } : null;
  }

  #uniqueName(name, ignoreId) {
    const taken = new Set(this.items.filter((i) => i.id !== ignoreId).map((i) => i.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; ; n++) {
      const candidate = name.slice(0, 36) + ' (' + n + ')';
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  /** spec: { name, mcVersion, loaderVersion (Fabric) or null, mods, azure, ram } -> the new instance. */
  create(spec) {
    const name = this.#uniqueName(cleanName(spec.name));
    if (!/^[0-9a-zA-Z._-]{1,30}$/.test(String(spec.mcVersion))) throw new InstanceError('BAD_VERSION', 'Pick a Minecraft version.');
    let id;
    do { id = slug(name) + '-' + crypto.randomBytes(2).toString('hex'); } while (this.items.some((i) => i.id === id));
    const inst = {
      id, name, mcVersion: String(spec.mcVersion), loader: spec.loaderVersion ? 'fabric' : null, loaderVersion: spec.loaderVersion || null,
      mods: Array.isArray(spec.mods) ? spec.mods : [], azure: !!spec.azure, ram: cleanRam(spec.ram), lastPlayed: null, created: new Date().toISOString(),
    };
    this.items.push(inst);
    this.#save();
    return { ...inst };
  }

  update(id, patch) {
    const i = this.items.find((x) => x.id === id);
    if (!i) throw new InstanceError('NOT_FOUND', 'That instance no longer exists.');
    if ('name' in patch) i.name = this.#uniqueName(cleanName(patch.name), id);
    if ('ram' in patch) i.ram = cleanRam(patch.ram);
    if ('lastPlayed' in patch) i.lastPlayed = patch.lastPlayed;
    if ('playTime' in patch) i.playTime = Math.max(0, Math.round(Number(patch.playTime) || 0)); // milliseconds played in total
    if ('icon' in patch) i.icon = patch.icon === 'icon.png' ? 'icon.png' : null; // a picture in the instance folder, or the default
    this.#save();
    return { ...i };
  }

  /** The copy's record (the caller copies the folder). */
  duplicate(id) {
    const src = this.items.find((x) => x.id === id);
    if (!src) throw new InstanceError('NOT_FOUND', 'That instance no longer exists.');
    const name = this.#uniqueName(cleanName(src.name.slice(0, 33) + ' copy'));
    let newId;
    do { newId = slug(name) + '-' + crypto.randomBytes(2).toString('hex'); } while (this.items.some((i) => i.id === newId));
    const copy = { ...JSON.parse(JSON.stringify(src)), id: newId, name, lastPlayed: null, playTime: 0, created: new Date().toISOString() };
    this.items.push(copy);
    this.#save();
    return { ...copy };
  }

  /** Removes the record. There is always at least one instance. */
  remove(id) {
    if (!this.items.some((x) => x.id === id)) throw new InstanceError('NOT_FOUND', 'That instance no longer exists.');
    if (this.items.length === 1) throw new InstanceError('LAST_INSTANCE', 'Keep at least one instance. Create another one first.');
    this.items = this.items.filter((x) => x.id !== id);
    this.#save();
    return this.items[0].id; // a sensible instance to select instead
  }
}

/** Makes the instance's own folders. */
function ensureInstanceDir(root, id) {
  const dir = instanceDir(root, id);
  fs.mkdirSync(dir, { recursive: true });
  for (const s of SUBFOLDERS) fs.mkdirSync(path.join(dir, s), { recursive: true });
  return dir;
}

function copyInstanceDir(root, fromId, toId) {
  const from = instanceDir(root, fromId);
  const to = instanceDir(root, toId);
  if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true });
  else ensureInstanceDir(root, toId);
}

function deleteInstanceDir(root, id) {
  fs.rmSync(instanceDir(root, id), { recursive: true, force: true });
}

module.exports = { InstanceStore, InstanceError, instanceDir, ensureInstanceDir, copyInstanceDir, deleteInstanceDir, cleanName, cleanRam, SUBFOLDERS };
