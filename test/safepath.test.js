'use strict';
// AUDIT M3: the Java file list is hash-checked, a finished runtime is checked again, and no path from a download
// list can leave its folder.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { inside, versionId } = require('../src/safepath');
const { ensureJava, platformKey } = require('../src/java');
const { loadVersion } = require('../src/install');
const { ensureFabricProfile } = require('../src/fabric');

const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'azure-safe-'));
const BS = String.fromCharCode(92); // a backslash

// A fake internet: url -> body (string or Buffer). Anything else is a 404.
function serve(routes) {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    const body = routes[url];
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    const buf = Buffer.from(body);
    return {
      ok: true, status: 200, headers: new Map(),
      json: async () => JSON.parse(buf.toString('utf8')),
      text: async () => buf.toString('utf8'),
      body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(buf)); c.close(); } }),
    };
  };
  return { asked, restore: () => { globalThis.fetch = real; } };
}

const ALL = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
function runtime(files, { manifestSha1 } = {}) {
  const manifest = JSON.stringify({ files });
  const all = JSON.stringify({ [platformKey()]: { 'java-runtime-test': [{ manifest: { url: 'https://example.invalid/m.json', sha1: manifestSha1 || sha1(manifest) } }] } });
  return { [ALL]: all, 'https://example.invalid/m.json': manifest };
}
const file = (url, bytes) => ({ type: 'file', downloads: { raw: { url, sha1: sha1(bytes) } } });

test('inside() and versionId() refuse anything that leaves the folder', () => {
  const base = path.join(os.tmpdir(), 'base');
  assert.strictEqual(inside(base, 'bin/java.exe'), path.join(base, 'bin', 'java.exe'));
  for (const bad of ['../evil', 'bin/../../evil', '..' + BS + 'evil', '/etc/passwd', 'C:' + BS + 'Windows' + BS + 'x', 'C:x', '', 'a' + String.fromCharCode(0) + 'b']) assert.throws(() => inside(base, bad), bad);
  assert.strictEqual(versionId('fabric-loader-0.18.3-1.21.11'), 'fabric-loader-0.18.3-1.21.11');
  for (const bad of ['..', '../1.21', 'a/b', 'a' + BS + 'b', '', '.hidden']) assert.throws(() => versionId(bad), bad);
});

test('the Java file list must match its SHA-1 from all.json', async () => {
  const root = tmp();
  const net = serve(runtime({ 'bin/java.exe': file('https://example.invalid/j', 'java') }, { manifestSha1: '0'.repeat(40) }));
  try {
    await assert.rejects(ensureJava(root, 'java-runtime-test'), /Wrong sha1/);
  } finally { net.restore(); }
});

test('a Java file list with a path out of the runtime folder is refused and nothing is written outside', async () => {
  const root = tmp();
  const net = serve({ ...runtime({ '../../../../evil.txt': file('https://example.invalid/e', 'evil') }), 'https://example.invalid/e': 'evil' });
  try {
    await assert.rejects(ensureJava(root, 'java-runtime-test'), /Refused a file path/);
    assert.ok(!fs.existsSync(path.join(root, 'evil.txt')) && !fs.existsSync(path.join(root, '..', 'evil.txt')));
  } finally { net.restore(); }
});

test('a finished Java runtime is checked again: a damaged file is downloaded again', async () => {
  const root = tmp();
  const routes = { ...runtime({ 'bin/java.exe': file('https://example.invalid/j', 'java bytes') }), 'https://example.invalid/j': 'java bytes' };
  const net = serve(routes);
  try {
    const exe = await ensureJava(root, 'java-runtime-test');
    assert.strictEqual(fs.readFileSync(exe, 'utf8'), 'java bytes');
    fs.writeFileSync(exe, 'damaged'); // other size: a same-size rewrite in the same clock tick would look unchanged to the cache
    net.asked.length = 0;
    await ensureJava(root, 'java-runtime-test');
    assert.strictEqual(fs.readFileSync(exe, 'utf8'), 'java bytes');
    assert.deepStrictEqual(net.asked, ['https://example.invalid/j'], 'only the damaged file is fetched, not the lists');
  } finally { net.restore(); }
});

test('a version id or library path from a profile cannot leave the game folder', async () => {
  const root = tmp();
  await assert.rejects(loadVersion(root, '../../outside'), /Refused a version id/);
  const net = serve({ 'https://meta.fabricmc.net/v2/versions/loader/1.21.11/0.18.3/profile/json': JSON.stringify({ id: '../../evil', inheritsFrom: '1.21.11' }) });
  try {
    await assert.rejects(ensureFabricProfile(root, '1.21.11', '0.18.3'), /Refused a version id/);
  } finally { net.restore(); }
});

test('M4: a saved Fabric profile is used without asking the server; a missing or damaged one is fetched', async () => {
  const root = tmp();
  const id = 'fabric-loader-0.18.3-1.21.11';
  const url = 'https://meta.fabricmc.net/v2/versions/loader/1.21.11/0.18.3/profile/json';
  const profile = { id, inheritsFrom: '1.21.11', mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient', libraries: [] };
  const net = serve({ [url]: JSON.stringify(profile) });
  try {
    assert.strictEqual(await ensureFabricProfile(root, '1.21.11', '0.18.3'), id);
    assert.deepStrictEqual(net.asked, [url]);
    net.asked.length = 0;
    assert.strictEqual(await ensureFabricProfile(root, '1.21.11', '0.18.3'), id);
    assert.deepStrictEqual(net.asked, [], 'second start: no network');
    fs.writeFileSync(path.join(root, 'versions', id, id + '.json'), '{"id": "fabric-lo');
    assert.strictEqual(await ensureFabricProfile(root, '1.21.11', '0.18.3'), id);
    assert.deepStrictEqual(net.asked, [url], 'damaged: fetched again');
  } finally { net.restore(); }
});

test('M6: natives are written once; a second start leaves them alone (a running game holds them open)', () => {
  const { zipSync, strToU8 } = require('fflate');
  const { extractNatives } = require('../src/install');
  const root = tmp();
  const jar = path.join(root, 'lwjgl-natives-windows.jar');
  fs.writeFileSync(jar, zipSync({ 'windows/x64/org/lwjgl/lwjgl.dll': strToU8('dll bytes'), 'META-INF/MANIFEST.MF': strToU8('x') }));
  const dir = path.join(root, 'natives');
  assert.strictEqual(extractNatives(jar, dir), 1);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'lwjgl.dll'), 'utf8'), 'dll bytes');
  const real = fs.writeFileSync;
  fs.writeFileSync = (f, ...a) => { if (String(f).endsWith('.dll')) { const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e; } return real(f, ...a); };
  try {
    assert.strictEqual(extractNatives(jar, dir), 0, 'nothing rewritten, so a locked file is no problem');
  } finally { fs.writeFileSync = real; }
  fs.writeFileSync(path.join(dir, 'lwjgl.dll'), 'old');
  assert.strictEqual(extractNatives(jar, dir), 1, 'a different file is replaced');
});
