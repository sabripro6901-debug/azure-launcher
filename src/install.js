'use strict';
// Installs a Minecraft version the way Mojang's version JSON describes it: the client jar, the libraries, the natives,
// the asset index and every asset object, and the log config. Everything comes from Mojang's servers (Fabric's own
// libraries from Fabric's maven) and every file is checked against the SHA-1 / SHA-512 in the manifest before it is
// kept. Nothing here is redistributed by us.
const fs = require('node:fs');
const path = require('node:path');
const { unzipSync } = require('fflate');
const { getJson, download, pool, fetchSha1, openHashCache } = require('./net');
const { inside, versionId } = require('./safepath');

const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const ASSET_HOST = 'https://resources.download.minecraft.net/';

function osName() {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
}

function osArch() {
  return process.arch === 'ia32' ? 'x86' : process.arch;
}

/** Mojang's rules: no rules = allowed; otherwise the last matching rule decides. */
function ruleAllows(rules, features = {}) {
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const r of rules) {
    let match = true;
    if (r.os) {
      if (r.os.name && r.os.name !== osName()) match = false;
      if (r.os.arch && r.os.arch !== osArch()) match = false;
      if (r.os.version && !new RegExp(r.os.version).test(require('node:os').release())) match = false;
    }
    if (match && r.features) {
      for (const [k, v] of Object.entries(r.features)) if (!!features[k] !== v) match = false;
    }
    if (match) allowed = r.action === 'allow';
  }
  return allowed;
}

/** group:artifact:version[:classifier] -> maven path. */
function mavenPath(name) {
  const [coords, ext = 'jar'] = name.split('@');
  const [group, artifact, version, classifier] = coords.split(':');
  const file = artifact + '-' + version + (classifier ? '-' + classifier : '') + '.' + ext;
  return group.replace(/\./g, '/') + '/' + artifact + '/' + version + '/' + file;
}

/** Merges a version JSON with the one it inherits from (Fabric's profile inherits from vanilla). Child libraries first. */
function mergeVersions(parent, child) {
  const out = { ...parent, ...child };
  out.libraries = [...(child.libraries || []), ...(parent.libraries || [])];
  out.arguments = {
    jvm: [...((parent.arguments && parent.arguments.jvm) || []), ...((child.arguments && child.arguments.jvm) || [])],
    game: [...((parent.arguments && parent.arguments.game) || []), ...((child.arguments && child.arguments.game) || [])],
  };
  for (const k of ['assetIndex', 'assets', 'downloads', 'javaVersion', 'logging']) if (!child[k]) out[k] = parent[k];
  return out;
}

/** The vanilla version JSON, from Mojang's manifest (the manifest carries its SHA-1). */
async function fetchVanilla(root, id) {
  versionId(id);
  const manifest = await getJson(MANIFEST);
  const entry = manifest.versions.find((v) => v.id === id);
  if (!entry) throw new Error('Mojang has no Minecraft version ' + id);
  const file = path.join(root, 'versions', id, id + '.json');
  await download(entry.url, file, { sha1: entry.sha1 });
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Versions before 1.13 list their game arguments as one string: turn that into the newer list form. */
function normalizeArguments(v) {
  if (!v.arguments) {
    v.arguments = {
      jvm: ['-Djava.library.path=${natives_directory}', '-Dminecraft.launcher.brand=${launcher_name}', '-Dminecraft.launcher.version=${launcher_version}', '-cp', '${classpath}'],
      game: String(v.minecraftArguments || '').split(' ').filter(Boolean),
    };
  }
  return v;
}

/** Loads a version by id (a local profile such as Fabric's, or a vanilla version) with its parents merged. */
async function loadVersion(root, id) {
  versionId(id); // also every inheritsFrom on the way down (AUDIT M3)
  const local = path.join(root, 'versions', id, id + '.json');
  const data = normalizeArguments(fs.existsSync(local) ? JSON.parse(fs.readFileSync(local, 'utf8')) : await fetchVanilla(root, id));
  if (!data.inheritsFrom) return data;
  return mergeVersions(await loadVersion(root, data.inheritsFrom), data);
}

/** The files a library needs on this machine: [{ path, url, sha1, sha512, natives }]. */
function libraryFiles(lib) {
  if (!ruleAllows(lib.rules)) return [];
  const out = [];
  const natives = lib.natives && lib.natives[osName()] ? lib.natives[osName()].replace('${arch}', process.arch === 'ia32' ? '32' : '64') : null;
  const art = lib.downloads && lib.downloads.artifact;
  if (art) {
    out.push({ path: art.path, url: art.url, sha1: art.sha1, natives: /:natives-/.test(lib.name) });
  } else if (!lib.downloads) {
    const p = mavenPath(lib.name);
    out.push({ path: p, url: (lib.url || 'https://libraries.minecraft.net/') + p, sha1: lib.sha1, sha512: lib.sha512, natives: /:natives-/.test(lib.name) });
  }
  if (natives && lib.downloads && lib.downloads.classifiers && lib.downloads.classifiers[natives]) {
    const c = lib.downloads.classifiers[natives];
    out.push({ path: c.path, url: c.url, sha1: c.sha1, natives: true, onlyNatives: true });
  }
  return out;
}

/** Same group:artifact[:classifier] twice: the first (child) one wins. */
function dedupeLibraries(libs) {
  const seen = new Set();
  const out = [];
  for (const lib of libs) {
    const [g, a, , c] = lib.name.split('@')[0].split(':');
    // old versions list a library twice: once for the jar, once (with "natives") for its per-OS native files; both are needed
    const key = g + ':' + a + ':' + (c || '') + (lib.natives ? ':natives' : '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(lib);
  }
  return out;
}

function extractNatives(jar, dir) {
  const files = unzipSync(new Uint8Array(fs.readFileSync(jar)), { filter: (f) => /\.(dll|so|dylib|jnilib)$/i.test(f.name) });
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, path.basename(name)), data); // flat, basename only: no path from the zip is trusted
  }
}

/**
 * Installs `id` (e.g. the Fabric profile id) under root and returns what the launch needs:
 * { version, classpath: [absolute jar paths], clientJar, nativesDir, assetsDir, assetIndexId, logConfig }.
 */
async function install(root, id, log = () => {}) {
  const cache = openHashCache(path.join(root, 'hash-cache.json')); // files already checked are not read again (AUDIT M2)
  try {
    return await installWith(root, id, log, cache);
  } finally {
    try { cache.save(); } catch { /* a cache only */ }
  }
}

async function installWith(root, id, log, cache) {
  const v = await loadVersion(root, id);
  const mc = v.inheritsFrom || v.id;
  const libsDir = path.join(root, 'libraries');
  const nativesDir = path.join(root, 'versions', mc, 'natives');

  const clientJar = path.join(root, 'versions', mc, mc + '.jar');
  const c = v.downloads && v.downloads.client;
  if (!c) throw new Error('Version ' + mc + ' has no client download');
  await download(c.url, clientJar, { sha1: c.sha1, cache });
  log('client jar ok');

  const wanted = [];
  for (const lib of dedupeLibraries(v.libraries)) wanted.push(...libraryFiles(lib));
  let done = 0;
  const classpath = [];
  await pool(wanted, 12, async (f) => {
    const dest = inside(libsDir, f.path); // the path comes from the version JSON (AUDIT M3)
    // Fabric's profile lists no hash for a few of its own libraries: the maven server publishes a .sha1 next to each file.
    // Already checked against that .sha1 before and unchanged since: no need to ask the server again.
    if (!f.sha1 && !f.sha512) f.sha1 = cache.known(dest, 'sha1') || await fetchSha1(f.url + '.sha1');
    await download(f.url, dest, { sha1: f.sha1, sha512: f.sha512, cache });
    if (f.natives) extractNatives(dest, nativesDir);
    if (++done % 25 === 0) log('libraries ' + done + '/' + wanted.length);
  });
  for (const f of wanted) { const p = inside(libsDir, f.path); if (!f.onlyNatives && !classpath.includes(p)) classpath.push(p); }
  log('libraries ok (' + wanted.length + ')');

  const ai = v.assetIndex;
  const indexFile = path.join(root, 'assets', 'indexes', versionId(ai.id) + '.json');
  await download(ai.url, indexFile, { sha1: ai.sha1, cache });
  const objects = Object.values(JSON.parse(fs.readFileSync(indexFile, 'utf8')).objects);
  const unique = [...new Map(objects.map((o) => [o.hash, o])).values()];
  let got = 0;
  await pool(unique, 24, async (o) => {
    if (!/^[0-9a-f]{40}$/.test(String(o.hash))) throw new Error('Refused an asset with a bad hash in the index');
    const dir = o.hash.slice(0, 2);
    await download(ASSET_HOST + dir + '/' + o.hash, path.join(root, 'assets', 'objects', dir, o.hash), { sha1: o.hash, cache });
    if (++got % 500 === 0) log('assets ' + got + '/' + unique.length);
  });
  log('assets ok (' + unique.length + ')');

  let logConfig = null;
  const lc = v.logging && v.logging.client;
  if (lc && lc.file) {
    logConfig = { file: inside(path.join(root, 'assets', 'log_configs'), path.basename(String(lc.file.id))), argument: lc.argument };
    await download(lc.file.url, logConfig.file, { sha1: lc.file.sha1, cache });
  }
  return { version: v, classpath, clientJar, nativesDir, assetsDir: path.join(root, 'assets'), assetIndexId: ai.id, logConfig, mc };
}

module.exports = { install, loadVersion, normalizeArguments, ruleAllows, mavenPath, mergeVersions, dedupeLibraries, libraryFiles, osName };
