'use strict';
// The Fabric Loader profile (a version JSON that inherits from vanilla), from Fabric's own meta server.
const fs = require('node:fs');
const path = require('node:path');
const { getJson } = require('./net');
const { writeJsonAtomic } = require('./atomic');
const { versionId } = require('./safepath');

async function ensureFabricProfile(root, mcVersion, loaderVersion) {
  const url = 'https://meta.fabricmc.net/v2/versions/loader/' + mcVersion + '/' + loaderVersion + '/profile/json';
  const profile = await getJson(url);
  const id = versionId(profile.id); // fabric-loader-<loader>-<mc>; checked: it becomes a folder name (AUDIT M3)
  if (profile.inheritsFrom != null) versionId(profile.inheritsFrom);
  const file = path.join(root, 'versions', id, id + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, profile);
  return id;
}

module.exports = { ensureFabricProfile };
