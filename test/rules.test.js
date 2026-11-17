'use strict';
// The launcher's standing rules, as tests: no offline mode in src/, launch() only takes a verified account, only
// auth.js makes accounts, no other launcher's client ID anywhere, and the Legit guard runs before a jar is installed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { zipSync } = require('fflate');
const { launch } = require('../src/launch');
const { isVerifiedAccount, makeAccount } = require('../src/account');
const { installAzureJar } = require('../src/mods');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
const SRC = path.join(__dirname, '..', 'src');

test('src has no offline-account code', () => {
  for (const file of [...walk(SRC), ...walk(path.join(__dirname, '..', 'app'))]) {
    if (/renderer[\/](style\.css|icon\.png)$/.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const word of ['OfflinePlayer', 'getAuth', "type: 'offline'", "userType: 'legacy'"]) {
      assert.ok(!text.includes(word), file + ' contains ' + word);
    }
    if (!/app[\\/](app|devgate)\.js$/.test(file)) assert.ok(!text.includes('AZURE_DEV'), file + ' names the dev switch');
  }
});

test('launch refuses to start without a verified account', async () => {
  const fake = { name: 'x', uuid: 'y', accessToken: '0', userType: 'legacy', player() { return this; } };
  for (const bad of [null, undefined, {}, fake, { name: 'a' }]) {
    await assert.rejects(() => launch({ root: 'x', config: {}, account: bad, azureJar: 'x' }), /No account/);
  }
  assert.ok(isVerifiedAccount(makeAccount({ accessToken: 't', name: 'n', uuid: 'u' })));
  assert.ok(!isVerifiedAccount(fake));
});

test('only auth.js makes accounts', () => {
  for (const file of walk(SRC)) {
    if (/account\.js$|auth\.js$/.test(file)) continue;
    assert.ok(!fs.readFileSync(file, 'utf8').includes('makeAccount'), file + ' uses makeAccount');
  }
});

test('an account never shows its token when printed or serialised', () => {
  const a = makeAccount({ accessToken: 'SECRET-TOKEN-123', name: 'n', uuid: 'u' });
  assert.ok(!JSON.stringify(a).includes('SECRET'));
  assert.ok(!String(a).includes('SECRET'));
  assert.ok(!require('node:util').inspect(a).includes('SECRET'));
});

test('no other launcher client ID: prismarine defaults are never used', () => {
  const auth = fs.readFileSync(path.join(SRC, 'auth.js'), 'utf8');
  assert.ok(!/Titles\./.test(auth));
  assert.ok(!/389b1b32-b5d5-43b2-bddc-84ce938d6737|000000004C12AE6F/i.test(auth));
  assert.ok(/flow: 'msal'/.test(auth) && /authTitle: clientId/.test(auth));
});

function makeJar(files) {
  const entries = {};
  for (const [name, text] of Object.entries(files)) entries[name] = new TextEncoder().encode(text);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'azure-jar-')), 'azure-client-test.jar');
  fs.writeFileSync(file, zipSync(entries));
  return file;
}

// Names of files that only other editions have, kept encoded so the source names none of them.
const enc = (b64) => Buffer.from(b64, 'base64').toString();
const OWNER_CLASS = enc('Y29tL2F1cm9yYS9jbGllbnQvbW9kdWxlL093bmVyTW9kdWxlcy5jbGFzcw==');
const OLD_CLASS = enc('Y29tL2F1cm9yYS9jbGllbnQvbW9kdWxlL0NoZWF0TW9kdWxlcy5jbGFzcw==');
const OWNER_MIXINS = enc('YXVyb3JhLmhhY2tzLm1peGlucy5qc29u');
const OWNER_DIR_FILE = enc('Y29tL2F1cm9yYS9jbGllbnQvbWl4aW4vaGFja3Mv') + 'A.class';
const OWNER_ID = enc('c29sc3RpY2U=');

test('the Legit guard runs before any jar is installed', () => {
  const game = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-game-'));
  const legit = makeJar({ 'fabric.mod.json': JSON.stringify({ id: 'aurora', mixins: ['aurora.mixins.json'] }), 'a.class': 'x' });
  assert.ok(fs.existsSync(installAzureJar(game, legit)));
  const bad = [
    { 'fabric.mod.json': JSON.stringify({ id: 'aurora' }), [OWNER_CLASS]: 'x' },
    { 'fabric.mod.json': JSON.stringify({ id: 'aurora' }), [OLD_CLASS]: 'x' },
    { 'fabric.mod.json': JSON.stringify({ id: 'aurora' }), [OWNER_DIR_FILE]: 'x' },
    { 'fabric.mod.json': JSON.stringify({ id: OWNER_ID }) },
    { 'fabric.mod.json': JSON.stringify({ id: 'aurora', jars: [{ file: 'META-INF/jars/x.jar' }] }) },
    { 'fabric.mod.json': JSON.stringify({ id: 'aurora' }), 'META-INF/jars/seedcracker.jar': 'x' },
    { 'fabric.mod.json': JSON.stringify({ id: 'aurora', mixins: ['aurora.mixins.json', OWNER_MIXINS] }), [OWNER_MIXINS]: '{}' },
    { 'fabric.mod.json': JSON.stringify({ id: 'aurora' }), 'x.class': 'this mentions ' + OWNER_ID.toUpperCase() },
  ];
  const game2 = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-game-'));
  for (const files of bad) {
    assert.throws(() => installAzureJar(game2, makeJar(files)), /Refusing to install/);
  }
  assert.ok(!fs.existsSync(path.join(game2, 'mods')) || fs.readdirSync(path.join(game2, 'mods')).length === 0);
});
