'use strict';
// .mrpack import and export: hashes, allowed hosts, path safety, unsupported loaders, the Azure jar never exported.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { zipSync, unzipSync } = require('fflate');
const mrpack = require('../src/mrpack');
const { Content } = require('../src/content');
const { recogniseInstalled } = require('../src/importer');

const enc = (t) => new TextEncoder().encode(t);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'azure-mrp-'));
const sha = (b, a) => crypto.createHash(a).update(b).digest('hex');
const CDN = 'https://cdn.modrinth.com/data/x/';

function packFile(index, extra = {}) {
  const entries = { 'modrinth.index.json': enc(JSON.stringify(index)) };
  for (const [k, v] of Object.entries(extra)) entries[k] = typeof v === 'string' ? enc(v) : v;
  const f = path.join(tmp(), 'p.mrpack');
  fs.writeFileSync(f, zipSync(entries));
  return f;
}
const entry = (p, bytes, over = {}) => ({ path: p, hashes: { sha1: sha(bytes, 'sha1'), sha512: sha(bytes, 'sha512') }, downloads: [CDN + path.basename(p)], fileSize: bytes.length, ...over });
const base = (files, deps = {}) => ({ formatVersion: 1, game: 'minecraft', versionId: '1', name: 'My Pack', dependencies: { minecraft: '1.21.11', 'fabric-loader': '0.18.3', ...deps }, files });

test('parse: a good pack is described; Fabric and vanilla only; bad files are refused with a clear reason', () => {
  const m = Buffer.from('mod');
  const ok = mrpack.parse(packFile(base([entry('mods/a.jar', m), entry('resourcepacks/r.zip', m)])));
  assert.deepStrictEqual([ok.name, ok.mc, ok.fabricLoader, ok.files.length], ['My Pack', '1.21.11', '0.18.3', 2]);
  assert.throws(() => mrpack.parse(packFile(base([], { forge: '47.1' }))), (e) => e.code === 'LOADER' && /Forge/.test(e.message));
  assert.throws(() => mrpack.parse(packFile(base([], { neoforge: '21.0' }))), (e) => e.code === 'LOADER' && /NeoForge/.test(e.message));
  assert.throws(() => mrpack.parse(packFile(base([], { 'quilt-loader': '0.2' }))), (e) => e.code === 'LOADER' && /Quilt/.test(e.message));
  assert.throws(() => mrpack.parse(packFile({ formatVersion: 2, game: 'minecraft', files: [] })), (e) => e.code === 'BAD_PACK');
  assert.throws(() => mrpack.parse(packFile({ formatVersion: 1, game: 'minecraft', dependencies: {}, files: [] })), (e) => e.code === 'BAD_PACK'); // no Minecraft version
  const junk = path.join(tmp(), 'x.mrpack');
  fs.writeFileSync(junk, 'not a zip');
  assert.throws(() => mrpack.parse(junk), (e) => e.code === 'BAD_PACK');
  assert.throws(() => mrpack.parse(path.join(tmp(), 'nope.zip')));
});

test('parse: paths that could leave the instance, risky files, unknown hosts and missing hashes are skipped', () => {
  const m = Buffer.from('m');
  const files = [
    entry('mods/ok.jar', m),
    entry('../evil.jar', m), entry('mods/../../evil.jar', m), entry('/abs/evil.jar', m), entry('C:/evil.jar', m), entry('mods\\bad.jar', m), entry('mods/con.jar', m),
    entry('mods/run.exe', m), entry('mods/script.bat', m), entry('saves/world/level.dat', m),
    entry('mods/nohost.jar', m, { downloads: ['https://evil.example/x.jar'] }),
    entry('mods/http.jar', m, { downloads: ['http://cdn.modrinth.com/x.jar'] }),
    entry('mods/nohash.jar', m, { hashes: { sha1: 'a'.repeat(40) } }),
    entry('mods/azure-client-legit-9.jar', m),
    entry('mods/serveronly.jar', m, { env: { client: 'unsupported', server: 'required' } }),
    entry('mods/gh.jar', m, { downloads: ['https://github.com/o/r/releases/download/v1/gh.jar'] }),
  ];
  const p = mrpack.parse(packFile(base(files)));
  assert.deepStrictEqual(p.files.map((f) => f.path), ['mods/ok.jar', 'mods/gh.jar']);
  assert.ok(p.skipped.length >= 11);
  assert.ok(p.skipped.some((s) => /Azure Client is added by the launcher/.test(s.reason)));
  assert.deepStrictEqual(mrpack.ALLOWED_HOSTS, ['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com']);
  assert.strictEqual(mrpack.safeRel('mods/a.jar'), 'mods/a.jar');
  for (const bad of ['', '..', 'a/../b', 'a//b', '.hidden/../x', 'a/b ', 'nul', 'x:y']) assert.strictEqual(mrpack.safeRel(bad), null, bad);
});

test('install: files are downloaded and verified, overrides are written inside the instance only', async () => {
  const mod = Buffer.from('mod-content');
  const pack = packFile(base([entry('mods/a.jar', mod), entry('resourcepacks/r.zip', Buffer.from('rp'))]), {
    'overrides/config/x.toml': 'a = 1', 'overrides/options.txt': 'fov:90',
    'client-overrides/config/x.toml': 'a = 2', // client overrides win
    'overrides/../evil.txt': 'evil', 'overrides/mods/run.exe': 'x', 'overrides/mods/azure-client-legit.jar': 'fake', 'overrides/mods/fabric-api-9.jar': 'fake', 'overrides/saves/w/level.dat': 'no',
  });
  const parsed = mrpack.parse(pack);
  const dir = tmp();
  const fetched = [];
  const fakeDownload = async (url, dest, opts) => {
    fetched.push([url, opts.sha512 && opts.sha512.length]);
    const bytes = url.endsWith('a.jar') ? mod : Buffer.from('rp');
    if (sha(bytes, 'sha512') !== opts.sha512) throw new Error('Wrong sha512');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
  };
  const r = await mrpack.install(parsed, pack, dir, { fetchDownload: fakeDownload });
  assert.strictEqual(r.files, 2);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'mods', 'a.jar'), 'utf8'), 'mod-content');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'config', 'x.toml'), 'utf8'), 'a = 2');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'options.txt'), 'utf8'), 'fov:90');
  for (const no of ['mods/run.exe', 'mods/azure-client-legit.jar', 'mods/fabric-api-9.jar', 'saves/w/level.dat']) assert.ok(!fs.existsSync(path.join(dir, no)), no + ' must not be written');
  assert.ok(!fs.existsSync(path.join(dir, '..', 'evil.txt')));
  assert.ok(r.skipped.length >= 3);
  // a file whose hash does not match is refused
  const tampered = mrpack.parse(packFile(base([{ ...entry('mods/b.jar', mod), hashes: { sha512: 'f'.repeat(128) } }])));
  await assert.rejects(() => mrpack.install(tampered, pack, tmp(), { fetchDownload: fakeDownload }), (e) => e.code === 'DOWNLOAD');
});

test('install over the real network layer: wrong hash is not kept, only allowed hosts are tried', async () => {
  const server = http.createServer((req, res) => res.end('some bytes')).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = 'http://127.0.0.1:' + server.address().port + '/a.jar';
  const parsed = { files: [{ path: 'mods/a.jar', sha512: 'a'.repeat(128), urls: [url], size: 0 }], skipped: [] };
  const dir = tmp();
  await assert.rejects(() => mrpack.install(parsed, packFile(base([])), dir), (e) => e.code === 'DOWNLOAD' && /Wrong sha512/.test(e.message));
  assert.ok(!fs.existsSync(path.join(dir, 'mods', 'a.jar')));
  server.closeAllConnections();
  server.close();
});

test('the pack\'s own Fabric API becomes the instance\'s included one', () => {
  const m = Buffer.from('f');
  const p = mrpack.parse(packFile(base([entry('mods/fabric-api-0.100.jar', m), entry('mods/other.jar', m)])));
  const api = mrpack.packFabricApi(p);
  assert.deepStrictEqual([api.file, api.locked, api.sha512.length], ['fabric-api-0.100.jar', true, 128]);
  assert.strictEqual(mrpack.packFabricApi(mrpack.parse(packFile(base([entry('mods/other.jar', m)])))), null);
});

test('export: Modrinth files become download links, local files go into overrides, the Azure jar is never included', async () => {
  const gameDir = tmp();
  const content = new Content({ gameDir, instance: { mcVersion: '1.21.11', loader: 'fabric', azure: true, mods: [] }, client: {} });
  fs.mkdirSync(path.join(gameDir, 'mods'));
  fs.mkdirSync(path.join(gameDir, 'resourcepacks'));
  const known = Buffer.from('known-mod');
  fs.writeFileSync(path.join(gameDir, 'mods', 'known.jar'), known);
  fs.writeFileSync(path.join(gameDir, 'mods', 'mine.jar'), 'local-mod');
  fs.writeFileSync(path.join(gameDir, 'mods', 'off.jar.disabled'), 'disabled-mod');
  fs.writeFileSync(path.join(gameDir, 'mods', 'azure-client-legit-1.2.15.jar'), 'AZURE');
  fs.writeFileSync(path.join(gameDir, 'resourcepacks', 'rp.zip'), 'zip');
  const items = [];
  for (const kind of ['mod', 'resourcepack']) for (const it of content.list()[kind]) if (!it.virtual) { const file = path.join(content.dir(kind), it.file); items.push({ kind, base: it.base, file, enabled: it.enabled, modId: it.modId, hash: sha(fs.readFileSync(file), 'sha512') }); }
  const knownHash = sha(known, 'sha512');
  const lookup = async () => ({ [knownHash]: { files: [{ url: CDN + 'known.jar', size: 9, hashes: { sha1: sha(known, 'sha1'), sha512: knownHash } }] } });
  const out = await mrpack.build({ instance: { name: 'Mine', mcVersion: '1.21.11', loader: 'fabric', loaderVersion: '0.18.3' }, items, lookup, extraFiles: [{ rel: 'config/c.toml', bytes: enc('k=1') }] });
  const zip = unzipSync(new Uint8Array(out.bytes));
  const index = JSON.parse(Buffer.from(zip['modrinth.index.json']).toString('utf8'));
  assert.deepStrictEqual(index.dependencies, { minecraft: '1.21.11', 'fabric-loader': '0.18.3' });
  assert.deepStrictEqual(index.files.map((f) => f.path), ['mods/known.jar']);
  assert.strictEqual(index.files[0].downloads[0], CDN + 'known.jar');
  assert.deepStrictEqual(Object.keys(zip).filter((n) => n.startsWith('overrides/')).sort(), ['overrides/config/c.toml', 'overrides/mods/mine.jar', 'overrides/resourcepacks/rp.zip']);
  assert.ok(!Object.keys(zip).some((n) => /azure|aurora/i.test(n)), 'the Azure jar must never be in an export');
  assert.ok(!JSON.stringify(index).match(/azure-client/i));
  assert.strictEqual(out.files, 1);
  assert.strictEqual(out.overrides, 3);
  // and the export can be imported again
  const f = path.join(tmp(), 'out.mrpack');
  fs.writeFileSync(f, out.bytes);
  const again = mrpack.parse(f);
  assert.deepStrictEqual(again.files.map((x) => x.path), ['mods/known.jar']);
  const dir = tmp();
  await mrpack.install(again, f, dir, { fetchDownload: async (u, dest) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, known); } });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'mods', 'mine.jar'), 'utf8'), 'local-mod');
  assert.ok(fs.existsSync(path.join(dir, 'config', 'c.toml')));
});

test('after an import, files Modrinth knows get names, icons and update checks', async () => {
  const gameDir = tmp();
  fs.mkdirSync(path.join(gameDir, 'mods'));
  const bytes = Buffer.from('packmod');
  fs.writeFileSync(path.join(gameDir, 'mods', 'p.jar'), bytes);
  fs.writeFileSync(path.join(gameDir, 'mods', 'q.jar'), 'unknown');
  const h = sha(bytes, 'sha512');
  const client = { versionsByHashes: async () => ({ [h]: { id: 'v9', project_id: 'P9', version_number: '9.0' } }), projects: async () => [{ id: 'P9', title: 'Pack Mod', icon_url: 'https://cdn.modrinth.com/p9.png' }] };
  const content = new Content({ gameDir, instance: { mcVersion: '1.21.11', loader: 'fabric', mods: [] }, client });
  assert.strictEqual(await recogniseInstalled(content, client), 1);
  const list = new Content({ gameDir, instance: { mcVersion: '1.21.11', loader: 'fabric', mods: [] }, client }).list().mod;
  assert.deepStrictEqual(list.map((m) => [m.name, m.source]).sort(), [['Pack Mod', 'modrinth'], ['q', 'local']]);
});

test('M10: a pack is never read into memory whole; only its description and override files are read', () => {
  const big = new Uint8Array(8 * 1024 * 1024); // stored mods data the launcher must not load (pretend: a big pack)
  const f = packFile(base([]), { 'overrides/config/a.txt': 'hello', 'overrides/mods/x.jar': big.subarray(0, 10), 'other/huge.bin': big });
  const real = fs.readFileSync;
  const readWhole = [];
  fs.readFileSync = (p, ...a) => { if (String(p) === f) readWhole.push(p); return real(p, ...a); };
  try {
    const pack = mrpack.parse(f);
    assert.strictEqual(pack.name, 'My Pack');
    const { overrides } = mrpack.readOverrides(f);
    assert.deepStrictEqual(overrides.map((o) => o.rel).sort(), ['config/a.txt', 'mods/x.jar']);
    assert.strictEqual(Buffer.from(overrides.find((o) => o.rel === 'config/a.txt').bytes).toString(), 'hello');
  } finally { fs.readFileSync = real; }
  assert.deepStrictEqual(readWhole, [], 'the whole pack file was never read');
});

test('M10: a zip entry that lies about its size is refused', () => {
  const { openZip } = require('../src/zipfile');
  const f = packFile(base([]), { 'overrides/config/a.txt': 'x'.repeat(5000) });
  const b = fs.readFileSync(f);
  // make the directory claim the override is 10 bytes; it inflates to 5000
  const name = Buffer.from('overrides/config/a.txt');
  for (let i = 0; i < b.length - 4; i++) {
    if (b.readUInt32LE(i) === 0x02014b50 && b.subarray(i + 46, i + 46 + name.length).equals(name)) b.writeUInt32LE(10, i + 24);
  }
  fs.writeFileSync(f, b);
  const zip = openZip(f);
  try {
    assert.throws(() => zip.read(zip.entries.find((e) => e.name === 'overrides/config/a.txt')), /oversized|Damaged/);
  } finally { zip.close(); }
});
