'use strict';
// app/bedrock-ipc.js without Electron: the handlers are called the way the page calls them. Covers the running-game
// check on every write, tokens, paths from the page, trash and cleanup, progress events, the one-job-at-a-time rule and
// the backups-to-keep setting.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { zipSync } = require('fflate');
const { registerBedrock } = require('../app/bedrock-ipc');
const { Bedrock } = require('../src/bedrock');

const enc = (t) => new TextEncoder().encode(t);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'azure-ipc-'));
const U1 = '11111111-2222-3333-4444-555555555555';
const manifest = (uuid, name = 'My Pack') => JSON.stringify({ format_version: 2, header: { name, uuid, version: [1, 0, 0] }, modules: [{ type: 'resources', uuid: '99999999-0000-0000-0000-000000000001', version: [1, 0, 0] }] });

function levelDat() {
  const name = (s) => { const b = Buffer.from(s); const l = Buffer.alloc(2); l.writeUInt16LE(b.length); return Buffer.concat([l, b]); };
  const lp = Buffer.alloc(8); lp.writeBigInt64LE(1700000000n);
  const body = Buffer.concat([Buffer.from([10]), name(''), Buffer.from([4]), name('LastPlayed'), lp, Buffer.from([0])]);
  const head = Buffer.alloc(8); head.writeInt32LE(10, 0); head.writeInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

function setup({ keep = 5 } = {}) {
  const appdata = tmp();
  const root = path.join(appdata, 'Minecraft Bedrock', 'Users', '1234', 'games', 'com.mojang');
  fs.mkdirSync(root, { recursive: true });
  const userData = tmp();
  const handlers = {};
  const events = [];
  const answers = [];
  const state = { running: false, keep };
  const exec = async (file) => {
    if (/powershell/i.test(file)) return JSON.stringify({ Version: '1.26.6501.0', PackageFamilyName: 'Microsoft.MinecraftUWP_8wekyb3d8bbwe', AppId: 'Game' });
    return state.running ? '"Minecraft.Windows.exe","1","Console","1","1 K"\n' : 'INFO: No tasks are running which match the specified criteria.\n';
  };
  const dialog = { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };
  const opened = [];
  registerBedrock({
    handle: (ch, fn) => { handlers[ch] = fn; }, dialog, shell: { openPath: async (p) => { opened.push(p); return ''; } }, getWin: () => null,
    userData, answer: () => (answers.length ? answers.shift() : null), logLine: () => {}, send: (c, d) => events.push([c, d]),
    getSettings: () => ({ bedrockKeepBackups: state.keep }), bedrockOptions: { appdata, localappdata: tmp(), exec },
  });
  const call = (ch, arg) => handlers[ch](arg);
  const profile = 'x1234';
  const world = (folder, name, data = 'data') => {
    const d = path.join(root, 'minecraftWorlds', folder);
    fs.mkdirSync(path.join(d, 'db'), { recursive: true });
    fs.writeFileSync(path.join(d, 'level.dat'), levelDat());
    fs.writeFileSync(path.join(d, 'levelname.txt'), name);
    fs.writeFileSync(path.join(d, 'db', '000005.ldb'), data);
    return d;
  };
  const packFile = (name, uuid = U1) => { const f = path.join(tmp(), name + '.mcpack'); fs.writeFileSync(f, zipSync({ 'manifest.json': enc(manifest(uuid, name)), 'textures/a.png': enc('x') })); return f; };
  return { call, handlers, events, answers, state, root, userData, profile, world, packFile, opened };
}

test('state: finds the game and its folders; the page can ask whether it runs', async () => {
  const s = setup();
  const r = await s.call('bedrock:state');
  assert.deepStrictEqual([r.ok, r.bedrock.installed, r.bedrock.running, r.bedrock.profiles.map((p) => p.id)], [true, true, false, ['x1234']]);
  s.state.running = true;
  assert.strictEqual((await s.call('bedrock:running')).running, true);
});

test('every change is refused while Bedrock runs, and nothing on disk changes; the same calls work when it is closed', async () => {
  const s = setup();
  await s.call('bedrock:state');
  const home = s.world('AAA=', 'Home', 'keep-me');
  // an installed pack to remove, a pack file and a world file waiting for confirmation
  const f = s.packFile('Remove Me');
  const insp = await s.call('bedrock:packInspect', { profile: s.profile, paths: [f] });
  s.state.running = false;
  const added = await s.call('bedrock:packAdd', { profile: s.profile, token: insp.token, ids: [insp.candidates[0].id] });
  assert.strictEqual(added.added.length, 1);
  const wfile = path.join(tmp(), 'w.mcworld');
  fs.writeFileSync(wfile, zipSync({ 'level.dat': levelDat(), 'levelname.txt': enc('Imported'), 'db/000005.ldb': enc('i') }));
  const bk = await s.call('bedrock:worldBackup', { profile: s.profile, folder: 'AAA=' });
  assert.strictEqual(bk.ok, true);

  s.state.running = true;
  const startsBefore = s.events.filter(([, d]) => d.phase === 'start').length;
  const insp2 = await s.call('bedrock:packInspect', { profile: s.profile, paths: [s.packFile('Other', '22222222-2222-3333-4444-555555555555')] });
  const exportTo = path.join(tmp(), 'out.mcworld');
  const worldsBefore = fs.readdirSync(path.join(s.root, 'minecraftWorlds')).length;
  const packAddRefused = await s.call('bedrock:packAdd', { profile: s.profile, token: insp2.token, ids: [insp2.candidates[0].id] });
  s.answers.push(wfile);
  const wi = await s.call('bedrock:worldImportPick', { profile: s.profile });
  s.answers.push(exportTo);
  const refused = {
    packAdd: packAddRefused,
    packRemove: await s.call('bedrock:packRemove', { profile: s.profile, kind: 'resource', folder: 'Remove Me' }),
    backup: await s.call('bedrock:worldBackup', { profile: s.profile, folder: 'AAA=' }),
    export: await s.call('bedrock:worldExport', { profile: s.profile, folder: 'AAA=' }),
    import: await s.call('bedrock:worldImport', { profile: s.profile, token: wi.token }),
    restore: await s.call('bedrock:worldRestore', { profile: s.profile, folder: 'AAA=', backup: bk.backups[0].fileName }),
  };
  for (const [name, r] of Object.entries(refused)) { assert.strictEqual(r.ok, false, name); assert.match(r.message, /Close Minecraft Bedrock/, name); }
  assert.ok(!fs.existsSync(exportTo), 'no export file written');
  assert.ok(fs.existsSync(path.join(s.root, 'resource_packs', 'Remove Me')), 'the pack is still there');
  assert.strictEqual(fs.readdirSync(path.join(s.root, 'minecraftWorlds')).length, worldsBefore, 'no world added');
  assert.strictEqual(fs.readFileSync(path.join(home, 'db', '000005.ldb'), 'utf8'), 'keep-me');
  assert.strictEqual(s.events.filter(([, d]) => d.phase === 'start').length, startsBefore, 'a refused change never shows as a running job');

  s.state.running = false;
  s.answers.push(exportTo);
  assert.strictEqual((await s.call('bedrock:worldExport', { profile: s.profile, folder: 'AAA=' })).ok, true);
  assert.ok(fs.existsSync(exportTo));
  const restored = await s.call('bedrock:worldRestore', { profile: s.profile, folder: 'AAA=', backup: bk.backups[0].fileName });
  assert.strictEqual(restored.ok, true);
  assert.ok(restored.safety);
  assert.strictEqual((await s.call('bedrock:packRemove', { profile: s.profile, kind: 'resource', folder: 'Remove Me' })).ok, true);
});

test('the same guard holds in the service for remove, export and restore (the game is checked each time)', async () => {
  const appdata = tmp();
  fs.mkdirSync(path.join(appdata, 'Minecraft Bedrock', 'Users', 'Shared', 'games', 'com.mojang'), { recursive: true });
  let running = true;
  const exec = async (file) => (/powershell/i.test(file) ? JSON.stringify({ Version: '1.26.6501.0', PackageFamilyName: 'Microsoft.MinecraftUWP_8wekyb3d8bbwe' }) : running ? 'Minecraft.Windows.exe\n' : 'INFO: none\n');
  const b = new Bedrock({ appdata, localappdata: tmp(), exec, backupRoot: tmp() });
  await b.detect();
  await assert.rejects(b.removePack('shared', 'resource', 'x'), /Close Minecraft Bedrock/);
  await assert.rejects(b.exportWorld('shared', 'x', path.join(tmp(), 'a.mcworld')), /Close Minecraft Bedrock/);
  await assert.rejects(b.restoreWorld('shared', path.join(tmp(), 'a.mcworld'), 'x'), /Close Minecraft Bedrock/);
  await assert.rejects(b.importWorld('shared', path.join(tmp(), 'a.mcworld')), /Close Minecraft Bedrock/);
  const unknown = { ...exec };
  const blind = new Bedrock({ appdata, localappdata: tmp(), exec: async (file) => (/powershell/i.test(file) ? exec(file) : null), backupRoot: tmp() });
  await blind.detect();
  await assert.rejects(blind.removePack('shared', 'resource', 'x'), /Could not check/, 'if the check itself fails, nothing is changed');
  assert.ok(unknown);
});

test('tokens: a wrong, reused or other-profile token is refused', async () => {
  const s = setup();
  await s.call('bedrock:state');
  const insp = await s.call('bedrock:packInspect', { profile: s.profile, paths: [s.packFile('A')] });
  assert.strictEqual((await s.call('bedrock:packAdd', { profile: s.profile, token: 'nope', ids: [insp.candidates[0].id] })).code, 'STALE');
  const insp2 = await s.call('bedrock:packInspect', { profile: s.profile, paths: [s.packFile('A')] });
  assert.strictEqual((await s.call('bedrock:packAdd', { profile: 'shared', token: insp2.token, ids: [insp2.candidates[0].id] })).code, 'STALE');
  const ok = await s.call('bedrock:packAdd', { profile: s.profile, token: insp2.token, ids: [insp2.candidates[0].id] });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual((await s.call('bedrock:packAdd', { profile: s.profile, token: insp2.token, ids: [insp2.candidates[0].id] })).code, 'STALE', 'a token works once');
  assert.strictEqual((await s.call('bedrock:worldImport', { profile: s.profile, token: 'nope' })).code, 'STALE');
  assert.strictEqual((await s.call('bedrock:worldRestore', { profile: s.profile, folder: 'AAA=', token: 'nope' })).code, 'MISSING');
  assert.strictEqual((await s.call('bedrock:worldRestore', { profile: s.profile, folder: 'AAA=', backup: 'ghost.mcworld' })).code, 'MISSING');
  assert.strictEqual((await s.call('bedrock:packs', { profile: 'nope' })).code, 'NO_PROFILE');
});

test('paths from the page: only absolute local paths are accepted', async () => {
  const s = setup();
  await s.call('bedrock:state');
  for (const bad of [['relative/a.mcpack'], ['\\\\server\\share\\a.mcpack'], 'not-an-array', [123], new Array(51).fill(path.join(os.tmpdir(), 'a.mcpack'))]) {
    const r = await s.call('bedrock:packInspect', { profile: s.profile, paths: bad });
    assert.strictEqual(r.code, 'BAD_PATHS', JSON.stringify(bad).slice(0, 40));
  }
  // odd pack and world names from the page cannot climb out of the folders
  for (const folder of ['..', '../resource_packs', 'a/b']) assert.strictEqual((await s.call('bedrock:packRemove', { profile: s.profile, kind: 'resource', folder })).ok, false);
  assert.strictEqual((await s.call('bedrock:worldBackup', { profile: s.profile, folder: '../x' })).ok, false);
});

test('remove keeps a copy in the launcher folder; the 30 days count from the removal and old copies are cleaned', async () => {
  const s = setup();
  await s.call('bedrock:state');
  const insp = await s.call('bedrock:packInspect', { profile: s.profile, paths: [s.packFile('Old Pack')] });
  await s.call('bedrock:packAdd', { profile: s.profile, token: insp.token, ids: [insp.candidates[0].id] });
  const installed = path.join(s.root, 'resource_packs', 'Old Pack');
  const longAgo = new Date(Date.now() - 90 * 86400000);
  fs.utimesSync(installed, longAgo, longAgo); // installed three months ago
  assert.strictEqual((await s.call('bedrock:packRemove', { profile: s.profile, kind: 'resource', folder: 'Old Pack' })).ok, true);
  const removed = path.join(s.userData, 'bedrock-removed');
  assert.strictEqual(fs.readdirSync(removed).length, 1);
  assert.ok(!fs.existsSync(installed));
  await s.call('bedrock:state'); // runs the cleanup
  assert.strictEqual(fs.readdirSync(removed).length, 1, 'a pack removed just now is not cleaned although it is old');
  const stale = path.join(removed, 'stale');
  fs.mkdirSync(stale);
  fs.utimesSync(stale, longAgo, longAgo);
  await s.call('bedrock:state');
  assert.deepStrictEqual(fs.readdirSync(removed).includes('stale'), false, 'a copy older than 30 days goes');
  assert.strictEqual(fs.readdirSync(removed).length, 1);
});

test('progress: a job reports start, steps and end; a second job at the same time is refused', async () => {
  const s = setup();
  await s.call('bedrock:state');
  s.world('AAA=', 'Big', 'x'.repeat(4 * 1024 * 1024));
  const [a, b] = await Promise.all([s.call('bedrock:worldBackup', { profile: s.profile, folder: 'AAA=' }), s.call('bedrock:worldBackup', { profile: s.profile, folder: 'AAA=' })]);
  const results = [a, b];
  assert.strictEqual(results.filter((r) => r.ok).length, 1);
  assert.strictEqual(results.find((r) => !r.ok).code, 'BUSY');
  const phases = s.events.filter(([c]) => c === 'bedrock:progress').map(([, d]) => d);
  assert.strictEqual(phases[0].phase, 'start');
  assert.strictEqual(phases[phases.length - 1].phase, 'end');
  assert.ok(phases.some((p) => p.phase === 'backup' && p.total > 0 && p.done > 0), 'steps with a total came through');
  // after it ends, the next job runs
  assert.strictEqual((await s.call('bedrock:worldBackup', { profile: s.profile, folder: 'AAA=' })).ok, true);
});

test('restore reports both its steps; picking a file restores from it after the page confirms', async () => {
  const s = setup();
  await s.call('bedrock:state');
  s.world('AAA=', 'Home', 'before');
  const bk = await s.call('bedrock:worldBackup', { profile: s.profile, folder: 'AAA=' });
  s.events.length = 0;
  assert.strictEqual((await s.call('bedrock:worldRestore', { profile: s.profile, folder: 'AAA=', backup: bk.backups[0].fileName })).ok, true);
  const phases = new Set(s.events.map(([, d]) => d.phase));
  assert.ok(phases.has('restore') && phases.has('safety'), [...phases].join());
  const file = path.join(tmp(), 'p.mcworld');
  fs.writeFileSync(file, zipSync({ 'level.dat': levelDat(), 'levelname.txt': enc('Picked'), 'db/000005.ldb': enc('picked') }));
  s.answers.push(file);
  const pk = await s.call('bedrock:worldPickRestore', { profile: s.profile });
  assert.strictEqual(pk.name, 'Picked');
  assert.strictEqual((await s.call('bedrock:worldRestore', { profile: s.profile, folder: 'AAA=', token: pk.token })).ok, true);
  assert.strictEqual(fs.readFileSync(path.join(s.root, 'minecraftWorlds', 'AAA=', 'db', '000005.ldb'), 'utf8'), 'picked');
  s.answers.push(path.join(tmp(), 'bad.mcworld'));
  fs.writeFileSync(s.answers[0], zipSync({ 'level.dat': levelDat(), 'x.dll': enc('MZ') }));
  assert.strictEqual((await s.call('bedrock:worldPickRestore', { profile: s.profile })).ok, false, 'a refused file is refused at the pick');
});

test('the backups-to-keep setting is used: older backups of that world are deleted, the new one never', async () => {
  const s = setup({ keep: 2 });
  await s.call('bedrock:state');
  s.world('AAA=', 'One');
  s.world('BBB=', 'Two');
  let last;
  for (let i = 0; i < 4; i++) last = await s.call('bedrock:worldBackup', { profile: s.profile, folder: 'AAA=' });
  const other = await s.call('bedrock:worldBackup', { profile: s.profile, folder: 'BBB=' });
  const mine = last.backups.filter((b) => b.folder === 'AAA=');
  assert.strictEqual(mine.length, 2);
  assert.ok(mine.some((b) => b.fileName === last.file), 'the backup just made stays');
  assert.strictEqual(other.backups.filter((b) => b.folder === 'BBB=').length, 1);
  s.state.keep = -3; // an unusable value falls back to 5, it never means "delete everything"
  const again = await s.call('bedrock:worldBackup', { profile: s.profile, folder: 'AAA=' });
  assert.strictEqual(again.backups.filter((b) => b.folder === 'AAA=').length, 3);
  s.state.keep = undefined;
  assert.strictEqual((await s.call('bedrock:worldBackup', { profile: s.profile, folder: 'AAA=' })).backups.filter((b) => b.folder === 'AAA=').length, 4, 'no setting counts as 5');
  s.state.keep = 0; // Keep all: nothing is ever deleted
  let all;
  for (let i = 0; i < 4; i++) all = await s.call('bedrock:worldBackup', { profile: s.profile, folder: 'AAA=' });
  assert.strictEqual(all.backups.filter((b) => b.folder === 'AAA=').length, 8);
});

test('export asks where to save; cancelling writes nothing', async () => {
  const s = setup();
  await s.call('bedrock:state');
  s.world('AAA=', 'Home');
  const r = await s.call('bedrock:worldExport', { profile: s.profile, folder: 'AAA=' });
  assert.deepStrictEqual([r.ok, r.cancelled], [true, true]);
  assert.strictEqual((await s.call('bedrock:worldExport', { profile: s.profile, folder: 'GHOST=' })).code, 'MISSING');
});
