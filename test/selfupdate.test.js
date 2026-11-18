'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createSelfUpdater, isConfigured } = require('../src/selfupdate');

function fakeUpdater({ available = true, version = '2.0.0', checkError, downloadError } = {}) {
  const calls = [];
  return {
    calls,
    setFeedURL: (o) => calls.push(['feed', o]),
    checkForUpdates: async () => { calls.push(['check']); if (checkError) throw new Error(checkError); return { isUpdateAvailable: available, updateInfo: { version } }; },
    downloadUpdate: async () => { calls.push(['download']); if (downloadError) throw new Error(downloadError); },
    quitAndInstall: (...a) => calls.push(['install', a]),
  };
}
const cfg = { owner: 'someone', repo: 'azure-launcher' };

test('not configured or not packaged: no update ever runs', async () => {
  for (const [config, isPackaged] of [[{ owner: 'REPLACE_WITH_GITHUB_OWNER', repo: 'azure-launcher' }, true], [cfg, false], [undefined, true]]) {
    const u = fakeUpdater();
    const s = createSelfUpdater({ autoUpdater: u, config, isPackaged, currentVersion: '1.0.0' });
    assert.strictEqual(s.enabled, false);
    await s.check();
    assert.strictEqual(s.install(), false);
    assert.deepStrictEqual(u.calls, []);
  }
  assert.ok(isConfigured(cfg) && !isConfigured({ owner: 'REPLACE_X', repo: 'r' }));
});

test('automatic updates off: a verified download becomes "ready" and installs only on request', async () => {
  const u = fakeUpdater();
  const s = createSelfUpdater({ autoUpdater: u, config: cfg, isPackaged: true, currentVersion: '1.0.0', auto: () => false });
  assert.deepStrictEqual(u.calls[0], ['feed', { provider: 'github', owner: 'someone', repo: 'azure-launcher' }]);
  assert.strictEqual(s.install(), false); // nothing downloaded yet
  const st = await s.check();
  assert.strictEqual(st.status, 'ready');
  assert.strictEqual(st.version, '2.0.0');
  assert.ok(!u.calls.some((c) => c[0] === 'install'));
  assert.strictEqual(s.install(), true);
  assert.deepStrictEqual(u.calls.at(-1), ['install', [false, true]]);
});

test('same version: nothing is downloaded', async () => {
  const u = fakeUpdater({ available: false, version: '1.0.0' });
  const s = createSelfUpdater({ autoUpdater: u, config: cfg, isPackaged: true, currentVersion: '1.0.0' });
  assert.strictEqual((await s.check()).status, 'current');
  assert.ok(!u.calls.some((c) => c[0] === 'download'));
});

test('a failed check or a failed/tampered download leaves the running launcher alone and never installs', async () => {
  for (const opts of [{ checkError: 'offline' }, { downloadError: 'sha512 checksum mismatch' }]) {
    const logs = [];
    const u = fakeUpdater(opts);
    const s = createSelfUpdater({ autoUpdater: u, config: cfg, isPackaged: true, currentVersion: '1.0.0', log: (m) => logs.push(m) });
    const st = await s.check();
    assert.strictEqual(st.status, 'failed');
    assert.match(st.message, /keeps working/);
    assert.strictEqual(s.install(), false);
    assert.ok(!u.calls.some((c) => c[0] === 'install'));
    assert.match(logs[0], /LAUNCHER UPDATE/);
  }
});

function fakeTimers() {
  const t = { pending: [], repeats: [] };
  t.setTimeout = (fn, ms) => { const h = { fn, ms }; t.pending.push(h); return h; };
  t.clearTimeout = (h) => { t.pending = t.pending.filter((x) => x !== h); };
  t.setInterval = (fn, ms) => { t.repeats.push({ fn, ms }); return {}; };
  t.runPending = () => { const now = t.pending; t.pending = []; now.forEach((h) => h.fn()); };
  return t;
}

test('automatic: a verified update installs itself quietly and reopens, with a note written first', async () => {
  const u = fakeUpdater();
  const notes = [];
  const s = createSelfUpdater({ autoUpdater: u, config: cfg, isPackaged: true, currentVersion: '1.0.0', timers: fakeTimers(), beforeInstall: (v) => notes.push(v) });
  const st = await s.check();
  assert.strictEqual(st.status, 'installing');
  assert.deepStrictEqual(u.calls.at(-1), ['install', [true, true]]); // silent installer, then start again
  assert.deepStrictEqual(notes, ['2.0.0']);
});

test('automatic: never while something is going on; it waits and installs once things are quiet', async () => {
  const u = fakeUpdater();
  const timers = fakeTimers();
  let busy = true;
  const s = createSelfUpdater({ autoUpdater: u, config: cfg, isPackaged: true, currentVersion: '1.0.0', timers, safeNow: () => !busy });
  assert.strictEqual((await s.check()).status, 'ready');
  assert.ok(!u.calls.some((c) => c[0] === 'install'));
  assert.strictEqual(timers.pending.length, 1); // a retry
  timers.runPending();
  assert.ok(!u.calls.some((c) => c[0] === 'install'));
  busy = false;
  timers.runPending();
  assert.deepStrictEqual(u.calls.at(-1), ['install', [true, true]]);
});

test('automatic: a failed or tampered download installs nothing; checks run at start and every 30 minutes', async () => {
  const u = fakeUpdater({ downloadError: 'sha512 checksum mismatch' });
  const timers = fakeTimers();
  const s = createSelfUpdater({ autoUpdater: u, config: cfg, isPackaged: true, currentVersion: '1.0.0', timers });
  assert.strictEqual((await s.check()).status, 'failed');
  assert.ok(!u.calls.some((c) => c[0] === 'install'));
  s.start();
  assert.ok(timers.pending.some((h) => h.ms === 15000));
  assert.deepStrictEqual(timers.repeats.map((r) => r.ms), [30 * 60 * 1000]);
});

test('settings: automatic launcher updates are on by default and only a boolean is kept', () => {
  const { validate } = require('../src/settings');
  assert.strictEqual(validate({}).autoUpdateLauncher, true);
  assert.strictEqual(validate({ autoUpdateLauncher: false }).autoUpdateLauncher, false);
  assert.strictEqual(validate({ autoUpdateLauncher: 'no' }).autoUpdateLauncher, true);
});
