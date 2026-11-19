'use strict';
// AUDIT M5: closing the window while playing never stops the game; the launcher waits in the tray, then closes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createBackground } = require('../app/background');

function fakes({ busy = true } = {}) {
  const log = [];
  const win = { hidden: false, isDestroyed: () => false, isMinimized: () => false, hide() { this.hidden = true; log.push('hide'); }, show() { this.hidden = false; log.push('show'); }, focus() {}, restore() {} };
  class Tray {
    constructor() { log.push('tray'); this.handlers = {}; }
    on(ev, fn) { this.handlers[ev] = fn; }
    setToolTip(t) { this.tip = t; }
    setContextMenu(m) { this.menu = m; }
    destroy() { log.push('tray gone'); }
  }
  const Menu = { buildFromTemplate: (t) => t };
  const nativeImage = { createFromPath: () => ({ isEmpty: () => false, resize: () => ({}) }) };
  const state = { busy, quit: 0 };
  const bg = createBackground({ Tray, Menu, nativeImage, iconPath: 'icon.png', getWin: () => win, isBusy: () => state.busy, quit: () => state.quit++ });
  return { bg, win, log, state };
}
const closeEvent = () => ({ prevented: false, preventDefault() { this.prevented = true; } });

test('closing with no game closes as before', () => {
  const { bg, log } = fakes({ busy: false });
  const e = closeEvent();
  bg.onWindowClose(e);
  assert.strictEqual(e.prevented, false);
  assert.deepStrictEqual(log, []);
});

test('closing while the game runs hides to the tray; the launcher closes once the game has ended', () => {
  const { bg, win, log, state } = fakes();
  const e = closeEvent();
  bg.onWindowClose(e);
  assert.strictEqual(e.prevented, true, 'the window close is stopped: the game keeps running');
  assert.strictEqual(win.hidden, true);
  assert.ok(bg.hasTray());
  assert.strictEqual(state.quit, 0);
  state.busy = false;
  assert.strictEqual(bg.onGameDone(), true);
  assert.strictEqual(state.quit, 1);
  assert.ok(log.includes('tray gone'));
  const again = closeEvent();
  bg.onWindowClose(again); // the quit closes the window: allowed now
  assert.strictEqual(again.prevented, false);
});

test('opening the window again from the tray keeps the launcher open after the game', () => {
  const { bg, win, state } = fakes();
  bg.onWindowClose(closeEvent());
  bg.showWindow();
  assert.strictEqual(win.hidden, false);
  assert.strictEqual(bg.onGameDone(), false);
  assert.strictEqual(state.quit, 0);
});

test('app.js hooks it up: window close, the hide-while-playing setting, and every end of a game', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');
  assert.match(src, /win\.on\('close', \(e\) => background\.onWindowClose\(e\)\)/);
  assert.match(src, /background\.onHiddenForGame\(\)/);
  assert.strictEqual((src.match(/!background\.onGameDone\(\) && win\) win\.show\(\)/g) || []).length, 3);
  assert.ok(!/(?<!onGameDone\(\) && win\) )if \(win\) win\.show\(\);/.test(src), 'no game end shows the window without asking the tray first');
});
