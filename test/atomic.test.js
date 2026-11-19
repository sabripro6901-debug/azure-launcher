'use strict';
// AUDIT H2: a crash or full disk during a save must never wipe the instance list or the settings.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { InstanceStore } = require('../src/instances');
const { SettingsStore } = require('../src/settings');

const SEED = { name: 'Azure Client 1.21.11', mcVersion: '1.21.11', loader: 'fabric', loaderVersion: '0.18.3', mods: [], azure: true };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'azure-atomic-'));

// The disk fills up (or the power goes) half way through writing: only part of the data lands, then an error.
function crashMidWrite(fn) {
  const real = fs.writeFileSync;
  fs.writeFileSync = (f, data, ...rest) => {
    const s = String(data);
    real(f, s.slice(0, Math.floor(s.length / 2)), ...rest);
    const e = new Error('ENOSPC: no space left on device');
    e.code = 'ENOSPC';
    throw e;
  };
  try { fn(); } catch { /* the save fails: expected */ } finally { fs.writeFileSync = real; }
}

test('a save that fails half way leaves the old instance list whole', () => {
  const dir = tmp();
  const file = path.join(dir, 'instances.json');
  const store = new InstanceStore(file, SEED);
  store.create({ name: 'My world', mcVersion: '1.20.1', loaderVersion: '0.16.0', mods: [], azure: false });
  const before = fs.readFileSync(file, 'utf8');
  crashMidWrite(() => store.create({ name: 'Another', mcVersion: '1.20.1', loaderVersion: '0.16.0', mods: [], azure: false }));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  assert.deepStrictEqual(new InstanceStore(file, SEED).list().map((i) => i.name), ['Azure Client 1.21.11', 'My world']);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temporary file left behind');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a save that fails half way leaves the old settings whole', () => {
  const dir = tmp();
  const file = path.join(dir, 'settings.json');
  const s = new SettingsStore(file);
  s.set({ closeOnLaunch: true });
  const before = fs.readFileSync(file, 'utf8');
  crashMidWrite(() => s.set({ closeOnLaunch: false }));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a damaged instance list is kept aside, not overwritten by the default', () => {
  const dir = tmp();
  const file = path.join(dir, 'instances.json');
  fs.writeFileSync(file, '{"instances": [{"id": "my-world-1a2b", "na');
  const store = new InstanceStore(file, SEED);
  assert.deepStrictEqual(store.list().map((i) => i.id), ['default']);
  const kept = fs.readdirSync(dir).filter((f) => f.startsWith('instances.json.broken-'));
  assert.strictEqual(kept.length, 1);
  assert.match(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), /my-world-1a2b/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a list that is only locked for a moment (virus scanner) is read, not set aside', () => {
  const dir = tmp();
  const file = path.join(dir, 'instances.json');
  new InstanceStore(file, SEED).create({ name: 'Kept', mcVersion: '1.20.1', loaderVersion: '0.16.0', mods: [], azure: false });
  const real = fs.readFileSync;
  let fails = 2;
  fs.readFileSync = (f, ...a) => {
    if (f === file && fails-- > 0) { const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e; }
    return real(f, ...a);
  };
  try {
    assert.deepStrictEqual(new InstanceStore(file, SEED).list().map((i) => i.name), ['Azure Client 1.21.11', 'Kept']);
  } finally { fs.readFileSync = real; }
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.includes('.broken-')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a list still locked after the retries is never overwritten by the default', () => {
  const dir = tmp();
  const file = path.join(dir, 'instances.json');
  new InstanceStore(file, SEED).create({ name: 'Kept', mcVersion: '1.20.1', loaderVersion: '0.16.0', mods: [], azure: false });
  const before = fs.readFileSync(file, 'utf8');
  const real = fs.readFileSync;
  fs.readFileSync = (f, ...a) => { if (f === file) { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; } return real(f, ...a); };
  try {
    new InstanceStore(file, SEED);
  } finally { fs.readFileSync = real; }
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a list with the wrong shape is kept aside, not overwritten', () => {
  const dir = tmp();
  const file = path.join(dir, 'instances.json');
  fs.writeFileSync(file, '{"instances": {"my-world-1a2b": {}}}');
  new InstanceStore(file, SEED);
  const kept = fs.readdirSync(dir).filter((f) => f.startsWith('instances.json.broken-'));
  assert.strictEqual(kept.length, 1);
  assert.match(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), /my-world-1a2b/);
  fs.rmSync(dir, { recursive: true, force: true });
});
