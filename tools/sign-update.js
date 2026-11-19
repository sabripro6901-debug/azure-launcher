'use strict';
// Signs a launcher release on the maintainer's PC (AUDIT H4). The private key lives only in
// %USERPROFILE%\.azure-launcher-update-key: never in this repo, never in GitHub, never printed.
//
//   node tools/sign-update.js keygen          once: makes the key pair, writes the public key to config/launcher-update-key.txt
//   node tools/sign-update.js sign <folder>   each release: <folder> holds Azure-Launcher-Setup-<version>.exe (the CI artifact);
//                                             writes launcher-update.json and launcher-update.json.sig next to it
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifySig, MANIFEST } = require('../src/updatesig');

const ROOT = path.join(__dirname, '..');
const KEY_FILE = process.env.AZURE_LAUNCHER_UPDATE_KEY || path.join(os.homedir(), '.azure-launcher-update-key');
const PUB_FILE = path.join(ROOT, 'config', 'launcher-update-key.txt');

function die(m) { console.error(m); process.exit(1); }

function keygen() {
  if (fs.existsSync(KEY_FILE)) die('A launcher update key already exists (' + KEY_FILE + '). Not replaced: installed launchers trust that one.');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(KEY_FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(PUB_FILE, publicKey.export({ type: 'spki', format: 'der' }).toString('base64') + '\n');
  console.log('Private key saved to ' + KEY_FILE + ' (keep a backup offline; never commit it).');
  console.log('Public key written to config/launcher-update-key.txt (commit this one).');
}

function sign(folder) {
  if (!folder) die('Usage: node tools/sign-update.js sign <folder with the installer>');
  if (!fs.existsSync(KEY_FILE)) die('No launcher update key at ' + KEY_FILE + '. Run keygen once first.');
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const file = 'Azure-Launcher-Setup-' + version + '.exe';
  const exe = path.join(folder, file);
  if (!fs.existsSync(exe)) die('Not found: ' + exe + ' (package.json says version ' + version + ').');
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
  const json = JSON.stringify({ version, file, sha256 }, null, 2) + '\n';
  const key = crypto.createPrivateKey(fs.readFileSync(KEY_FILE));
  const sig = crypto.sign(null, Buffer.from(json), key).toString('base64');
  if (!verifySig(json, sig, fs.readFileSync(PUB_FILE, 'utf8'))) die('The signature does not match config/launcher-update-key.txt: nothing written.');
  fs.writeFileSync(path.join(folder, MANIFEST), json);
  fs.writeFileSync(path.join(folder, MANIFEST + '.sig'), sig + '\n');
  console.log('Signed ' + file + ' (' + version + ', sha256 ' + sha256 + ').');
  console.log('Attach ' + MANIFEST + ' and ' + MANIFEST + '.sig to the v' + version + ' release, next to the installer, its .blockmap and latest.yml.');
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'keygen') keygen();
else if (cmd === 'sign') sign(arg);
else die('Usage: node tools/sign-update.js keygen | sign <folder>');
