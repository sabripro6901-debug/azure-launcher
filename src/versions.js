'use strict';
// Which Minecraft versions can be chosen, and what each one gets: Mojang's manifest for the list, Fabric's meta server
// for Fabric support and the loader version, Modrinth for the matching Fabric API (checked by its published SHA-512).
const { getJson } = require('./net');
const { userAgent } = require('./version');

const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const FABRIC_GAMES = 'https://meta.fabricmc.net/v2/versions/game';
const FABRIC_LOADERS = 'https://meta.fabricmc.net/v2/versions/loader/';
const MODRINTH = 'https://api.modrinth.com/v2';

/** 1.13 is where the version JSON got the format this launcher reads; older releases are not offered yet. */
const OLDEST = [1, 13];

function releaseOrder(id) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(id);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

function atLeastOldest(id) {
  const v = releaseOrder(id);
  return !!v && (v[0] > OLDEST[0] || (v[0] === OLDEST[0] && v[1] >= OLDEST[1]));
}

/**
 * The choosable versions, newest first: [{ id, type, fabric, azure }].
 * azureSet: versions with an Azure build (from the signed channel); null if the channel could not be read.
 */
async function listVersions({ snapshots = false, azureSet = null, fetchJson = getJson } = {}) {
  const [manifest, games] = await Promise.all([fetchJson(MANIFEST), fetchJson(FABRIC_GAMES).catch(() => [])]);
  const fabric = new Set(games.map((g) => g.version));
  return manifest.versions
    .filter((v) => (v.type === 'release' && atLeastOldest(v.id)) || (snapshots && v.type === 'snapshot'))
    .map((v) => ({ id: v.id, type: v.type, fabric: fabric.has(v.id), azure: !!azureSet && azureSet.has(v.id) }));
}

/** The newest stable Fabric Loader for a Minecraft version, or null if Fabric does not support it. */
async function fabricLoaderFor(mc, fetchJson = getJson) {
  const list = await fetchJson(FABRIC_LOADERS + encodeURIComponent(mc)).catch(() => []);
  const stable = list.find((l) => l.loader && l.loader.stable) || list[0];
  return stable ? stable.loader.version : null;
}

/** The newest release of Fabric API for a Minecraft version, as a pinned mod entry, or null. */
async function fabricApiFor(mc, fetchJson = getJson) {
  const q = '?loaders=' + encodeURIComponent('["fabric"]') + '&game_versions=' + encodeURIComponent(JSON.stringify([mc]));
  const versions = await fetchJson(MODRINTH + '/project/fabric-api/version' + q).catch(() => []);
  const v = versions.find((x) => x.version_type === 'release') || versions[0];
  if (!v) return null;
  const file = v.files.find((f) => f.primary) || v.files[0];
  if (!file || !file.hashes || !file.hashes.sha512 || !/^[A-Za-z0-9._+-]+\.jar$/.test(file.filename)) return null;
  return { name: 'Fabric API', file: file.filename, url: file.url, sha512: file.hashes.sha512, locked: true };
}

module.exports = { listVersions, fabricLoaderFor, fabricApiFor, atLeastOldest, userAgent };
