'use strict';
// Reading and writing the zip files Bedrock uses (.mcpack, .mcaddon, .mcworld, .zip). Every entry name is checked
// before anything is written, and only file types a Bedrock pack or world normally holds are accepted: a .dll, .exe
// or script of any other kind makes the whole file refused.
const fs = require('node:fs');
const path = require('node:path');
const { Zip, ZipDeflate } = require('fflate');
const { inside } = require('../safepath');
const { openZip, ZipError } = require('../zipfile');

class BedrockError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const MAX_FILE = 1024 * 1024 * 1024;     // one file inside an archive
const MAX_TOTAL = 8 * 1024 * 1024 * 1024; // everything in a world archive
const PACK_MAX = { file: 256 * 1024 * 1024, total: 1024 * 1024 * 1024 }; // packs are small: much lower limits
const MAX_META = 2 * 1024 * 1024;        // manifest.json, lang, level.dat, levelname.txt
const ZIP32 = 0xfffffffe;                 // the zip writer here has no ZIP64: bigger worlds cannot be backed up

// What a pack normally holds (JSON, textures, sounds, models, shaders, functions, structures, scripts, text).
const PACK_EXT = new Set(['json', 'jsonc', 'png', 'jpg', 'jpeg', 'tga', 'lang', 'ogg', 'fsb', 'wav', 'mp3', 'mcfunction', 'mcstructure',
  'material', 'fragment', 'vertex', 'geometry', 'txt', 'md', 'js', 'mjs', 'mcmeta', 'bin', 'nbt', 'properties']);
// What a world adds: LevelDB files and the level data.
const WORLD_EXT = new Set([...PACK_EXT, 'ldb', 'log', 'dat', 'dat_old', 'old', 'sst']);
const PLAIN_NAMES = /^(license|licence|readme|notice|credits|current|lock|log|manifest-\d+|\.ds_store|thumbs\.db|desktop\.ini)$/i;
// Never reported, never written: files an archiver adds on its own.
const NOISE = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;
const DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** Lower-cased extension of the file part of an entry name ('' if none); level.dat_old gives dat_old. */
function extOf(name) {
  const base = name.split('/').pop();
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i + 1).toLowerCase();
}

/** Why an entry name must be refused ('' if fine). Names use / after normalising. */
function badName(name) {
  const n = name.replace(/\\/g, '/');
  if (!n || n.includes('\0') || /[\x00-\x1f]/.test(n)) return 'unsafe path';
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.includes(':')) return 'unsafe path';
  for (const part of n.split('/')) {
    if (part === '..') return 'unsafe path';
    if (part && (/[. ]$/.test(part) && part !== '.' || DEVICE.test(part) || /[<>"|?*]/.test(part))) return 'unsafe path';
  }
  return '';
}

/**
 * Looks at every entry of an opened zip. { files: [{ entry, name }] (names normalised, folders and noise dropped),
 * blocked: [{ name, reason }] }. allow = PACK_EXT or WORLD_EXT.
 */
function screen(zip, allow, limits = {}) {
  const maxFile = limits.file || MAX_FILE;
  const maxTotal = limits.total || MAX_TOTAL;
  const files = [];
  const blocked = [];
  let total = 0;
  for (const entry of zip.entries) {
    const name = entry.name.replace(/\\/g, '/');
    if (name.endsWith('/')) { const r = badName(name.replace(/\/+$/, '')); if (r) blocked.push({ name, reason: r }); continue; }
    if (NOISE.test(name)) continue;
    const r = badName(name);
    if (r) { blocked.push({ name, reason: r }); continue; }
    const base = name.split('/').pop();
    const ext = extOf(name);
    if (!(PLAIN_NAMES.test(base) || (ext && allow.has(ext)))) { blocked.push({ name, reason: 'not a Bedrock file type' }); continue; }
    if (entry.size > maxFile) { blocked.push({ name, reason: 'too big' }); continue; }
    total += entry.size;
    files.push({ entry, name });
  }
  if (total > maxTotal) blocked.push({ name: '(whole file)', reason: 'too big' });
  return { files, blocked, total };
}

function openArchive(file) {
  try { return openZip(file); } catch (e) {
    if (e instanceof ZipError) throw new BedrockError('BAD_ZIP', 'That file is not a readable pack or world.');
    throw e;
  }
}

/** One small entry (manifest, lang, level.dat ...): refused when it claims to be big. */
function readSmall(zip, entry) {
  if (entry.size > MAX_META) throw new BedrockError('BAD_ZIP', 'That file is not a readable pack or world.');
  return zip.read(entry);
}

/** Throws unless the disk holding dir has room for bytes (plus a margin). */
function needSpace(dir, bytes) {
  let free = Infinity;
  try {
    let d = path.resolve(dir);
    while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
    const s = fs.statfsSync(d);
    free = Number(s.bavail) * Number(s.bsize);
  } catch { /* cannot tell: go on */ }
  if (free < bytes * 1.1 + 64 * 1024 * 1024) throw new BedrockError('DISK_FULL', 'There is not enough free space on the disk.');
}

/** Writes the given files (from screen()) under dest, dropping `strip` (a folder prefix ending in /) from names. */
function extract(zip, files, dest, strip = '', onProgress = null) {
  needSpace(path.dirname(dest), files.reduce((n, f) => n + f.entry.size, 0));
  fs.mkdirSync(dest, { recursive: true });
  const total = files.filter((f) => !strip || f.name.startsWith(strip)).reduce((n, f) => n + f.entry.size, 0);
  let done = 0;
  for (const { entry, name } of files) {
    if (strip && !name.startsWith(strip)) continue;
    const rel = name.slice(strip.length);
    if (!rel) continue;
    const out = inside(dest, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, zip.read(entry));
    done += entry.size;
    if (onProgress) onProgress(done, total);
  }
}

/** Every file below dir: [{ rel, full }] with / in rel. Symbolic links are not followed or included. */
function walk(dir, base = '') {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + d.name : d.name;
    if (d.isDirectory()) out.push(...walk(path.join(dir, d.name), rel));
    else if (d.isFile()) out.push({ rel, full: path.join(dir, d.name) });
  }
  return out;
}

/** Zips the contents of dir (not dir itself) into file, streaming so a big world never sits in memory. */
function zipDir(dir, file, onProgress = null) {
  const all = walk(dir);
  let total = 0;
  for (const f of all) {
    const n = fs.statSync(f.full).size;
    total += n;
    if (n > ZIP32 || total > ZIP32) throw new BedrockError('TOO_BIG', 'This world is over 4 GB, which a backup file cannot hold here.');
  }
  needSpace(path.dirname(file), total * 0.9);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  let failure = null;
  try {
    let done = 0;
    const zip = new Zip((err, chunk) => {
      if (err) { failure = err; return; }
      fs.writeSync(fd, chunk);
    });
    for (const f of all) {
      const item = new ZipDeflate(f.rel, { level: 1 });
      zip.add(item);
      const src = fs.openSync(f.full, 'r');
      try {
        const buf = Buffer.alloc(1024 * 1024);
        for (;;) {
          const n = fs.readSync(src, buf, 0, buf.length, null);
          if (n === 0) { item.push(new Uint8Array(0), true); break; }
          item.push(new Uint8Array(buf.subarray(0, n)));
          done += n;
          if (onProgress) onProgress(done, total);
        }
      } finally { fs.closeSync(src); }
      if (failure) throw failure;
    }
    zip.end();
    if (failure) throw failure;
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.closeSync(fd); } catch { /* closed */ }
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

module.exports = { BedrockError, PACK_MAX, readSmall, needSpace, PACK_EXT, WORLD_EXT, badName, extOf, screen, openArchive, extract, walk, zipDir };
