'use strict';
// Reading what is inside a mod jar or a pack zip, safely. Imported files are untrusted: nothing is ever extracted to
// disk or run, entries are read into memory only, only a few named entries are inflated, and sizes are capped.
const fs = require('node:fs');
const { unzipSync } = require('fflate');

const MAX_FILE = 256 * 1024 * 1024; // bigger files are not opened
const MAX_ENTRIES = 30000;
const MAX_JSON = 2 * 1024 * 1024;
const MAX_ICON = 256 * 1024;

const META = ['fabric.mod.json', 'quilt.mod.json', 'META-INF/mods.toml', 'META-INF/neoforge.mods.toml', 'mcmod.info', 'pack.mcmeta', 'pack.png'];

/** Reads only the named entries of a zip (plus a list of every entry name). Never writes anything. */
function readZip(file, wanted) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('This file is too large to check.');
  const data = new Uint8Array(fs.readFileSync(file));
  const names = [];
  const got = unzipSync(data, {
    filter: (f) => {
      names.push(f.name);
      if (names.length > MAX_ENTRIES) throw new Error('This archive has too many entries.');
      return wanted.includes(f.name) && f.originalSize <= (f.name.endsWith('.png') ? MAX_ICON : MAX_JSON);
    },
  });
  return { entries: got, names };
}

/** An icon path from inside a zip: no absolute paths, no "..", PNG only. */
function safeEntry(p) {
  const clean = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return clean && !clean.split('/').includes('..') && /\.png$/i.test(clean) ? clean : null;
}

const dataUrl = (bytes) => 'data:image/png;base64,' + Buffer.from(bytes).toString('base64');

/** Fabric's version ranges (">=1.20 <1.21", "~1.20.1", "1.20.x", arrays, "||") against a Minecraft release. */
function mcSatisfies(spec, mc) {
  const parse = (v) => { const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(v); return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null; };
  const target = parse(mc);
  if (!target) return null; // snapshots: cannot say
  const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
  const one = (term) => {
    const m = /^(>=|<=|>|<|=|~|\^)?\s*(.+)$/.exec(term.trim());
    if (!m) return null;
    const op = m[1] || '=';
    const v = m[2].trim();
    if (v === '*' || v === 'x' || v === 'X') return true;
    if (/[xX*]/.test(v)) { // 1.20.x
      const parts = v.split('.');
      return parts.every((p, i) => /^[xX*]$/.test(p) || Number(p) === target[i]);
    }
    const base = parse(v.split('-')[0]);
    if (!base) return null;
    switch (op) {
      case '>=': return cmp(target, base) >= 0;
      case '<=': return cmp(target, base) <= 0;
      case '>': return cmp(target, base) > 0;
      case '<': return cmp(target, base) < 0;
      case '~': return target[0] === base[0] && target[1] === base[1] && target[2] >= base[2];
      case '^': return target[0] === base[0] && cmp(target, base) >= 0;
      default: return cmp(target, base) === 0;
    }
  };
  const specs = Array.isArray(spec) ? spec : [spec];
  let unknown = false;
  for (const s of specs) {
    for (const alt of String(s).split('||')) {
      const results = alt.trim().split(/\s+/).filter(Boolean).map(one);
      if (results.includes(null)) { unknown = true; continue; }
      if (results.every(Boolean)) return true;
    }
  }
  return unknown ? null : false;
}

function tomlValue(text, key) {
  const m = new RegExp('^\\s*' + key + '\\s*=\\s*"([^"]*)"', 'm').exec(text);
  return m ? m[1] : null;
}

/** What a mod jar says about itself: { loader, id, name, version, description, icon, mcRange } (loader null = not a mod). */
function readModInfo(file) {
  const out = { loader: null, id: null, name: null, version: null, description: '', icon: null, mcRange: null, error: null };
  let zip;
  try {
    zip = readZip(file, META);
  } catch (e) {
    out.error = e.message;
    return out;
  }
  const text = (n) => (zip.entries[n] ? Buffer.from(zip.entries[n]).toString('utf8') : null);
  try {
    if (text('fabric.mod.json')) {
      const j = JSON.parse(text('fabric.mod.json'));
      Object.assign(out, { loader: 'fabric', id: String(j.id || ''), name: j.name || j.id || null, version: String(j.version || ''), description: j.description || '' });
      out.mcRange = j.depends && j.depends.minecraft !== undefined ? j.depends.minecraft : null;
      const icon = typeof j.icon === 'string' ? j.icon : j.icon && typeof j.icon === 'object' ? j.icon[Object.keys(j.icon).sort((a, b) => Number(b) - Number(a))[0]] : null;
      const entry = safeEntry(icon);
      if (entry) {
        const again = readZip(file, [entry]).entries[entry];
        if (again) out.icon = dataUrl(again);
      }
    } else if (text('quilt.mod.json')) {
      const j = JSON.parse(text('quilt.mod.json'));
      const q = j.quilt_loader || {};
      Object.assign(out, { loader: 'quilt', id: String(q.id || ''), name: (q.metadata && q.metadata.name) || q.id || null, version: String(q.version || '') });
    } else if (text('META-INF/neoforge.mods.toml')) {
      const t = text('META-INF/neoforge.mods.toml');
      Object.assign(out, { loader: 'neoforge', id: tomlValue(t, 'modId'), name: tomlValue(t, 'displayName'), version: tomlValue(t, 'version') });
    } else if (text('META-INF/mods.toml')) {
      const t = text('META-INF/mods.toml');
      Object.assign(out, { loader: 'forge', id: tomlValue(t, 'modId'), name: tomlValue(t, 'displayName'), version: tomlValue(t, 'version') });
    } else if (text('mcmod.info')) {
      Object.assign(out, { loader: 'forge', id: null, name: null });
    }
  } catch (e) {
    out.error = 'The mod information inside this file is damaged.';
  }
  return out;
}

/** What a resource pack or shader pack zip is: { kind: 'resourcepack' | 'shader' | null, packFormat, description, icon }. */
function readPackInfo(file) {
  const out = { kind: null, packFormat: null, description: '', icon: null, error: null };
  let zip;
  try {
    zip = readZip(file, ['pack.mcmeta', 'pack.png']);
  } catch (e) {
    out.error = e.message;
    return out;
  }
  const hasShaders = zip.names.some((n) => /^shaders\//.test(n) || /^[^/]+\/shaders\//.test(n));
  try {
    if (zip.entries['pack.mcmeta']) {
      const j = JSON.parse(Buffer.from(zip.entries['pack.mcmeta']).toString('utf8'));
      out.packFormat = (j.pack && j.pack.pack_format) || null;
      const d = j.pack && j.pack.description;
      out.description = typeof d === 'string' ? d : Array.isArray(d) ? d.map((x) => (typeof x === 'string' ? x : x.text || '')).join('') : (d && d.text) || '';
    }
  } catch { out.error = 'pack.mcmeta is damaged.'; }
  if (zip.entries['pack.png']) out.icon = dataUrl(zip.entries['pack.png']);
  if (hasShaders) out.kind = 'shader';
  else if (zip.entries['pack.mcmeta'] || zip.names.some((n) => /^assets\//.test(n))) out.kind = 'resourcepack';
  return out;
}

module.exports = { readModInfo, readPackInfo, mcSatisfies, readZip, safeEntry, MAX_FILE };
