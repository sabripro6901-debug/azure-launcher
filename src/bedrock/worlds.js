'use strict';
// Worlds in a com.mojang/minecraftWorlds folder: list, back up to .mcworld, restore (a backup of the current world is
// always made first), export and import. The caller has checked that the game is closed.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { BedrockError, WORLD_EXT, screen, openArchive, extract, walk, zipDir, readSmall } = require('./archive');
const { iconUrl, versionText, compare } = require('./manifest');

const SUB = 'minecraftWorlds';

// ---------- level.dat (little-endian NBT behind an 8-byte header) ----------
function readNbt(buf) {
  let p = 0;
  const need = (n) => { if (p + n > buf.length) throw new Error('short'); };
  const str = () => { need(2); const n = buf.readUInt16LE(p); p += 2; need(n); const s = buf.toString('utf8', p, p + n); p += n; return s; };
  const payload = (t, depth) => {
    if (depth > 24) throw new Error('deep');
    switch (t) {
      case 1: need(1); return buf.readInt8(p++);
      case 2: need(2); p += 2; return buf.readInt16LE(p - 2);
      case 3: need(4); p += 4; return buf.readInt32LE(p - 4);
      case 4: need(8); p += 8; return Number(buf.readBigInt64LE(p - 8));
      case 5: need(4); p += 4; return buf.readFloatLE(p - 4);
      case 6: need(8); p += 8; return buf.readDoubleLE(p - 8);
      case 7: { need(4); const n = buf.readInt32LE(p); p += 4; if (n < 0) throw new Error('bad'); need(n); p += n; return null; }
      case 8: return str();
      case 9: {
        need(5); const it = buf.readUInt8(p); const n = buf.readInt32LE(p + 1); p += 5;
        if (n < 0 || n > 1e6) throw new Error('bad');
        const a = [];
        for (let i = 0; i < n; i++) a.push(payload(it, depth + 1));
        return a;
      }
      case 10: {
        const o = {};
        for (;;) { need(1); const tt = buf.readUInt8(p++); if (tt === 0) return o; o[str()] = payload(tt, depth + 1); }
      }
      case 11: { need(4); const n = buf.readInt32LE(p); p += 4; if (n < 0) throw new Error('bad'); need(n * 4); p += n * 4; return null; }
      case 12: { need(4); const n = buf.readInt32LE(p); p += 4; if (n < 0) throw new Error('bad'); need(n * 8); p += n * 8; return null; }
      default: throw new Error('tag');
    }
  };
  need(1);
  if (buf.readUInt8(p++) !== 10) throw new Error('root');
  str();
  return payload(10, 0);
}

/** { lastPlayed (ms), openedWith: [..], gameType } from a level.dat buffer; {} when it can't be read. */
function levelInfo(buf) {
  try {
    if (!buf || buf.length < 16) return {};
    const o = readNbt(buf.subarray(8));
    const v = Array.isArray(o.lastOpenedWithVersion) ? o.lastOpenedWithVersion.filter(Number.isInteger) : [];
    return { lastPlayed: Number.isFinite(o.LastPlayed) ? o.LastPlayed * 1000 : 0, openedWith: v, gameType: o.GameType };
  } catch { return {}; }
}

const readText = (f) => { try { return fs.readFileSync(f, 'utf8').replace(/^﻿/, '').split(/\r?\n/)[0].trim(); } catch { return ''; } };
const safeName = (s) => (String(s).replace(/[^A-Za-z0-9 _.()=+-]+/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 50) || 'world');
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const plainFolder = (f) => { const s = String(f); return !!s && !s.startsWith('.') && !/[\\/:\0]/.test(s) && !s.includes('..'); };
const dirSize = (dir) => { let n = 0; try { for (const f of walk(dir)) n += fs.statSync(f.full).size; } catch { /* partial */ } return n; };

function worldDir(profile, folder, needLevel = true) {
  if (!plainFolder(folder)) throw new BedrockError('BAD_NAME', 'That world could not be found.');
  const dir = path.join(profile.root, SUB, String(folder));
  if (!fs.existsSync(dir) || (needLevel && !fs.existsSync(path.join(dir, 'level.dat')))) throw new BedrockError('MISSING', 'That world is not there any more.');
  return dir;
}

/** Worlds of a profile, newest played first. */
function listWorlds(profile) {
  const base = path.join(profile.root, SUB);
  let names = [];
  try { names = fs.readdirSync(base); } catch { return []; }
  const out = [];
  for (const folder of names) {
    if (folder.startsWith('.')) continue;
    const dir = path.join(base, folder);
    try {
      if (!fs.statSync(dir).isDirectory() || !fs.existsSync(path.join(dir, 'level.dat'))) continue;
      let info = {};
      try { info = levelInfo(fs.readFileSync(path.join(dir, 'level.dat'))); } catch { /* unreadable level.dat */ }
      let icon = null;
      try { icon = iconUrl(fs.readFileSync(path.join(dir, 'world_icon.jpeg'))); } catch { /* none */ }
      out.push({ folder, name: readText(path.join(dir, 'levelname.txt')) || folder, lastPlayed: info.lastPlayed || 0, openedWith: info.openedWith || [], size: dirSize(dir), icon });
    } catch { /* skip an unreadable folder */ }
  }
  return out.sort((a, b) => b.lastPlayed - a.lastPlayed);
}

/** Backs a world up into backupDir (the launcher's own folder). Returns the file. */
function backup(profile, folder, backupDir, { loose = false, onProgress = null, keep = 0, protect = [] } = {}) {
  const dir = worldDir(profile, folder, !loose);
  // The name carries the time. A new backup is always newer than every earlier one of this world, even when several are
  // made within a second (then the name runs a second ahead), so the newest-first order never depends on the clock.
  let t = Date.now();
  try {
    for (const n of fs.readdirSync(backupDir)) {
      const m = n.match(/^(.+?)__(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.mcworld$/);
      if (m && m[1] === safeName(folder)) t = Math.max(t, Date.UTC(+m[2], +m[3] - 1, +m[4], +m[5], +m[6], +m[7]) + 1000);
    }
  } catch { /* no backups yet */ }
  const file = path.join(backupDir, safeName(folder) + '__' + stamp(new Date(t)) + '.mcworld');
  zipDir(dir, file, onProgress);
  // a backup that cannot be read back again is worse than none: check it before anyone relies on it
  let bad = null;
  try {
    const z = openArchive(file);
    try { const s = screen(z, WORLD_EXT); if (s.blocked.length) bad = s.blocked[0].name; } finally { z.close(); }
  } catch { bad = '(unreadable)'; }
  if (bad) { fs.rmSync(file, { force: true }); throw new BedrockError('BACKUP_BAD', 'The backup could not be checked, so nothing was changed.'); }
  if (keep >= 1) prune(backupDir, folder, keep, [path.basename(file), ...protect]);
  return file;
}

/**
 * Keeps the newest `keep` backups of one world and deletes the older ones. Never deletes a file named in protect (the one
 * just made, or the one being restored). Returns the names deleted. keep below 1 deletes nothing.
 */
function prune(backupDir, folder, keep, protect = []) {
  if (!(keep >= 1)) return [];
  let names = [];
  try { names = fs.readdirSync(backupDir); } catch { return []; }
  const mine = [];
  for (const n of names) {
    const m = n.match(/^(.+?)__(\d{8}-\d{6})\.mcworld$/);
    if (m && m[1] === safeName(folder)) mine.push({ n, t: m[2] });
  }
  mine.sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : a.n < b.n ? 1 : -1)); // newest first
  const gone = [];
  mine.slice(keep).forEach(({ n }) => {
    if (protect.includes(n)) return;
    try { fs.rmSync(path.join(backupDir, n), { force: true }); gone.push(n); } catch { /* in use: next time */ }
  });
  return gone;
}

/** Launcher backups of a profile: [{ file, fileName, folder, name, time, size }], newest first. */
function listBackups(backupDir) {
  let names = [];
  try { names = fs.readdirSync(backupDir); } catch { return []; }
  const out = [];
  for (const fileName of names) {
    const m = fileName.match(/^(.+?)__(\d{8}-\d{6})\.mcworld$/);
    if (!m) continue;
    const file = path.join(backupDir, fileName);
    try {
      const st = fs.statSync(file);
      let name = m[1];
      try {
        const zip = openArchive(file);
        try { const e = zip.entries.find((x) => x.name === 'levelname.txt'); if (e) name = zip.read(e).toString('utf8').split(/\r?\n/)[0].trim() || name; } finally { zip.close(); }
      } catch { /* keep the folder name */ }
      out.push({ file, fileName, folder: m[1], name, time: st.mtimeMs, size: st.size });
    } catch { /* skip */ }
  }
  return out.sort((a, b) => b.time - a.time);
}

/** Finds level.dat at the top of a world archive or one folder down: the prefix to strip, or null. */
function worldRoot(files) {
  const names = files.map((f) => f.name);
  if (names.includes('level.dat')) return '';
  const hit = names.find((n) => /^[^/]+\/level\.dat$/.test(n));
  return hit ? hit.slice(0, hit.indexOf('/') + 1) : null;
}

/** What an archive holds, without writing anything: { name, icon, openedWith, issues, blocked }. */
function inspectWorld(file, ctx = {}) {
  const fileName = path.basename(file);
  const out = { file, fileName, name: fileName, icon: null, openedWith: [], issues: [], blocked: false };
  const block = (t) => { out.issues.push({ level: 'block', text: t }); out.blocked = true; return out; };
  if (!/\.(mcworld|zip)$/i.test(fileName)) return block('Only .mcworld and .zip files can be added.');
  let zip;
  try { zip = openArchive(file); } catch (e) { if (e instanceof BedrockError) return block(e.message); throw e; }
  try {
    const { files, blocked } = screen(zip, WORLD_EXT);
    if (blocked.length) return block('Refused: it holds files a Bedrock world never has (' + blocked.slice(0, 3).map((b) => b.name).join(', ') + (blocked.length > 3 ? ' …' : '') + ').');
    const root = worldRoot(files);
    if (root === null) return block('No world found: there is no level.dat in it.');
    const get = (n) => { const f = files.find((x) => x.name === root + n); return f ? readSmall(zip, f.entry) : null; };
    out.root = root;
    out.name = (get('levelname.txt') || Buffer.alloc(0)).toString('utf8').replace(/^﻿/, '').split(/\r?\n/)[0].trim() || fileName.replace(/\.[^.]+$/, '');
    const icon = get('world_icon.jpeg');
    out.icon = icon ? iconUrl(icon) : null;
    out.openedWith = levelInfo(get('level.dat')).openedWith || [];
    if (ctx.gameVersion && out.openedWith.length && compare(out.openedWith, ctx.gameVersion) > 0) {
      out.issues.push({ level: 'ask', text: 'Last played on Minecraft ' + versionText(out.openedWith.slice(0, 3)) + '; you have ' + versionText(ctx.gameVersion) + '. It may not open.' });
    }
    if (ctx.existingNames && ctx.existingNames.includes(out.name)) out.issues.push({ level: 'info', text: 'A world with this name already exists. This one is added as a separate copy.' });
  } finally { zip.close(); }
  return out;
}

/** Name for a new world folder, like the game's own (random, base64-like). */
const newFolder = () => crypto.randomBytes(9).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

/** Copies a world archive in as a new world. Returns { folder, name }. */
function importWorld(profile, file, { onProgress = null } = {}) {
  const info = inspectWorld(file);
  if (info.blocked) throw new BedrockError('BLOCKED', info.issues[0].text);
  const base = path.join(profile.root, SUB);
  fs.mkdirSync(base, { recursive: true });
  const tmp = path.join(base, '.azure-tmp-' + crypto.randomBytes(5).toString('hex'));
  const zip = openArchive(file);
  try {
    const { files } = screen(zip, WORLD_EXT);
    extract(zip, files, tmp, info.root, onProgress);
    if (!fs.existsSync(path.join(tmp, 'level.dat'))) throw new BedrockError('NO_LEVEL', 'No world found: there is no level.dat in it.');
    if (!fs.existsSync(path.join(tmp, 'levelname.txt'))) fs.writeFileSync(path.join(tmp, 'levelname.txt'), info.name);
    let folder = newFolder();
    while (fs.existsSync(path.join(base, folder))) folder = newFolder();
    fs.renameSync(tmp, path.join(base, folder));
    return { folder, name: info.name };
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  } finally { zip.close(); }
}

/**
 * Puts a backup back over a world. A backup of the world as it is now is made first; if that fails nothing changes.
 * ctx: { backupDir, trash }. Returns { folder, safety } (safety = the backup just made, or null when the world was gone).
 */
function restore(profile, backupFile, folder, ctx) {
  if (!plainFolder(folder)) throw new BedrockError('BAD_NAME', 'That world could not be found.');
  const info = inspectWorld(backupFile);
  if (info.blocked) throw new BedrockError('BLOCKED', info.issues[0].text);
  const base = path.join(profile.root, SUB);
  fs.mkdirSync(base, { recursive: true });
  const target = path.join(base, folder);
  const tmp = path.join(base, '.azure-tmp-' + crypto.randomBytes(5).toString('hex'));
  const zip = openArchive(backupFile);
  let safety = null;
  try {
    const { files } = screen(zip, WORLD_EXT);
    extract(zip, files, tmp, info.root, ctx.onProgress ? (d, t) => ctx.onProgress(d, t, 'restore') : null);
    if (!fs.existsSync(path.join(tmp, 'level.dat'))) throw new BedrockError('NO_LEVEL', 'No world found: there is no level.dat in it.');
    if (fs.existsSync(target)) {
      safety = backup(profile, folder, ctx.backupDir, { loose: true, keep: ctx.keep || 0, protect: [path.basename(backupFile)], onProgress: ctx.onProgress ? (d, t) => ctx.onProgress(d, t, 'safety') : null });
      const old = path.join(base, '.azure-old-' + crypto.randomBytes(5).toString('hex'));
      fs.renameSync(target, old);
      try { fs.renameSync(tmp, target); } catch (e) { fs.renameSync(old, target); throw e; }
      try { ctx.trash(old); } catch { /* the restore worked; a leftover folder is cleaned up later */ }
    } else {
      fs.renameSync(tmp, target);
    }
    return { folder, safety };
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  } finally { zip.close(); }
}

/** Writes a world to a .mcworld file the player picked (the original world is only read). */
function exportWorld(profile, folder, dest, { onProgress = null } = {}) {
  const dir = worldDir(profile, folder);
  if (!/\.mcworld$/i.test(dest)) throw new BedrockError('BAD_NAME', 'Save it as a .mcworld file.');
  zipDir(dir, dest, onProgress);
  return dest;
}

module.exports = { prune, SUB, readNbt, levelInfo, listWorlds, backup, listBackups, inspectWorld, importWorld, restore, exportWorld, worldRoot };
