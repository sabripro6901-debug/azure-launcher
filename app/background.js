'use strict';
// AUDIT M5: closing the launcher window while a game runs (or is being prepared) never stops the game. The window
// hides, a tray icon keeps the launcher reachable, and the launcher closes by itself once the game has exited.
// Electron's Tray, Menu and nativeImage are passed in (fakes in the tests).

function createBackground({ Tray, Menu, nativeImage, iconPath, getWin, isBusy, quit, onFirstHide = () => {} }) {
  let tray = null;
  let closeWhenDone = false; // the player closed the window during a game: quit once it ends
  let quitting = false;
  let toldOnce = false;

  function showWindow() {
    const w = getWin();
    if (!w || w.isDestroyed()) return;
    closeWhenDone = false; // opened again: it stays open after the game
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
    refresh();
  }

  function refresh() {
    if (!tray) return;
    tray.setToolTip(closeWhenDone ? 'Azure Launcher (closes when the game ends)' : 'Azure Launcher');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Azure Launcher', click: showWindow },
      { type: 'separator' },
      { label: 'Close the launcher when the game ends', type: 'checkbox', checked: closeWhenDone, click: (item) => { closeWhenDone = !!item.checked; refresh(); } },
    ]));
  }

  function ensureTray() {
    if (tray) return tray;
    let img = nativeImage.createFromPath(iconPath);
    if (img && !img.isEmpty() && img.resize) img = img.resize({ width: 16, height: 16, quality: 'best' });
    tray = new Tray(img);
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
    refresh();
    return tray;
  }

  /** The window's 'close' event: keeps the launcher (and so the game's output and play time) alive while busy. */
  function onWindowClose(e) {
    if (quitting || !isBusy()) return; // nothing running: close as before
    e.preventDefault();
    const w = getWin();
    if (w && !w.isDestroyed()) w.hide();
    closeWhenDone = true;
    ensureTray();
    refresh();
    if (!toldOnce) {
      toldOnce = true;
      try { onFirstHide(tray); } catch { /* a note only */ }
    }
  }

  /** The window was hidden for the game (the "hide while playing" setting): still reachable from the tray. */
  function onHiddenForGame() {
    ensureTray();
  }

  /** The game (and any quick restart) is over. True if the launcher is closing now. */
  function onGameDone() {
    if (closeWhenDone) {
      quitting = true;
      destroyTray();
      quit();
      return true;
    }
    destroyTray();
    return false;
  }

  function destroyTray() {
    if (tray) { tray.destroy(); tray = null; }
  }

  return { onWindowClose, onHiddenForGame, onGameDone, showWindow, destroyTray, closesWhenDone: () => closeWhenDone, hasTray: () => !!tray };
}

module.exports = { createBackground };
