'use strict';
// Java for the game: Mojang's own runtime for this Minecraft version (Java 21 for 1.21.x), downloaded from Mojang.
const fs = require('node:fs');
const path = require('node:path');
const { getJson, download, pool } = require('./net');

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
  if (fs.existsSync(exe) && fs.existsSync(marker)) return exe;
  const all = await getJson(ALL);
  const entry = all[key] && all[key][component] && all[key][component][0];
  if (!entry) throw new Error('Mojang has no ' + component + ' runtime for ' + key);
  const manifest = await getJson(entry.manifest.url);
  const files = Object.entries(manifest.files).filter(([, f]) => f.type === 'file');
  log('Java ' + component + ': ' + files.length + ' files');
  let done = 0;
  await pool(files, 8, async ([rel, f]) => {
    const dest = path.join(dir, rel);
    await download(f.downloads.raw.url, dest, { sha1: f.downloads.raw.sha1 });
    if (f.executable && process.platform !== 'win32') fs.chmodSync(dest, 0o755);
    if (++done % 100 === 0) log('  java ' + done + '/' + files.length);
  });
  fs.writeFileSync(marker, new Date().toISOString());
  return exe;
}

module.exports = { ensureJava, platformKey };
