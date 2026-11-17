'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const queue = require('../src/queue');

function instance() {
  const game = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-queue-'));
  const mods = path.join(game, 'mods');
  fs.mkdirSync(path.join(game, '.azure-launcher', 'staged'), { recursive: true });
  fs.mkdirSync(mods, { recursive: true });
  return { game, mods };
}
const put = (dir, name, text = 'x') => fs.writeFileSync(path.join(dir, name), text);
const staged = (game) => path.join(game, '.azure-launcher', 'staged');

test('applies add, update, remove, enable and disable, then rolls all of it back', () => {
  const { game, mods } = instance();
  put(staged(game), 'newmod-1.0.jar', 'new');
  put(staged(game), 'upd-2.0.jar', 'v2');
  put(mods, 'upd-1.0.jar', 'v1');
  put(mods, 'gone-1.0.jar', 'gone');
  put(mods, 'off-1.0.jar.disabled', 'off');
  put(mods, 'on-1.0.jar', 'on');
  queue.write(game, [
    { id: 'a', op: 'add', name: 'New Mod', file: 'newmod-1.0.jar', staged: 'newmod-1.0.jar' },
    { id: 'b', op: 'update', name: 'Upd', file: 'upd-2.0.jar', oldFile: 'upd-1.0.jar', staged: 'upd-2.0.jar' },
    { id: 'c', op: 'remove', name: 'Gone', file: 'gone-1.0.jar' },
    { id: 'd', op: 'enable', name: 'Off', file: 'off-1.0.jar' },
    { id: 'e', op: 'disable', name: 'On', file: 'on-1.0.jar' },
  ]);
  const r = queue.apply(game, mods);
  assert.strictEqual(r.done.length, 5);
  assert.deepStrictEqual(r.failed, []);
  assert.deepStrictEqual(fs.readdirSync(mods).sort(), ['newmod-1.0.jar', 'off-1.0.jar', 'on-1.0.jar.disabled', 'upd-2.0.jar']);
  assert.deepStrictEqual(queue.read(game), []); // the queue is empty afterwards
  assert.ok(fs.existsSync(path.join(game, '.azure-launcher', 'applied.json')));
  queue.rollbackBatch(r.rollback, mods);
  assert.deepStrictEqual(fs.readdirSync(mods).sort(), ['gone-1.0.jar', 'off-1.0.jar.disabled', 'on-1.0.jar', 'upd-1.0.jar']);
  assert.strictEqual(fs.readFileSync(path.join(mods, 'upd-1.0.jar'), 'utf8'), 'v1');
});

test('refuses names that could leave the folder, and never touches Azure or Fabric API', () => {
  const { game, mods } = instance();
  queue.write(game, [
    { id: '1', op: 'remove', file: '../../evil.jar' },
    { id: '2', op: 'remove', file: 'C:\\Windows\\x.jar' },
    { id: '3', op: 'add', file: 'ok.jar', staged: '..\\..\\x.jar' },
    { id: '4', op: 'remove', file: 'azure-client-legit-1.2.17.jar' },
    { id: '5', op: 'remove', file: 'fabric-api-0.141.jar' },
    { id: '6', op: 'run', file: 'x.jar' },
  ]);
  assert.deepStrictEqual(queue.read(game), []);
  assert.strictEqual(queue.apply(game, mods), null);
});

test('a restart request is read once, only when fresh, and gives safe quick-play arguments', () => {
  const { game } = instance();
  const f = path.join(game, '.azure-launcher', 'restart.json');
  fs.writeFileSync(f, JSON.stringify({ world: 'New World', changes: ['Installed X'] }));
  const r = queue.takeRestart(game, Date.now() - 5000);
  assert.deepStrictEqual(queue.quickPlayArgs(r), ['--quickPlaySingleplayer', 'New World']);
  assert.strictEqual(queue.takeRestart(game, 0), null); // deleted after reading
  fs.writeFileSync(f, JSON.stringify({ world: '../other' }));
  assert.deepStrictEqual(queue.quickPlayArgs(queue.takeRestart(game, 0)), []);
  fs.writeFileSync(f, JSON.stringify({ server: 'play.example.net:25565' }));
  assert.deepStrictEqual(queue.quickPlayArgs(queue.takeRestart(game, 0)), ['--quickPlayMultiplayer', 'play.example.net:25565']);
  fs.writeFileSync(f, JSON.stringify({ server: 'a b; rm -rf' }));
  assert.deepStrictEqual(queue.quickPlayArgs(queue.takeRestart(game, 0)), []);
});

test('a crash is blamed on the mod the crash report names, else on the whole batch', () => {
  const { game } = instance();
  const entries = [{ op: 'add', name: 'Sodium Extra', file: 'sodium-extra-0.6.jar' }, { op: 'add', name: 'Fancy', file: 'fancymenu-3.1.jar' }];
  fs.mkdirSync(path.join(game, 'crash-reports'));
  fs.writeFileSync(path.join(game, 'crash-reports', 'crash-1.txt'), 'Mixin apply failed fancymenu.mixins.json');
  assert.strictEqual(queue.blame(game, entries, 0), 'Fancy');
  fs.rmSync(path.join(game, 'crash-reports'), { recursive: true });
  assert.strictEqual(queue.blame(game, entries, 0), 'Sodium Extra, Fancy');
});
