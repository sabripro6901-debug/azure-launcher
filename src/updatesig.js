'use strict';
// The launcher only installs an update of itself that the maintainer signed (AUDIT H4). GitHub alone is not trusted:
// electron-updater's SHA-512 check compares the installer with latest.yml, and both come from the same release.
// Each release also carries launcher-update.json (version, installer name, SHA-256) and launcher-update.json.sig, an
// Ed25519 signature made on the maintainer's PC with a private key that is never in this repo or in GitHub. The
// public key is built into the launcher (config/launcher-update-key.txt). Anything that doesn't match is refused.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { hashFile, fetchWithTimeout } = require('./net');

const MANIFEST = 'launcher-update.json';
const MAX_MANIFEST = 4096;

function verifySig(data, sigBase64, keyBase64) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(String(keyBase64).trim(), 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') return false;
    return crypto.verify(null, Buffer.from(data), key, Buffer.from(String(sigBase64).trim(), 'base64'));
  } catch {
    return false;
  }
}

async function getText(url, fetchFn) {
  const r = await fetchFn(url, { headers: { 'User-Agent': require('./version').userAgent } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
  const t = await r.text();
  if (t.length > MAX_MANIFEST) throw new Error('Update description too large: ' + url);
  return t;
}

/**
 * Throws unless the downloaded installer is the one the maintainer signed for exactly this version.
 * files: what electron-updater's downloadUpdate() returned (the installer path among them).
 */
async function verifyLauncherUpdate({ owner, repo, version, files, keyBase64, fetchFn = fetchWithTimeout }) {
  if (!keyBase64 || !String(keyBase64).trim()) throw new Error('No launcher update key built in: update refused.');
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) throw new Error('Unexpected update version: ' + version);
  const base = 'https://github.com/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/releases/download/v' + version + '/';
  const [json, sig] = await Promise.all([getText(base + MANIFEST, fetchFn), getText(base + MANIFEST + '.sig', fetchFn)]);
  if (!verifySig(json, sig, keyBase64)) throw new Error('The launcher update is not signed with the Azure launcher key: refused.');
  let m;
  try { m = JSON.parse(json); } catch { throw new Error('The signed update description is not valid JSON: refused.'); }
  if (!m || m.version !== version) throw new Error('The signed update is for ' + (m && m.version) + ', not ' + version + ': refused.');
  if (typeof m.file !== 'string' || !/^[A-Za-z0-9._ -]+\.exe$/.test(m.file) || !/^[0-9a-f]{64}$/.test(m.sha256 || '')) {
    throw new Error('The signed update description is incomplete: refused.');
  }
  const installer = (files || []).find((f) => typeof f === 'string' && path.basename(f).toLowerCase().endsWith('.exe'));
  if (!installer || !fs.existsSync(installer)) throw new Error('The downloaded installer was not found: refused.');
  // electron-updater may save it under its own name; the signed name must still match it (dashes vs spaces aside)
  const norm = (n) => n.toLowerCase().replace(/[ _-]+/g, '-');
  if (norm(path.basename(installer)) !== norm(m.file)) throw new Error('The downloaded installer is not the signed file (' + m.file + '): refused.');
  const got = await hashFile(installer, 'sha256');
  if (got !== m.sha256) throw new Error('The downloaded installer is not the signed one (SHA-256 differs): refused.');
  return { version: m.version, file: m.file, sha256: m.sha256 };
}

module.exports = { verifyLauncherUpdate, verifySig, MANIFEST };
