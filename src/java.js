'use strict';
// Java for the game: Mojang's own runtime for this Minecraft version (Java 21 for 1.21.x), downloaded from Mojang.
const fs = require('node:fs');
const path = require('node:path');
const { getJson, download, pool, openHashCache } = require('./net');
const { inside } = require('./safepath');

const ALL = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

function platformKey() {
  if (process.platform === 'win32') return process.arch === 'arm64' ? 'windows-arm64' : process.arch === 'ia32' ? 'windows-x86' : 'windows-x64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  return process.arch === 'ia32' ? 'linux-i386' : 'linux';
}

/** Makes sure the runtime `component` (from the version JSON, e.g. java-runtime-delta) is installed; returns the java executable. */
async function ensureJava(root, component, log = () => {}) {
  const key = platformKey();
  const dir = path.join(root, 'runtime', component, key, component);
  const exe = path.join(dir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const marker = path.join(dir, '.azure-complete');
  // The runtime's file list, kept next to it once its SHA-1 from all.json matched (AUDIT M3).
  const manifestFile = path.join(root, 'runtime', component, key, 'manifest.json');
  const cache = openHashCache(path.join(root, 'hash-cache.json'));
  try {
    if (!(fs.existsSync(exe) && fs.existsSync(marker) && fs.existsSync(manifestFile))) {
      const all = await getJson(ALL);
      const entry = all[key] && all[key][component] && all[key][component][0];
      if (!entry) throw new Error('Mojang has no ' + component + ' runtime for ' + key);
      if (!/^[0-9a-f]{40}$/.test(String(entry.manifest && entry.manifest.sha1))) throw new Error('Mojang lists no SHA-1 for the ' + component + ' file list');
      await download(entry.manifest.url, manifestFile, { sha1: entry.manifest.sha1, cache });
    }
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const files = Object.entries(manifest.files).filter(([, f]) => f.type === 'file');
    const complete = fs.existsSync(marker);
    if (!complete) log('Java ' + component + ': ' + files.length + ' files');
    let done = 0, fixed = 0;
    // Every start: each file is checked again (cheap: unchanged files are known by the hash cache); a changed or
    // missing one is downloaded again.
    await pool(files, 8, async ([rel, f]) => {
      const dest = inside(dir, rel);
      if (await download(f.downloads.raw.url, dest, { sha1: f.downloads.raw.sha1, cache })) fixed++;
      if (f.executable && process.platform !== 'win32') fs.chmodSync(dest, 0o755);
      if (!complete && ++done % 100 === 0) log('  java ' + done + '/' + files.length);
    });
    if (complete && fixed) log('Java ' + component + ': ' + fixed + ' damaged or missing files downloaded again');
    if (!complete) fs.writeFileSync(marker, new Date().toISOString());
    return exe;
  } finally {
    try { cache.save(); } catch { /* a cache only */ }
  }
}

module.exports = { ensureJava, platformKey };
