'use strict';
// Design tokens, the dev gate, and the version shown everywhere.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { devOptions } = require('../app/devgate');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

test('style.css uses only the tokens: no color, radius or shadow of its own', () => {
  const css = read('app', 'renderer', 'style.css');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'a hex color is written in style.css');
  assert.ok(!/\brgba?\(/.test(css), 'an rgb()/rgba() color is written in style.css');
  assert.ok(!/gradient\(/.test(css), 'a gradient is used');
  for (const m of css.matchAll(/border-radius:\s*([^;]+);/g)) {
    assert.ok(/var\(--r-/.test(m[1]) || /^50%$/.test(m[1].trim()), 'radius not from tokens: ' + m[1]);
  }
  for (const m of css.matchAll(/box-shadow:\s*([^;]+);/g)) {
    assert.ok(/var\(--/.test(m[1]), 'shadow not from tokens: ' + m[1]);
  }
  for (const m of css.matchAll(/var\((--[a-z0-9-]+)\)/g)) {
    assert.ok(read('app', 'renderer', 'tokens.css').includes(m[1] + ':'), m[1] + ' is not defined in tokens.css');
  }
});

test('the tokens are the in-game menu values', () => {
  const t = read('app', 'renderer', 'tokens.css');
  assert.match(t, /--accent:\s*#2f8cff/i);   // Azure's default accent (47, 140, 255)
  assert.match(t, /--panel:\s*#111116/i);    // Theme.PANEL_BG
  assert.match(t, /--text:\s*#e8e8ee/i);     // Theme.TEXT
  assert.match(t, /--text-dim:\s*#8c8c99/i); // Theme.TEXT_DIM
  assert.match(t, /--r-s:\s*4px/);
  assert.match(t, /--r-m:\s*8px/);
  assert.match(t, /--r-l:\s*12px/);
});

test('the danger color is used only by destructive confirm buttons', () => {
  const css = read('app', 'renderer', 'style.css');
  const uses = css.match(/var\(--danger\)/g) || [];
  assert.ok(uses.length >= 1);
  const rules = css.split('}').filter((r) => r.includes('var(--danger)'));
  for (const r of rules) assert.ok(/\.pill\.confirm-danger/.test(r), 'danger color used outside confirm buttons: ' + r.trim().slice(0, 60));
  assert.ok(/--danger:\s*#[0-9a-f]{6}/i.test(read('app', 'renderer', 'tokens.css')));
  const js = read('app', 'renderer', 'renderer.js');
  // the only buttons that use it: Delete and Stop game confirmations
  assert.strictEqual((js.match(/confirm-danger/g) || []).length, 1);
  assert.ok(/confirmDialog\('Delete/.test(js) && /confirmDialog\('Stop the game\?'/.test(js));
});

test('the Launch button is a solid color: no gradient, no glow', () => {
  const css = read('app', 'renderer', 'style.css');
  const block = /\.launch-group\s*\{[^}]*\}/.exec(css)[0] + /\.launch\s*\{[^}]*\}/.exec(css)[0];
  assert.match(block, /background:\s*var\(--accent\)/);
  assert.ok(!/gradient|glow/.test(css));
  assert.ok(!/orange|amber/i.test(css));
});

test('developer hooks work only from source with AZURE_DEV=1; a packaged build ignores them', () => {
  const evil = { azureJar: '/tmp/x.jar', onReady() {} };
  // packaged: never, whatever the environment says
  assert.deepStrictEqual(devOptions(evil, { isPackaged: true, env: '1' }), { enabled: false });
  assert.deepStrictEqual(devOptions(evil, { isPackaged: true, env: undefined }), { enabled: false });
  // from source without the switch: off too
  assert.deepStrictEqual(devOptions(evil, { isPackaged: false, env: undefined }), { enabled: false });
  assert.deepStrictEqual(devOptions(evil, { isPackaged: false, env: '0' }), { enabled: false });
  // from source with the switch: on (and the page shows a DEV badge)
  assert.strictEqual(devOptions(evil, { isPackaged: false, env: '1' }).enabled, true);
  // the app only ever reads those options through the gate
  const app = read('app', 'app.js');
  assert.match(app, /devOptions\(opts,\s*\{\s*isPackaged:\s*app\.isPackaged/);
  assert.ok(!/opts\.(createAuth|azureJar|onReady)/.test(app), 'app.js reads a hook without the gate');
  assert.ok(!/createAuth(?!Service)/.test(app), 'app.js signs in only through createAuthService');
  assert.match(app, /dev:\s*dev\.enabled/);
});

test('a packaged build cannot reach dev/: the entry passes nothing, and packaging leaves dev/ out', () => {
  assert.match(read('app', 'main.js'), /startApp\(\)/);
  const pkg = JSON.parse(read('package.json'));
  assert.strictEqual(pkg.main, 'app/main.js');
  const files = pkg.build.files;
  assert.ok(files.some((f) => f === '!dev' || f === '!dev/**'), 'dev/ is not excluded from packaging');
  assert.ok(!files.some((f) => /^dev(\/|$)/.test(f)), 'dev/ is included in packaging');
  for (const f of ['test/**', 'node_modules/electron/**']) assert.ok(files.includes('!' + f) || !files.includes(f));
  // nothing under app/ or src/ may require dev/
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of [...walk(path.join(ROOT, 'app')), ...walk(path.join(ROOT, 'src'))].filter((x) => x.endsWith('.js'))) {
    assert.ok(!/require\([^)]*dev[\\/]/.test(fs.readFileSync(f, 'utf8')), f + ' requires dev/');
  }
});

test('one version everywhere: the launcher\'s own, from package.json', () => {
  const { version, userAgent } = require('../src/version');
  assert.strictEqual(version, JSON.parse(read('package.json')).version);
  assert.strictEqual(userAgent, 'AzureLauncher/' + version + ' (Azure Client launcher)');
  for (const f of ['app/app.js', 'src/launch.js', 'src/net.js', 'src/auth.js', 'src/channel.js', 'src/skin.js']) {
    const text = read(...f.split('/'));
    assert.ok(!/getVersion\(\)/.test(text), f + ' uses an Electron/app version');
    assert.ok(!/AzureLauncher\/\d/.test(text) && !/LAUNCHER_VERSION = '\d/.test(text), f + ' hard-codes a version');
  }
});

test('players read friendly errors; the missing app ID says exactly that', () => {
  const { playerMessage } = require('../app/messages');
  assert.strictEqual(playerMessage('NOT_CONFIGURED'), "Sign-in isn't available yet.");
  for (const code of ['APP_NOT_APPROVED', 'NO_JAVA_EDITION', 'NO_PROFILE', 'NETWORK', 'LAUNCH_FAILED', 'UNKNOWN', 'SIGN_IN_REQUIRED']) {
    const m = playerMessage(code);
    assert.ok(m && !/AADSTS|HTTP \d|config\/|launcher\.config|client\)? ID|403|401/i.test(m), code + ': ' + m);
  }
  assert.strictEqual(playerMessage('NOT_A_CODE'), playerMessage('UNKNOWN'));
});
