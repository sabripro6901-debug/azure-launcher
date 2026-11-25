'use strict';
// Packs in a com.mojang folder: reading .mcpack / .mcaddon / .zip files, listing what is installed, adding (always a
// copy, the original file is never moved or changed) and removing.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { BedrockError, PACK_EXT, PACK_MAX, screen, openArchive, extract, readSmall } = require('./archive');
const { parseManifest, parseLang, displayName, iconUrl, versionText, compare } = require('./manifest');

const DIRS = { resource: 'resource_packs', behavior: 'behavior_packs', skin: 'skin_packs' };
const PACK_FILE = /\.(mcpack|mcaddon|zip)$/i;

const safeFolder = (name) => (String(name).replace(/[^A-Za-z0-9 _.()-]+/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 60) || 'pack');

/** One pack folder on disk: { kind, folder, name, version, uuid, icon } or null when it has no readable manifest. */
function readPackDir(dir, kind, folder) {
  const full = path.join(dir, folder);
  try {
    if (!fs.statSync(full).isDirectory()) return null;
    const mf = path.join(full, 'manifest.json');
    if (fs.statSync(mf).size > 1024 * 1024) return null;
    const m = parseManifest(fs.readFileSync(mf, 'utf8'));
    if (!m.ok) return { kind, folder, name: folder, version: [], uuid: '', icon: null, error: m.error };
    let lang = null;
    try { lang = parseLang(fs.readFileSync(path.join(full, 'texts', 'en_US.lang'), 'utf8')); } catch { /* no lang file */ }
    let icon = null;
    try { icon = iconUrl(fs.readFileSync(path.join(full, 'pack_icon.png'))); } catch { /* no icon */ }
    return { kind, folder, name: displayName(m.name, lang) || folder, version: m.version, uuid: m.uuid, icon, minEngine: m.minEngine };
  } catch { return null; }
}

/** Everything installed in a profile (a { root } folder), by kind. */
function listInstalled(profile) {
  const out = [];
  for (const [kind, sub] of Object.entries(DIRS)) {
    const dir = path.join(profile.root, sub);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const folder of names) {
      if (folder.startsWith('.')) continue;
      const p = readPackDir(dir, kind, folder);
      if (p) out.push(p);
    }
  }
  return out;
}

/** Where manifest.json files sit: the shortest folders, none inside another. */
function packRoots(files) {
  const roots = files.map((f) => f.name).filter((n) => n.split('/').pop() === 'manifest.json' && n.split('/').length <= 3)
    .map((n) => n.slice(0, n.length - 'manifest.json'.length)).sort((a, b) => a.length - b.length);
  const out = [];
  for (const r of roots) if (!out.some((o) => r.startsWith(o))) out.push(r);
  return out;
}

let counter = 0;

/**
 * Reads the given files and says what they hold. ctx: { profile, gameVersion: [maj, min, patch] | null }.
 * Returns candidates { id, file, fileName, root, name, version, uuid, kind, icon, issues: [{level,text}], blocked, ask,
 * replaces: ['folder|kind'] }; level is 'block', 'ask' or 'info'.
 */
function inspect(files, ctx) {
  const installed = ctx.profile ? listInstalled(ctx.profile) : [];
  const out = [];
  for (const file of files) {
    const fileName = path.basename(file);
    const bad = (text) => out.push({ id: counter++, file, fileName, name: fileName, version: '', kind: '', icon: null, issues: [{ level: 'block', text }], blocked: true, ask: false, replaces: [] });
    if (!PACK_FILE.test(fileName)) { bad('Only .mcpack, .mcaddon and .zip files can be added.'); continue; }
    let zip;
    try { zip = openArchive(file); } catch (e) { if (e instanceof BedrockError) { bad(e.message); continue; } throw e; }
    try {
      const { files: entries, blocked } = screen(zip, PACK_EXT, PACK_MAX);
      if (blocked.length) {
        const list = blocked.slice(0, 3).map((b) => b.name).join(', ') + (blocked.length > 3 ? ' …' : '');
        bad('Refused: it holds files a Bedrock pack never has (' + list + ').');
        continue;
      }
      const roots = packRoots(entries);
      if (!roots.length) { bad('No pack found: there is no manifest.json in it.'); continue; }
      for (const root of roots) {
        const entry = entries.find((f) => f.name === root + 'manifest.json');
        let m;
        try { m = parseManifest(readSmall(zip, entry.entry).toString('utf8')); } catch { m = { ok: false, error: 'manifest.json could not be read' }; }
        const c = { id: counter++, file, fileName, root, name: fileName, version: '', uuid: '', kind: '', icon: null, issues: [], blocked: false, ask: false, replaces: [] };
        out.push(c);
        if (!m.ok) { c.issues.push({ level: 'block', text: m.error + '.' }); c.blocked = true; continue; }
        let lang = null;
        const l = entries.find((f) => f.name === root + 'texts/en_US.lang');
        if (l) try { lang = parseLang(readSmall(zip, l.entry).toString('utf8')); } catch { /* ignore */ }
        const ic = entries.find((f) => f.name === root + 'pack_icon.png');
        if (ic && ic.entry.size <= 300 * 1024) try { c.icon = iconUrl(zip.read(ic.entry)); } catch { /* no icon */ }
        c.name = displayName(m.name, lang) || fileName;
        c.version = versionText(m.version);
        c.uuid = m.uuid;
        c.kind = m.kind;
        if (!DIRS[m.kind]) { c.issues.push({ level: 'block', text: 'This is a world template, which is not supported here.' }); c.blocked = true; continue; }
        if (m.minEngine && ctx.gameVersion && compare(m.minEngine, ctx.gameVersion) > 0) {
          c.issues.push({ level: 'ask', text: 'Needs Minecraft ' + versionText(m.minEngine) + ' or newer; you have ' + versionText(ctx.gameVersion) + '.' });
          c.ask = true;
        }
        for (const p of installed.filter((x) => x.uuid === m.uuid)) {
          const d = compare(m.version, p.version);
          c.replaces.push(p.folder + '|' + p.kind);
          c.issues.push({ level: 'ask', text: d === 0 ? 'Already installed (same version ' + versionText(p.version) + '). Adding replaces it.'
            : d > 0 ? 'Version ' + versionText(p.version) + ' is installed. Adding replaces it with ' + c.version + '.'
              : 'A newer version ' + versionText(p.version) + ' is installed. Adding replaces it with the older ' + c.version + '.' });
          c.ask = true;
        }
        const missing = m.dependencies.filter((u) => !installed.some((p) => p.uuid === u));
        if (missing.length && roots.length === 1) c.issues.push({ level: 'info', text: missing.length === 1 ? 'Needs another pack that is not installed.' : 'Needs ' + missing.length + ' other packs that are not installed.' });
      }
    } finally { zip.close(); }
  }
  return out;
}

/**
 * Copies the chosen candidates into the profile. ctx: { profile, trash(path) }. Returns { added: [{name, folder}],
 * skipped: [{name, reason}] }. A pack with the same UUID that is installed is replaced (the old folder goes to the
 * trash). The caller has checked that the game is closed.
 */
function add(candidates, ids, ctx) {
  const added = [];
  const skipped = [];
  const want = new Set(ids);
  const seen = new Set();
  for (const c of candidates) {
    if (!want.has(c.id)) continue;
    if (c.uuid && seen.has(c.uuid)) { skipped.push({ name: c.name, reason: 'twice in the selection' }); continue; }
    if (c.uuid) seen.add(c.uuid);
    if (c.blocked || !DIRS[c.kind]) { skipped.push({ name: c.name, reason: 'not allowed' }); continue; }
    const dir = path.join(ctx.profile.root, DIRS[c.kind]);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, '.azure-tmp-' + crypto.randomBytes(5).toString('hex'));
    let zip;
    try {
      zip = openArchive(c.file);
      const { files, blocked } = screen(zip, PACK_EXT, PACK_MAX);
      if (blocked.length) throw new BedrockError('BLOCKED', 'Refused.');
      extract(zip, files, tmp, c.root, ctx.onProgress ? (d, t) => ctx.onProgress(d, t) : null);
      // the file may have changed since it was looked at: what landed must still be the pack that was shown
      const now = parseManifest(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'));
      if (!now.ok || now.uuid !== c.uuid || now.kind !== c.kind) throw new BedrockError('CHANGED', 'The file changed.');
      let folder = safeFolder(c.name);
      for (const r of c.replaces) {
        const [f, k] = r.split('|');
        const old = DIRS[k] ? path.join(ctx.profile.root, DIRS[k], f) : '';
        const was = old && fs.existsSync(old) ? readPackDir(path.join(ctx.profile.root, DIRS[k]), k, f) : null;
        if (was && was.uuid === c.uuid) { ctx.trash(old); if (k === c.kind && safeFolder(f) === f) folder = f; }
      }
      let final = path.join(dir, folder);
      for (let n = 2; fs.existsSync(final); n++) final = path.join(dir, folder + ' ' + n);
      fs.renameSync(tmp, final);
      added.push({ name: c.name, folder: path.basename(final) });
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      skipped.push({ name: c.name, reason: e instanceof BedrockError ? 'not allowed' : 'could not be copied' });
    } finally { if (zip) zip.close(); }
  }
  return { added, skipped };
}

/** Sends one installed pack to the trash. kind is resource|behavior|skin; folder is a plain folder name. */
function remove(profile, kind, folder, ctx) {
  if (!DIRS[kind]) throw new BedrockError('BAD_KIND', 'Unknown pack type.');
  const f = String(folder);
  if (!f || f.startsWith('.') || /[\\/:\0]/.test(f) || f.includes('..')) throw new BedrockError('BAD_NAME', 'That pack could not be found.');
  const full = path.join(profile.root, DIRS[kind], f);
  if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) throw new BedrockError('MISSING', 'That pack is not there any more.');
  ctx.trash(full);
}

module.exports = { DIRS, listInstalled, inspect, add, remove, safeFolder };
