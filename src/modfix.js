'use strict';
// Fixes for what the mod check found. Each fix is written down in <instance>/.azure-launcher/modfix.json so the
// whole set done from one problems screen can be undone: turned-off mods come back, removed mods are moved back from
// mods-removed/ (nothing is ever deleted), downloaded mods are taken out again, the Fabric Loader goes back.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { satisfies } = require('./modcheck');
const { bestVersion, fileOf, FABRIC_API_ID } = require('./modrinth');

const JOURNAL = path.join('.azure-launcher', 'modfix.json');
const SAFE_FILE = /^[^\\/:*?"<>|]+\.jar$/i;

function sha512File(file) {
  return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('hex');
}

function readJournal(gameDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(gameDir, JOURNAL), 'utf8'));
    return j && Array.isArray(j.sessions) ? j : { sessions: [] };
  } catch { return { sessions: [] }; }
}

function writeJournal(gameDir, j) {
  const f = path.join(gameDir, JOURNAL);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  j.sessions = j.sessions.slice(-20);
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
}

function note(gameDir, session, step) {
  const j = readJournal(gameDir);
  let s = j.sessions.find((x) => x.id === session);
  if (!s) { s = { id: session, at: new Date().toISOString(), steps: [] }; j.sessions.push(s); }
  s.steps.push(step);
  writeJournal(gameDir, j);
}

function canUndo(gameDir, session) {
  const s = readJournal(gameDir).sessions.find((x) => x.id === session);
  return !!(s && s.steps.length);
}

const inside = (dir, file) => path.dirname(path.resolve(dir, file)) === path.resolve(dir);

/**
 * Adds the possible fixes to each problem: [{ action, label, ...}]. Network lookups (Modrinth by file hash, Fabric's
 * loader list) are best effort: offline, only "Turn off" and "Remove" are offered.
 * ctx: { modsDir, mc, loaderVersion, client, newestLoader: async () => version|null }
 */
async function withFixes(report, ctx) {
  const { modsDir, mc, client } = ctx;
  const problems = report.problems;
  const open = problems.filter((p) => !p.locked);
  // A newer Fabric Loader, when that alone would satisfy a mod.
  let newest = null;
  if (problems.some((p) => p.reasons.some((r) => r.kind === 'loader'))) {
    try { newest = await ctx.newestLoader(); } catch { newest = null; }
  }
  // The version of each problem mod made for this Minecraft, found by the file's hash (only hashes are sent).
  const hashes = new Map();
  for (const p of open) {
    if (p.reasons.some((r) => ['mc', 'loader', 'java', 'depversion', 'breaks'].includes(r.kind)) && !p.reasons.some((r) => r.kind === 'duplicate')) {
      try { hashes.set(p.file, sha512File(path.join(modsDir, p.file))); } catch { /* gone */ }
    }
  }
  let latest = {};
  if (hashes.size && client) {
    try { latest = await client.latestByHashes([...new Set(hashes.values())], { mc, loader: 'fabric' }); } catch { latest = {}; }
  }
  const present = new Set(fs.existsSync(modsDir) ? fs.readdirSync(modsDir) : []);
  for (const p of problems) {
    p.fixes = [];
    if (p.locked) continue;
    const v = hashes.has(p.file) ? latest[hashes.get(p.file)] : null;
    const file = v ? fileOf(v) : null;
    if (v && file && file.filename !== p.file && !present.has(file.filename) && (v.game_versions || []).includes(mc) && !(v.project_id === FABRIC_API_ID && ctx.fabricApiIncluded)) {
      p.fixes.push({ action: 'update', label: 'Get the version for ' + mc + ' (' + v.version_number + ')', projectId: v.project_id, versionId: v.id });
    }
    const loaderNeeds = p.reasons.filter((r) => r.kind === 'loader');
    // only when the loader is all that is wrong with this mod (a 26.3 mod is not fixed by a newer loader)
    if (loaderNeeds.length && loaderNeeds.length === p.reasons.length && newest && loaderNeeds.every((r) => satisfies(r.spec, newest) === true)) {
      p.fixes.push({ action: 'loader', label: 'Use Fabric Loader ' + newest, version: newest });
    }
    for (const r of p.reasons.filter((x) => x.kind === 'missing')) {
      if (!client || !/^[a-z0-9_.-]{2,64}$/i.test(r.dep)) continue;
      try {
        const best = bestVersion(await client.versionsFor(r.dep, { mc, loader: 'fabric' }));
        if (best && fileOf(best)) p.fixes.push({ action: 'getdep', label: 'Get ' + r.dep, dep: r.dep, projectId: best.project_id, versionId: best.id });
      } catch { /* not on Modrinth under that name */ }
    }
    p.fixes.push({ action: 'disable', label: 'Turn off' });
    p.fixes.push({ action: 'remove', label: 'Remove' });
  }
  return report;
}

function moveOut(gameDir, modsDir, file, session, how) {
  if (!SAFE_FILE.test(file) || !inside(modsDir, file)) throw new Error('Bad file name.');
  const from = path.join(modsDir, file);
  if (!fs.existsSync(from)) throw new Error(file + ' is gone.');
  let to;
  if (how === 'disable') {
    to = from + '.disabled';
  } else {
    const dir = path.join(gameDir, 'mods-removed', session.replace(/[^A-Za-z0-9_-]/g, ''));
    fs.mkdirSync(dir, { recursive: true });
    to = path.join(dir, file);
  }
  if (fs.existsSync(to)) throw new Error('A file named ' + path.basename(to) + ' is already there.');
  fs.renameSync(from, to);
  note(gameDir, session, { op: 'rename', from, to });
}

/**
 * Applies one fix. ctx: { gameDir, modsDir, content (Content for this instance), setLoader(version) -> old version }.
 */
async function applyFix(fix, file, session, ctx) {
  const { gameDir, modsDir } = ctx;
  switch (fix.action) {
    case 'disable':
    case 'remove':
      moveOut(gameDir, modsDir, file, session, fix.action);
      return;
    case 'loader': {
      const old = ctx.setLoader(String(fix.version));
      note(gameDir, session, { op: 'loader', from: old, to: String(fix.version) });
      return;
    }
    case 'update':
    case 'getdep': {
      const before = new Set(fs.readdirSync(modsDir));
      if (fix.action === 'update') moveOut(gameDir, modsDir, file, session, 'remove');
      try {
        await ctx.content.install('mod', String(fix.projectId), { versionId: fix.versionId ? String(fix.versionId) : undefined });
      } finally {
        const added = fs.readdirSync(modsDir).filter((f) => !before.has(f));
        if (added.length) note(gameDir, session, { op: 'added', files: added.map((f) => path.join(modsDir, f)) });
      }
      return;
    }
    default:
      throw new Error('Unknown fix.');
  }
}

/** Puts back everything done in this session, newest first. */
function undo(session, ctx) {
  const j = readJournal(ctx.gameDir);
  const s = j.sessions.find((x) => x.id === session);
  if (!s) return 0;
  const errors = [];
  for (const step of [...s.steps].reverse()) {
    try {
      if (step.op === 'rename') {
        if (!fs.existsSync(step.to)) errors.push(path.basename(step.from) + ' is no longer in ' + path.basename(path.dirname(step.to)));
        else if (fs.existsSync(step.from)) errors.push('a file named ' + path.basename(step.from) + ' is in the way; ' + path.basename(step.to) + ' was left in ' + path.dirname(step.to));
        else fs.renameSync(step.to, step.from);
      } else if (step.op === 'added') {
        for (const f of step.files) if (path.dirname(f) === path.resolve(ctx.modsDir)) fs.rmSync(f, { force: true }); // downloaded by this session
      } else if (step.op === 'loader') {
        ctx.setLoader(step.from);
      }
    } catch (e) { errors.push(e.message); }
  }
  const n = s.steps.length;
  j.sessions = j.sessions.filter((x) => x !== s);
  writeJournal(ctx.gameDir, j);
  if (errors.length) throw new Error('Some changes could not be put back: ' + errors.join('; '));
  return n;
}

/** The best single fix for a problem when the player asks to fix everything: the right version, else turn it off. */
function preferred(p) {
  return p.fixes.find((f) => f.action === 'update') || p.fixes.find((f) => f.action === 'loader') || p.fixes.find((f) => f.action === 'getdep') || p.fixes.find((f) => f.action === 'disable') || null;
}

module.exports = { withFixes, applyFix, undo, canUndo, preferred, readJournal };
