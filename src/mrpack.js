'use strict';
// .mrpack files (Modrinth's modpack format): read one to build an instance, write one from an instance.
// A pack is untrusted input. It is only read into memory, every path is checked so nothing can land outside the
// instance folder, downloads are limited to the hosts the format allows and verified against the pack's SHA-512,
// and nothing in it is ever run. The Azure jar is never part of an export (the launcher adds it by itself).
const fs = require('node:fs');
const path = require('node:path');
const { zipSync } = require('fflate');
const { openZip } = require('./zipfile');
const { download } = require('./net');
const { AZURE_JAR } = require('./content');

const INDEX = 'modrinth.index.json';
/** The hosts the mrpack format allows downloads from. */
const ALLOWED_HOSTS = ['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com'];
const TOP_DIRS = ['mods', 'resourcepacks', 'shaderpacks', 'config'];
const MAX_FILES = 2000;
const MAX_INDEX = 5 * 1024 * 1024;
const MAX_ZIP = 400 * 1024 * 1024;
const MAX_OVERRIDES_TOTAL = 300 * 1024 * 1024;
const MAX_OVERRIDE_FILE = 150 * 1024 * 1024;
const RISKY = /\.(exe|bat|cmd|com|scr|msi|ps1|psm1|vbs|vbe|lnk|sh|jse|wsf|dll)$/i;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

class PackError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** A relative path inside the instance folder, or null if it could go anywhere else. */
function safeRel(p) {
  if (typeof p !== 'string' || !p || p.length > 260 || p.includes('\\') || p.includes('\0') || p.includes(':') || p.startsWith('/')) return null;
  const parts = p.split('/');
  if (parts.some((s) => !s || s === '.' || s === '..' || /[. ]$/.test(s) || RESERVED.test(s))) return null;
  return parts.join('/');
}

function readIndexFrom(file) {
  const size = fs.statSync(file).size;
  if (size > MAX_ZIP) throw new PackError('TOO_BIG', 'This pack is too large.');
  // Only the pack's description is read from the file, not the whole pack (AUDIT M10).
  let zip, raw;
  try {
    zip = openZip(file);
    const e = zip.entries.find((x) => x.name === INDEX && x.size <= MAX_INDEX);
    raw = e ? zip.read(e) : null;
  } catch {
    throw new PackError('BAD_PACK', 'This file is not a valid .mrpack.');
  } finally {
    if (zip) zip.close();
  }
  if (!raw) throw new PackError('BAD_PACK', 'This file is not a valid .mrpack (no modrinth.index.json).');
  let index;
  try { index = JSON.parse(raw.toString('utf8')); } catch { throw new PackError('BAD_PACK', 'The pack description is damaged.'); }
  return { index };
}

/** Checks a pack's description and returns what it contains. Nothing is downloaded or written. */
function parse(file) {
  const { index } = readIndexFrom(file);
  if (index.formatVersion !== 1 || index.game !== 'minecraft') throw new PackError('BAD_PACK', 'This is not a Minecraft modpack in the .mrpack format.');
  const deps = index.dependencies || {};
  const mc = deps.minecraft;
  if (!/^[0-9a-zA-Z._-]{1,30}$/.test(String(mc || ''))) throw new PackError('BAD_PACK', 'The pack does not say which Minecraft version it needs.');
  for (const other of ['forge', 'neoforge', 'quilt-loader']) {
    if (deps[other]) throw new PackError('LOADER', 'This pack needs ' + ({ forge: 'Forge', neoforge: 'NeoForge', 'quilt-loader': 'Quilt' })[other] + ', which this launcher does not support yet. Only Fabric and plain Minecraft packs can be imported.');
  }
  if (!Array.isArray(index.files) || index.files.length > MAX_FILES) throw new PackError('BAD_PACK', 'The pack lists too many files.');
  const files = [];
  const skipped = [];
  for (const f of index.files) {
    const rel = safeRel(f && f.path);
    if (!rel) { skipped.push({ path: String(f && f.path).slice(0, 80), reason: 'unsafe path' }); continue; }
    if (!TOP_DIRS.includes(rel.split('/')[0]) || RISKY.test(rel)) { skipped.push({ path: rel, reason: 'not a mod, pack or config file' }); continue; }
    if (f.env && f.env.client === 'unsupported') continue; // server-only file
    const sha512 = f.hashes && f.hashes.sha512;
    if (!/^[0-9a-f]{128}$/.test(sha512 || '')) { skipped.push({ path: rel, reason: 'no SHA-512 hash' }); continue; }
    const urls = (f.downloads || []).filter((u) => { try { const x = new URL(u); return x.protocol === 'https:' && ALLOWED_HOSTS.includes(x.hostname); } catch { return false; } });
    if (!urls.length) { skipped.push({ path: rel, reason: 'no download from an allowed host' }); continue; }
    if (rel.startsWith('mods/') && AZURE_JAR.test(path.posix.basename(rel))) { skipped.push({ path: rel, reason: 'Azure Client is added by the launcher' }); continue; }
    files.push({ path: rel, sha512, sha1: (f.hashes && f.hashes.sha1) || null, urls, size: Number(f.fileSize) || 0 });
  }
  if (files.some((f) => f.path.startsWith('mods/')) && !deps['fabric-loader']) throw new PackError('LOADER', 'This pack has mods but does not say which loader it uses.');
  return {
    name: String(index.name || 'Imported pack').slice(0, 40), versionId: String(index.versionId || ''), summary: String(index.summary || '').slice(0, 300),
    mc, fabricLoader: deps['fabric-loader'] || null, files, skipped,
  };
}

/** Does the pack ship its own Fabric API? Then that file is the instance's included Fabric API. */
function packFabricApi(pack) {
  const f = pack.files.find((x) => /^mods\/fabric-api-/i.test(x.path));
  return f ? { name: 'Fabric API', file: path.posix.basename(f.path), url: f.urls[0], sha512: f.sha512, locked: true } : null;
}

/** The override files inside the pack (overrides/ and client-overrides/), checked and ready to write. */
function readOverrides(file) {
  let total = 0;
  const out = [];
  const skipped = [];
  // Only the override files are read from the pack, one by one, each capped at its stated size (AUDIT M10).
  let zip;
  try {
    zip = openZip(file);
  } catch {
    throw new PackError('BAD_PACK', 'This file is not a valid .mrpack.');
  }
  try {
    for (const f of zip.entries) {
      const m = /^(client-)?overrides\/(.+)$/.exec(f.name);
      if (!m || f.name.endsWith('/')) continue;
      const rel = safeRel(m[2]);
      if (!rel || RISKY.test(rel) || !TOP_DIRS.includes(rel.split('/')[0]) && !['options.txt', 'servers.dat'].includes(rel)) { skipped.push({ path: m[2].slice(0, 80), reason: 'not allowed' }); continue; }
      if (rel.startsWith('mods/') && (AZURE_JAR.test(path.posix.basename(rel)) || /^fabric-api-/i.test(path.posix.basename(rel)))) { skipped.push({ path: rel, reason: 'Azure Client and Fabric API are managed by the launcher' }); continue; }
      if (f.size > MAX_OVERRIDE_FILE || (total += f.size) > MAX_OVERRIDES_TOTAL) throw new PackError('TOO_BIG', 'The pack carries too much extra data.');
      let bytes;
      try { bytes = new Uint8Array(zip.read(f)); } catch { throw new PackError('BAD_PACK', 'A file inside the pack is damaged.'); }
      out.push({ rel, bytes, client: !!m[1] });
    }
  } finally {
    zip.close();
  }
  out.sort((a, b) => Number(a.client) - Number(b.client)); // client overrides win
  return { overrides: out, skipped };
}

/**
 * Writes a parsed pack into an instance folder: downloads every file (SHA-512 checked, only from allowed hosts), then the
 * override files. Nothing is written outside dir.
 */
async function install(pack, file, dir, { onProgress = () => {}, fetchDownload = download } = {}) {
  const root = path.resolve(dir);
  const inside = (rel) => {
    const full = path.resolve(root, ...rel.split('/'));
    if (!full.startsWith(root + path.sep)) throw new PackError('BAD_PATH', 'A file in the pack points outside the instance.');
    return full;
  };
  let n = 0;
  for (const f of pack.files) {
    onProgress('Downloading ' + path.posix.basename(f.path) + ' (' + (++n) + '/' + pack.files.length + ')');
    let lastErr;
    let done = false;
    for (const url of f.urls) {
      try {
        await fetchDownload(url, inside(f.path), { sha512: f.sha512, tries: 2 });
        done = true;
        break;
      } catch (e) { lastErr = e; }
    }
    if (!done) throw new PackError('DOWNLOAD', 'Could not download ' + path.posix.basename(f.path) + ': ' + String(lastErr && lastErr.message).slice(0, 120));
  }
  const { overrides, skipped } = readOverrides(file);
  for (const o of overrides) {
    const full = inside(o.rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, o.bytes);
  }
  return { files: pack.files.length, overrides: overrides.length, skipped: [...pack.skipped, ...skipped] };
}

/**
 * Builds a .mrpack from an instance. items: [{ kind, base, file (path on disk), source, hash, versionId }], lookup: a function
 * hash[] -> { hash: Modrinth version } for the files Modrinth knows. Modrinth files become download entries; everything else is
 * packed into overrides/. The Azure jar is never included.
 */
async function build({ instance, items, lookup, extraFiles = [], versionId = '1.0.0' }) {
  const dirOf = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' };
  const usable = items.filter((i) => i.enabled !== false && !(i.kind === 'mod' && (AZURE_JAR.test(i.base) || i.modId === 'aurora')) && !i.virtual && !i.folder);
  const known = usable.length ? await lookup([...new Set(usable.map((i) => i.hash))]) : {};
  const files = [];
  const entries = {};
  let overrides = 0;
  for (const i of usable) {
    const rel = dirOf[i.kind] + '/' + i.base;
    const v = known[i.hash];
    const vf = v && (v.files || []).find((f) => f.hashes && f.hashes.sha512 === i.hash);
    if (vf && vf.url && new URL(vf.url).hostname === 'cdn.modrinth.com') {
      files.push({ path: rel, hashes: { sha1: vf.hashes.sha1, sha512: i.hash }, env: { client: 'required', server: 'unsupported' }, downloads: [vf.url], fileSize: vf.size || fs.statSync(i.file).size });
    } else {
      entries['overrides/' + rel] = new Uint8Array(fs.readFileSync(i.file));
      overrides++;
    }
  }
  for (const x of extraFiles) { entries['overrides/' + x.rel] = x.bytes; overrides++; }
  const index = {
    formatVersion: 1, game: 'minecraft', versionId, name: instance.name, summary: 'Exported from Azure Launcher',
    files,
    dependencies: { minecraft: instance.mcVersion, ...(instance.loader ? { 'fabric-loader': instance.loaderVersion } : {}) },
  };
  entries[INDEX] = new Uint8Array(Buffer.from(JSON.stringify(index, null, 2)));
  return { bytes: Buffer.from(zipSync(entries)), files: files.length, overrides };
}

module.exports = { parse, install, build, packFabricApi, safeRel, readOverrides, PackError, ALLOWED_HOSTS, INDEX };
