'use strict';
// Mod check: before the game starts, every enabled mod's own information (fabric.mod.json, plus the mods bundled
// inside it) is read and compared with the instance (Minecraft, Fabric Loader, Java) and with the other mods, so a
// set that Fabric would refuse is explained instead of crashing. Files are only read here (in memory, sizes capped);
// the fixes (fixes.js) are separate and every one of them can be undone.
const fs = require('node:fs');
const path = require('node:path');
const { unzipSync } = require('fflate');

const MAX_FILE = 256 * 1024 * 1024;
const MAX_JSON = 2 * 1024 * 1024;
const MAX_NESTED = 64 * 1024 * 1024;
const MAX_DEPTH = 3;

/** Fabric Loader itself brings these (MixinExtras since 0.15). */
const BUILTIN_EXTRA = ['mixinextras'];

// ---------- versions ----------

/** "0.141.6+1.21.11" -> [0, 141, 6]; null when it does not start with a number. */
function parseVer(v) {
  const m = /^v?(\d+(?:\.\d+)*)/.exec(String(v == null ? '' : v).trim());
  return m ? m[1].split('.').map(Number) : null;
}

function cmpVer(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Fabric's version ranges (">=0.18.4", "~1.21.11", "1.21.x", "*", "a || b", arrays = any of) against a version.
 * true / false, or null when it cannot be told (then the check stays quiet: no false alarms).
 */
function satisfies(spec, version) {
  const have = parseVer(version);
  if (!have) return null;
  const one = (term) => {
    const m = /^(>=|<=|>|<|=|~|\^)?\s*(.+)$/.exec(term.trim());
    if (!m) return null;
    const op = m[1] || '=';
    const v = m[2].trim();
    if (v === '*' || /^[xX]$/.test(v)) return true;
    if (/(^|\.)[xX*](\.|$)/.test(v)) {
      const parts = v.split('.');
      return parts.every((p, i) => /^[xX*]$/.test(p) || Number(p) === (have[i] || 0));
    }
    const base = parseVer(v);
    if (!base) return null;
    const c = cmpVer(have, base);
    switch (op) {
      case '>=': return c >= 0;
      case '<=': return c <= 0;
      case '>': return c > 0;
      case '<': return c < 0;
      case '~': return c >= 0 && have[0] === base[0] && (base.length < 2 || have[1] === base[1]);
      case '^': return c >= 0 && have[0] === base[0];
      default: return c === 0;
    }
  };
  const specs = Array.isArray(spec) ? spec : [spec];
  let unknown = false;
  for (const s of specs) {
    for (const alt of String(s).split('||')) {
      const results = alt.trim().split(/\s+/).filter(Boolean).map(one);
      if (!results.length) return true;
      if (results.includes(false)) continue;
      if (results.includes(null)) { unknown = true; continue; }
      return true;
    }
  }
  return unknown ? null : false;
}

/** ">=0.18.4" -> "0.18.4 or newer", for the problem texts. */
function specText(spec) {
  const term = (t) => {
    const m = /^(>=|<=|>|<|=|~|\^)?\s*(.+)$/.exec(t.trim());
    if (!m) return t;
    const v = m[2].replace(/-.*$/, '');
    if (v === '*' || v === '') return 'any version';
    switch (m[1]) {
      case '>=': return v + ' or newer';
      case '>': return 'newer than ' + v;
      case '<=': return v + ' or older';
      case '<': return 'older than ' + v;
      case '~': { const p = v.split('.'); return p.length > 2 ? p.slice(0, 2).join('.') + ' (' + v + ' or newer)' : v + '.x'; }
      case '^': return v + ' or newer (' + v.split('.')[0] + '.x)';
      default: return v;
    }
  };
  const specs = Array.isArray(spec) ? spec : [spec];
  return specs.map((s) => String(s).split('||').map((alt) => alt.trim().split(/\s+/).filter(Boolean).map(term).join(' and ')).join(' or ')).join(' or ');
}

// ---------- reading mods ----------

function unzipNames(data, wanted) {
  const names = [];
  const got = unzipSync(data, {
    filter: (f) => {
      names.push(f.name);
      if (names.length > 30000) throw new Error('too many entries');
      return wanted(f.name) && f.originalSize <= (f.name.endsWith('.jar') ? MAX_NESTED : MAX_JSON);
    },
  });
  return { got, names };
}

/** One mod archive (or a bundled one): { id, version, name, provides, depends, breaks, loader, nested, error }. */
function readMod(data, depth = 0) {
  const out = { id: null, version: null, name: null, provides: [], depends: {}, breaks: {}, loader: null, nested: [], error: null };
  let first;
  try {
    first = unzipNames(data, (n) => n === 'fabric.mod.json' || n === 'quilt.mod.json' || n === 'META-INF/mods.toml' || n === 'META-INF/neoforge.mods.toml' || n === 'mcmod.info');
  } catch {
    out.error = 'This file is not a working jar (damaged or not a zip).';
    return out;
  }
  const text = (n) => (first.got[n] ? Buffer.from(first.got[n]).toString('utf8') : null);
  if (!text('fabric.mod.json')) {
    out.loader = text('quilt.mod.json') ? 'quilt' : text('META-INF/neoforge.mods.toml') ? 'neoforge' : (text('META-INF/mods.toml') || text('mcmod.info')) ? 'forge' : null;
    return out;
  }
  let j;
  try {
    j = JSON.parse(text('fabric.mod.json').replace(/^﻿/, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' '));
  } catch {
    try { j = JSON.parse(text('fabric.mod.json').replace(/\r?\n/g, ' ')); } catch { out.error = 'The mod information inside this file is damaged.'; return out; }
  }
  out.loader = 'fabric';
  out.id = String(j.id || '');
  out.version = String(j.version || '');
  out.name = String(j.name || j.id || '');
  out.provides = Array.isArray(j.provides) ? j.provides.map(String) : [];
  out.depends = j.depends && typeof j.depends === 'object' ? j.depends : {};
  out.breaks = j.breaks && typeof j.breaks === 'object' ? j.breaks : {};
  const jars = Array.isArray(j.jars) ? j.jars.map((x) => x && String(x.file || '')).filter((f) => f && f.endsWith('.jar') && !f.split('/').includes('..')) : [];
  if (jars.length && depth < MAX_DEPTH) {
    try {
      const inner = unzipNames(data, (n) => jars.includes(n));
      for (const f of jars) if (inner.got[f]) out.nested.push(readMod(inner.got[f], depth + 1));
    } catch { /* bundled mods unreadable: checked as if absent */ }
  }
  return out;
}

function readModFile(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_FILE) return { ...readMod(new Uint8Array(0)), error: 'This file is too large to check.' };
  return readMod(new Uint8Array(fs.readFileSync(file)));
}

// ---------- the check ----------

const prettyLoader = (l) => ({ forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt' }[l] || l);

/**
 * modsDir: the instance's mods folder; mc, loaderVersion; javaMajor (or null); locked: file names the launcher
 * puts there itself (they are never offered to be turned off). Returns { mods, problems }:
 * problems = [{ file, name, version, id, locked, reasons: [{ kind, text, dep?, spec? }] }].
 */
function check({ modsDir, mc, loaderVersion, javaMajor = null, locked = [] }) {
  const files = fs.existsSync(modsDir) ? fs.readdirSync(modsDir).filter((f) => f.toLowerCase().endsWith('.jar') && fs.statSync(path.join(modsDir, f)).isFile()).sort() : [];
  const mods = files.map((file) => ({ file, ...readModFile(path.join(modsDir, file)) }));
  // Who provides what: id -> [{ version, file, top }]
  const provided = new Map();
  const add = (id, version, file, top) => {
    if (!id) return;
    if (!provided.has(id)) provided.set(id, []);
    provided.get(id).push({ version, file, top });
  };
  add('minecraft', mc, null, false);
  add('java', javaMajor == null ? null : String(javaMajor), null, false);
  add('fabricloader', loaderVersion, null, false);
  add('fabric-loader', loaderVersion, null, false);
  for (const id of BUILTIN_EXTRA) add(id, null, null, false);
  const walk = (m, file, top) => {
    add(m.id, m.version, file, top);
    for (const p of m.provides) add(p, m.version, file, top);
    for (const n of m.nested) walk(n, file, false);
  };
  for (const m of mods) if (m.loader === 'fabric') walk(m, m.file, true);

  const problems = new Map();
  const reason = (m, r) => {
    if (!problems.has(m.file)) problems.set(m.file, { file: m.file, name: m.name || m.file.replace(/\.jar$/i, ''), version: m.version || '', id: m.id || null, locked: locked.includes(m.file), reasons: [] });
    problems.get(m.file).reasons.push(r);
  };

  for (const m of mods) {
    if (m.error) { reason(m, { kind: 'damaged', text: m.error }); continue; }
    if (m.loader !== 'fabric') {
      reason(m, { kind: 'notfabric', text: m.loader ? 'This is a ' + prettyLoader(m.loader) + ' mod; this instance uses Fabric.' : 'No mod information inside: this is not a Fabric mod.' });
      continue;
    }
    for (const [dep, spec] of Object.entries(m.depends)) {
      if (dep === 'minecraft') {
        if (satisfies(spec, mc) === false) reason(m, { kind: 'mc', dep, spec, text: 'Made for Minecraft ' + specText(spec) + '; this instance is ' + mc + '.' });
      } else if (dep === 'fabricloader' || dep === 'fabric-loader') {
        if (satisfies(spec, loaderVersion) === false) reason(m, { kind: 'loader', dep, spec, text: 'Needs Fabric Loader ' + specText(spec) + '; this instance has ' + loaderVersion + '.' });
      } else if (dep === 'java') {
        if (javaMajor != null && satisfies(spec, String(javaMajor)) === false) reason(m, { kind: 'java', dep, spec, text: 'Needs Java ' + specText(spec) + '; Minecraft ' + mc + ' runs on Java ' + javaMajor + '.' });
      } else {
        const have = (provided.get(dep) || []).filter((p) => p.file !== m.file || !p.top);
        if (!have.length) {
          reason(m, { kind: 'missing', dep, spec, text: 'Needs ' + dep + (specText(spec) === 'any version' ? '' : ' ' + specText(spec)) + ', which is not installed.' });
        } else if (have.every((p) => satisfies(spec, p.version) === false)) {
          const best = have.filter((p) => p.version).sort((a, b) => cmpVer(parseVer(b.version) || [], parseVer(a.version) || []))[0];
          reason(m, { kind: 'depversion', dep, spec, text: 'Needs ' + dep + ' ' + specText(spec) + '; you have ' + (best ? best.version : '?') + '.' });
        }
      }
    }
    for (const [dep, spec] of Object.entries(m.breaks)) {
      const clash = (provided.get(dep) || []).filter((p) => p.top && p.file !== m.file && satisfies(spec, p.version) === true);
      if (clash.length) reason(m, { kind: 'breaks', dep, spec, text: 'Does not work together with ' + dep + ' ' + clash[0].version + ' (' + clash[0].file + '), its author says.' });
    }
  }

  // The same mod installed twice: the older copies are the problem.
  const byId = new Map();
  for (const m of mods) if (m.loader === 'fabric' && m.id) { if (!byId.has(m.id)) byId.set(m.id, []); byId.get(m.id).push(m); }
  for (const [, list] of byId) {
    if (list.length < 2) continue;
    // keep the one the launcher manages, else the newest version
    const keep = list.find((m) => locked.includes(m.file)) || [...list].sort((a, b) => cmpVer(parseVer(b.version) || [], parseVer(a.version) || []))[0];
    for (const m of list) if (m !== keep) reason(m, { kind: 'duplicate', dep: m.id, other: keep.file, text: 'Installed twice: ' + keep.file + ' (' + keep.version + ') is the copy that stays.' });
  }
  return { mods: mods.map((m) => ({ file: m.file, id: m.id, version: m.version, name: m.name, loader: m.loader })), problems: [...problems.values()] };
}

/**
 * Fabric's own refusal, read from the game's output: the lines of its suggested solution, or null when the output
 * is not that error.
 */
function fabricRefusal(lines) {
  const text = lines.join('\n');
  if (!/Some of your mods are incompatible|Incompatible mods found|Mod resolution failed/.test(text)) return null;
  const out = [];
  let on = false;
  for (const raw of lines) {
    const l = raw.replace(/^\[[^\]]*\]\s*(\[[^\]]*\]:?\s*)?/, '').trim();
    if (/A potential solution has been determined|More details:/.test(l)) { on = true; continue; }
    if (on && /^at\s|^net\.fabricmc\.loader/.test(l)) break;
    if (on && /^- /.test(l)) out.push(l.slice(2));
    if (out.length >= 40) break;
  }
  return out;
}

module.exports = { check, satisfies, specText, parseVer, cmpVer, readMod, readModFile, fabricRefusal };
