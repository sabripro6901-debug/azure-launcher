'use strict';
// The launcher updating itself, through electron-updater (GitHub releases of the launcher repo).
// - Only a packaged launcher updates, and only when config.launcherUpdate names a real repo (not the placeholder).
// - electron-updater downloads the installer named in latest.yml and refuses it unless its SHA-512 matches; a failed or
//   tampered download throws and nothing is installed: the running launcher stays as it is.
// - It checks a moment after start and then every 30 minutes. With "Update the launcher automatically" on (the
//   default) a verified update installs itself quietly and the launcher opens again on its own, but only when nothing
//   is going on: never while a game runs, a download or install is busy, or a sign-in is open. Otherwise it waits and
//   tries again. With it off, the update waits for "Restart to update" (or is installed when the launcher is closed).
// The updater and the timers are passed in (fakes in the tests), so this file has no Electron dependency of its own.

const PLACEHOLDER = /^REPLACE/;
const CHECK_EVERY_MS = 30 * 60 * 1000;
const FIRST_CHECK_MS = 15 * 1000;
const RETRY_SAFE_MS = 20 * 1000;

function isConfigured(cfg) {
  return !!(cfg && cfg.owner && cfg.repo && !PLACEHOLDER.test(cfg.owner) && !PLACEHOLDER.test(cfg.repo));
}

/**
 * state: { status: 'off' | 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'current' | 'failed', version, message }
 * auto(): whether to install by itself; safeNow(): nothing is going on; beforeInstall(version): called right before.
 */
function createSelfUpdater({
  autoUpdater, config, isPackaged, currentVersion, log = () => {}, onState = () => {},
  auto = () => true, safeNow = () => true, beforeInstall = () => {}, timers = { setTimeout, setInterval, clearTimeout },
}) {
  let state = { status: 'off', version: null, message: '' };
  const set = (patch) => { state = { ...state, ...patch }; onState(state); };

  const enabled = !!isPackaged && isConfigured(config);
  if (!enabled) {
    state.message = !isPackaged ? 'Updates are off in a development build.' : 'Launcher updates are not set up yet.';
    return { enabled, state: () => state, check: async () => state, install: () => false, start: () => {}, tryAuto: () => false };
  }

  autoUpdater.autoDownload = false;          // check() downloads it itself
  autoUpdater.autoInstallOnAppQuit = true;   // a downloaded update is also installed when the launcher is closed
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.setFeedURL({ provider: 'github', owner: config.owner, repo: config.repo });
  state = { status: 'idle', version: null, message: '' };

  const fail = (e) => {
    log('[LAUNCHER UPDATE] ' + ((e && e.message) || e));
    // Whatever went wrong (offline, a wrong checksum, a half download), this launcher is untouched and keeps working.
    set({ status: 'failed', version: null, message: "Couldn't update the launcher. This version keeps working; it will try again later." });
  };

  let retry = null;
  /** Installs a ready update now if that is allowed and safe; otherwise tries again a little later. */
  function tryAuto() {
    if (state.status !== 'ready' || !auto()) return false;
    if (!safeNow()) {
      if (!retry) retry = timers.setTimeout(() => { retry = null; tryAuto(); }, RETRY_SAFE_MS);
      return false;
    }
    if (retry) { timers.clearTimeout(retry); retry = null; }
    const v = state.version;
    log('[LAUNCHER UPDATE] installing ' + v + ' quietly; the launcher opens again by itself');
    set({ status: 'installing', message: 'Updating to ' + v + '…' });
    try { beforeInstall(v); } catch { /* only a note for after the update */ }
    autoUpdater.quitAndInstall(true, true); // silent installer, then start the launcher again
    return true;
  }

  async function check() {
    if (state.status === 'ready') { tryAuto(); return state; }
    if (state.status === 'checking' || state.status === 'downloading' || state.status === 'installing') return state;
    set({ status: 'checking', message: '' });
    try {
      const r = await autoUpdater.checkForUpdates();
      const next = r && r.updateInfo && r.updateInfo.version;
      if (!next || next === currentVersion || !r.isUpdateAvailable) { set({ status: 'current', version: null, message: 'You have the latest launcher.' }); return state; }
      set({ status: 'downloading', version: next, message: 'Downloading ' + next + '…' });
      await autoUpdater.downloadUpdate();
      set({ status: 'ready', version: next, message: auto() ? 'Launcher ' + next + ' is ready. It installs by itself when nothing is running.' : 'Launcher ' + next + ' is ready. It installs when you restart.' });
      tryAuto();
    } catch (e) {
      fail(e);
    }
    return state;
  }

  /** Restarts into the downloaded update. False (and nothing happens) unless one is fully downloaded and verified. */
  function install() {
    if (state.status !== 'ready') return false;
    try { beforeInstall(state.version); } catch { /* note only */ }
    autoUpdater.quitAndInstall(false, true);
    return true;
  }

  /** A check a moment after start, then every 30 minutes. */
  function start() {
    timers.setTimeout(() => check(), FIRST_CHECK_MS);
    timers.setInterval(() => check(), CHECK_EVERY_MS);
  }

  return { enabled, state: () => state, check, install, start, tryAuto };
}

module.exports = { createSelfUpdater, isConfigured, CHECK_EVERY_MS };
