'use strict';
// Mod changes queued in the game's Mod Manager (or here), applied while the game is closed. The file format is shared
// with the game: <instance>/.azure-launcher/queue.json, new jars waiting in .azure-launcher/staged/, replaced or removed
// jars kept in .azure-launcher/rollback/<time>/ with an undo.json, so a change that crashes the game on start can be
// rolled back. Only ever touches the instance's mods folder and its .azure-launcher folder.
const fs = require('node:fs');
const path = require('node:path');

const DIR = '.azure-launcher';
const SAFE = /^[^/\\:*?"<>|\x00-\x1f]{1,180}\.jar$/i;
const OPS = new Set(['add', 'remove', 'update', 'enable', 'disable']);

const dirOf = (gameDir) => path.join(gameDir, DIR);
const safeName = (n) => typeof n === 'string' && SAFE.test(n) && !n.includes('..');
const locked = (n) => /^(azure-client|aurora-client|fabric-api)/i.test(n);

/** A path inside dir, or throws (nothing can point outside it). */
function inside(dir, name) {
  const base = path.resolve(dir);
  const p = path.resolve(base, name);
  if (path.dirname(p) !== base) throw new Error('outside the folder: ' + name);
  return p;
}

function valid(e) {
  if (!e || !OPS.has(e.op) || !safeName(e.file) || locked(e.file)) return false;
  if (e.oldFile != null && (!safeName(e.oldFile) || locked(e.oldFile))) return false;
  if (e.staged != null && !safeName(e.staged)) return false;
  if ((e.op === 'add' || e.op === 'update') && !e.staged) return false;
  if (e.op === 'update' && !e.oldFile) return false;
  return true;
}

/** The queued changes (invalid ones are dropped). */
function read(gameDir) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(dirOf(gameDir), 'queue.json'), 'utf8'));
    return Array.isArray(o.changes) ? o.changes.filter(valid) : [];
  } catch {
    return [];
  }
}

function write(gameDir, list) {
  const f = path.join(dirOf(gameDir), 'queue.json');
  if (!list.length) { fs.rmSync(f, { force: true }); return; }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + '.tmp', JSON.stringify({ version: 1, changes: list }, null, 2));
  fs.renameSync(f + '.tmp', f);
}

function describe(e) {
  const n = e.name || e.file;
  switch (e.op) {
    case 'add': return 'Installed ' + n + (e.newVersion ? ' ' + e.newVersion : '');
    case 'remove': return 'Removed ' + n;
    case 'update': return 'Updated ' + n + (e.oldVersion ? ' ' + e.oldVersion : '') + ' -> ' + (e.newVersion || '');
    case 'enable': return 'Turned on ' + n;
    case 'disable': return 'Turned off ' + n;
    default: return n;
  }
}

/** Takes one change back (deletes its staged download). */
function undo(gameDir, id) {
  const list = read(gameDir);
  for (const e of list) if (e.id === id && e.staged) fs.rmSync(inside(path.join(dirOf(gameDir), 'staged'), e.staged), { force: true });
  write(gameDir, list.filter((e) => e.id !== id));
}

/**
 * Applies the queue to modsDir (game closed). Returns { done, failed, entries, rollback } or null when nothing was
 * queued. Writes applied.json for the in-game toast.
 */
function apply(gameDir, modsDir) {
  const list = read(gameDir);
  if (!list.length) return null;
  const staged = path.join(dirOf(gameDir), 'staged');
  const rollback = path.join(dirOf(gameDir), 'rollback', new Date().toISOString().replace(/:/g, '-'));
  fs.mkdirSync(rollback, { recursive: true });
  fs.mkdirSync(modsDir, { recursive: true });
  const undoSteps = [];
  const done = [];
  const failed = [];
  for (const e of list) {
    try {
      const target = inside(modsDir, e.file);
      if (e.op === 'add') {
        if (fs.existsSync(target)) throw new Error('already there');
        fs.renameSync(inside(staged, e.staged), target);
        undoSteps.push({ do: 'delete', file: e.file });
      } else if (e.op === 'remove') {
        const src = fs.existsSync(target) ? target : inside(modsDir, e.file + '.disabled');
        fs.renameSync(src, path.join(rollback, path.basename(src)));
        undoSteps.push({ do: 'restore', file: path.basename(src) });
      } else if (e.op === 'update') {
        const from = inside(staged, e.staged);
        if (!fs.existsSync(from)) throw new Error('the downloaded update is missing'); // the old mod stays
        // the old file may be turned off: the new one then stays off too
        let old = inside(modsDir, e.oldFile);
        let off = false;
        if (!fs.existsSync(old) && fs.existsSync(old + '.disabled')) { old += '.disabled'; off = true; }
        const dest = off ? target + '.disabled' : target;
        if (fs.existsSync(dest) && path.resolve(dest) !== path.resolve(old)) throw new Error('a different file with that name is there');
        if (fs.existsSync(old)) {
          fs.renameSync(old, path.join(rollback, path.basename(old)));
          undoSteps.push({ do: 'restore', file: path.basename(old) });
        }
        fs.renameSync(from, dest);
        undoSteps.push({ do: 'delete', file: path.basename(dest) });
      } else if (e.op === 'enable') {
        const off = inside(modsDir, e.file + '.disabled');
        if (fs.existsSync(off)) {
          if (fs.existsSync(target)) throw new Error('already on (a file with that name is there)');
          fs.renameSync(off, target);
          undoSteps.push({ do: 'rename', file: e.file, to: e.file + '.disabled' });
        }
      } else if (e.op === 'disable') {
        if (fs.existsSync(target)) { fs.renameSync(target, inside(modsDir, e.file + '.disabled')); undoSteps.push({ do: 'rename', file: e.file + '.disabled', to: e.file }); }
      }
      done.push(describe(e));
    } catch (err) {
      failed.push(describe(e) + ': ' + err.message);
    }
  }
  fs.writeFileSync(path.join(rollback, 'undo.json'), JSON.stringify({ undo: undoSteps, entries: list }, null, 2));
  write(gameDir, []);
  fs.writeFileSync(path.join(dirOf(gameDir), 'applied.json'), JSON.stringify({ at: new Date().toISOString(), done, failed }, null, 2));
  return { done, failed, entries: list, rollback };
}

/** Undoes one applied batch (newest step first): the mods folder is back as it was before. */
function rollbackBatch(rollbackDir, modsDir) {
  const plan = JSON.parse(fs.readFileSync(path.join(rollbackDir, 'undo.json'), 'utf8'));
  for (const s of [...plan.undo].reverse()) {
    try {
      if (s.do === 'delete') fs.rmSync(inside(modsDir, s.file), { force: true });
      else if (s.do === 'restore') fs.renameSync(inside(rollbackDir, s.file), inside(modsDir, s.file));
      else if (s.do === 'rename') fs.renameSync(inside(modsDir, s.file), inside(modsDir, s.to));
    } catch { /* keep going: undo as much as possible */ }
  }
  return plan.entries || [];
}

/** Which mod of a batch is to blame for a crash: the one named in the newest crash report or the log, else all of them. */
function blame(gameDir, entries, since) {
  let text = '';
  try {
    const dir = path.join(gameDir, 'crash-reports');
    const newest = fs.readdirSync(dir).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).mtimeMs >= since)
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (newest) text += fs.readFileSync(newest, 'utf8');
  } catch { /* no crash report */ }
  try { text += fs.readFileSync(path.join(gameDir, 'logs', 'latest.log'), 'utf8').slice(-200000); } catch { /* no log */ }
  const lower = text.toLowerCase();
  const added = entries.filter((e) => e.op === 'add' || e.op === 'update' || e.op === 'enable');
  const hit = added.filter((e) => {
    const stem = e.file.replace(/\.jar$/i, '').toLowerCase();
    const id = stem.split(/[-_+]/)[0];
    return lower.includes(stem) || (id.length > 3 && lower.includes(id)) || (e.name && lower.includes(e.name.toLowerCase()));
  });
  const pick = hit.length ? hit : added;
  return pick.map((e) => e.name || e.file).join(', ') || 'a mod change';
}

/** The restart request the game wrote (world or server to come back to), or null. Deleted once read. */
function takeRestart(gameDir, since) {
  const f = path.join(dirOf(gameDir), 'restart.json');
  try {
    const st = fs.statSync(f);
    const o = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.rmSync(f, { force: true });
    if (st.mtimeMs < since) return null;
    const out = { requestedAt: st.mtimeMs, changes: Array.isArray(o.changes) ? o.changes.map(String).slice(0, 50) : [] };
    if (typeof o.world === 'string' && /^[^/\\:*?"<>|\x00-\x1f]{1,120}$/.test(o.world) && o.world !== '.' && o.world !== '..') out.world = o.world;
    else if (typeof o.server === 'string' && /^[A-Za-z0-9.\-:[\]_]{1,255}$/.test(o.server)) out.server = o.server;
    return out;
  } catch {
    return null;
  }
}

/** The game marked itself started (ready.json) after `since`. */
function readySince(gameDir, since) {
  try { return fs.statSync(path.join(dirOf(gameDir), 'ready.json')).mtimeMs >= since; } catch { return false; }
}

function quickPlayArgs(req) {
  if (!req) return [];
  if (req.world) return ['--quickPlaySingleplayer', req.world];
  if (req.server) return ['--quickPlayMultiplayer', req.server];
  return [];
}

module.exports = { read, write, undo, apply, rollbackBatch, blame, takeRestart, readySince, quickPlayArgs, describe, DIR };
