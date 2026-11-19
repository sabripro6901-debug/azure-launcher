'use strict';
// Paths that come from downloaded lists (Mojang's Java manifest, library paths, Fabric's profile id) are joined
// under their folder only after checking they stay inside it (AUDIT M3): a bad or tampered list can't make the
// launcher write anywhere else on the PC.
const path = require('node:path');

/** base joined with rel, or an error if rel is absolute, empty or climbs out of base. */
function inside(base, rel) {
  const r = String(rel == null ? '' : rel);
  if (!r || r.includes('\0') || path.isAbsolute(r) || /^[a-zA-Z]:/.test(r) || r.split(/[\\/]+/).includes('..')) {
    throw new Error('Refused a file path from a download list: ' + JSON.stringify(r.slice(0, 120)));
  }
  const full = path.resolve(base, r);
  const b = path.resolve(base);
  if (full !== b && !full.startsWith(b + path.sep)) throw new Error('Refused a file path outside its folder: ' + JSON.stringify(r.slice(0, 120)));
  return full;
}

/** A version id (Mojang's or Fabric's) that is safe as a folder and file name. */
function versionId(id) {
  const s = String(id == null ? '' : id);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,80}$/.test(s) || s.includes('..')) throw new Error('Refused a version id: ' + JSON.stringify(s.slice(0, 80)));
  return s;
}

module.exports = { inside, versionId };
