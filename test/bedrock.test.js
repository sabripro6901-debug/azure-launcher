'use strict';
// Bedrock tab: manifests, importing packs, worlds (list, backup, restore, import, export), detection, and the rules
// that keep it safe (zip paths, file types, game running).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { zipSync } = require('fflate');
const { parseManifest, parseLang, displayName, compare } = require('../src/bedrock/manifest');
const packs = require('../src/bedrock/packs');
const worlds = require('../src/bedrock/worlds');
const { findProfiles, gameVersionOf, detect } = require('../src/bedrock/detect');
const { Bedrock } = require('../src/bedrock');
const { openZip } = require('../src/zipfile');

const enc = (t) => new TextEncoder().encode(t);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'azure-bed-'));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cf00000301010018dd8db00000000049454e44ae426082', 'hex');
const U1 = '11111111-2222-3333-4444-555555555555';
const U2 = '66666666-7777-8888-9999-000000000000';

const manifest = (uuid, o = {}) => JSON.stringify({
  format_version: 2,
  header: { name: o.name || 'My Pack', description: 'd', uuid, version: o.version || [1, 0, 0], min_engine_version: o.min || [1, 20, 0] },
  modules: [{ type: o.type || 'resources', uuid: '99999999-0000-0000-0000-000000000001', version: [1, 0, 0] }],
  ...(o.deps ? { dependencies: o.deps.map((u) => ({ uuid: u, version: [1, 0, 0] })) } : {}),
});
function zip(dir, name, files) {
  const e = {};
  for (const [k, v] of Object.entries(files)) e[k] = typeof v === 'string' ? enc(v) : v;
  const f = path.join(dir, name);
  fs.writeFileSync(f, zipSync(e));
  return f;
}

// a little-endian NBT level.dat: LastPlayed (long), lastOpenedWithVersion (list of int)
function levelDat(lastPlayed, version) {
  const parts = [];
  const name = (s) => { const b = Buffer.from(s); const l = Buffer.alloc(2); l.writeUInt16LE(b.length); return Buffer.concat([l, b]); };
  parts.push(Buffer.from([10]), name(''));
  const lp = Buffer.alloc(8); lp.writeBigInt64LE(BigInt(lastPlayed));
  parts.push(Buffer.from([4]), name('LastPlayed'), lp);
  const list = Buffer.alloc(5); list.writeUInt8(3, 0); list.writeInt32LE(version.length, 1);
  const ints = Buffer.alloc(4 * version.length); version.forEach((v, i) => ints.writeInt32LE(v, 4 * i));
  parts.push(Buffer.from([9]), name('lastOpenedWithVersion'), list, ints);
  parts.push(Buffer.from([0]));
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8); head.writeInt32LE(10, 0); head.writeInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

function profile() {
  const root = path.join(tmp(), 'com.mojang');
  fs.mkdirSync(root, { recursive: true });
  return { id: 'x1', label: 'Xbox user', root };
}
function makeWorld(p, folder, name, opts = {}) {
  const d = path.join(p.root, 'minecraftWorlds', folder);
  fs.mkdirSync(path.join(d, 'db'), { recursive: true });
  fs.writeFileSync(path.join(d, 'level.dat'), levelDat(opts.lastPlayed || 1700000000, opts.version || [1, 21, 100]));
  fs.writeFileSync(path.join(d, 'levelname.txt'), name);
  fs.writeFileSync(path.join(d, 'db', '000005.ldb'), opts.data || 'data-one');
  fs.writeFileSync(path.join(d, 'db', 'CURRENT'), 'MANIFEST-000004\n');
  return d;
}
const trashed = [];
const fakeTrash = (p) => { trashed.push(p); fs.rmSync(p, { recursive: true, force: true }); };

test('manifests: comments, trailing commas and a BOM are fine; bad ones say why', () => {
  const text = '\uFEFF{ // c\n "header": { "name": "pack.name", "uuid": "' + U1 + '", "version": [1,2,3], "min_engine_version": [1,20,0], }, /* x */ "modules": [ {"type":"data",} ], }';
  const m = parseManifest(text);
  assert.strictEqual(m.ok, true);
  assert.deepStrictEqual([m.kind, m.version, m.uuid], ['behavior', [1, 2, 3], U1]);
  assert.strictEqual(parseManifest('{"header":{"uuid":"nope","version":[1,0,0]},"modules":[]}').ok, false);
  assert.strictEqual(parseManifest('not json').ok, false);
  assert.strictEqual(parseManifest(manifest(U1, { type: 'skin_pack' })).kind, 'skin');
  assert.strictEqual(parseManifest(manifest(U1, { type: 'world_template' })).kind, 'world_template');
  assert.strictEqual(displayName('pack.name', parseLang('pack.name=Cool Pack ## note\n')), 'Cool Pack');
  assert.strictEqual(displayName('Plain Name', {}), 'Plain Name');
  assert.strictEqual(compare([1, 2], [1, 2, 0]), 0);
  assert.strictEqual(compare([1, 10, 0], [1, 9, 9]), 1);
});

test('detection: profiles per Xbox user and Shared, old layout, versions, not installed', async () => {
  const appdata = tmp();
  const local = tmp();
  for (const id of ['10572920953863333493', 'Shared']) fs.mkdirSync(path.join(appdata, 'Minecraft Bedrock', 'Users', id, 'games', 'com.mojang'), { recursive: true });
  fs.mkdirSync(path.join(appdata, 'Minecraft Bedrock', 'Users', 'NoGames'), { recursive: true });
  fs.mkdirSync(path.join(local, 'Packages', 'Microsoft.MinecraftUWP_8wekyb3d8bbwe', 'LocalState', 'games', 'com.mojang'), { recursive: true });
  const ps = findProfiles({ appdata, localappdata: local });
  assert.deepStrictEqual(ps.map((p) => p.id), ['x10572920953863333493', 'shared', 'uwp']);
  assert.strictEqual(ps[0].label, 'Xbox user …3493');
  assert.strictEqual(ps[1].label, 'Shared');
  assert.deepStrictEqual(gameVersionOf('1.26.6501.0'), [1, 26, 65]);
  assert.deepStrictEqual(gameVersionOf('1.21.12011.0'), [1, 21, 120]);
  assert.deepStrictEqual(gameVersionOf('1.21.9401.0'), [1, 21, 94]);
  const none = await detect({ appdata: tmp(), localappdata: tmp(), exec: async () => '' });
  assert.strictEqual(none.installed, false);
  assert.deepStrictEqual(none.profiles, []);
  const exec = (v) => async () => JSON.stringify({ Version: v, PackageFamilyName: 'Microsoft.MinecraftUWP_8wekyb3d8bbwe' });
  const gdk = await detect({ appdata, localappdata: local, exec: exec('1.26.6501.0') });
  assert.deepStrictEqual([gdk.installed, gdk.layout, gdk.version], [true, 'gdk', '1.26.65']);
  assert.ok(!gdk.profiles.some((p) => p.id === 'uwp'), 'the old folder is not offered on the current build');
  // Windows could not be asked (PowerShell blocked): the folders still show the game is there
  const blind = await detect({ appdata, localappdata: local, exec: async () => null });
  assert.deepStrictEqual([blind.installed, blind.layout], [true, 'gdk']);
  assert.strictEqual((await detect({ appdata: tmp(), localappdata: tmp(), exec: async () => null })).installed, false);
  const old = await detect({ appdata, localappdata: local, exec: exec('1.21.9401.0') });
  assert.strictEqual(old.layout, 'uwp');
});

test('packs: .mcpack is read (name, version, icon, UUID) and copied; the original stays', () => {
  const p = profile();
  const src = tmp();
  const f = zip(src, 'cool.mcpack', {
    'manifest.json': manifest(U1, { name: 'pack.name', version: [1, 2, 0] }),
    'texts/en_US.lang': 'pack.name=Cool Textures\n', 'pack_icon.png': PNG, 'textures/a.png': PNG,
  });
  const [c] = packs.inspect([f], { profile: p, gameVersion: [1, 26, 65] });
  assert.deepStrictEqual([c.name, c.version, c.uuid, c.kind, c.blocked, c.ask], ['Cool Textures', '1.2.0', U1, 'resource', false, false]);
  assert.match(c.icon, /^data:image\/png/);
  const r = packs.add([c], [c.id], { profile: p, trash: fakeTrash });
  assert.strictEqual(r.added.length, 1);
  assert.ok(fs.existsSync(path.join(p.root, 'resource_packs', 'Cool Textures', 'textures', 'a.png')));
  assert.ok(fs.existsSync(f), 'the original is not moved');
  const list = packs.listInstalled(p);
  assert.deepStrictEqual(list.map((x) => [x.kind, x.name, x.uuid]), [['resource', 'Cool Textures', U1]]);
  assert.strictEqual(fs.readdirSync(path.join(p.root, 'resource_packs')).filter((n) => n.startsWith('.')).length, 0, 'no temp folder left');
});

test('packs: .mcaddon with two packs, a pack inside a folder, behavior and skin go to their folders', () => {
  const p = profile();
  const f = zip(tmp(), 'add.mcaddon', {
    'RP/manifest.json': manifest(U1, { name: 'Add RP' }), 'RP/textures/x.png': PNG,
    'BP/manifest.json': manifest(U2, { name: 'Add BP', type: 'data', deps: [U1] }), 'BP/scripts/main.js': 'console.log(1)',
  });
  const cs = packs.inspect([f], { profile: p });
  assert.strictEqual(cs.length, 2);
  packs.add(cs, cs.map((c) => c.id), { profile: p, trash: fakeTrash });
  assert.ok(fs.existsSync(path.join(p.root, 'resource_packs', 'Add RP', 'manifest.json')));
  assert.ok(fs.existsSync(path.join(p.root, 'behavior_packs', 'Add BP', 'scripts', 'main.js')));
  const g = zip(tmp(), 'skins.zip', { 'skins/manifest.json': manifest('abcdefab-0000-0000-0000-000000000000', { type: 'skin_pack', name: 'Skins' }), 'skins/skins.json': '{}' });
  const [s] = packs.inspect([g], { profile: p });
  assert.strictEqual(s.kind, 'skin');
  packs.add([s], [s.id], { profile: p, trash: fakeTrash });
  assert.ok(fs.existsSync(path.join(p.root, 'skin_packs', 'Skins', 'skins.json')));
});

test('packs: unsafe zip paths and files a pack never has are refused, nothing is written', () => {
  const p = profile();
  const src = tmp();
  const cases = {
    'a.mcpack': { 'manifest.json': manifest(U1), '../evil.json': '{}' },
    'b.mcpack': { 'manifest.json': manifest(U1), 'bin/tool.dll': 'MZ' },
    'c.mcpack': { 'manifest.json': manifest(U1), 'setup.exe': 'MZ' },
    'd.mcpack': { 'manifest.json': manifest(U1), 'C:/windows/x.json': '{}' },
    'e.mcpack': { 'manifest.json': manifest(U1), 'run.bat': 'echo' },
    'f.mcpack': { 'manifest.json': manifest(U1), 'a.json:stream': '{}' },
    'g.mcpack': { 'manifest.json': manifest(U1), 'x/../../up.json': '{}' },
    'h.mcpack': { 'readme.txt': 'no manifest' },
  };
  for (const [name, files] of Object.entries(cases)) {
    const [c] = packs.inspect([zip(src, name, files)], { profile: p });
    assert.strictEqual(c.blocked, true, name);
    const r = packs.add([c], [c.id], { profile: p, trash: fakeTrash });
    assert.strictEqual(r.added.length, 0, name);
  }
  assert.ok(!fs.existsSync(path.join(p.root, 'resource_packs')) || fs.readdirSync(path.join(p.root, 'resource_packs')).length === 0);
  fs.writeFileSync(path.join(src, 'notzip.mcpack'), 'junk');
  assert.strictEqual(packs.inspect([path.join(src, 'notzip.mcpack')], { profile: p })[0].blocked, true);
  fs.writeFileSync(path.join(src, 'x.exe'), 'MZ');
  assert.strictEqual(packs.inspect([path.join(src, 'x.exe')], { profile: p })[0].blocked, true);
});

test('packs: duplicates (same UUID) and a newer game version need a yes; a yes replaces the old one', () => {
  const p = profile();
  const src = tmp();
  const v1 = zip(src, 'v1.mcpack', { 'manifest.json': manifest(U1, { name: 'Dup', version: [1, 0, 0] }) });
  const [c1] = packs.inspect([v1], { profile: p });
  packs.add([c1], [c1.id], { profile: p, trash: fakeTrash });
  const v2 = zip(src, 'v2.mcpack', { 'manifest.json': manifest(U1, { name: 'Dup', version: [2, 0, 0], min: [1, 99, 0] }), 'marker.txt': 'two' });
  const [c2] = packs.inspect([v2], { profile: p, gameVersion: [1, 26, 65] });
  assert.strictEqual(c2.ask, true);
  assert.ok(c2.issues.some((i) => /Needs Minecraft 1\.99\.0/.test(i.text)));
  assert.ok(c2.issues.some((i) => /replaces it with 2\.0\.0/.test(i.text)));
  const [c3] = packs.inspect([v1], { profile: p });
  assert.ok(c3.issues.some((i) => /same version/.test(i.text)));
  trashed.length = 0;
  packs.add([c2], [c2.id], { profile: p, trash: fakeTrash });
  assert.strictEqual(trashed.length, 1);
  const list = packs.listInstalled(p);
  assert.strictEqual(list.length, 1);
  assert.deepStrictEqual(list[0].version, [2, 0, 0]);
});

test('packs: remove sends one folder to the trash and refuses odd names', () => {
  const p = profile();
  const [c] = packs.inspect([zip(tmp(), 'r.mcpack', { 'manifest.json': manifest(U1, { name: 'Gone' }) })], { profile: p });
  packs.add([c], [c.id], { profile: p, trash: fakeTrash });
  for (const bad of ['..', '../resource_packs', 'a/b', '', '.x']) assert.throws(() => packs.remove(p, 'resource', bad, { trash: fakeTrash }), bad);
  assert.throws(() => packs.remove(p, 'nope', 'Gone', { trash: fakeTrash }));
  packs.remove(p, 'resource', 'Gone', { trash: fakeTrash });
  assert.strictEqual(packs.listInstalled(p).length, 0);
});

test('worlds: list shows name, last played and size; level.dat is read', () => {
  const p = profile();
  makeWorld(p, 'AAA=', 'Old', { lastPlayed: 1000 });
  makeWorld(p, 'BBB=', 'New', { lastPlayed: 2000, version: [1, 26, 65] });
  fs.mkdirSync(path.join(p.root, 'minecraftWorlds', 'junk'));
  const l = worlds.listWorlds(p);
  assert.deepStrictEqual(l.map((w) => w.name), ['New', 'Old']);
  assert.strictEqual(l[0].lastPlayed, 2000000);
  assert.deepStrictEqual(l[0].openedWith, [1, 26, 65]);
  assert.ok(l[0].size > 0);
});

test('worlds: backup is a real .mcworld, restore makes a safety backup first and brings the old data back', () => {
  const p = profile();
  const back = tmp();
  const d = makeWorld(p, 'AAA=', 'Home', { data: 'before' });
  const b = worlds.backup(p, 'AAA=', back);
  assert.match(path.basename(b), /^AAA=__\d{8}-\d{6}\.mcworld$/);
  const z = openZip(b);
  assert.ok(z.entries.some((e) => e.name === 'level.dat') && z.entries.some((e) => e.name === 'db/000005.ldb'));
  z.close();
  assert.deepStrictEqual(worlds.listBackups(back).map((x) => [x.folder, x.name]), [['AAA=', 'Home']]);
  fs.writeFileSync(path.join(d, 'db', '000005.ldb'), 'after');
  const r = worlds.restore(p, b, 'AAA=', { backupDir: back, trash: fakeTrash });
  assert.strictEqual(fs.readFileSync(path.join(d, 'db', '000005.ldb'), 'utf8'), 'before');
  assert.ok(r.safety && fs.existsSync(r.safety), 'a backup of the world as it was is made first');
  const z2 = openZip(r.safety);
  assert.strictEqual(z2.read(z2.entries.find((e) => e.name === 'db/000005.ldb')).toString(), 'after');
  z2.close();
  assert.strictEqual(fs.readdirSync(path.join(p.root, 'minecraftWorlds')).filter((n) => n.startsWith('.')).length, 0);
});

test('worlds: a restore that fails changes nothing (bad archive)', () => {
  const p = profile();
  const d = makeWorld(p, 'AAA=', 'Home', { data: 'keep' });
  const bad = zip(tmp(), 'bad.mcworld', { 'level.dat': levelDat(1, [1, 21, 0]), 'bin/evil.dll': 'MZ' });
  assert.throws(() => worlds.restore(p, bad, 'AAA=', { backupDir: tmp(), trash: fakeTrash }));
  assert.strictEqual(fs.readFileSync(path.join(d, 'db', '000005.ldb'), 'utf8'), 'keep');
  assert.throws(() => worlds.restore(p, bad, '../x', { backupDir: tmp(), trash: fakeTrash }));
});

test('worlds: export and import round trip; import adds a new folder, never overwrites; warns about newer worlds', () => {
  const p = profile();
  makeWorld(p, 'AAA=', 'Trip', { version: [1, 30, 0] });
  const out = path.join(tmp(), 'trip.mcworld');
  worlds.exportWorld(p, 'AAA=', out);
  assert.throws(() => worlds.exportWorld(p, 'AAA=', path.join(tmp(), 'trip.zip')));
  const info = worlds.inspectWorld(out, { gameVersion: [1, 26, 65], existingNames: ['Trip'] });
  assert.strictEqual(info.blocked, false);
  assert.ok(info.issues.some((i) => i.level === 'ask' && /may not open/.test(i.text)));
  assert.ok(info.issues.some((i) => /already exists/.test(i.text)));
  const r = worlds.importWorld(p, out);
  assert.notStrictEqual(r.folder, 'AAA=');
  const l = worlds.listWorlds(p);
  assert.strictEqual(l.length, 2);
  assert.strictEqual(fs.readFileSync(path.join(p.root, 'minecraftWorlds', r.folder, 'db', '000005.ldb'), 'utf8'), 'data-one');
  // a world zipped inside a folder is also fine
  const nested = zip(tmp(), 'n.zip', { 'My World/level.dat': levelDat(5, [1, 21, 0]), 'My World/levelname.txt': 'Nested', 'My World/db/CURRENT': 'x' });
  assert.strictEqual(worlds.importWorld(p, nested).name, 'Nested');
});

test('worlds: archives with programs or unsafe paths are refused', () => {
  const p = profile();
  const src = tmp();
  for (const [n, files] of Object.entries({
    'a.mcworld': { 'level.dat': levelDat(1, [1, 21, 0]), 'x.dll': 'MZ' },
    'b.mcworld': { 'level.dat': levelDat(1, [1, 21, 0]), '../up.txt': 'x' },
    'c.mcworld': { 'levelname.txt': 'no level' },
    'd.mcworld': { 'level.dat': levelDat(1, [1, 21, 0]), 'db/run.exe': 'MZ' },
  })) {
    const f = zip(src, n, files);
    assert.strictEqual(worlds.inspectWorld(f).blocked, true, n);
    assert.throws(() => worlds.importWorld(p, f), n);
  }
  assert.strictEqual(worlds.listWorlds(p).length, 0);
});

test('service: nothing changes while Bedrock runs; launch uses the Start-menu way; Shared works like a profile', async () => {
  const appdata = tmp();
  const shared = path.join(appdata, 'Minecraft Bedrock', 'Users', 'Shared', 'games', 'com.mojang');
  fs.mkdirSync(shared, { recursive: true });
  let running = true;
  const calls = [];
  const exec = async (file) => {
    if (/powershell/i.test(file)) return JSON.stringify({ Version: '1.26.6501.0', PackageFamilyName: 'Microsoft.MinecraftUWP_8wekyb3d8bbwe' });
    return running ? '"Minecraft.Windows.exe","1234","Console","1","300,000 K"\n' : 'INFO: No tasks are running which match the specified criteria.\n';
  };
  const b = new Bedrock({ appdata, localappdata: tmp(), exec, backupRoot: tmp(), trash: fakeTrash, spawn: (...a) => { calls.push(a); return { unref() {} }; } });
  const info = await b.detect();
  assert.strictEqual(info.profiles[0].id, 'shared');
  makeWorld({ root: shared }, 'AAA=', 'S');
  const f = zip(tmp(), 'p.mcpack', { 'manifest.json': manifest(U1) });
  const cs = b.inspectPacks('shared', [f]);
  await assert.rejects(b.addPacks('shared', cs, [cs[0].id]), /Close Minecraft Bedrock/);
  await assert.rejects(b.backupWorld('shared', 'AAA='), /Close Minecraft Bedrock/);
  await assert.rejects(b.importWorld('shared', f), /Close Minecraft Bedrock/);
  await assert.rejects(b.launch(), /already running/);
  assert.strictEqual((await b.listWorlds('shared')).length, 1, 'listing is allowed while the game runs');
  running = false;
  assert.strictEqual((await b.addPacks('shared', cs, [cs[0].id])).added.length, 1);
  assert.ok(fs.existsSync(path.join(shared, 'resource_packs')));
  assert.deepStrictEqual(fs.readdirSync(shared).sort(), ['minecraftWorlds', 'resource_packs'], 'only pack and world folders are touched');
  assert.ok((await b.backupWorld('shared', 'AAA=')).endsWith('.mcworld'));
  await b.launch();
  assert.deepStrictEqual(calls[0].slice(0, 2), ['explorer.exe', ['shell:AppsFolder\\Microsoft.MinecraftUWP_8wekyb3d8bbwe!Game']]);
  assert.throws(() => b.profile('nope'));
});

test('service: not installed is reported and launch refuses', async () => {
  const b = new Bedrock({ appdata: tmp(), localappdata: tmp(), exec: async () => null, backupRoot: tmp() });
  assert.strictEqual((await b.detect()).installed, false);
  await assert.rejects(b.launch(), /not installed/);
});

test('launch uses the app id Windows reports (the old build used App, the new one Game)', async () => {
  const calls = [];
  const exec = async (file) => (/powershell/i.test(file)
    ? JSON.stringify({ Version: '1.21.9401.0', PackageFamilyName: 'Microsoft.MinecraftUWP_8wekyb3d8bbwe', AppId: 'App' })
    : 'INFO: No tasks are running which match the specified criteria.\n');
  const b = new Bedrock({ appdata: tmp(), localappdata: tmp(), exec, backupRoot: tmp(), spawn: (...a) => { calls.push(a); return { unref() {} }; } });
  await b.launch();
  assert.strictEqual(calls[0][1][0], 'shell:AppsFolder\\Microsoft.MinecraftUWP_8wekyb3d8bbwe!App');
});

test('restore also works over a world whose level.dat is gone; a leftover temp folder is swept', async () => {
  const p = profile();
  const d = makeWorld(p, 'AAA=', 'Home', { data: 'good' });
  const back = tmp();
  const b = worlds.backup(p, 'AAA=', back);
  fs.rmSync(path.join(d, 'level.dat'));
  const r = worlds.restore(p, b, 'AAA=', { backupDir: back, trash: fakeTrash });
  assert.ok(r.safety && fs.existsSync(path.join(d, 'level.dat')));
  // a real world's LevelDB has a file called LOG: the backup of it must be readable again
  fs.writeFileSync(path.join(d, 'db', 'LOG'), 'x');
  fs.writeFileSync(path.join(d, 'db', 'LOG.old'), 'x');
  assert.ok(worlds.backup(p, 'AAA=', back).endsWith('.mcworld'));
  const left = path.join(p.root, 'minecraftWorlds', '.azure-tmp-dead');
  fs.mkdirSync(left);
  fs.utimesSync(left, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
  const fresh = path.join(p.root, 'minecraftWorlds', '.azure-tmp-busy');
  fs.mkdirSync(fresh);
  const bed = new Bedrock({ backupRoot: back });
  bed.info = { profiles: [{ id: 'x1', root: p.root }] };
  bed.sweep();
  assert.ok(!fs.existsSync(left) && fs.existsSync(fresh), 'old leftovers go, a fresh temp folder (maybe in use) stays');
});

test('packs: the same UUID twice in one selection installs once; a file that changed after the look is refused', () => {
  const p = profile();
  const src = tmp();
  const a = zip(src, 'a.mcpack', { 'manifest.json': manifest(U1, { name: 'A' }) });
  const b = zip(src, 'b.mcpack', { 'manifest.json': manifest(U1, { name: 'B' }) });
  const cs = packs.inspect([a, b], { profile: p });
  const r = packs.add(cs, cs.map((c) => c.id), { profile: p, trash: fakeTrash });
  assert.deepStrictEqual([r.added.length, r.skipped.length], [1, 1]);
  const p2 = profile();
  const [c] = packs.inspect([a], { profile: p2 });
  zip(src, 'a.mcpack', { 'manifest.json': manifest(U2, { name: 'Swapped' }) }); // same file name, other pack
  const r2 = packs.add([c], [c.id], { profile: p2, trash: fakeTrash });
  assert.strictEqual(r2.added.length, 0);
  assert.strictEqual(packs.listInstalled(p2).length, 0);
});

test('oversized metadata and packs are refused before anything is written', () => {
  const p = profile();
  const big = zip(tmp(), 'big.mcpack', { 'manifest.json': manifest(U1) + ' '.repeat(3 * 1024 * 1024) });
  const [c] = packs.inspect([big], { profile: p });
  assert.strictEqual(c.blocked, true);
});

test('backups: only the newest N per world are kept, never the one just made, other worlds are untouched', () => {
  const p = profile();
  makeWorld(p, 'AAA=', 'One');
  makeWorld(p, 'BBB=', 'Two');
  const back = tmp();
  const old = (folder, stamp) => { const f = path.join(back, folder + '__' + stamp + '.mcworld'); fs.writeFileSync(f, 'x'); return f; };
  for (const s of ['20260101-000001', '20260101-000002', '20260101-000003', '20260101-000004', '20260101-000005', '20260101-000006', '20260101-000007']) old('AAA=', s);
  old('BBB=', '20250101-000001');
  const made = worlds.backup(p, 'AAA=', back, { keep: 5 });
  const left = fs.readdirSync(back).filter((n) => n.startsWith('AAA=')).sort();
  assert.strictEqual(left.length, 5);
  assert.ok(left.includes(path.basename(made)), 'the backup just made stays');
  assert.ok(!left.some((n) => /000001|000002|000003/.test(n)), 'the oldest go');
  assert.ok(fs.existsSync(path.join(back, 'BBB=__20250101-000001.mcworld')), 'another world is not touched');
  // keep 1: only the newest (the one just made); an even older file made later is protected by name
  const made2 = worlds.backup(p, 'AAA=', back, { keep: 1 });
  assert.deepStrictEqual(fs.readdirSync(back).filter((n) => n.startsWith('AAA=')), [path.basename(made2)]);
  assert.deepStrictEqual(worlds.prune(back, 'AAA=', 0), [], 'keep 0 means keep everything');
  const lone = old('AAA=', '20200101-000001');
  worlds.prune(back, 'AAA=', 1, [path.basename(lone)]);
  assert.ok(fs.existsSync(lone), 'a protected file is never deleted');
});

test('restore: the safety backup counts as the newest and the backup being restored is not pruned away', () => {
  const p = profile();
  makeWorld(p, 'AAA=', 'Home', { data: 'one' });
  const back = tmp();
  const b = worlds.backup(p, 'AAA=', back);
  const r = worlds.restore(p, b, 'AAA=', { backupDir: back, keep: 1, trash: fakeTrash });
  assert.ok(fs.existsSync(r.safety));
  assert.ok(fs.existsSync(b), 'the source backup survives even with keep 1');
});

test('jobs run in a worker: progress arrives, results come back, refusals stay refusals', async () => {
  const { runJob } = require('../src/bedrock/jobs');
  const p = profile();
  makeWorld(p, 'AAA=', 'Big', { data: 'x'.repeat(3 * 1024 * 1024) });
  const seen = [];
  const dest = path.join(tmp(), 'big.mcworld');
  await runJob('export', { root: p.root, folder: 'AAA=', dest }, (m) => seen.push(m));
  assert.ok(fs.existsSync(dest) && seen.length >= 1 && seen[seen.length - 1].done === seen[seen.length - 1].total);
  const list = await runJob('worlds', { root: p.root });
  assert.deepStrictEqual(list.map((w) => w.name), ['Big']);
  await assert.rejects(runJob('export', { root: p.root, folder: 'AAA=', dest: path.join(tmp(), 'x.zip') }), (e) => e.code === 'BAD_NAME' && /\.mcworld/.test(e.message));
  await assert.rejects(runJob('backup', { root: p.root, folder: '../x', backupDir: tmp(), keep: 5 }), (e) => e.code === 'BAD_NAME');
  const imp = await runJob('import', { root: p.root, file: dest }, () => {});
  assert.strictEqual((await runJob('worlds', { root: p.root })).length, 2);
  assert.ok(imp.folder);
});

test('settings: backups to keep accepts Keep all (0) and 1 to 100, nothing else', () => {
  const { validate } = require('../src/settings');
  assert.strictEqual(validate({}).bedrockKeepBackups, 5);
  assert.strictEqual(validate({ bedrockKeepBackups: 0 }).bedrockKeepBackups, 0);
  assert.strictEqual(validate({ bedrockKeepBackups: 12 }).bedrockKeepBackups, 12);
  for (const bad of [-1, 101, 2.5, '5', null, NaN]) assert.strictEqual(validate({ bedrockKeepBackups: bad }, { ...validate({}), bedrockKeepBackups: 7 }).bedrockKeepBackups, 7, String(bad));
  assert.strictEqual(new Bedrock({ keep: () => 0 }).keep(), 0);
  assert.strictEqual(new Bedrock({ keep: () => 3 }).keep(), 3);
  assert.strictEqual(new Bedrock({ keep: () => undefined }).keep(), 5);
  assert.strictEqual(new Bedrock({}).keep(), 5);
});
