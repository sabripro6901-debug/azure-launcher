'use strict';
// Instances, the version list, and the per-version Azure builds in the signed channel (no network: injected answers).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { InstanceStore, InstanceError, instanceDir, ensureInstanceDir, copyInstanceDir, deleteInstanceDir, cleanRam } = require('../src/instances');
const { listVersions, fabricLoaderFor, fabricApiFor, atLeastOldest } = require('../src/versions');
const { pickBuild, azureVersions } = require('../src/channel');
const { normalizeArguments } = require('../src/install');

const SEED = { name: 'Azure Client 1.21.11', mcVersion: '1.21.11', loader: 'fabric', loaderVersion: '0.18.3', mods: [], azure: true };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'azure-inst-'));

test('instances: first run seeds the default, create / rename / duplicate / delete, own RAM, unique names', () => {
  const dir = tmp();
  const store = new InstanceStore(path.join(dir, 'i.json'), SEED);
  assert.deepStrictEqual(store.list().map((i) => i.id), ['default']);
  const a = store.create({ name: '  My   world ', mcVersion: '1.20.1', loaderVersion: '0.16.0', mods: [], azure: false, ram: 3000 });
  assert.strictEqual(a.name, 'My world');
  assert.strictEqual(a.ram, 3072); // rounded to 256 MB steps
  assert.strictEqual(a.loader, 'fabric');
  assert.match(a.id, /^my-world-[0-9a-f]{4}$/);
  const v = store.create({ name: 'my world', mcVersion: '1.12.2', loaderVersion: null });
  assert.strictEqual(v.name, 'my world (2)'); // names stay unique
  assert.strictEqual(v.loader, null);
  assert.strictEqual(store.update(a.id, { name: 'Renamed', ram: null }).ram, null);
  const copy = store.duplicate(a.id);
  assert.strictEqual(copy.name, 'Renamed copy');
  assert.notStrictEqual(copy.id, a.id);
  assert.strictEqual(copy.lastPlayed, null);
  assert.strictEqual(store.remove(copy.id), 'default');
  assert.strictEqual(store.list().length, 3);
  // saved to disk
  assert.deepStrictEqual(new InstanceStore(path.join(dir, 'i.json')).list().map((i) => i.name), ['Azure Client 1.21.11', 'Renamed', 'my world (2)']);
  // bad input
  assert.throws(() => store.create({ name: '   ', mcVersion: '1.20.1' }), (e) => e.code === 'BAD_NAME');
  assert.throws(() => store.create({ name: 'x'.repeat(41), mcVersion: '1.20.1' }), (e) => e.code === 'BAD_NAME');
  assert.throws(() => store.create({ name: 'ok', mcVersion: '../../x' }), (e) => e.code === 'BAD_VERSION');
  assert.throws(() => store.update('nope', { name: 'x' }), (e) => e.code === 'NOT_FOUND');
  assert.strictEqual(cleanRam(''), null);
  assert.strictEqual(cleanRam(100), 1024);
  assert.strictEqual(cleanRam(99999), 32768);
});

test('instances: there is always at least one', () => {
  const store = new InstanceStore(path.join(tmp(), 'i.json'), SEED);
  assert.throws(() => store.remove('default'), (e) => e instanceof InstanceError && e.code === 'LAST_INSTANCE');
  assert.strictEqual(store.list().length, 1);
});

test('instance folders: own subfolders, copied on duplicate, deleted on delete, never outside <root>/instances', () => {
  const root = tmp();
  const d = ensureInstanceDir(root, 'one');
  for (const s of ['mods', 'resourcepacks', 'shaderpacks', 'saves']) assert.ok(fs.existsSync(path.join(d, s)));
  fs.writeFileSync(path.join(d, 'options.txt'), 'fov:90');
  fs.writeFileSync(path.join(d, 'saves', 'world.dat'), 'w');
  copyInstanceDir(root, 'one', 'two');
  assert.strictEqual(fs.readFileSync(path.join(instanceDir(root, 'two'), 'options.txt'), 'utf8'), 'fov:90');
  assert.ok(fs.existsSync(path.join(instanceDir(root, 'two'), 'saves', 'world.dat')));
  fs.writeFileSync(path.join(d, 'options.txt'), 'fov:60'); // the copy is independent
  assert.strictEqual(fs.readFileSync(path.join(instanceDir(root, 'two'), 'options.txt'), 'utf8'), 'fov:90');
  deleteInstanceDir(root, 'one');
  assert.ok(!fs.existsSync(d));
  assert.ok(fs.existsSync(instanceDir(root, 'two')));
  // an id can never point outside the instances folder
  for (const bad of ['..', '../x', 'a/b', 'a\\b', '', '.', 'UPPER', 'x'.repeat(41)]) {
    assert.throws(() => instanceDir(root, bad), (e) => e.code === 'BAD_ID', bad);
    assert.throws(() => deleteInstanceDir(root, bad));
  }
  assert.ok(fs.existsSync(root));
});

test('version list: releases from 1.13 on by default, snapshots on request, Fabric and Azure flags', async () => {
  const manifest = { versions: [
    { id: '25w01a', type: 'snapshot' }, { id: '1.21.11', type: 'release' }, { id: '1.20.1', type: 'release' },
    { id: '1.12.2', type: 'release' }, { id: '1.13', type: 'release' }, { id: 'b1.7.3', type: 'old_beta' } ] };
  const fetchJson = async (url) => (url.includes('version_manifest') ? manifest : [{ version: '1.21.11' }, { version: '1.20.1' }, { version: '25w01a' }]);
  const rel = await listVersions({ azureSet: new Set(['1.21.11']), fetchJson });
  assert.deepStrictEqual(rel.map((v) => v.id), ['1.21.11', '1.20.1', '1.13']);
  assert.deepStrictEqual(rel.map((v) => [v.fabric, v.azure]), [[true, true], [true, false], [false, false]]);
  assert.deepStrictEqual((await listVersions({ snapshots: true, azureSet: null, fetchJson })).map((v) => v.id), ['25w01a', '1.21.11', '1.20.1', '1.13']);
  assert.ok(atLeastOldest('1.13') && atLeastOldest('1.21.11') && !atLeastOldest('1.12.2') && !atLeastOldest('25w01a'));
});

test('Fabric: newest stable loader, and a Fabric API pinned by the SHA-512 Modrinth publishes', async () => {
  const loaders = [{ loader: { version: '0.19.0-beta', stable: false } }, { loader: { version: '0.18.3', stable: true } }];
  assert.strictEqual(await fabricLoaderFor('1.21.11', async () => loaders), '0.18.3');
  assert.strictEqual(await fabricLoaderFor('1.7.10', async () => []), null); // no Fabric: vanilla
  const versions = [
    { version_type: 'beta', files: [{ primary: true, filename: 'b.jar', url: 'https://cdn.modrinth.com/b.jar', hashes: { sha512: 'b' } }] },
    { version_type: 'release', files: [{ primary: false, filename: 'x.jar', url: 'u', hashes: { sha512: 'x' } }, { primary: true, filename: 'fabric-api-1.jar', url: 'https://cdn.modrinth.com/f.jar', hashes: { sha512: 'abc' } }] }];
  const api = await fabricApiFor('1.20.1', async () => versions);
  assert.deepStrictEqual(api, { name: 'Fabric API', file: 'fabric-api-1.jar', url: 'https://cdn.modrinth.com/f.jar', sha512: 'abc', locked: true });
  assert.strictEqual(await fabricApiFor('1.20.1', async () => []), null);
  assert.strictEqual(await fabricApiFor('1.20.1', async () => [{ version_type: 'release', files: [{ primary: true, filename: '../evil.jar', url: 'u', hashes: { sha512: 'a' } }] }]), null);
  assert.strictEqual(await fabricApiFor('1.20.1', async () => [{ version_type: 'release', files: [{ primary: true, filename: 'a.jar', url: 'u', hashes: {} }] }]), null); // no hash, no download
});

test('signed channel: one Legit jar per Minecraft version, and the old single-jar format still works', () => {
  const b = (f, version) => ({ file: f, sha256: 'a'.repeat(64), size: 1, ...(version ? { version } : {}) });
  const old = { version: '1.2.15', legit: b('azure-client-legit-1.2.15.jar') }; // today's latest.json
  assert.deepStrictEqual([...azureVersions(old)], ['1.21.11']);
  assert.strictEqual(pickBuild(old, '1.21.11').file, 'azure-client-legit-1.2.15.jar');
  assert.strictEqual(pickBuild(old, '1.20.1'), null);
  const multi = { version: '1.3.0', minecraft: '1.21.11', legit: b('azure-client-legit-1.3.0.jar'), builds: { '1.21.11': b('azure-client-legit-1.3.0.jar', '1.3.0'), '1.20.1': b('azure-client-legit-1.2.9+1.20.1.jar', '1.2.9') } };
  assert.deepStrictEqual([...azureVersions(multi)].sort(), ['1.20.1', '1.21.11']);
  assert.strictEqual(pickBuild(multi, '1.20.1').file, 'azure-client-legit-1.2.9+1.20.1.jar');
  assert.strictEqual(pickBuild(multi, '1.20.1').version, '1.2.9'); // ports can be on their own Azure version
  assert.strictEqual(pickBuild(multi, '1.19.4'), null);
  const bad = { version: '9', builds: { '1.20.1': { file: '../x.jar', sha256: 'a'.repeat(64) }, '1.19': { file: 'x.jar', sha256: 'short' } } };
  assert.strictEqual(azureVersions(bad).size, 0);
});

test('old version JSONs (a single minecraftArguments string) become argument lists', () => {
  const v = normalizeArguments({ minecraftArguments: '--username ${auth_player_name} --version ${version_name}', mainClass: 'x' });
  assert.deepStrictEqual(v.arguments.game, ['--username', '${auth_player_name}', '--version', '${version_name}']);
  assert.ok(v.arguments.jvm.includes('-cp') && v.arguments.jvm.includes('${classpath}'));
  const modern = normalizeArguments({ arguments: { jvm: ['a'], game: ['b'] } });
  assert.deepStrictEqual(modern.arguments, { jvm: ['a'], game: ['b'] });
});
