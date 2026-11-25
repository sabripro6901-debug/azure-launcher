'use strict';
// Bedrock pack manifests: manifest.json is JSON that the game also accepts with comments, a byte-order mark and
// trailing commas, so it is read forgivingly. Names that are text keys (pack.name) come from texts/en_US.lang.

/** Removes // and /* *\/ comments (outside strings) and trailing commas. */
function relax(text) {
  let s = String(text).replace(/^﻿/, '');
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += s[++i] || ''; } else if (c === '"') inStr = false;
    } else if (c === '"') { inStr = true; out += c; }
    else if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; out += '\n'; }
    else if (c === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i++; }
    else out += c;
  }
  // a comma right before } or ] (outside strings: strings were copied untouched, but a ",]" inside one is rare enough
  // to ignore; JSON.parse of the original decides in the end)
  return out.replace(/,(\s*[}\]])/g, '$1');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function version(v) {
  if (Array.isArray(v) && v.length >= 1 && v.length <= 4 && v.every((n) => Number.isInteger(n) && n >= 0 && n < 1e9)) return v.slice();
  if (typeof v === 'string' && /^\d+(\.\d+){0,3}$/.test(v)) return v.split('.').map(Number);
  return null;
}

const KINDS = { resources: 'resource', data: 'behavior', script: 'behavior', client_data: 'behavior', interface: 'behavior', skin_pack: 'skin', world_template: 'world_template' };

/** { ok: true, name, description, uuid, version: [n..], minEngine, kind, dependencies: [uuid] } or { ok: false, error }. */
function parseManifest(text) {
  let m;
  try { m = JSON.parse(relax(text)); } catch { return { ok: false, error: 'manifest.json is not valid JSON' }; }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, error: 'manifest.json is empty' };
  const h = m.header;
  if (!h || typeof h !== 'object') return { ok: false, error: 'manifest.json has no header' };
  const uuid = typeof h.uuid === 'string' ? h.uuid.toLowerCase() : '';
  if (!UUID.test(uuid)) return { ok: false, error: 'manifest.json has no valid UUID' };
  const ver = version(h.version);
  if (!ver) return { ok: false, error: 'manifest.json has no valid version' };
  const types = (Array.isArray(m.modules) ? m.modules : []).map((x) => (x && typeof x.type === 'string' ? x.type.toLowerCase() : ''));
  const order = ['skin_pack', 'world_template', 'resources', 'data', 'script', 'client_data', 'interface'];
  const first = order.find((t) => types.includes(t));
  if (!first) return { ok: false, error: 'manifest.json has no known module type' };
  const deps = (Array.isArray(m.dependencies) ? m.dependencies : [])
    .map((d) => (d && typeof d.uuid === 'string' ? d.uuid.toLowerCase() : '')).filter((u) => UUID.test(u));
  return {
    ok: true,
    name: typeof h.name === 'string' && h.name.trim() ? h.name.trim().slice(0, 120) : '',
    description: typeof h.description === 'string' ? h.description.trim().slice(0, 300) : '',
    uuid,
    version: ver,
    minEngine: version(h.min_engine_version),
    kind: KINDS[first],
    dependencies: deps,
  };
}

/** key=value lines of a .lang file, as an object. */
function parseLang(text) {
  const out = {};
  for (const line of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i <= 0 || line.startsWith('#')) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).replace(/\s*##.*$/, '').trim();
  }
  return out;
}

/** A manifest name that is a text key (pack.name, no spaces) is looked up in the lang file; otherwise as it is. */
function displayName(name, lang) {
  if (name && /^[\w.]+$/.test(name) && name.includes('.') && lang && lang[name]) return lang[name].slice(0, 120);
  return name;
}

/** A pack icon as a data: URL, or null when it is not a small, real PNG or JPEG. */
function iconUrl(buf) {
  if (!buf || buf.length < 16 || buf.length > 300 * 1024) return null;
  if (buf.readUInt32BE(0) === 0x89504e47) return 'data:image/png;base64,' + buf.toString('base64');
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'data:image/jpeg;base64,' + buf.toString('base64');
  return null;
}

const versionText = (v) => (v || []).join('.');
/** -1, 0, 1 comparing version arrays (missing parts count as 0). */
function compare(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

module.exports = { parseManifest, parseLang, displayName, iconUrl, versionText, compare, relax };
