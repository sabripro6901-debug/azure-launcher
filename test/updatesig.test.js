'use strict';
// AUDIT H4: the launcher installs only an update the maintainer signed for exactly that version and installer.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyLauncherUpdate } = require('../src/updatesig');

const pair = () => crypto.generateKeyPairSync('ed25519');
const pub = (k) => k.export({ type: 'spki', format: 'der' }).toString('base64');

function release({ key, version = '2.0.0', bytes = 'installer bytes', manifest, sig } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-upd-'));
  const exe = path.join(dir, 'Azure-Launcher-Setup-' + version + '.exe');
  fs.writeFileSync(exe, bytes);
  const json = manifest || JSON.stringify({ version, file: path.basename(exe), sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  const signature = sig || crypto.sign(null, Buffer.from(json), key).toString('base64');
  const asked = [];
  const fetchFn = async (url) => {
    asked.push(url);
    const body = url.endsWith('.sig') ? signature : json;
    return { ok: true, status: 200, text: async () => body };
  };
  return { dir, exe, fetchFn, asked };
}

const opts = (r, k, over = {}) => ({ owner: 'someone', repo: 'azure-launcher', version: '2.0.0', files: [r.exe], keyBase64: pub(k), fetchFn: r.fetchFn, ...over });

test('a correctly signed update passes, read from that version\'s own release', async () => {
  const { publicKey, privateKey } = pair();
  const r = release({ key: privateKey });
  const ok = await verifyLauncherUpdate(opts(r, publicKey));
  assert.strictEqual(ok.version, '2.0.0');
  assert.ok(r.asked.every((u) => u.startsWith('https://github.com/someone/azure-launcher/releases/download/v2.0.0/launcher-update.json')));
});

test('refused: signed with another key (a leaked GitHub token is not enough)', async () => {
  const mine = pair(), theirs = pair();
  const r = release({ key: theirs.privateKey });
  await assert.rejects(verifyLauncherUpdate(opts(r, mine.publicKey)), /not signed/);
});

test('refused: the installer is not the signed one', async () => {
  const { publicKey, privateKey } = pair();
  const r = release({ key: privateKey });
  fs.writeFileSync(r.exe, 'something else');
  await assert.rejects(verifyLauncherUpdate(opts(r, publicKey)), /SHA-256/);
});

test('refused: an old signed description replayed for a newer version', async () => {
  const { publicKey, privateKey } = pair();
  const r = release({ key: privateKey, version: '1.5.0' });
  await assert.rejects(verifyLauncherUpdate(opts(r, publicKey, { version: '2.0.0' })), /for 1\.5\.0/);
});

test('refused: no key built in, a bad signature, or no installer', async () => {
  const { publicKey, privateKey } = pair();
  const r = release({ key: privateKey });
  await assert.rejects(verifyLauncherUpdate(opts(r, publicKey, { keyBase64: '' })), /No launcher update key/);
  await assert.rejects(verifyLauncherUpdate(opts(release({ key: privateKey, sig: 'AAAA' }), publicKey)), /not signed/);
  await assert.rejects(verifyLauncherUpdate(opts(r, publicKey, { files: [] })), /not found/);
});

test('the private key is never in the repo', () => {
  const root = path.join(__dirname, '..');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (['node_modules', '.git', 'dist', 'dev-local'].includes(e.name) ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(root)) {
    if (f === __filename || /\.(png|ico|exe|jar|zip)$/i.test(f)) continue;
    assert.ok(!fs.readFileSync(f, 'utf8').includes('PRIVATE KEY-----'), f + ' holds a private key');
  }
});

test('the launcher has its update key built in (public key only)', () => {
  const txt = fs.readFileSync(path.join(__dirname, '..', 'config', 'launcher-update-key.txt'), 'utf8');
  const key = crypto.createPublicKey({ key: Buffer.from(txt.trim(), 'base64'), format: 'der', type: 'spki' });
  assert.strictEqual(key.asymmetricKeyType, 'ed25519');
  assert.ok(!/PRIVATE/.test(txt));
});
