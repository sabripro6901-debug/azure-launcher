'use strict';
// The launcher updating itself, through electron-updater (GitHub releases of the launcher repo).
// - Only a packaged launcher updates, and only when config.launcherUpdate names a real repo (not the placeholder).
// - electron-updater downloads the installer named in latest.yml and refuses it unless its SHA-512 matches; a failed or
//   tampered download throws and nothing is installed: the running launcher stays as it is.
// - A downloaded update is installed only when the player restarts (or quits); never in the middle of a game.
// The updater is passed in (a fake in the tests), so this file has no Electron dependency of its own.

const PLACEHOLDER = /^REPLACE/;

function isConfigured(cfg) {
  return !!(cfg && cfg.owner && cfg.repo && !PLACEHOLDER.test(cfg.owner) && !PLACEHOLDER.test(cfg.repo));
}

/**
 * state: { status: 'off' | 'idle' | 'checking' | 'downloading' | 'ready' | 'current' | 'failed', version, message }
 */
function createSelfUpdater({ autoUpdater, config, isPackaged, currentVersion, log = () => {}, onState = () => {} }) {
  let state = { status: 'off', version: null, message: '' };
  const set = (patch) => { state = { ...state, ...patch }; onState(state); };

  const enabled = !!isPackaged && isConfigured(config);
  if (!enabled) {
    state.message = !isPackaged ? 'Updates are off in a development build.' : 'Launcher updates are not set up yet.';
    return { enabled, state: () => state, check: async () => state, install: () => false };
  }

  autoUpdater.autoDownload = false;          // we ask first, then download
  autoUpdater.autoInstallOnAppQuit = true;   // a downloaded update is installed when the launcher is closed
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.setFeedURL({ provider: 'github', owner: config.owner, repo: config.repo });
  state = { status: 'idle', version: null, message: '' };

  const fail = (e) => {
    log('[LAUNCHER UPDATE] ' + ((e && e.message) || e));
    // Whatever went wrong (offline, a wrong checksum, a half download), this launcher is untouched and keeps working.
    set({ status: 'failed', version: null, message: "Couldn't update the launcher. This version keeps working; it will try again later." });
  };

  async function check() {
    if (state.status === 'checking' || state.status === 'downloading' || state.status === 'ready') return state;
    set({ status: 'checking', message: '' });
    try {
      const r = await autoUpdater.checkForUpdates();
      const next = r && r.updateInfo && r.updateInfo.version;
      if (!next || next === currentVersion || !r.isUpdateAvailable) { set({ status: 'current', version: null, message: 'You have the latest launcher.' }); return state; }
      set({ status: 'downloading', version: next, message: 'Downloading ' + next + '…' });
      await autoUpdater.downloadUpdate();
      set({ status: 'ready', version: next, message: 'Launcher ' + next + ' is ready. It installs when you restart.' });
    } catch (e) {
      fail(e);
    }
    return state;
  }

  /** Restarts into the downloaded update. False (and nothing happens) unless one is fully downloaded and verified. */
  function install() {
    if (state.status !== 'ready') return false;
    autoUpdater.quitAndInstall(false, true);
    return true;
  }

  return { enabled, state: () => state, check, install };
}

module.exports = { createSelfUpdater, isConfigured };
