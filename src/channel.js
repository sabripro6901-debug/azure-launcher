'use strict';
// The signed update channel: latest.json + latest.json.sig (Ed25519, made with Azure's release key) on the public
// releases bucket. The launcher trusts a release only if the signature matches the public key shipped with it, then
// checks the jar's size and SHA-256 from latest.json and runs the Legit guard before the jar is kept.
//
// latest.json today:   { version, notes, legit: { file, sha256, size } }          (one jar, for Minecraft 1.21.11)
// latest.json later:   the same, plus (both optional, so the mod's current updater keeps working unchanged)
//                        minecraft: "1.21.11"                                      the Minecraft version `legit` is for
//                        builds: { "1.21.11": { file, sha256, size, version }, "1.20.1": { ... } }   one Legit jar per version,
//                                                    each with its own Azure `version` (ports can be on different versions)
// The launcher reads the supported Minecraft versions from here: nothing is hard-coded.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { download, hashFile, fetchWithTimeout } = require('./net');
const { checkLegitJar } = require('./guard');

const DEFAULT_MC = '1.21.11'; // what a latest.json without "minecraft" means

function publicKey(base64Der) {
  return crypto.createPublicKey({ key: Buffer.from(base64Der.trim(), 'base64'), format: 'der', type: 'spki' });
}

/** True if sig (base64) is a valid Ed25519 signature of data by the key. */
function verifySignature(data, sigBase64, keyBase64) {
  try {
    return crypto.verify(null, Buffer.from(data), publicKey(keyBase64), Buffer.from(sigBase64.trim(), 'base64'));
  } catch {
    return false;
  }
}

async function fetchText(url, fetchFn) {
  const r = await fetchFn(url, { headers: { 'User-Agent': require('./version').userAgent } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
  return r.text();
}

/** The verified release description (parsed latest.json). Throws if the signature is wrong. */
async function fetchRelease({ base, keyBase64, fetchFn = fetchWithTimeout }) {
  const [json, sig] = await Promise.all([
    fetchText(base + '/latest.json', fetchFn),
    fetchText(base + '/latest.json.sig', fetchFn),
  ]);
  if (!verifySignature(json, sig, keyBase64)) throw new Error('The release list is not signed with the Azure release key: ignored.');
  return JSON.parse(json);
}

const usable = (b) => b && typeof b.file === 'string' && /^[A-Za-z0-9._+-]+\.jar$/.test(b.file) && /^[0-9a-f]{64}$/.test(b.sha256 || '');

/** The Legit build for a Minecraft version from a release description, or null if there is none. */
function pickBuild(release, mc) {
  if (release.builds && usable(release.builds[mc])) return release.builds[mc];
  if (usable(release.legit) && (release.minecraft || DEFAULT_MC) === mc) return release.legit;
  return null;
}

/** Every Minecraft version that has an Azure Legit build. */
function azureVersions(release) {
  const out = new Set();
  if (usable(release.legit)) out.add(release.minecraft || DEFAULT_MC);
  for (const [mc, b] of Object.entries(release.builds || {})) if (usable(b)) out.add(mc);
  return out;
}

/** True if version a is older than b (dotted numbers, e.g. 1.2.9 < 1.2.21). Unknown versions are never "older". */
function olderThan(a, b) {
  const nums = (v) => String(v || '').trim().replace(/^v/i, '').replace(/[-+].*$/, '').split('.').map(Number);
  const pa = nums(a);
  const pb = nums(b);
  if (!a || !b || pa.some(Number.isNaN) || pb.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

const STATE = 'installed.json'; // dir/installed.json: { "<mc>": { file, sha256, version } } = the last jar that passed every check

function readState(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, STATE), 'utf8')) || {}; } catch { return {}; }
}

function writeState(dir, state) {
  require('./atomic').writeJsonAtomic(path.join(dir, STATE), state);
}

/** The jar that last passed every check for this Minecraft version, if it is still there and still clean; else null. */
async function installedJar(dir, mc) {
  const rec = readState(dir)[mc];
  if (!rec || !/^[A-Za-z0-9._+-]+\.jar$/.test(rec.file || '')) return null;
  const file = path.join(dir, rec.file);
  if (!fs.existsSync(file) || (await hashFile(file, 'sha256')) !== rec.sha256 || checkLegitJar(file).length) return null;
  return { path: file, version: rec.version };
}

/**
 * Makes sure the Legit jar for Minecraft `mc` is in dir; returns { path, version } (or null if that version has no build).
 * A new jar is downloaded into a staging folder and only moved into place after it passed everything: the signed list's
 * signature, its SHA-256 and size, and the guard. Until then the jar that is already installed is untouched; if anything
 * fails (offline, a forged list, a tampered file, a jar the guard refuses) the installed jar keeps being used
 * ({ ..., fallback: <reason> }). Only with nothing installed does the failure reach the caller.
 */
async function ensureLegitJar({ base, keyBase64, dir, mc = DEFAULT_MC, fetchFn = fetchWithTimeout, log = () => {}, release }) {
  try {
    const rel = release || await fetchRelease({ base, keyBase64, fetchFn });
    const build = pickBuild(rel, mc);
    if (!build) return null;
    // An older signed list served again (a replay or a stale mirror) never takes a player back to an older Azure (AUDIT L1).
    const before = readState(dir)[mc];
    if (before && olderThan(build.version || rel.version, before.version)) {
      throw new Error('The release list offers Azure ' + (build.version || rel.version) + ', older than the installed ' + before.version + ': ignored.');
    }
    const dest = path.join(dir, build.file);
    const stage = path.join(dir, '.staging', build.file);
    fs.mkdirSync(dir, { recursive: true });
    const have = fs.existsSync(dest) && (await hashFile(dest, 'sha256')) === build.sha256 && !checkLegitJar(dest).length;
    if (!have) {
      fs.rmSync(stage, { force: true });
      await download(base + '/' + build.file, stage, { sha256: build.sha256 });
      try {
        if (build.size && fs.statSync(stage).size !== build.size) throw new Error('The downloaded jar has the wrong size: removed.');
        const problems = checkLegitJar(stage);
        if (problems.length) throw new Error('This jar is not a clean Legit jar and was removed: ' + problems.join('; '));
      } catch (e) {
        fs.rmSync(stage, { force: true });
        throw e;
      }
      fs.renameSync(stage, dest);
    }
    const state = readState(dir);
    const old = state[mc];
    state[mc] = { file: build.file, sha256: build.sha256, version: build.version || rel.version };
    writeState(dir, state);
    if (old && old.file !== build.file && /^[A-Za-z0-9._+-]+\.jar$/.test(old.file || '')) fs.rmSync(path.join(dir, old.file), { force: true }); // the new one is in: the old one can go
    try { fs.rmdirSync(path.join(dir, '.staging')); } catch { /* not empty or not there */ }
    log((have ? 'Up to date: ' : 'Downloaded ') + build.file);
    return { path: dest, version: state[mc].version };
  } catch (e) {
    try { fs.rmdirSync(path.join(dir, '.staging')); } catch { /* not empty or not there */ }
    const keep = await installedJar(dir, mc).catch(() => null);
    if (!keep) throw e;
    log('[AZURE] Update not applied (' + e.message + '): using Azure ' + keep.version + ', which is already installed.');
    return { ...keep, fallback: e.message };
  }
}

module.exports = { verifySignature, fetchRelease, ensureLegitJar, pickBuild, azureVersions, olderThan, DEFAULT_MC };
