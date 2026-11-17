'use strict';
// Version JSON handling and download checking, with local files only (no network).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ruleAllows, mavenPath, mergeVersions, dedupeLibraries, libraryFiles, osName } = require('../src/install');
const { download } = require('../src/net');

test('rules: no rules allow, os rules match this system, the last match decides', () => {
  assert.ok(ruleAllows(undefined));
  assert.ok(ruleAllows([{ action: 'allow' }]));
  assert.ok(!ruleAllows([{ action: 'allow' }, { action: 'disallow', os: { name: osName() } }]));
  const other = osName() === 'windows' ? 'linux' : 'windows';
  assert.ok(!ruleAllows([{ action: 'allow', os: { name: other } }]));
  assert.ok(ruleAllows([{ action: 'allow', features: { is_demo_user: false } }], { is_demo_user: false }));
  assert.ok(!ruleAllows([{ action: 'allow', features: { is_demo_user: true } }], {}));
});

test('maven names become paths', () => {
  assert.strictEqual(mavenPath('org.ow2.asm:asm:9.9'), 'org/ow2/asm/asm/9.9/asm-9.9.jar');
  assert.strictEqual(mavenPath('org.lwjgl:lwjgl:3.3.3:natives-windows'), 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar');
});

test('a child version keeps its main class and adds its libraries first', () => {
  const parent = { id: '1.21.11', mainClass: 'Main', libraries: [{ name: 'a:b:1' }], arguments: { jvm: ['-p'], game: ['--g'] }, assetIndex: { id: 'x' } };
  const child = { id: 'fabric', inheritsFrom: '1.21.11', mainClass: 'Knot', libraries: [{ name: 'c:d:1' }], arguments: { jvm: ['-c'], game: [] } };
  const m = mergeVersions(parent, child);
  assert.strictEqual(m.mainClass, 'Knot');
  assert.deepStrictEqual(m.libraries.map((l) => l.name), ['c:d:1', 'a:b:1']);
  assert.deepStrictEqual(m.arguments.jvm, ['-p', '-c']);
  assert.deepStrictEqual(m.assetIndex, { id: 'x' });
});

test('the same library twice: the first (child) one wins', () => {
  const out = dedupeLibraries([{ name: 'o:a:2' }, { name: 'o:a:1' }, { name: 'o:a:1:natives-windows' }]);
  assert.deepStrictEqual(out.map((l) => l.name), ['o:a:2', 'o:a:1:natives-windows']);
});

test('libraries for other systems are skipped; hashes come from the manifest', () => {
  const other = osName() === 'windows' ? 'linux' : 'windows';
  const lib = { name: 'x:y:1', downloads: { artifact: { path: 'x/y/1/y-1.jar', url: 'http://m/y.jar', sha1: 'aa' } }, rules: [{ action: 'allow', os: { name: other } }] };
  assert.deepStrictEqual(libraryFiles(lib), []);
  const ok = libraryFiles({ ...lib, rules: undefined });
  assert.strictEqual(ok[0].sha1, 'aa');
});

test('a download with the wrong hash is refused and not kept', async () => {
  const body = Buffer.from('hello world');
  const server = http.createServer((req, res) => res.end(body)).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = 'http://127.0.0.1:' + server.address().port + '/f';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-dl-'));
  try {
    const good = crypto.createHash('sha1').update(body).digest('hex');
    await assert.rejects(() => download(url, path.join(dir, 'bad.bin'), { sha1: 'f'.repeat(40), tries: 1 }), /Wrong sha1/);
    assert.ok(!fs.existsSync(path.join(dir, 'bad.bin')));
    assert.strictEqual(await download(url, path.join(dir, 'good.bin'), { sha1: good }), true);
    assert.strictEqual(await download(url, path.join(dir, 'good.bin'), { sha1: good }), false); // already there and checked
    fs.writeFileSync(path.join(dir, 'good.bin'), 'tampered');
    assert.strictEqual(await download(url, path.join(dir, 'good.bin'), { sha1: good }), true); // a changed file is fetched again
  } finally {
    server.close();
  }
});

test('old versions (1.13) list a library twice: the jar and its per-OS natives; both survive and the natives are fetched', () => {
  const jar = { name: 'org.lwjgl:lwjgl:3.1.6', downloads: { artifact: { path: 'a/lwjgl-3.1.6.jar', url: 'u1', sha1: 'x' } } };
  const nat = { name: 'org.lwjgl:lwjgl:3.1.6', natives: { windows: 'natives-windows', linux: 'natives-linux', osx: 'natives-macos' },
    downloads: { artifact: { path: 'a/lwjgl-3.1.6.jar', url: 'u1', sha1: 'x' }, classifiers: { 'natives-windows': { path: 'a/lwjgl-3.1.6-natives-windows.jar', url: 'u2', sha1: 'y' }, 'natives-linux': { path: 'a/n-l.jar', url: 'u3', sha1: 'z' }, 'natives-macos': { path: 'a/n-m.jar', url: 'u4', sha1: 'w' } } } };
  const kept = dedupeLibraries([jar, nat]);
  assert.strictEqual(kept.length, 2);
  const files = kept.flatMap(libraryFiles);
  assert.ok(files.some((f) => f.natives && f.onlyNatives), 'the native classifier jar for this OS must be listed');
});
