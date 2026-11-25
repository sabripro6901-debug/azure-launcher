'use strict';
// The mod check: problems found before the game starts, Fabric's own refusal read from the output, and the fixes
// (turn off, remove, newer loader, right version, missing mod) with Undo.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { zipSync } = require('fflate');
const { check, satisfies, specText, fabricRefusal } = require('../src/modcheck');
const modfix = require('../src/modfix');

const enc = (t) => new TextEncoder().encode(t);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'azure-mc-'));
const modJson = (id, version, extra = {}) => JSON.stringify({ schemaVersion: 1, id, version, name: 'Mod ' + id, ...extra });
const zip = (files) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? enc(v) : v])));
function jar(dir, name, id, version, extra = {}, more = {}) {
  fs.writeFileSync(path.join(dir, name), zip({ 'fabric.mod.json': modJson(id, version, extra), ...more }));
}
const base = (modsDir, extra = {}) => ({ modsDir, mc: '1.21.11', loaderVersion: '0.18.3', javaMajor: 21, locked: [], ...extra });
const kinds = (r, file) => (r.problems.find((p) => p.file === file) || { reasons: [] }).reasons.map((x) => x.kind).sort();

test('version ranges: Fabric operators, x wildcards, ||, arrays; unknown stays quiet', () => {
  assert.strictEqual(satisfies('>=0.18.4', '0.18.3'), false);
  assert.strictEqual(satisfies('>=0.18.4', '0.19.0'), true);
  assert.strictEqual(satisfies('~1.21.11', '1.21.11'), true);
  assert.strictEqual(satisfies('~1.21', '1.21.11'), true);
  assert.strictEqual(satisfies('~26.3', '1.21.11'), false);
  assert.strictEqual(satisfies('1.21.x', '1.21.11'), true);
  assert.strictEqual(satisfies('26.3.x', '1.21.11'), false);
  assert.strictEqual(satisfies('>=26.1 <27', '1.21.11'), false);
  assert.strictEqual(satisfies(['1.21.10', '1.21.11'], '1.21.11'), true);
  assert.strictEqual(satisfies('1.20 || >=1.21.11', '1.21.11'), true);
  assert.strictEqual(satisfies('*', '1.0'), true);
  assert.strictEqual(satisfies('>=25', '21'), false);
  assert.strictEqual(satisfies('>=1.0', 'beta'), null);
  assert.strictEqual(specText('>=0.19.5'), '0.19.5 or newer');
  assert.strictEqual(specText('>=26.3-rc.1'), '26.3 or newer');
});

test('finds every kind of problem; a good set has none', () => {
  const d = tmp();
  jar(d, 'good.jar', 'good', '1.0.0', { depends: { minecraft: '~1.21.11', fabricloader: '>=0.16', lib: '>=2.0' } });
  jar(d, 'lib.jar', 'lib', '2.1.0');
  assert.deepStrictEqual(check(base(d)).problems, []);
  jar(d, 'new.jar', 'newmc', '1.0.0', { depends: { minecraft: '26.3.x' } });
  jar(d, 'loader.jar', 'loadery', '1.0.0', { depends: { fabricloader: '>=0.18.6' } });
  jar(d, 'java.jar', 'javay', '1.0.0', { depends: { java: '>=25' } });
  jar(d, 'needs.jar', 'needsx', '1.0.0', { depends: { 'not-here': '*' } });
  jar(d, 'oldlib.jar', 'wantsnew', '1.0.0', { depends: { lib: '>=3.0' } });
  jar(d, 'lib-old.jar', 'lib', '1.5.0');
  jar(d, 'hater.jar', 'hater', '1.0.0', { breaks: { good: '*' } });
  fs.writeFileSync(path.join(d, 'forge.jar'), zip({ 'META-INF/mods.toml': 'modId="x"' }));
  fs.writeFileSync(path.join(d, 'broken.jar'), enc('not a zip'));
  const r = check(base(d));
  assert.deepStrictEqual(kinds(r, 'new.jar'), ['mc']);
  assert.deepStrictEqual(kinds(r, 'loader.jar'), ['loader']);
  assert.deepStrictEqual(kinds(r, 'java.jar'), ['java']);
  assert.deepStrictEqual(kinds(r, 'needs.jar'), ['missing']);
  assert.deepStrictEqual(kinds(r, 'oldlib.jar'), ['depversion']);
  assert.deepStrictEqual(kinds(r, 'lib-old.jar'), ['duplicate']); // the older copy of lib
  assert.deepStrictEqual(kinds(r, 'hater.jar'), ['breaks']);
  assert.deepStrictEqual(kinds(r, 'forge.jar'), ['notfabric']);
  assert.deepStrictEqual(kinds(r, 'broken.jar'), ['damaged']);
  assert.deepStrictEqual(kinds(r, 'good.jar'), []);
  assert.match(r.problems.find((p) => p.file === 'loader.jar').reasons[0].text, /Fabric Loader 0\.18\.6 or newer; this instance has 0\.18\.3/);
});

test('mods bundled inside a jar (and "provides") count as installed; disabled files are not read', () => {
  const d = tmp();
  const inner = zip({ 'fabric.mod.json': modJson('bundled-lib', '4.0.0') });
  jar(d, 'host.jar', 'host', '1.0.0', { jars: [{ file: 'META-INF/jars/lib.jar' }], provides: ['alias'] }, { 'META-INF/jars/lib.jar': inner });
  jar(d, 'user.jar', 'user', '1.0.0', { depends: { 'bundled-lib': '>=4', alias: '*', mixinextras: '>=0.3' } });
  fs.writeFileSync(path.join(d, 'off.jar.disabled'), enc('ignored'));
  assert.deepStrictEqual(check(base(d)).problems, []);
});

test('the launcher\'s own files are marked locked and win a duplicate', () => {
  const d = tmp();
  jar(d, 'fabric-api-0.141.6+1.21.11.jar', 'fabric-api', '0.141.6+1.21.11');
  jar(d, 'fabric-api-0.162.0+26.3.jar', 'fabric-api', '0.162.0+26.3', { depends: { minecraft: '26.3.x' } });
  const r = check(base(d, { locked: ['fabric-api-0.141.6+1.21.11.jar'] }));
  assert.deepStrictEqual(r.problems.map((p) => p.file), ['fabric-api-0.162.0+26.3.jar']);
  assert.deepStrictEqual(kinds(r, 'fabric-api-0.162.0+26.3.jar'), ['duplicate', 'mc']);
});

test('Fabric\'s refusal is read from the game output; other crashes are not', () => {
  const lines = [
    '[13:01:02] [main/ERROR]: Incompatible mods found!',
    'net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!',
    'A potential solution has been determined, this may resolve your problem:',
    '\t - Replace mod \'Sodium\' (sodium) 0.9.3 with any version that is compatible with:',
    '\t - Replace \'Minecraft\' (minecraft) 1.21.11 with version 26.3.',
    'More details:',
    '\t - Mod \'Lithium\' (lithium) 0.26.2 requires version 26.3 of \'Minecraft\'',
    '\tat net.fabricmc.loader.impl.FormattedException.ofLocalized(FormattedException.java:51)',
  ];
  const r = fabricRefusal(lines);
  assert.strictEqual(r.length, 3);
  assert.match(r[0], /^Replace mod 'Sodium'/);
  assert.strictEqual(fabricRefusal(['java.lang.NullPointerException', '\tat foo']), null);
});

function fixture() {
  const gameDir = tmp();
  const modsDir = path.join(gameDir, 'mods');
  fs.mkdirSync(modsDir);
  jar(modsDir, 'a.jar', 'a', '1.0.0', { depends: { fabricloader: '>=0.18.6' } });
  jar(modsDir, 'b.jar', 'b', '1.0.0', { depends: { minecraft: '26.3.x' } });
  let loader = '0.18.3';
  const ctx = { gameDir, modsDir, setLoader: (v) => { const old = loader; loader = v; return old; }, loader: () => loader };
  return { gameDir, modsDir, ctx };
}

test('fixes: offline only turn off / remove; a newer loader and the right version when known; locked gets none', async () => {
  const { modsDir } = fixture();
  const r = check(base(modsDir));
  const offline = { latestByHashes: async () => { throw new Error('offline'); }, versionsFor: async () => { throw new Error('offline'); } };
  await modfix.withFixes(r, { modsDir, mc: '1.21.11', client: offline, newestLoader: async () => { throw new Error('offline'); } });
  for (const p of r.problems) assert.deepStrictEqual(p.fixes.map((f) => f.action), ['disable', 'remove']);
  const r2 = check(base(modsDir));
  const file = { filename: 'b-1.21.11.jar', url: 'https://cdn.modrinth.com/b.jar', hashes: { sha512: 'x' }, primary: true };
  const online = { latestByHashes: async (hashes) => Object.fromEntries(hashes.map((h) => [h, { id: 'v2', project_id: 'pb', version_number: '2.0', game_versions: ['1.21.11'], files: [file] }])) };
  await modfix.withFixes(r2, { modsDir, mc: '1.21.11', client: online, newestLoader: async () => '0.19.2' });
  const a = r2.problems.find((p) => p.file === 'a.jar');
  const b = r2.problems.find((p) => p.file === 'b.jar');
  assert.ok(a.fixes.some((f) => f.action === 'loader' && f.version === '0.19.2'));
  assert.ok(b.fixes.some((f) => f.action === 'update' && f.versionId === 'v2'));
  const locked = check(base(modsDir, { locked: ['a.jar'] }));
  await modfix.withFixes(locked, { modsDir, mc: '1.21.11', client: offline, newestLoader: async () => null });
  assert.deepStrictEqual(locked.problems.find((p) => p.file === 'a.jar').fixes, []);
});

test('turn off, remove (moved, never deleted), loader, right version: all undone by one Undo', async () => {
  const { gameDir, modsDir, ctx } = fixture();
  const S = 's1234567';
  jar(modsDir, 'c.jar', 'c', '1.0.0');
  jar(modsDir, 'd.jar', 'd', '1.0.0');
  ctx.content = { install: async () => { fs.writeFileSync(path.join(modsDir, 'b-1.21.11.jar'), enc('new')); } };
  await modfix.applyFix({ action: 'disable' }, 'c.jar', S, ctx);
  await modfix.applyFix({ action: 'remove' }, 'd.jar', S, ctx);
  await modfix.applyFix({ action: 'loader', version: '0.19.2' }, '', S, ctx);
  await modfix.applyFix({ action: 'update', projectId: 'pb', versionId: 'v2' }, 'b.jar', S, ctx);
  assert.ok(fs.existsSync(path.join(modsDir, 'c.jar.disabled')));
  assert.ok(fs.existsSync(path.join(gameDir, 'mods-removed', S, 'd.jar')));
  assert.ok(fs.existsSync(path.join(gameDir, 'mods-removed', S, 'b.jar')));
  assert.ok(fs.existsSync(path.join(modsDir, 'b-1.21.11.jar')));
  assert.strictEqual(ctx.loader(), '0.19.2');
  assert.ok(modfix.canUndo(gameDir, S));
  assert.strictEqual(modfix.undo(S, ctx), 5);
  assert.deepStrictEqual(fs.readdirSync(modsDir).sort(), ['a.jar', 'b.jar', 'c.jar', 'd.jar']);
  assert.strictEqual(ctx.loader(), '0.18.3');
  assert.ok(!modfix.canUndo(gameDir, S));
});

test('fix file names cannot leave the mods folder', async () => {
  const { modsDir, ctx } = fixture();
  await assert.rejects(modfix.applyFix({ action: 'remove' }, '../x.jar', 's1234567', ctx));
  await assert.rejects(modfix.applyFix({ action: 'disable' }, 'nope.jar', 's1234567', ctx));
  assert.deepStrictEqual(fs.readdirSync(modsDir).sort(), ['a.jar', 'b.jar']);
});

test('a version with build metadata (+1.21.x) is compared without it, like Fabric does', () => {
  const { satisfies } = require('../src/modcheck');
  assert.strictEqual(satisfies('>=1.0.0+1.21.x', '1.0.0+1.21.x'), true);
  assert.strictEqual(satisfies('>=1.0.1+1.21.x', '1.0.0+1.21.x'), false);
  assert.strictEqual(satisfies('1.21.x', '1.21.11'), true);
});
