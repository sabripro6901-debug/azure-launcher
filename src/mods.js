'use strict';
// Mods the launcher keeps in the game's mods folder: the pinned list from the config (downloaded from their own
// sources and checked by hash), plus the Azure Client Legit jar (see guard.js).
const fs = require('node:fs');
const path = require('node:path');
const { download } = require('./net');
const { checkLegitJar } = require('./guard');

async function ensureMods(gameDir, list, log = () => {}) {
  const dir = path.join(gameDir, 'mods');
  fs.mkdirSync(dir, { recursive: true });
  for (const m of list) {
    // a plain .jar name only: a hand-edited instances.json can't place a file outside mods/ (AUDIT L10)
    if (typeof m.file !== 'string' || !/^[^\\/:*?"<>|\x00-\x1f]+\.jar$/i.test(m.file) || m.file !== path.basename(m.file) || m.file.startsWith('.')) {
      throw new Error('Refused a mod file name from the instance list: ' + JSON.stringify(String(m.file).slice(0, 80)));
    }
    const got = await download(m.url, path.join(dir, m.file), { sha512: m.sha512 });
    log((got ? 'downloaded ' : 'ok ') + m.name);
  }
}

/** Puts exactly one Azure jar into mods/ (older Azure jars are removed). A jar that is not a clean Legit jar is refused. */
function installAzureJar(gameDir, jarPath) {
  const problems = checkLegitJar(jarPath);
  if (problems.length) {
    throw new Error('Refusing to install ' + jarPath + ': ' + problems.join('; '));
  }
  const dir = path.join(gameDir, 'mods');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    if (/^(azure|aurora)-client.*\.jar$/i.test(f)) fs.rmSync(path.join(dir, f), { force: true });
  }
  const dest = path.join(dir, path.basename(jarPath));
  fs.copyFileSync(jarPath, dest);
  return dest;
}

/** An instance on a version without an Azure build must not keep an Azure jar from before. */
function removeAzureJars(gameDir) {
  const dir = path.join(gameDir, 'mods');
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (/^(azure|aurora)-client.*\.jar$/i.test(f)) fs.rmSync(path.join(dir, f), { force: true });
  }
}

module.exports = { ensureMods, installAzureJar, removeAzureJars };
