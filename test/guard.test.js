'use strict';
// The launcher's Legit guard (src/guard.js) must refuse what the mod repo's tools/check_legit_jar.py refuses.
// AUDIT M1: any .ogg that is not one of our own sounds, also inside archives in the jar.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { zipSync, strToU8 } = require('fflate');
const { checkLegitJar, OWN_SOUNDS } = require('../src/guard');

const META = strToU8(JSON.stringify({ id: 'aurora', mixins: ['aurora.mixins.json'] }));
function jar(files) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'azure-guard-')), 'azure-client-legit-test.jar');
  fs.writeFileSync(f, zipSync({ 'fabric.mod.json': META, ...files }));
  return f;
}

test('a clean jar passes', () => {
  assert.deepStrictEqual(checkLegitJar(jar({ 'com/aurora/client/A.class': strToU8('plain class bytes') })), []);
});

test('M1: an .ogg that is not on the own-sounds list is refused (no Minecraft audio)', () => {
  const p = checkLegitJar(jar({ 'assets/aurora/sounds/amb/aurora.ogg': strToU8('OggS mojang loop') }));
  assert.ok(p.some((x) => /own-sounds list.*amb\/aurora\.ogg/.test(x)), p.join('; '));
});

test('M1: a listed sound with other bytes is refused; with the listed bytes it passes', () => {
  const name = 'assets/aurora/sounds/test_beat.ogg';
  const bytes = strToU8('OggS our own beat');
  OWN_SOUNDS.set(name, crypto.createHash('sha256').update(bytes).digest('hex'));
  try {
    assert.deepStrictEqual(checkLegitJar(jar({ [name]: bytes })), []);
    const p = checkLegitJar(jar({ [name]: strToU8('OggS replaced') }));
    assert.ok(p.some((x) => /changed since it was listed/.test(x)), p.join('; '));
  } finally {
    OWN_SOUNDS.delete(name);
  }
});

test('M1: archives inside the jar are opened and checked the same way', () => {
  const inner = zipSync({ 'pack/sounds/rain.ogg': strToU8('OggS rain'), 'pack/notes.txt': strToU8('uses lrclib') });
  const p = checkLegitJar(jar({ 'assets/aurora/packs/extra.zip': inner }));
  assert.ok(p.some((x) => /own-sounds list: assets\/aurora\/packs\/extra\.zip!\/pack\/sounds\/rain\.ogg/.test(x)), p.join('; '));
  assert.ok(p.some((x) => /lrclib.*extra\.zip!\/pack\/notes\.txt/.test(x)), p.join('; '));
});

test('M1: the own-sounds list matches the mod repo (when AZURE_MOD_REPO points to it)', { skip: !process.env.AZURE_MOD_REPO }, () => {
  const py = fs.readFileSync(path.join(process.env.AZURE_MOD_REPO, 'tools', 'check_legit_jar.py'), 'utf8');
  const block = py.slice(py.indexOf('OWN_SOUNDS = {'), py.indexOf('}', py.indexOf('OWN_SOUNDS = {')));
  const theirs = [...block.matchAll(/"([^"]+\.ogg)":\s*"([0-9a-f]{64})"/g)].map((m) => m[1] + '=' + m[2]).sort();
  assert.deepStrictEqual([...OWN_SOUNDS].map(([k, v]) => k + '=' + v).sort(), theirs);
});

test('L1: an older signed release list never replaces the installed Azure; versions compare as numbers', async () => {
  const { ensureLegitJar, olderThan } = require('../src/channel');
  assert.ok(olderThan('1.2.9', '1.2.21') && !olderThan('1.2.21', '1.2.9') && !olderThan('1.2.21', '1.2.21') && !olderThan('', '1.0') && !olderThan('x', '1.0'));
  const f = jar({ 'com/aurora/client/A.class': strToU8('ok') });
  const dir = path.dirname(f);
  fs.writeFileSync(path.join(dir, 'installed.json'), JSON.stringify({ '1.21.11': { file: path.basename(f), sha256: crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'), version: '1.2.21' } }));
  const old = { version: '1.2.9', legit: { file: 'azure-client-legit-1.2.9.jar', sha256: '0'.repeat(64), size: 10 } };
  const r = await ensureLegitJar({ base: 'http://127.0.0.1:9', keyBase64: '', dir, mc: '1.21.11', release: old });
  assert.strictEqual(r.version, '1.2.21');
  assert.match(r.fallback, /older than the installed 1\.2\.21/);
  assert.ok(!fs.existsSync(path.join(dir, 'azure-client-legit-1.2.9.jar')));
});

test('L2: a damaged fabric.mod.json is refused, not a crash', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'azure-guard-')), 'bad.jar');
  fs.writeFileSync(f, zipSync({ 'fabric.mod.json': strToU8('{"id": "aur') }));
  assert.deepStrictEqual(checkLegitJar(f), ['fabric.mod.json is not valid JSON']);
});
