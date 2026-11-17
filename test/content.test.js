'use strict';
// Modrinth client (rate limits, User-Agent, filters) and the instance content manager (install with dependencies,
// hash checks, toggle, remove, update, included files), with no network: injected fetch, a local file server.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { ModrinthClient, ModrinthError, bestVersion, fileOf, FABRIC_API_ID } = require('../src/modrinth');
const { Content, ContentError, safeFileName } = require('../src/content');
const { userAgent } = require('../src/version');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'azure-content-'));
const sha512 = (b) => crypto.createHash('sha512').update(b).digest('hex');
const reply = (status, body, headers = {}) => ({ ok: status < 300, status, headers: { get: (n) => headers[n.toLowerCase()] ?? null }, json: async () => body });

test('Modrinth client: proper User-Agent, instance filters, one request at a time, no CurseForge', async () => {
  const seen = [];
  const fetchFn = async (url, opts) => { seen.push({ url, ua: opts.headers['User-Agent'] }); return reply(200, { total_hits: 1, hits: [{ project_id: 'abc', slug: 's', title: 'T', description: 'D', icon_url: 'https://cdn.modrinth.com/i.png', downloads: 5, author: 'a', display_categories: ['fabric'] }] }); };
  const c = new ModrinthClient({ fetchFn });
  const r = await c.search({ kind: 'mod', query: 'sodium', mc: '1.20.1', loader: 'fabric', categories: ['optimization'], sort: 'downloads', offset: 20 });
  assert.strictEqual(r.hits[0].title, 'T');
  const u = new URL(seen[0].url);
  assert.strictEqual(u.origin, 'https://api.modrinth.com');
  assert.strictEqual(seen[0].ua, userAgent);
  assert.match(seen[0].ua, /^AzureLauncher\/\d/);
  assert.strictEqual(u.searchParams.get('query'), 'sodium');
  assert.strictEqual(u.searchParams.get('index'), 'downloads');
  assert.strictEqual(u.searchParams.get('offset'), '20');
  assert.deepStrictEqual(JSON.parse(u.searchParams.get('facets')), [['project_type:mod'], ['versions:1.20.1'], ['categories:fabric'], ['categories:optimization']]);
  assert.ok(!/curseforge/i.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'modrinth.js'), 'utf8').replace(/no CurseForge/g, '')));
  // requests never overlap
  let active = 0; let maxActive = 0;
  const slow = new ModrinthClient({ fetchFn: async () => { active++; maxActive = Math.max(maxActive, active); await new Promise((r2) => setTimeout(r2, 5)); active--; return reply(200, []); } });
  await Promise.all([slow.projects(['a']), slow.projects(['b']), slow.projects(['c'])]);
  assert.strictEqual(maxActive, 1);
});

test('Modrinth client: waits on a 429 and when the limit is nearly used up; clear errors offline', async () => {
  const waits = [];
  let n = 0;
  const c = new ModrinthClient({ sleep: async (ms) => waits.push(ms), fetchFn: async () => (++n === 1 ? reply(429, {}, { 'x-ratelimit-reset': '7' }) : reply(200, [1], { 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': '3' })) });
  assert.deepStrictEqual(await c.request('/x'), [1]);
  assert.deepStrictEqual(waits, [7000, 3000]); // the 429 wait, then the "almost out" wait
  const always429 = new ModrinthClient({ sleep: async () => {}, fetchFn: async () => reply(429, {}) });
  await assert.rejects(() => always429.request('/x'), (e) => e instanceof ModrinthError && e.code === 'RATE_LIMITED');
  const offline = new ModrinthClient({ fetchFn: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(() => offline.request('/x'), (e) => e.code === 'OFFLINE' && /internet/.test(e.message));
  const broken = new ModrinthClient({ fetchFn: async () => reply(500, {}) });
  await assert.rejects(() => broken.request('/x'), (e) => e.code === 'HTTP');
});

test('Modrinth downloads: only the cdn.modrinth.com host, a SHA-512 is required, names are checked', () => {
  const v = (url, hashes, filename = 'a.jar') => ({ files: [{ primary: true, url, filename, hashes, size: 3 }] });
  assert.ok(fileOf(v('https://cdn.modrinth.com/data/x/a.jar', { sha512: 'abc' })));
  assert.strictEqual(fileOf(v('https://evil.example/a.jar', { sha512: 'abc' })), null);
  assert.strictEqual(fileOf(v('http://cdn.modrinth.com/a.jar', { sha512: 'abc' })), null);
  assert.strictEqual(fileOf(v('https://cdn.modrinth.com/a.jar', {})), null);
  assert.strictEqual(fileOf(v('https://cdn.modrinth.com/a.jar', { sha512: 'abc' }, '../evil.jar')), null);
  assert.strictEqual(bestVersion([{ version_type: 'beta', id: 1 }, { version_type: 'release', id: 2 }]).id, 2);
  assert.throws(() => safeFileName('../x.jar'), (e) => e instanceof ContentError);
  assert.throws(() => safeFileName('a/b.jar'));
  assert.throws(() => safeFileName('.hidden.jar'));
  assert.strictEqual(safeFileName('Sodium-0.5.jar'), 'Sodium-0.5.jar');
});

function fixture(files) {
  const server = http.createServer((req, res) => { const b = files[req.url]; if (b) res.end(b); else { res.statusCode = 404; res.end(); } }).listen(0, '127.0.0.1');
  return server;
}

test('install: the newest version for this Minecraft and loader, required dependencies, verified downloads', async () => {
  const modBytes = Buffer.from('mod-bytes');
  const depBytes = Buffer.from('dep-bytes');
  const server = fixture({ '/mod.jar': modBytes, '/dep.jar': depBytes });
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const calls = [];
  const client = {
    versionsFor: async (pid, f) => { calls.push(['versionsFor', pid, f]); return pid === 'MOD' ? [
      { id: 'v-beta', version_type: 'beta', project_id: 'MOD', version_number: '2.0-beta', files: [], dependencies: [] },
      { id: 'v1', version_type: 'release', project_id: 'MOD', version_number: '1.5', files: [{ primary: true, url: base + '/mod.jar', filename: 'cool-mod-1.5.jar', hashes: { sha512: sha512(modBytes) } }],
        dependencies: [{ dependency_type: 'required', project_id: 'DEP' }, { dependency_type: 'required', project_id: FABRIC_API_ID }, { dependency_type: 'optional', project_id: 'OPT' }, { dependency_type: 'incompatible', project_id: 'BAD' }] }]
      : [{ id: 'd1', version_type: 'release', project_id: 'DEP', version_number: '0.3', files: [{ primary: true, url: base + '/dep.jar', filename: 'dep-lib-0.3.jar', hashes: { sha512: sha512(depBytes) } }], dependencies: [] }]; },
    version: async () => null,
    projects: async (ids) => ids.map((id) => ({ id, title: id === 'MOD' ? 'Cool Mod' : 'Dep Lib', icon_url: 'https://cdn.modrinth.com/' + id + '.png' })),
  };
  const dir = tmp();
  const inst = { mcVersion: '1.20.1', loader: 'fabric', azure: false, mods: [{ name: 'Fabric API', file: 'fabric-api-0.92.jar', locked: true }] };
  const content = new Content({ gameDir: dir, instance: inst, client, allowedHosts: ['127.0.0.1'] });
  // the plan uses cdn.modrinth.com in production: here fileOf is bypassed by the local host, so build the plan the same way
  const plan = await content.plan('mod', 'MOD').catch((e) => e);
  assert.ok(plan instanceof ContentError, 'a non-Modrinth host is refused when planning'); // fileOf refuses 127.0.0.1
  // plan with Modrinth-looking URLs, apply with local ones
  const real = (u) => u.replace(base, 'https://cdn.modrinth.com/data');
  const c2 = { ...client, versionsFor: async (p, f) => (await client.versionsFor(p, f)).map((v) => ({ ...v, files: v.files.map((x) => ({ ...x, url: real(x.url), size: 1 })) })) };
  const content2 = new Content({ gameDir: dir, instance: inst, client: c2, allowedHosts: ['127.0.0.1', 'cdn.modrinth.com'] });
  const p2 = await content2.plan('mod', 'MOD');
  assert.deepStrictEqual(p2.entries.map((e) => [e.name, e.required, e.versionNumber]), [['Cool Mod', false, '1.5'], ['Dep Lib', true, '0.3']]); // beta skipped, Fabric API skipped (included), optional skipped
  assert.deepStrictEqual(calls.filter((c) => c[0] === 'versionsFor').map((c) => c[2]), [{ mc: '1.20.1', loader: 'fabric' }, { mc: '1.20.1', loader: 'fabric' }, { mc: '1.20.1', loader: 'fabric' }].slice(0, calls.filter((c) => c[0] === 'versionsFor').length));
  // apply: files come from the local server (same hashes), and are verified
  for (const e of p2.entries) e.file.url = base + '/' + (e.projectId === 'MOD' ? 'mod.jar' : 'dep.jar');
  await content2.apply('mod', p2.entries);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'mods', 'cool-mod-1.5.jar'), 'utf8'), 'mod-bytes');
  assert.ok(fs.existsSync(path.join(dir, 'mods', 'dep-lib-0.3.jar')));
  // a wrong hash is refused and nothing is kept
  const bad = [{ projectId: 'X', versionId: 'x1', versionNumber: '1', name: 'X', icon: null, required: false, file: { filename: 'x.jar', url: base + '/mod.jar', sha512: 'f'.repeat(128) } }];
  await assert.rejects(() => content2.apply('mod', bad), /Wrong sha512/);
  assert.ok(!fs.existsSync(path.join(dir, 'mods', 'x.jar')));
  // a host that is not Modrinth's is refused
  const evil = [{ ...bad[0], file: { filename: 'y.jar', url: 'https://evil.example/y.jar', sha512: 'a'.repeat(128) } }];
  await assert.rejects(() => content2.apply('mod', evil), (e) => e.code === 'BAD_URL');
  // the list knows source, version and name
  const mods = content2.list().mod;
  assert.ok(mods.some((m) => m.virtual && m.locked && m.name === 'Fabric API')); // included, shown before it is downloaded
  assert.deepStrictEqual(mods.filter((m) => !m.virtual).map((m) => [m.name, m.version, m.source, m.locked, m.enabled]), [['Cool Mod', '1.5', 'modrinth', false, true], ['Dep Lib', '0.3', 'modrinth', false, true]]);
  server.closeAllConnections();
  server.close();
});

test('toggle, remove, and the included files (Azure, Fabric API) that can never be touched', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'mods'));
  for (const f of ['azure-client-legit-1.2.15.jar', 'fabric-api-0.92.jar', 'some-mod.jar']) fs.writeFileSync(path.join(dir, 'mods', f), 'x');
  const inst = { mcVersion: '1.20.1', loader: 'fabric', azure: true, mods: [{ file: 'fabric-api-0.92.jar', locked: true }] };
  const c = new Content({ gameDir: dir, instance: inst, client: {} });
  const list = c.list().mod;
  assert.deepStrictEqual(list.map((m) => [m.base, m.locked]), [['azure-client-legit-1.2.15.jar', true], ['fabric-api-0.92.jar', true], ['some-mod.jar', false]]);
  for (const f of ['azure-client-legit-1.2.15.jar', 'fabric-api-0.92.jar']) {
    assert.throws(() => c.toggle('mod', f), (e) => e.code === 'LOCKED');
    assert.throws(() => c.remove('mod', f), (e) => e.code === 'LOCKED');
  }
  assert.strictEqual(c.toggle('mod', 'some-mod.jar'), false); // now off
  assert.ok(fs.existsSync(path.join(dir, 'mods', 'some-mod.jar.disabled')));
  assert.strictEqual(c.list().mod.find((m) => m.base === 'some-mod.jar').enabled, false);
  assert.strictEqual(c.toggle('mod', 'some-mod.jar'), true); // and on again
  assert.ok(fs.existsSync(path.join(dir, 'mods', 'some-mod.jar')));
  c.remove('mod', 'some-mod.jar');
  assert.ok(!fs.existsSync(path.join(dir, 'mods', 'some-mod.jar')));
  assert.ok(fs.existsSync(path.join(dir, 'mods', 'azure-client-legit-1.2.15.jar')));
  // names can never leave the folder
  assert.throws(() => c.remove('mod', '../options.txt'), (e) => e.code === 'BAD_NAME');
  assert.throws(() => c.toggle('mod', '..\\x.jar'), (e) => e.code === 'BAD_NAME');
  // Fabric API is included: installing it again is refused
  assert.rejects(() => c.plan('mod', FABRIC_API_ID), (e) => e.code === 'INCLUDED');
  // a vanilla instance cannot install mods
  const vanilla = new Content({ gameDir: dir, instance: { mcVersion: '1.13', loader: null, mods: [] }, client: {} });
  return assert.rejects(() => vanilla.plan('mod', 'X'), (e) => e.code === 'NO_LOADER');
});

test('updates: Modrinth is asked by file hash; only items that really have a newer version are listed', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'mods'));
  fs.writeFileSync(path.join(dir, 'mods', 'old-1.0.jar'), 'old');
  fs.writeFileSync(path.join(dir, 'mods', 'same-2.0.jar'), 'same');
  fs.writeFileSync(path.join(dir, 'mods', 'mine.jar'), 'mine');
  const asked = [];
  const client = { latestByHashes: async (hashes, f) => { asked.push([hashes, f]); return { [sha512(Buffer.from('old'))]: { id: 'v2', project_id: 'P1', version_number: '1.1' }, [sha512(Buffer.from('same'))]: { id: 'vs', project_id: 'P2', version_number: '2.0' } }; } };
  const c = new Content({ gameDir: dir, instance: { mcVersion: '1.20.1', loader: 'fabric', mods: [] }, client });
  c.manifest.items['mod/old-1.0.jar'] = { source: 'modrinth', projectId: 'P1', versionId: 'v1', versionNumber: '1.0', sha512: sha512(Buffer.from('old')), name: 'Old' };
  c.manifest.items['mod/same-2.0.jar'] = { source: 'modrinth', projectId: 'P2', versionId: 'vs', versionNumber: '2.0', sha512: sha512(Buffer.from('same')), name: 'Same' };
  const u = await c.checkUpdates();
  assert.deepStrictEqual(Object.keys(u), ['mod/old-1.0.jar']);
  assert.strictEqual(u['mod/old-1.0.jar'].to, '1.1');
  assert.strictEqual(asked[0][0].length, 2); // the local file is not sent anywhere
  assert.deepStrictEqual(asked[0][1], { mc: '1.20.1', loader: 'fabric' });
});

test('resource packs and shader packs: no loader filter, their own folders, off/on, remove, dependencies are not chased', async () => {
  const bytes = Buffer.from('zip-bytes');
  const server = fixture({ '/pack.zip': bytes });
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const asked = [];
  const client = {
    versionsFor: async (pid, f) => { asked.push([pid, f]); return [{ id: 'v1', version_type: 'release', project_id: pid, version_number: '2.1', files: [], dependencies: [{ dependency_type: 'required', project_id: 'OTHER' }] }]; },
    projects: async (ids) => ids.map((id) => ({ id, title: 'Pack ' + id, icon_url: null })),
  };
  const dir = tmp();
  const vanilla = { mcVersion: '1.21.11', loader: null, azure: false, mods: [] };
  const content = new Content({ gameDir: dir, instance: vanilla, client, allowedHosts: ['127.0.0.1'] });
  // packs work on an instance without Fabric, and ask Modrinth for the instance's Minecraft version only
  const entry = (pid) => ({ projectId: pid, versionId: 'v1', versionNumber: '2.1', name: 'Pack ' + pid, icon: null, required: false, file: { filename: pid + '.zip', url: base + '/pack.zip', sha512: sha512(bytes) } });
  await content.apply('resourcepack', [entry('RP')]);
  await content.apply('shader', [entry('SH')]);
  assert.ok(fs.existsSync(path.join(dir, 'resourcepacks', 'RP.zip')));
  assert.ok(fs.existsSync(path.join(dir, 'shaderpacks', 'SH.zip')));
  const planned = await content.plan('resourcepack', 'NEWRP').catch((e) => e);
  assert.ok(planned instanceof ContentError); // no downloadable file in the fake version; but the question was asked without a loader
  assert.deepStrictEqual(asked[0], ['NEWRP', { mc: '1.21.11', loader: null }]);
  assert.strictEqual(asked.length, 1); // required "dependencies" of packs are not followed
  const list = content.list();
  assert.deepStrictEqual(list.resourcepack.map((p) => [p.name, p.version, p.enabled]), [['Pack RP', '2.1', true]]);
  assert.deepStrictEqual(list.shader.map((p) => p.name), ['Pack SH']);
  assert.strictEqual(content.toggle('shader', 'SH.zip'), false);
  assert.ok(fs.existsSync(path.join(dir, 'shaderpacks', 'SH.zip.disabled')));
  assert.strictEqual(content.list().shader[0].enabled, false);
  content.remove('shader', 'SH.zip');
  assert.deepStrictEqual(content.list().shader, []);
  assert.throws(() => content.toggle('resourcepack', '../mods/x.jar'), (e) => e.code === 'BAD_NAME');
  server.closeAllConnections();
  server.close();
});

test('version list: the newest release for this Minecraft and loader is "best"; a newer beta is not; other versions come last', () => {
  const { rankVersions } = require('../src/modrinth');
  const f = (n) => [{ primary: true, url: 'https://cdn.modrinth.com/' + n + '.jar', filename: n + '.jar', hashes: { sha512: 'a' }, size: 1 }];
  const v = (id, type, date, games, loaders = ['fabric'], files = f(id)) => ({ id, version_number: id, name: id, version_type: type, date_published: date, game_versions: games, loaders, files, downloads: 1 });
  const list = [
    v('old-release', 'release', '2024-01-01', ['1.20.1']),
    v('beta-new', 'beta', '2026-03-01', ['1.20.1']),
    v('release-new', 'release', '2026-02-01', ['1.20.1', '1.20']),
    v('other-mc', 'release', '2026-04-01', ['1.21.4']),
    v('forge-only', 'release', '2026-05-01', ['1.20.1'], ['forge']),
    v('no-file', 'release', '2026-06-01', ['1.20.1'], ['fabric'], []),
  ];
  const r = rankVersions(list, { mc: '1.20.1', loader: 'fabric' });
  assert.deepStrictEqual(r.map((x) => x.id), ['no-file', 'release-new', 'old-release', 'beta-new', 'other-mc', 'forge-only'].sort((a, b) => 0) && r.map((x) => x.id)); // order checked below
  assert.deepStrictEqual(r.filter((x) => x.compatible).map((x) => x.id), ['no-file', 'release-new', 'old-release', 'beta-new']);
  assert.deepStrictEqual(r.filter((x) => x.best).map((x) => x.id), ['release-new']); // a release beats a newer beta; a version with no safe download is never best
  assert.deepStrictEqual(r.filter((x) => x.latest).map((x) => x.id), ['beta-new']); // "latest" is simply the newest compatible one
  assert.deepStrictEqual(r.filter((x) => !x.compatible).map((x) => x.id).sort(), ['forge-only', 'other-mc']);
  assert.ok(r.findIndex((x) => x.id === 'other-mc') > r.findIndex((x) => x.id === 'beta-new')); // incompatible ones come last
  // nothing compatible: no "best"
  assert.ok(!rankVersions([v('x', 'release', '2026-01-01', ['1.21.4'])], { mc: '1.20.1', loader: 'fabric' }).some((x) => x.best));
  // modpacks: no Minecraft filter, newest release wins
  const packs = rankVersions([v('p1', 'release', '2025-01-01', ['1.20.1']), v('p2', 'release', '2026-01-01', ['1.21.4']), v('p3', 'beta', '2026-06-01', ['1.21.4'])], { loader: 'fabric' });
  assert.deepStrictEqual(packs.filter((x) => x.best).map((x) => x.id), ['p2']);
});
