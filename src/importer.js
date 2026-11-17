'use strict';
// Adding files the player already has (mods as .jar, resource packs and shader packs as .zip, or a folder of them).
// Every file is untrusted: it is only read into memory (never run, never extracted), checked, and then COPIED into the
// instance. The originals are never moved or deleted, and nothing is ever overwritten.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readModInfo, readPackInfo, mcSatisfies, MAX_FILE } = require('./modmeta');
const { KINDS, AZURE_JAR, ContentError, safeFileName } = require('./content');

const MAX_WALK_FILES = 500;
const MAX_WALK_DEPTH = 3;

/** level: block (cannot be added), ask (the player must confirm), info. */
const issue = (level, text) => ({ level, text });

function sha512File(file) {
  return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('hex');
}

/** A name that is safe in the instance folder: odd characters become "_" (the original file is not renamed). */
function cleanName(name) {
  const c = String(name).replace(/[^A-Za-z0-9._+~()[\] -]/g, '_').replace(/\.\.+/g, '.').replace(/^\.+/, '_').slice(0, 150);
  return safeFileName(c);
}

/** Files and folders to look at, from whatever the player picked or dropped. */
function expand(paths) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > MAX_WALK_DEPTH || found.length >= MAX_WALK_FILES) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.(jar|zip)$/i.test(e.name)) found.push({ path: full, folder: false });
      if (found.length >= MAX_WALK_FILES) return;
    }
  };
  for (const p of paths) {
    let st;
    try { st = fs.lstatSync(p); } catch { found.push({ path: p, missing: true }); continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      const isPackFolder = fs.existsSync(path.join(p, 'pack.mcmeta')) || fs.existsSync(path.join(p, 'shaders'));
      if (isPackFolder) found.push({ path: p, folder: true });
      else walk(p, 1);
    } else found.push({ path: p, folder: false });
  }
  return found;
}

/**
 * Looks at what was picked. Returns candidates:
 * { id, fileName, kind, name, version, icon, loader, mcRange, issues, blocked, ask, modrinth, folder }.
 * content: a Content for the instance; client: a ModrinthClient (used only to recognise files by their hash).
 */
async function inspect(paths, { content, instance, client }) {
  const installed = content.list();
  const modIds = new Map(installed.mod.filter((m) => m.modId).map((m) => [m.modId, m.base]));
  const out = [];
  let n = 0;
  for (const item of expand(paths)) {
    const fileName = path.basename(item.path);
    const c = { id: n++, path: item.path, fileName, kind: null, name: fileName, version: '', icon: null, loader: null, mcRange: null, issues: [], modrinth: null, folder: !!item.folder, hash: null, modId: null };
    out.push(c);
    if (item.missing) { c.issues.push(issue('block', 'This file could not be found.')); continue; }
    const lower = fileName.toLowerCase();
    try {
      if (item.folder) {
        const hasShaders = fs.existsSync(path.join(item.path, 'shaders'));
        c.kind = hasShaders ? 'shader' : 'resourcepack';
        c.name = fileName;
        if (fs.existsSync(path.join(item.path, 'pack.png'))) c.icon = 'data:image/png;base64,' + fs.readFileSync(path.join(item.path, 'pack.png')).toString('base64');
      } else if (lower.endsWith('.jar')) {
        c.kind = 'mod';
        const info = readModInfo(item.path);
        c.name = info.name || fileName.replace(/\.jar$/i, '');
        Object.assign(c, { version: info.version || '', icon: info.icon, loader: info.loader, mcRange: info.mcRange, modId: info.id });
        if (info.error) c.issues.push(issue('block', info.error));
        else if (!info.loader) c.issues.push(issue('ask', 'No mod information found inside. It may not be a mod, or it may be for another game version.'));
        else if (info.loader !== 'fabric') c.issues.push(issue('ask', 'This mod is for ' + info.loader[0].toUpperCase() + info.loader.slice(1) + ', but this instance uses Fabric. It will not work.'));
        if (info.loader === 'fabric' && info.mcRange !== null && mcSatisfies(info.mcRange, instance.mcVersion) === false) {
          c.issues.push(issue('ask', 'This mod is made for a different Minecraft version than ' + instance.mcVersion + '.'));
        }
        if (AZURE_JAR.test(fileName) || info.id === 'aurora' || info.id === 'fabric-api' || /^fabric-api-/i.test(fileName)) {
          c.issues.push(issue('block', (info.id === 'aurora' || AZURE_JAR.test(fileName) ? 'Azure Client' : 'Fabric API') + ' is included with the instance and cannot be replaced or added twice.'));
        } else if (info.id && modIds.has(info.id)) {
          c.issues.push(issue('ask', 'A mod with the same id (' + info.id + ') is already installed (' + modIds.get(info.id) + ').'));
        }
        if (!instance.loader) c.issues.push(issue('block', 'Mods are off for this instance (no Fabric for this version).'));
      } else if (lower.endsWith('.zip')) {
        const info = readPackInfo(item.path);
        c.kind = info.kind || 'resourcepack';
        c.name = fileName.replace(/\.zip$/i, '');
        c.icon = info.icon;
        c.version = info.packFormat ? 'pack format ' + info.packFormat : '';
        if (info.error) c.issues.push(issue('block', info.error));
        else if (!info.kind) c.issues.push(issue('ask', 'This zip does not look like a resource pack or a shader pack.'));
      } else {
        c.issues.push(issue('block', 'Only .jar mods and .zip packs can be added.'));
        continue;
      }
      // never overwrite: a file with this name is already in the instance
      const dest = path.join(content.dir(c.kind), cleanName(fileName));
      if (fs.existsSync(dest) || fs.existsSync(dest + '.disabled')) c.issues.push(issue('block', 'A file with this name is already in the instance.'));
      if (!item.folder && fs.statSync(item.path).size > MAX_FILE) c.issues.push(issue('block', 'This file is too large.'));
      if (!item.folder && !c.issues.some((i) => i.level === 'block')) c.hash = sha512File(item.path);
    } catch (e) {
      c.issues.push(issue('block', 'This file could not be read.'));
    }
  }
  // recognise files Modrinth knows, by their hash (nothing else about the file is sent)
  const hashed = out.filter((c) => c.hash);
  if (hashed.length && client) {
    try {
      const known = await client.versionsByHashes([...new Set(hashed.map((c) => c.hash))]);
      const ids = [...new Set(Object.values(known).map((v) => v.project_id))];
      const projects = new Map((await client.projects(ids)).map((p) => [p.id, p]));
      for (const c of hashed) {
        const v = known[c.hash];
        if (!v) continue;
        const p = projects.get(v.project_id);
        c.modrinth = { projectId: v.project_id, versionId: v.id, versionNumber: v.version_number, name: p ? p.title : c.name, icon: p ? p.icon_url || null : null };
      }
    } catch { /* offline or busy: the files are simply treated as local files */ }
  }
  for (const c of out) {
    c.blocked = c.issues.some((i) => i.level === 'block');
    c.ask = !c.blocked && c.issues.some((i) => i.level === 'ask');
  }
  return out;
}

/** Copies the chosen candidates into the instance (the player confirmed the ones that needed asking). */
function add(candidates, ids, { content }) {
  const added = [];
  const skipped = [];
  for (const c of candidates) {
    if (!ids.includes(c.id)) continue;
    if (c.blocked) { skipped.push({ name: c.fileName, reason: c.issues.find((i) => i.level === 'block').text }); continue; }
    const dir = content.dir(c.kind);
    fs.mkdirSync(dir, { recursive: true });
    const name = cleanName(c.fileName);
    const dest = path.join(dir, name);
    if (path.dirname(path.resolve(dest)) !== path.resolve(dir)) { skipped.push({ name: c.fileName, reason: 'Bad file name.' }); continue; }
    try {
      if (c.folder) {
        const src = path.resolve(c.path);
        if (path.resolve(content.gameDir).startsWith(src + path.sep) || src === path.resolve(content.gameDir)) throw new ContentError('BAD_FOLDER', 'That folder contains the instance itself.');
        fs.cpSync(src, dest, { recursive: true, errorOnExist: true, force: false, dereference: false, filter: (s) => !fs.lstatSync(s).isSymbolicLink() });
      } else {
        fs.copyFileSync(c.path, dest, fs.constants.COPYFILE_EXCL); // a copy, and never over an existing file
      }
    } catch (e) {
      skipped.push({ name: c.fileName, reason: e.code === 'EEXIST' ? 'A file with this name is already in the instance.' : 'Could not copy it.' });
      continue;
    }
    content.manifest.items[content.key(c.kind, name)] = c.modrinth
      ? { source: 'modrinth', projectId: c.modrinth.projectId, versionId: c.modrinth.versionId, versionNumber: c.modrinth.versionNumber, name: c.modrinth.name, icon: c.modrinth.icon, sha512: c.hash, addedAt: new Date().toISOString() }
      : { source: 'local', name: c.name, sha512: c.hash || null, addedAt: new Date().toISOString() };
    added.push({ name: c.modrinth ? c.modrinth.name : c.name, kind: c.kind, recognised: !!c.modrinth });
  }
  content.save();
  return { added, skipped };
}

/** Looks up what is in an instance on Modrinth (by file hash) so imported packs get names, icons and update checks. */
async function recogniseInstalled(content, client) {
  const all = content.list();
  const todo = [];
  for (const kind of Object.keys(KINDS)) {
    for (const it of all[kind]) {
      if (it.locked || it.folder || it.virtual) continue;
      if (content.manifest.items[content.key(kind, it.base)]) continue;
      todo.push({ kind, it, hash: sha512File(path.join(content.dir(kind), it.file)) });
    }
  }
  if (!todo.length) return 0;
  let known = {};
  let projects = new Map();
  try {
    known = await client.versionsByHashes([...new Set(todo.map((t) => t.hash))]);
    projects = new Map((await client.projects([...new Set(Object.values(known).map((v) => v.project_id))])).map((p) => [p.id, p]));
  } catch { return 0; }
  let n = 0;
  for (const t of todo) {
    const v = known[t.hash];
    if (!v) continue;
    const p = projects.get(v.project_id);
    content.manifest.items[content.key(t.kind, t.it.base)] = { source: 'modrinth', projectId: v.project_id, versionId: v.id, versionNumber: v.version_number, name: p ? p.title : t.it.name, icon: p ? p.icon_url || null : null, sha512: t.hash, addedAt: new Date().toISOString() };
    n++;
  }
  content.save();
  return n;
}

module.exports = { inspect, add, expand, cleanName, recogniseInstalled, sha512File, KINDS };
