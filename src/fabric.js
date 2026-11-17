'use strict';
// The Fabric Loader profile (a version JSON that inherits from vanilla), from Fabric's own meta server.
const fs = require('node:fs');
const path = require('node:path');
const { getJson } = require('./net');

async function ensureFabricProfile(root, mcVersion, loaderVersion) {
  const url = 'https://meta.fabricmc.net/v2/versions/loader/' + mcVersion + '/' + loaderVersion + '/profile/json';
  const profile = await getJson(url);
  const id = profile.id; // fabric-loader-<loader>-<mc>
  const file = path.join(root, 'versions', id, id + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(profile, null, 2));
  return id;
}

module.exports = { ensureFabricProfile };
