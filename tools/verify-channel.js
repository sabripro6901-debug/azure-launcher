'use strict';
// Downloads the Legit jar of every Minecraft version listed in the signed release channel and checks it the way the
// launcher does: signature of latest.json, then each jar's SHA-256, size and the Legit guard. Exit 1 on any problem.
//   node tools/verify-channel.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fetchRelease, azureVersions, ensureLegitJar } = require('../src/channel');

(async () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'launcher.config.json'), 'utf8'));
  const keyBase64 = fs.readFileSync(path.join(__dirname, '..', 'config', 'release-key.txt'), 'utf8');
  const base = config.updateChannel.base;
  const release = await fetchRelease({ base, keyBase64 }); // throws if the signature is wrong
  console.log('signature ok, release ' + release.version);
  const versions = [...azureVersions(release)];
  if (!versions.length) throw new Error('the release lists no Legit jar');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-channel-'));
  try {
    for (const mc of versions) {
      const got = await ensureLegitJar({ base, keyBase64, dir, mc, release }); // sha256 + size + guard; no fallback in an empty dir
      console.log('Minecraft ' + mc + ': ' + path.basename(got.path) + ' (Azure ' + got.version + ') sha256, size and guard ok');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('CHANNEL-OK');
})().catch((e) => { console.error('CHANNEL CHECK FAILED: ' + e.message); process.exit(1); });
