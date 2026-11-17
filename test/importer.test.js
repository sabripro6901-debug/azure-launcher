'use strict';
// Adding local files: reading mods and packs safely, flagging problems, copying (never moving), Modrinth recognition.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { zipSync } = require('fflate');
const { Content } = require('../src/content');
const { inspect, add, cleanName } = require('../src/importer');
const { readModInfo, readPackInfo, mcSatisfies } = require('../src/modmeta');

const enc = (t) => new TextEncoder().encode(t);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'azure-imp-'));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cf00000301010018dd8db00000000049454e44ae426082', 'hex');

function jar(dir, name, files) {
  const entries = {};
  for (const [k, v] of Object.entries(files)) entries[k] = typeof v === 'string' ? enc(v) : v;
  const file = path.join(dir, name);
  fs.writeFileSync(file, zipSync(entries));
  return file;
}
const fabricMod = (id, extra = {}) => JSON.stringify({ schemaVersion: 1, id, version: '1.0.0', name: 'Mod ' + id, depends: { minecraft: '~1.21' }, ...extra });

function setup(instance = {}) {
  const gameDir = tmp();
  const src = tmp();
  const inst = { id: 'i', mcVersion: '1.21.11', loader: 'fabric', azure: true, mods: [], ...instance };
  const content = new Content({ gameDir, instance: inst, client: {} });
  return { gameDir, src, inst, content };
}

test('mod information: fabric.mod.json (name, version, icon, Minecraft range) is read; other loaders are recognised', () => {
  const dir = tmp();
  const f = jar(dir, 'a.jar', { 'fabric.mod.json': fabricMod('cool', { icon: 'assets/cool/icon.png' }), 'assets/cool/icon.png': PNG });
  const i = readModInfo(f);
  assert.deepStrictEqual([i.loader, i.id, i.name, i.version, i.mcRange], ['fabric', 'cool', 'Mod cool', '1.0.0', '~1.21']);
  assert.match(i.icon, /^data:image\/png;base64,/);
  assert.strictEqual(readModInfo(jar(dir, 'f.jar', { 'META-INF/mods.toml': 'modId="forgemod"\ndisplayName="Forge Mod"\nversion="2"' })).loader, 'forge');
  assert.strictEqual(readModInfo(jar(dir, 'q.jar', { 'quilt.mod.json': JSON.stringify({ quilt_loader: { id: 'qm', version: '1' } }) })).loader, 'quilt');
  assert.strictEqual(readModInfo(jar(dir, 'n.jar', { 'readme.txt': 'hi' })).loader, null);
  fs.writeFileSync(path.join(dir, 'bad.jar'), 'this is not a zip');
  assert.ok(readModInfo(path.join(dir, 'bad.jar')).error);
  // an icon path that tries to leave the archive is ignored
  const sneaky = jar(dir, 's.jar', { 'fabric.mod.json': fabricMod('s', { icon: '../../evil.png' }), '../../evil.png': PNG });
  assert.strictEqual(readModInfo(sneaky).icon, null);
});

test('Minecraft ranges (Fabric syntax) against a release; snapshots are "unknown"', () => {
  assert.strictEqual(mcSatisfies('~1.21', '1.21.11'), true);
  assert.strictEqual(mcSatisfies('~1.20.1', '1.21.11'), false);
  assert.strictEqual(mcSatisfies('>=1.20 <1.21', '1.20.4'), true);
  assert.strictEqual(mcSatisfies('>=1.20 <1.21', '1.21.11'), false);
  assert.strictEqual(mcSatisfies('1.21.x', '1.21.4'), true);
  assert.strictEqual(mcSatisfies(['1.19.4', '1.20.1'], '1.20.1'), true);
  assert.strictEqual(mcSatisfies('1.19.4 || 1.20.1', '1.20.2'), false);
  assert.strictEqual(mcSatisfies('*', '1.21.11'), true);
  assert.strictEqual(mcSatisfies('^1.20', '1.21.11'), true);
  assert.strictEqual(mcSatisfies('~1.21', '25w01a'), null);
});

test('pack information: resource pack, shader pack, damaged and hostile zips are only read, never extracted', () => {
  const dir = tmp();
  const rp = jar(dir, 'rp.zip', { 'pack.mcmeta': JSON.stringify({ pack: { pack_format: 34, description: 'Nice' } }), 'pack.png': PNG, 'assets/minecraft/x.png': PNG });
  assert.deepStrictEqual([readPackInfo(rp).kind, readPackInfo(rp).packFormat, readPackInfo(rp).description], ['resourcepack', 34, 'Nice']);
  assert.ok(readPackInfo(rp).icon);
  const sh = jar(dir, 'sh.zip', { 'shaders/composite.fsh': 'x', 'shaders/lang/en_us.lang': 'y' });
  assert.strictEqual(readPackInfo(sh).kind, 'shader');
  const slip = jar(dir, 'slip.zip', { 'pack.mcmeta': '{"pack":{"pack_format":1}}', '../../evil.txt': 'evil', '/abs/evil.txt': 'evil' });
  assert.strictEqual(readPackInfo(slip).kind, 'resourcepack');
  assert.ok(!fs.existsSync(path.join(dir, '..', '..', 'evil.txt')) && !fs.existsSync('/abs/evil.txt'));
  fs.writeFileSync(path.join(dir, 'broken.zip'), 'nope');
  assert.ok(readPackInfo(path.join(dir, 'broken.zip')).error);
});

test('inspect: a clean mod is added as a copy, the original stays; names are cleaned', async () => {
  const { src, content, inst } = setup();
  const f = jar(src, 'cool-1.0.jar', { 'fabric.mod.json': fabricMod('cool') });
  const [c] = await inspect([f], { content, instance: inst, client: null });
  assert.deepStrictEqual([c.kind, c.blocked, c.ask, c.issues.length, c.name], ['mod', false, false, 0, 'Mod cool']);
  const r = add([c], [c.id], { content });
  assert.deepStrictEqual(r.added.map((a) => [a.kind, a.recognised]), [['mod', false]]);
  assert.ok(fs.existsSync(path.join(content.gameDir, 'mods', 'cool-1.0.jar')));
  assert.ok(fs.existsSync(f)); // the original is still there
  const listed = content.list().mod.find((m) => m.base === 'cool-1.0.jar');
  assert.deepStrictEqual([listed.name, listed.source, listed.version], ['Mod cool', 'local', '1.0.0']);
  assert.strictEqual(cleanName('we!rd name?.jar'), 'we_rd name_.jar');
});

test('inspect: other loader, other Minecraft version, duplicate id, unknown jar: ask first', async () => {
  const { src, content, inst } = setup();
  fs.mkdirSync(path.join(content.gameDir, 'mods'), { recursive: true });
  jar(path.join(content.gameDir, 'mods'), 'present.jar', { 'fabric.mod.json': fabricMod('dupe') });
  const files = [
    jar(src, 'forge.jar', { 'META-INF/mods.toml': 'modId="fm"\nversion="1"' }),
    jar(src, 'old.jar', { 'fabric.mod.json': fabricMod('oldmod', { depends: { minecraft: '1.19.4' } }) }),
    jar(src, 'dupe2.jar', { 'fabric.mod.json': fabricMod('dupe') }),
    jar(src, 'plain.jar', { 'x.txt': 'x' }),
  ];
  const r = await inspect(files, { content, instance: inst, client: null });
  assert.deepStrictEqual(r.map((c) => [c.blocked, c.ask]), [[false, true], [false, true], [false, true], [false, true]]);
  assert.match(r[0].issues[0].text, /Forge.*Fabric/);
  assert.match(r[1].issues[0].text, /different Minecraft version/);
  assert.match(r[2].issues[0].text, /same id \(dupe\)/);
  // nothing is added unless the player picked it
  assert.deepStrictEqual(add(r, [], { content }).added, []);
  assert.ok(!fs.existsSync(path.join(content.gameDir, 'mods', 'forge.jar')));
});

test('inspect: Azure and Fabric API can never be replaced or duplicated; existing files are never overwritten', async () => {
  const { src, content, inst } = setup();
  fs.mkdirSync(path.join(content.gameDir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(content.gameDir, 'mods', 'taken.jar'), 'mine');
  const files = [
    jar(src, 'azure-client-legit-9.jar', { 'fabric.mod.json': fabricMod('whatever') }),
    jar(src, 'renamed.jar', { 'fabric.mod.json': fabricMod('aurora') }),
    jar(src, 'fabric-api-0.99.jar', { 'fabric.mod.json': fabricMod('fabric-api') }),
    jar(src, 'sneaky.jar', { 'fabric.mod.json': fabricMod('fabric-api') }),
    jar(src, 'taken.jar', { 'fabric.mod.json': fabricMod('t') }),
  ];
  const r = await inspect(files, { content, instance: inst, client: null });
  assert.deepStrictEqual(r.map((c) => c.blocked), [true, true, true, true, true]);
  assert.match(r[0].issues.find((i) => i.level === 'block').text, /Azure Client.*cannot be replaced/);
  assert.match(r[2].issues.find((i) => i.level === 'block').text, /Fabric API/);
  assert.match(r[4].issues.find((i) => i.level === 'block').text, /already in the instance/);
  // even if the player's selection includes them, blocked files are skipped
  const out = add(r, r.map((c) => c.id), { content });
  assert.strictEqual(out.added.length, 0);
  assert.strictEqual(out.skipped.length, 5);
  assert.strictEqual(fs.readFileSync(path.join(content.gameDir, 'mods', 'taken.jar'), 'utf8'), 'mine');
  // a file that appears between the check and the copy is not overwritten either
  const { src: s2, content: c2, inst: i2 } = setup();
  const late = jar(s2, 'late.jar', { 'fabric.mod.json': fabricMod('late') });
  const [cand] = await inspect([late], { content: c2, instance: i2, client: null });
  fs.mkdirSync(path.join(c2.gameDir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(c2.gameDir, 'mods', 'late.jar'), 'appeared');
  const o2 = add([cand], [cand.id], { content: c2 });
  assert.strictEqual(o2.skipped.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(c2.gameDir, 'mods', 'late.jar'), 'utf8'), 'appeared');
});

test('inspect: resource packs, shader packs, folders; a vanilla instance takes no mods', async () => {
  const { src, content, inst } = setup();
  const rp = jar(src, 'Pack.zip', { 'pack.mcmeta': '{"pack":{"pack_format":34,"description":"d"}}' });
  const sh = jar(src, 'Shader.zip', { 'shaders/a.fsh': 'x' });
  const dir = path.join(src, 'MyPackFolder');
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.mcmeta'), '{"pack":{"pack_format":34}}');
  const bag = path.join(src, 'bag');
  fs.mkdirSync(path.join(bag, 'deeper'), { recursive: true });
  jar(bag, 'one.jar', { 'fabric.mod.json': fabricMod('one') });
  jar(path.join(bag, 'deeper'), 'two.zip', { 'pack.mcmeta': '{"pack":{"pack_format":34}}' });
  fs.writeFileSync(path.join(bag, 'readme.txt'), 'ignored');
  const r = await inspect([rp, sh, dir, bag], { content, instance: inst, client: null });
  assert.deepStrictEqual(r.map((c) => [c.kind, c.folder, c.blocked].join()).sort(), [['resourcepack', false, false], ['shader', false, false], ['resourcepack', true, false], ['mod', false, false], ['resourcepack', false, false]].map((x) => x.join()).sort());
  const out = add(r, r.map((c) => c.id), { content });
  assert.strictEqual(out.added.length, 5);
  assert.ok(fs.existsSync(path.join(content.gameDir, 'resourcepacks', 'Pack.zip')));
  assert.ok(fs.existsSync(path.join(content.gameDir, 'shaderpacks', 'Shader.zip')));
  assert.ok(fs.existsSync(path.join(content.gameDir, 'resourcepacks', 'MyPackFolder', 'pack.mcmeta')));
  assert.ok(fs.existsSync(path.join(dir, 'pack.mcmeta'))); // originals untouched
  const vanilla = new Content({ gameDir: tmp(), instance: { mcVersion: '1.13', loader: null, mods: [] }, client: {} });
  const [m] = await inspect([jar(src, 'x.jar', { 'fabric.mod.json': fabricMod('x') })], { content: vanilla, instance: { mcVersion: '1.13', loader: null }, client: null });
  assert.strictEqual(m.blocked, true);
  const [txt] = await inspect([path.join(bag, 'readme.txt')], { content, instance: inst, client: null });
  assert.strictEqual(txt.blocked, true);
});

test('Modrinth recognition by hash: a known file becomes a Modrinth install with updates; an unknown one is a Local file', async () => {
  const { src, content, inst } = setup();
  const known = jar(src, 'known-1.0.jar', { 'fabric.mod.json': fabricMod('known') });
  const mine = jar(src, 'mine.jar', { 'fabric.mod.json': fabricMod('mine') });
  const hash = crypto.createHash('sha512').update(fs.readFileSync(known)).digest('hex');
  const sent = [];
  const client = {
    versionsByHashes: async (h) => { sent.push(h); return { [hash]: { id: 'v1', project_id: 'P1', version_number: '1.0' } }; },
    projects: async () => [{ id: 'P1', title: 'Known Mod', icon_url: 'https://cdn.modrinth.com/p1.png' }],
    latestByHashes: async () => ({ [hash]: { id: 'v2', project_id: 'P1', version_number: '1.1' } }),
  };
  const r = await inspect([known, mine], { content, instance: inst, client });
  assert.deepStrictEqual(r.map((c) => !!c.modrinth), [true, false]);
  assert.strictEqual(sent[0].length, 2); // only hashes go out, never the files or their paths
  add(r, r.map((c) => c.id), { content: new Content({ gameDir: content.gameDir, instance: inst, client }) });
  const c2 = new Content({ gameDir: content.gameDir, instance: inst, client });
  const mods = c2.list().mod.filter((m) => !m.virtual);
  assert.deepStrictEqual(mods.map((m) => [m.name, m.source]).sort(), [['Known Mod', 'modrinth'], ['Mod mine', 'local']]);
  const updates = await c2.checkUpdates();
  assert.deepStrictEqual(Object.keys(updates), ['mod/known-1.0.jar']); // the Local file has no update check
  // offline: everything is simply a Local file
  const off = await inspect([known], { content: setup().content, instance: inst, client: { versionsByHashes: async () => { throw new Error('offline'); }, projects: async () => [] } });
  assert.strictEqual(off[0].modrinth, null);
});
