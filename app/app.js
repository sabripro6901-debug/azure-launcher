'use strict';
// The launcher app (Electron main process). The packaged entry (main.js) calls startApp() with nothing; developer hooks
// passed in are honoured only from source with AZURE_DEV=1 (see devgate.js).
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, shell, safeStorage, dialog, clipboard, session, nativeImage, nativeTheme, Tray, Menu } = require('electron');
const { createBackground } = require('./background');
const { SettingsStore, splitArgs } = require('../src/settings');
const { Vault, electronCipher } = require('../src/vault');
const { createAuthService, AuthError, isConfigured } = require('../src/auth');
const { launch } = require('../src/launch');
const { fetchRelease, ensureLegitJar, azureVersions } = require('../src/channel');
const queue = require('../src/queue');
const modcheck = require('../src/modcheck');
const modfix = require('../src/modfix');
const { listVersions, fabricLoaderFor, fabricApiFor } = require('../src/versions');
const { InstanceStore, InstanceError, instanceDir, ensureInstanceDir, copyInstanceDir, deleteInstanceDir } = require('../src/instances');
const { fetchSkinPng } = require('../src/skin');
const { ModrinthClient, ModrinthError, bestVersion, fileOf, rankVersions } = require('../src/modrinth');
const { download } = require('../src/net');
const { Content, ContentError } = require('../src/content');
const importer = require('../src/importer');
const mrpack = require('../src/mrpack');
const { getJson } = require('../src/net');
const { version } = require('../src/version');
const { createLogParser, progressOf } = require('./logfmt');
const { devOptions } = require('./devgate');
const { createSelfUpdater } = require('../src/selfupdate');
const { verifyLauncherUpdate } = require('../src/updatesig');
const { playerMessage, pointsToLogs, classify } = require('./messages');

const RENDERER = path.join(__dirname, 'renderer', 'index.html');
const MAX_LOG_LINE = 2000;
const RELEASE_TTL = 5 * 60 * 1000;

function startApp(opts = {}) {
  const dev = devOptions(opts, { isPackaged: app.isPackaged, env: process.env.AZURE_DEV });
  // One launcher at a time (AUDIT H3): two would write the same instance list and settings and download into the
  // same folders. Starting it again brings the open window to the front instead.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => background.showWindow());
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'launcher.config.json'), 'utf8'));
  const releaseKey = fs.readFileSync(path.join(__dirname, '..', 'config', 'release-key.txt'), 'utf8');
  const updateKeyFile = path.join(__dirname, '..', 'config', 'launcher-update-key.txt');
  const updateKey = fs.existsSync(updateKeyFile) ? fs.readFileSync(updateKeyFile, 'utf8') : ''; // none: every update is refused
  let win = null;
  // Closing the window during a game keeps the launcher in the tray until the game ends (AUDIT M5).
  const background = createBackground({
    Tray, Menu, nativeImage, iconPath: path.join(__dirname, 'renderer', 'icon.png'),
    getWin: () => win, isBusy: () => state !== 'idle' || !!child, quit: () => app.quit(),
    onFirstHide: (tray) => { if (tray.displayBalloon) tray.displayBalloon({ title: 'Azure Launcher', content: mainText('The game keeps running. The launcher closes by itself when the game ends.') }); },
    text: (s) => mainText(s),
  });
  // The few texts the main process shows itself (tray, notification), in the player's language (AUDIT M8).
  const MAIN_FR = {
    'Azure Launcher (closes when the game ends)': 'Azure Launcher (se ferme à la fin du jeu)',
    'Open Azure Launcher': 'Ouvrir Azure Launcher',
    'Close the launcher when the game ends': 'Fermer le launcher à la fin du jeu',
    'The game keeps running. The launcher closes by itself when the game ends.': 'Le jeu continue. Le launcher se fermera tout seul à la fin du jeu.',
  };
  function mainText(s) {
    const l = settings ? settings.get().language : 'system';
    const fr = l === 'fr' || (l !== 'en' && /^fr/i.test(app.getLocale() || ''));
    return fr && MAIN_FR[s] ? MAIN_FR[s] : s;
  }
  let settings;
  let auth;
  let store;
  let state = 'idle'; // idle | preparing | running
  let child = null;   // the game process while it runs
  let stopping = false; // the player asked to stop it
  let signIn = null;  // the sign-in in progress: { cancelled }
  let releaseCache = null;
  let pendingPack = null; // a .mrpack the player picked: { token, file, pack }
  let pendingImport = null; // what the player picked, waiting for their confirmation: { token, candidates }
  let modrinth = new ModrinthClient();
  let busyJobs = 0; // downloads and installs in progress (the launcher never updates itself in the middle of one)
  const devAnswers = []; // dev gate only: paths that stand in for the next file dialogs
  const answer = () => (dev.enabled && devAnswers.length ? devAnswers.shift() : null);
  const headCache = new Map();

  const send = (channel, data) => { if (win && !win.isDestroyed()) win.webContents.send(channel, data); };
  // Always a full Windows-style path (backslashes on Windows), wherever it was typed or picked from.
  const rootDir = () => path.resolve(settings.get().gameRoot || path.join(app.getPath('userData'), 'data'));
  const logLine = (line) => send('launch:event', { type: 'log', line });

  function setState(next) {
    state = next;
    send('launch:event', { type: 'state', state });
    if (next === 'idle') setTimeout(() => selfUpdate.tryAuto(), 3000); // a waiting launcher update, once the game is closed
  }

  /** A failure for players: friendly text up front, the technical detail only in the log. */
  function describe(e, fallback) {
    const code = e instanceof AuthError || e instanceof InstanceError ? e.code : classify(e, fallback);
    const detail = String((e && e.message) || e).slice(0, 600);
    logLine('[' + code + '] ' + detail);
    return { code, message: e instanceof InstanceError ? e.message : playerMessage(code), logs: pointsToLogs(code) };
  }

  // ---------- the launcher's own updates (packaged builds only) ----------
  const selfUpdate = createSelfUpdater({
    autoUpdater: app.isPackaged ? require('electron-updater').autoUpdater : null,
    config: config.launcherUpdate, isPackaged: app.isPackaged && !dev.enabled, currentVersion: version,
    log: (m) => logLine(m), onState: (st) => send('update:event', st),
    auto: () => settings.get().autoUpdateLauncher,
    safeNow: () => updateSafeNow(),
    beforeInstall: (to) => writeUpdatedNote(to),
    verify: (to, files) => verifyLauncherUpdate({ owner: config.launcherUpdate.owner, repo: config.launcherUpdate.repo, version: to, files, keyBase64: updateKey }),
  });
  /** Nothing going on: no game, no sign-in, no download or install. Only then does the launcher update itself. */
  function updateSafeNow() { return state === 'idle' && !child && !signIn && busyJobs === 0; }
  function writeUpdatedNote(to) {
    try { fs.writeFileSync(path.join(app.getPath('userData'), 'updated.json'), JSON.stringify({ from: version, to, at: new Date().toISOString() })); } catch { /* note only */ }
  }
  /** After a quiet update: which version it came from (shown once), else null. */
  function justUpdated() {
    const f = path.join(app.getPath('userData'), 'updated.json');
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      fs.rmSync(f, { force: true });
      return j && j.to === version ? { from: String(j.from || ''), to: version } : null;
    } catch { return null; }
  }
  let updatedNote;

  // ---------- the signed release (which Minecraft versions have an Azure build) ----------
  async function release() {
    if (releaseCache && Date.now() - releaseCache.at < RELEASE_TTL) return releaseCache.value;
    try {
      const value = await fetchRelease({ base: config.updateChannel.base, keyBase64: releaseKey });
      releaseCache = { at: Date.now(), value };
      return value;
    } catch (e) {
      logLine('[CHANNEL] ' + e.message);
      return releaseCache ? releaseCache.value : null;
    }
  }

  // ---------- instances ----------
  const selectedInstance = () => store.get(settings.get().selectedInstance) || store.list()[0];

  /** The instance's own picture as a small data URL (made 128 px when picked), or null for the default. */
  const iconCache = new Map();
  function iconOf(i) {
    if (i.icon !== 'icon.png') return null;
    try {
      const f = path.join(instanceDir(rootDir(), i.id), 'icon.png');
      const t = fs.statSync(f).mtimeMs;
      const c = iconCache.get(f);
      if (c && c.t === t) return c.url;
      const url = 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
      iconCache.set(f, { t, url });
      return url;
    } catch { return null; }
  }

  /** Folders of an instance that the Files tab can open (nothing else). */
  const OPENABLE = ['', 'mods', 'resourcepacks', 'shaderpacks', 'saves', 'config', 'screenshots', 'logs'];

  /** Worlds of an instance: folder name, last played (level.dat time) and its picture, newest first. */
  function worldsOf(id) {
    const saves = path.join(instanceDir(rootDir(), id), 'saves');
    let names = [];
    try { names = fs.readdirSync(saves, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
    const out = [];
    for (const name of names.slice(0, 200)) {
      const dir = path.join(saves, name);
      let played = null;
      try { played = fs.statSync(path.join(dir, 'level.dat')).mtime.toISOString(); } catch { continue; } // not a world
      let icon = null;
      try {
        const b = fs.readFileSync(path.join(dir, 'icon.png'));
        if (b.length < 200000) icon = 'data:image/png;base64,' + b.toString('base64');
      } catch { /* no picture */ }
      out.push({ name, played, icon });
    }
    return out.sort((a, b) => String(b.played).localeCompare(String(a.played)));
  }

  /** The end of the instance's latest game log (plain text, at most about 200 KB). */
  function logOf(id) {
    const f = path.join(instanceDir(rootDir(), id), 'logs', 'latest.log');
    try {
      const st = fs.statSync(f);
      const len = Math.min(st.size, 200000);
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(f, 'r');
      try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
      return { text: buf.toString('utf8'), when: st.mtime.toISOString() };
    } catch { return { text: '', when: null }; }
  }

  function view(i) {
    return {
      id: i.id, name: i.name, mcVersion: i.mcVersion, loader: i.loader ? 'Fabric ' + i.loaderVersion : 'Vanilla',
      fabric: !!i.loader, azure: !!i.azure, ram: i.ram, lastPlayed: i.lastPlayed, playTime: i.playTime || 0, icon: iconOf(i), dir: instanceDir(rootDir(), i.id),
      locked: i.azure ? ['Azure Client', 'Fabric API'] : [],
    };
  }

  async function createInstance({ name, mcVersion, ram }) {
    const rel = await release();
    const azureSet = rel ? azureVersions(rel) : new Set([config.minecraftVersion]);
    let loaderVersion;
    let mods = [];
    if (mcVersion === config.minecraftVersion) {
      loaderVersion = config.fabricLoader;
      mods = config.mods.map((m) => ({ ...m, locked: true }));
    } else {
      loaderVersion = await fabricLoaderFor(mcVersion);
      if (loaderVersion) {
        const api = await fabricApiFor(mcVersion);
        if (api) mods = [api];
      }
    }
    const azure = !!loaderVersion && azureSet.has(mcVersion);
    const inst = store.create({ name, mcVersion, loaderVersion, mods, azure, ram });
    ensureInstanceDir(rootDir(), inst.id);
    return inst;
  }

  // ---------- launch ----------
  /** Resolves with the time the game wrote ready.json (it is up), or null if it exits first / takes over 3 minutes. */
  function waitReady(gameDir, since, proc) {
    return new Promise((resolve) => {
      const end = Date.now() + 180000;
      const timer = setInterval(() => {
        let at = 0;
        try { at = fs.statSync(path.join(gameDir, queue.DIR, 'ready.json')).mtimeMs; } catch { /* not yet */ }
        if (at >= since) { clearInterval(timer); resolve(at); } else if (Date.now() > end || !proc || proc.exitCode !== null) { clearInterval(timer); resolve(null); }
      }, 250);
    });
  }

  async function doLaunch({ skipCheck = false } = {}) {
    if (state !== 'idle') return { ok: false, message: 'Already running.' };
    if (busyJobs > 0) return { ok: false, message: 'Wait until the download or fix in progress is done.' };
    const s = settings.get();
    const inst = selectedInstance();
    setState('preparing');
    send('launch:event', { type: 'status', text: 'Checking your account', clear: true });
    try {
      const account = await auth.getLaunchAccount();
      let azureJar = null;
      if (inst.azure) {
        azureJar = dev.enabled ? dev.azureJar : undefined;
        if (!azureJar) {
          send('launch:event', { type: 'status', text: 'Checking for Azure updates' });
          const got = await ensureLegitJar({
            base: config.updateChannel.base, keyBase64: releaseKey, dir: path.join(rootDir(), 'azure'),
            mc: inst.mcVersion, release: (await release()) || undefined, log: logLine,
          });
          azureJar = got ? got.path : null;
          if (!azureJar) logLine('[AZURE] No Azure build for Minecraft ' + inst.mcVersion + ' right now: starting without it.');
        }
      }
      const root = rootDir();
      const plainLog = createLogParser();
      const recent = []; // the last lines of the game's output, to explain a refused start
      let refusedAt = 0;
      if (s.openLogOnLaunch) send('launch:event', { type: 'openLog' });
      ensureInstanceDir(root, inst.id);
      const gameDir = instanceDir(root, inst.id);
      let quick = []; // after "Restart now": straight back into the same world or server
      let rolledBack = false;
      let pendingTiming = null;
      let code = 0;
      let wasStopped = false;
      for (let round = 0; round < 4; round++) {
      // Mod changes queued in the game (or here) are applied while the game is closed, with a rollback copy.
      const applyStart = Date.now();
      let batch = null;
      try { batch = queue.apply(gameDir, path.join(gameDir, 'mods')); } catch (e) { logLine('[MODS] Could not apply the queued changes: ' + e.message); }
      const applyMs = Date.now() - applyStart;
      if (batch) logLine('[MODS] Applied ' + batch.done.length + ' queued change(s) in ' + applyMs + ' ms' + (batch.failed.length ? ', failed: ' + batch.failed.join('; ') : ''));
      const startedAt = Date.now();
      const started = await launch({
        root, mc: inst.mcVersion, loader: inst.loader ? inst.loaderVersion : null, mods: inst.mods, azureJar, account,
        gameDir: instanceDir(root, inst.id),
        ram: (inst.ram || s.ram) + 'M', jvmArgs: splitArgs(s.javaArgs), gameArgs: [...(dev.enabled ? dev.gameArgs || [] : []), ...quick],
        log: (m) => {
          send('launch:event', { type: 'status', text: m, progress: progressOf(m) });
          logLine(m);
        },
        onLine: (raw) => {
          const line = plainLog(raw);
          if (line !== null) logLine(line.slice(0, MAX_LOG_LINE));
          recent.push(String(raw).slice(0, 600));
          if (recent.length > 400) recent.shift();
          // Fabric refusing the mods then waits on its own error window: once its report is written, close it
          if (!refusedAt && /Incompatible mods found|Some of your mods are incompatible/.test(raw)) {
            refusedAt = Date.now();
            setTimeout(() => { if (child) child.kill(); }, 2500);
          }
        },
        beforeStart: async (prepared) => {
          if (skipCheck || round > 0 || !inst.loader) return;
          send('launch:event', { type: 'status', text: 'Checking your mods' });
          const r = modcheck.check(checkArgs(inst, prepared.javaMajor));
          if (r.problems.length) throw Object.assign(new Error('Some mods would stop the game from starting.'), { code: 'MOD_PROBLEMS' });
        },
      });
      child = started.child;
      const playStart = Date.now();
      store.update(inst.id, { lastPlayed: new Date().toISOString() });
      setState('running');
      send('launch:event', { type: 'status', text: 'Playing', progress: null });
      if (s.closeOnLaunch && win) { win.hide(); background.onHiddenForGame(); }
      if (pendingTiming) {
        // Quick restart timings, reported once the game says it is up again.
        const t = { ...pendingTiming, applyMs, prepareMs: startedAt - pendingTiming.exitAt - applyMs };
        waitReady(gameDir, startedAt, child).then((readyAt) => {
          if (!readyAt) return;
          t.startMs = readyAt - startedAt;
          t.totalMs = readyAt - t.requestedAt;
          logLine('[MODS] Quick restart: closing ' + t.closeMs + ' ms, applying ' + t.applyMs + ' ms, launcher ' + t.prepareMs + ' ms, game start ' + t.startMs + ' ms, total ' + t.totalMs + ' ms');
          try { fs.writeFileSync(path.join(gameDir, queue.DIR, 'timings.json'), JSON.stringify(t, null, 2)); } catch { /* only a report */ }
        });
        pendingTiming = null;
      }
      code = await started.exit;
      child = null;
      try {
        const now = store.get(inst.id);
        if (now) store.update(inst.id, { playTime: (now.playTime || 0) + (Date.now() - playStart), lastPlayed: new Date().toISOString() });
      } catch { /* deleted meanwhile */ }
      wasStopped = stopping;
      // A queued change that crashes the game before it is up: roll it back once and start again.
      if (batch && code !== 0 && !wasStopped && !rolledBack && !queue.readySince(gameDir, startedAt)) {
        const entries = queue.rollbackBatch(batch.rollback, path.join(gameDir, 'mods'));
        const who = queue.blame(gameDir, entries, startedAt);
        try { fs.writeFileSync(path.join(gameDir, queue.DIR, 'applied.json'), JSON.stringify({ at: new Date().toISOString(), done: [], failed: [], crashed: who })); } catch { /* toast only */ }
        logLine('[MODS] ' + who + ' crashed the game on start: the change was rolled back, starting again');
        send('launch:event', { type: 'status', text: who + ' crashed the game: rolled back, starting again', progress: null });
        rolledBack = true;
        continue;
      }
      const req = !wasStopped && queue.takeRestart(gameDir, startedAt);
      if (req) {
        quick = queue.quickPlayArgs(req);
        pendingTiming = { requestedAt: req.requestedAt, exitAt: Date.now(), closeMs: Date.now() - req.requestedAt };
        logLine('[MODS] Quick restart requested' + (req.world ? ' (world ' + req.world + ')' : req.server ? ' (server ' + req.server + ')' : ''));
        send('launch:event', { type: 'status', text: 'Restarting with your mod changes', progress: null });
        continue;
      }
      break;
      }
      send('instances:changed', { instances: store.list().map(view), selected: selectedInstance().id });
      stopping = false;
      // Fabric refused this set of mods: explain it with the same screen instead of only "the game closed".
      const refusal = code !== 0 && !wasStopped && inst.loader ? modcheck.fabricRefusal(recent) : null;
      if (refusal) {
        if (!background.onGameDone() && win) win.show();
        setState('idle');
        send('launch:event', { type: 'modproblems', report: await modReport(inst, { fabric: refusal, fromCrash: true }) });
        return { ok: false, modProblems: true };
      }
      if (!background.onGameDone() && win) win.show();
      setState('idle');
      send('launch:event', { type: 'exit', code, stopped: wasStopped });
      return { ok: true };
    } catch (e) {
      child = null;
      if (!background.onGameDone() && win) win.show();
      setState('idle');
      if (e && e.code === 'MOD_PROBLEMS') {
        send('launch:event', { type: 'modproblems', report: await modReport(inst, {}) });
        return { ok: false, modProblems: true };
      }
      const err = describe(e, 'LAUNCH_FAILED');
      send('launch:event', { type: 'error', ...err });
      return { ok: false, ...err };
    }
  }

  // ---------- mod check ----------
  /** Java the instance's Minecraft runs on, from its installed version file (null before the first start). */
  function javaFor(mc) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(rootDir(), 'versions', mc, mc + '.json'), 'utf8'));
      return (v.javaVersion && v.javaVersion.majorVersion) || null;
    } catch { return null; }
  }
  function checkArgs(inst, javaMajor) {
    const modsDir = path.join(instanceDir(rootDir(), inst.id), 'mods');
    const locked = (inst.mods || []).filter((m) => m.locked).map((m) => m.file);
    if (fs.existsSync(modsDir)) for (const f of fs.readdirSync(modsDir)) if (/^(azure|aurora)-client.*\.jar$/i.test(f)) locked.push(f);
    return { modsDir, mc: inst.mcVersion, loaderVersion: inst.loaderVersion, javaMajor: javaMajor === undefined ? javaFor(inst.mcVersion) : javaMajor, locked };
  }
  /** The problems screen's data: what is wrong with each mod and how to fix it. */
  async function modReport(inst, { fabric = null, fromCrash = false, session = null } = {}) {
    const args = checkArgs(inst);
    const r = modcheck.check(args);
    await modfix.withFixes(r, {
      modsDir: args.modsDir, mc: inst.mcVersion, loaderVersion: inst.loaderVersion, client: modrinth,
      newestLoader: () => fabricLoaderFor(inst.mcVersion),
      fabricApiIncluded: (inst.mods || []).some((m) => m.locked && /^fabric-api/i.test(m.file)),
    });
    return {
      instance: { id: inst.id, name: inst.name, mc: inst.mcVersion, loader: inst.loaderVersion },
      problems: r.problems, fabric, fromCrash, canUndo: !!session && modfix.canUndo(instanceDir(rootDir(), inst.id), session),
    };
  }
  function fixCtx(inst) {
    const gameDir = instanceDir(rootDir(), inst.id);
    return {
      gameDir, modsDir: path.join(gameDir, 'mods'),
      content: new Content({ gameDir, instance: inst, client: modrinth, log: logLine }),
      setLoader: (v) => { const old = store.get(inst.id).loaderVersion; store.update(inst.id, { loaderVersion: v }); return old; },
    };
  }
  const SESSION = /^s[0-9]{6,16}$/;
  async function modcheckReply(fn) {
    busyJobs++;
    try {
      return { ok: true, ...(await fn()) };
    } catch (e) {
      logLine('[MODS] ' + String((e && e.message) || e).slice(0, 400));
      return { ok: false, message: e instanceof ModrinthError || e instanceof ContentError ? e.message : String((e && e.message) || 'Something went wrong.').slice(0, 200) };
    } finally {
      busyJobs--;
    }
  }

  // ---------- accounts ----------
  async function addAccount() {
    if (signIn) return { ok: false, message: 'A sign-in is already open.' };
    const mine = { cancelled: false };
    signIn = mine;
    try {
      const entry = await auth.signIn((code) => send('accounts:code', code));
      if (mine.cancelled) {
        auth.remove(entry.id); // the player gave up while waiting: do not keep the account
        return { ok: false, cancelled: true };
      }
      send('accounts:result', { ok: true, account: entry });
      return { ok: true };
    } catch (e) {
      const err = describe(e, 'UNKNOWN');
      if (!mine.cancelled) send('accounts:result', { ok: false, ...err });
      return { ok: false, ...err };
    } finally {
      if (signIn === mine) signIn = null;
    }
  }

  /** The player's head (and hat layer) as two tiny data: images, from their Mojang skin; null if there is none. */
  async function headOf(uuid) {
    if (!/^[0-9a-f-]{32,36}$/i.test(uuid)) return null;
    const key = uuid.replace(/-/g, '').toLowerCase();
    if (headCache.has(key)) return headCache.get(key);
    const file = path.join(app.getPath('userData'), 'heads', key + '.json');
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved && saved.head) { headCache.set(key, saved); return saved; }
    } catch { /* not cached yet */ }
    let result = null;
    try {
      const png = await fetchSkinPng(key);
      const img = png ? nativeImage.createFromBuffer(png) : null;
      const size = img ? img.getSize() : null;
      if (size && size.width >= 64 && size.height >= 32) {
        result = {
          head: img.crop({ x: 8, y: 8, width: 8, height: 8 }).toDataURL(),
          hat: img.crop({ x: 40, y: 8, width: 8, height: 8 }).toDataURL(),
        };
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(result));
      }
    } catch { /* offline or no skin: the page shows the initial instead */ }
    headCache.set(key, result);
    setTimeout(() => { if (!result) headCache.delete(key); }, 10 * 60 * 1000).unref();
    return result;
  }

  // ---------- window and IPC ----------
  const trusted = (event) => ((event.senderFrame && event.senderFrame.url) || '') === pathToFileURL(RENDERER).href;
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => {
    if (!trusted(event)) throw new Error('Untrusted sender');
    return fn(...args);
  });
  // ---------- mods, resource packs, shader packs ----------
  const contentFor = () => {
    const inst = selectedInstance();
    return { inst, content: new Content({ gameDir: instanceDir(rootDir(), inst.id), instance: inst, client: modrinth, log: logLine }) };
  };
  const notRunning = () => { if (state !== 'idle') throw new ContentError('RUNNING', 'Close the game first, then change what is installed.'); };
  /** Content calls answer { ok, ... } or { ok: false, code, message }: friendly text, never a crash. */
  const contentReply = async (fn) => {
    busyJobs++;
    try {
      return { ok: true, ...(await fn()) };
    } catch (e) {
      if (e instanceof ModrinthError) return { ok: false, code: e.code, message: e.message };
      if (e instanceof ContentError || e instanceof InstanceError) return { ok: false, code: e.code, message: e.message };
      logLine('[CONTENT] ' + String((e && e.message) || e).slice(0, 400));
      return { ok: false, code: 'UNKNOWN', message: 'Something went wrong.' };
    } finally {
      busyJobs--;
    }
  };
  const contentSnapshot = (content, inst) => ({
    items: content.list(),
    instance: { id: inst.id, name: inst.name, mcVersion: inst.mcVersion, loader: inst.loader ? 'Fabric ' + inst.loaderVersion : 'Vanilla', fabric: !!inst.loader },
  });

  /** Instance calls answer { ok, instances, selected } or { ok:false, message }. */
  const instanceReply = async (fn) => {
    try {
      const extra = await fn();
      return { ok: true, instances: store.list().map(view), selected: selectedInstance().id, ...(extra || {}) };
    } catch (e) {
      return { ok: false, ...describe(e, 'UNKNOWN') };
    }
  };

  /** A new instance from a parsed .mrpack: files downloaded and checked, overrides copied, the instance selected. */
  async function createFromPack(file, pack, name) {
    const rel = await release();
    const azureSet = rel ? azureVersions(rel) : new Set([config.minecraftVersion]);
    let loaderVersion = null;
    let mods = [];
    if (pack.fabricLoader) {
      // the pack's own loader version when Fabric has it, else the newest stable one
      loaderVersion = await getJson('https://meta.fabricmc.net/v2/versions/loader/' + encodeURIComponent(pack.mc) + '/' + encodeURIComponent(pack.fabricLoader)).then(() => pack.fabricLoader).catch(() => fabricLoaderFor(pack.mc));
      if (!loaderVersion) throw new ContentError('LOADER', 'Fabric does not support Minecraft ' + pack.mc + ' yet.');
      const own = mrpack.packFabricApi(pack);
      if (own) mods = [own];
      else { const api = await fabricApiFor(pack.mc); if (api) mods = [api]; }
    }
    const inst = store.create({ name: String(name || pack.name), mcVersion: pack.mc, loaderVersion, mods, azure: !!loaderVersion && azureSet.has(pack.mc), ram: null });
    const dir = ensureInstanceDir(rootDir(), inst.id);
    try {
      const result = await mrpack.install(pack, file, dir, { onProgress: (text) => send('content:event', { type: 'progress', text }) });
      const content = new Content({ gameDir: dir, instance: inst, client: modrinth });
      await importer.recogniseInstalled(content, modrinth);
      settings.set({ selectedInstance: inst.id });
      return { created: inst.id, files: result.files, overrides: result.overrides, skipped: result.skipped.length, instances: store.list().map(view), selected: inst.id };
    } catch (e) {
      try { store.remove(inst.id); deleteInstanceDir(rootDir(), inst.id); } catch { /* keep what we can */ }
      if (e instanceof mrpack.PackError) throw new ContentError(e.code, e.message);
      throw e;
    }
  }

  /** What the About card shows: from config/launcher.config.json (the privacy link must be https). */
  function aboutInfo() {
    const a = (config && config.about) || {};
    let privacyUrl = '';
    try { const u = new URL(a.privacyUrl); if (u.protocol === 'https:') privacyUrl = u.href; } catch { /* none */ }
    return { publisher: String(a.publisher || ''), contactEmail: String(a.contactEmail || ''), privacyUrl };
  }

  /** Licence files that ship with the program: only these names can be opened. */
  const LICENSE_FILES = {
    notices: () => path.join(process.resourcesPath, 'THIRD-PARTY-NOTICES.txt'),
    electron: () => path.join(path.dirname(process.execPath), 'LICENSE.electron.txt'),
    chromium: () => path.join(path.dirname(process.execPath), 'LICENSES.chromium.html'),
  };

  function registerIpc() {
    handle('app:state', () => ({
      state, version, dev: dev.enabled, configured: isConfigured(config),
      instances: store.list().map(view), selected: selectedInstance().id,
      accounts: auth.listAccounts(), settings: settings.get(), root: rootDir(),
      about: aboutInfo(), justUpdated: updatedNote === undefined ? (updatedNote = justUpdated()) : null,
    }));
    handle('launch:start', (opts) => doLaunch({ skipCheck: !!(opts && opts.skipCheck) }));
    handle('modcheck:report', (session) => modcheckReply(async () => ({ report: await modReport(selectedInstance(), { session: SESSION.test(String(session)) ? String(session) : null }) })));
    handle('modcheck:fix', ({ session, file, index } = {}) => modcheckReply(async () => {
      notRunning();
      if (!SESSION.test(String(session))) throw new Error('Bad session.');
      const inst = selectedInstance();
      const now = await modReport(inst, { session });
      const p = now.problems.find((x) => x.file === String(file));
      const fix = p && p.fixes[Number(index)];
      if (!fix) throw new Error('That fix is no longer needed.');
      await modfix.applyFix(fix, p.file, String(session), fixCtx(inst));
      logLine('[MODS] Fix: ' + fix.label + ' (' + p.file + ')');
      return { report: await modReport(selectedInstance(), { session }) };
    }));
    handle('modcheck:fixAll', (session) => modcheckReply(async () => {
      notRunning();
      if (!SESSION.test(String(session))) throw new Error('Bad session.');
      // one pass: a newer loader first (it may fix several), then the best fix for each remaining mod
      let rep = await modReport(selectedInstance(), { session });
      const loader = rep.problems.flatMap((p) => p.fixes).find((f) => f.action === 'loader');
      if (loader) { await modfix.applyFix(loader, '', session, fixCtx(selectedInstance())); rep = await modReport(selectedInstance(), { session }); }
      for (const p of rep.problems) {
        const f = modfix.preferred(p);
        if (!f || f.action === 'loader') continue;
        try { await modfix.applyFix(f, p.file, session, fixCtx(selectedInstance())); logLine('[MODS] Fix: ' + f.label + ' (' + p.file + ')'); } catch (e) { logLine('[MODS] Fix failed for ' + p.file + ': ' + e.message); }
      }
      return { report: await modReport(selectedInstance(), { session }) };
    }));
    handle('modcheck:undo', (session) => modcheckReply(async () => {
      notRunning();
      if (!SESSION.test(String(session))) throw new Error('Bad session.');
      const n = modfix.undo(String(session), fixCtx(selectedInstance()));
      logLine('[MODS] Undid ' + n + ' fix step(s)');
      return { report: await modReport(selectedInstance(), { session }) };
    }));
    handle('launch:stop', () => { if (child) { stopping = true; child.kill(); return true; } return false; });

    handle('update:state', () => selfUpdate.state());
    handle('update:check', () => selfUpdate.check());
    handle('update:install', () => (updateSafeNow() ? { ok: selfUpdate.install() } : { ok: false, message: 'Close the game (and wait for downloads) first, then update.' }));
    handle('versions:list', async ({ snapshots } = {}) => {
      const rel = await release();
      try {
        return { ok: true, azureKnown: !!rel, versions: await listVersions({ snapshots: !!snapshots, azureSet: rel ? azureVersions(rel) : null }) };
      } catch (e) {
        return { ok: false, ...describe(e, 'NETWORK') };
      }
    });
    handle('instances:create', (spec) => instanceReply(async () => {
      const inst = await createInstance(spec || {});
      settings.set({ selectedInstance: inst.id });
      return { created: inst.id };
    }));
    handle('instances:update', (id, patch) => instanceReply(() => { store.update(String(id), { name: patch.name, ram: patch.ram }); }));
    handle('instances:duplicate', (id) => instanceReply(() => {
      const copy = store.duplicate(String(id));
      copyInstanceDir(rootDir(), String(id), copy.id);
      return { created: copy.id };
    }));
    handle('instances:delete', (id) => instanceReply(() => {
      if (state !== 'idle' && selectedInstance().id === String(id)) throw new InstanceError('BUSY', 'Stop the game before deleting this instance.');
      const next = store.remove(String(id));
      deleteInstanceDir(rootDir(), String(id));
      if (settings.get().selectedInstance === String(id)) settings.set({ selectedInstance: next });
    }));
    handle('instances:select', (id) => instanceReply(() => {
      if (!store.get(String(id))) throw new InstanceError('NOT_FOUND', 'That instance no longer exists.');
      settings.set({ selectedInstance: String(id) });
    }));
    handle('instances:pickIcon', (id) => instanceReply(async () => {
      const inst = store.get(String(id));
      if (!inst) throw new InstanceError('NOT_FOUND', 'That instance no longer exists.');
      const forced = answer();
      let file = forced ? String(forced) : null;
      if (!file) {
        const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Pictures (.png, .jpg, .webp, .gif)', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
        if (r.canceled || !r.filePaths.length) return { cancelled: true };
        file = r.filePaths[0];
      }
      if (!/\.(png|jpe?g|webp|gif)$/i.test(file)) throw new InstanceError('BAD_ICON', 'Pick a .png, .jpg, .webp or .gif picture.');
      if (fs.statSync(file).size > 20 * 1024 * 1024) throw new InstanceError('BAD_ICON', 'That picture is too big (over 20 MB).');
      const img = nativeImage.createFromPath(file);
      if (img.isEmpty()) throw new InstanceError('BAD_ICON', 'That file could not be read as a picture.');
      const { width, height } = img.getSize();
      const side = Math.min(width, height); // a square from the middle, like Modrinth
      const square = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
      const dir = ensureInstanceDir(rootDir(), inst.id);
      fs.writeFileSync(path.join(dir, 'icon.png'), square.resize({ width: 128, height: 128, quality: 'best' }).toPNG());
      store.update(inst.id, { icon: 'icon.png' });
    }));
    handle('instances:resetIcon', (id) => instanceReply(() => {
      const inst = store.get(String(id));
      if (!inst) throw new InstanceError('NOT_FOUND', 'That instance no longer exists.');
      fs.rmSync(path.join(instanceDir(rootDir(), inst.id), 'icon.png'), { force: true });
      store.update(inst.id, { icon: null });
    }));
    handle('instances:openSub', (id, sub) => {
      const which = String(sub || '');
      if (!OPENABLE.includes(which)) return false;
      const dir = path.join(instanceDir(rootDir(), String(id)), which);
      fs.mkdirSync(dir, { recursive: true });
      return shell.openPath(dir);
    });
    handle('instances:worlds', (id) => { instanceDir(rootDir(), String(id)); return worldsOf(String(id)); });
    handle('instances:openWorld', (id, name) => {
      const n = String(name || '');
      if (!n || /[\\/]/.test(n) || n === '.' || n === '..') return false;
      const saves = path.join(instanceDir(rootDir(), String(id)), 'saves');
      const dir = path.resolve(saves, n);
      if (path.dirname(dir) !== saves || !fs.existsSync(dir)) return false;
      return shell.openPath(dir);
    });
    handle('instances:log', (id) => logOf(String(id)));
    handle('content:reveal', ({ kind, file } = {}) => {
      const f = String(file || '');
      if (!f || /[\\/]/.test(f) || f === '.' || f === '..') return false;
      const { content } = contentFor();
      const full = path.join(content.dir(String(kind)), f);
      if (!fs.existsSync(full)) return false;
      shell.showItemInFolder(full);
      return true;
    });
    handle('instances:openFolder', (id) => { const dir = instanceDir(rootDir(), String(id)); fs.mkdirSync(dir, { recursive: true }); return shell.openPath(dir); });

    handle('content:search', ({ kind, query, sort, categories, offset } = {}) => contentReply(async () => {
      if (kind === 'modpack') {
        // modpacks make a new instance, so they are not filtered to the selected one (only Fabric packs: that is what the launcher runs)
        const r = await modrinth.search({ kind, query: String(query || '').slice(0, 100), loader: 'fabric', sort, categories: (categories || []).slice(0, 8).map(String), offset: Number(offset) || 0 });
        return { ...r, hits: r.hits.map((h) => ({ ...h, installed: false })) };
      }
      const { inst, content } = contentFor();
      const loader = kind === 'mod' ? inst.loader : kind === 'shader' && inst.loader ? 'iris' : null;
      if (kind === 'mod' && !inst.loader) throw new ContentError('NO_LOADER', 'This version has no Fabric, so mods are off.');
      const r = await modrinth.search({ kind, query: String(query || '').slice(0, 100), mc: inst.mcVersion, loader, sort, categories: (categories || []).slice(0, 8).map(String), offset: Number(offset) || 0 });
      const have = new Set(Object.values(content.manifest.items).map((i) => i.projectId).filter(Boolean));
      if ((inst.mods || []).some((m) => m.locked && /^fabric-api/i.test(m.file))) have.add('P7dR8mSH'); // included: shown as installed
      return { ...r, hits: r.hits.map((h) => ({ ...h, installed: have.has(h.projectId) })) };
    }));
    handle('content:categories', (kind) => contentReply(async () => ({ categories: await modrinth.categories(String(kind)) })));
    handle('content:list', () => contentReply(async () => { const { inst, content } = contentFor(); return { ...contentSnapshot(content, inst), queue: queue.read(instanceDir(rootDir(), inst.id)).map((e) => ({ id: e.id, op: e.op, name: e.name || e.file, file: e.file, oldVersion: e.oldVersion || '', newVersion: e.newVersion || '', text: queue.describe(e) })) }; }));
    handle('content:unqueue', (id) => contentReply(async () => { notRunning(); const { inst } = contentFor(); queue.undo(instanceDir(rootDir(), inst.id), String(id)); return {}; }));
    handle('content:versions', ({ kind, projectId, all } = {}) => contentReply(async () => {
      if (kind === 'modpack') return { versions: rankVersions(await modrinth.versionsFor(String(projectId), { loader: 'fabric' }), { loader: 'fabric' }), mc: null };
      const { inst } = contentFor();
      const loader = kind === 'mod' ? inst.loader : null;
      const list = await modrinth.versionsFor(String(projectId), all ? { loader } : { mc: inst.mcVersion, loader });
      return { versions: rankVersions(list, { mc: inst.mcVersion, loader }), mc: inst.mcVersion };
    }));
    handle('content:install', ({ kind, projectId, versionId }) => contentReply(async () => {
      notRunning();
      const { inst, content } = contentFor();
      const plan = await content.install(String(kind), String(projectId), { versionId: versionId ? String(versionId) : undefined, onProgress: (text) => send('content:event', { type: 'progress', text }) });
      return { installed: plan.entries.map((e) => e.name), missing: plan.missing.length, ...contentSnapshot(content, inst) };
    }));
    handle('content:toggle', ({ kind, base }) => contentReply(async () => { notRunning(); const { inst, content } = contentFor(); content.toggle(String(kind), String(base)); return contentSnapshot(content, inst); }));
    handle('content:remove', ({ kind, base }) => contentReply(async () => { notRunning(); const { inst, content } = contentFor(); content.remove(String(kind), String(base)); return contentSnapshot(content, inst); }));
    handle('content:check', () => contentReply(async () => { const { content } = contentFor(); return { updates: await content.checkUpdates() }; }));
    handle('content:update', ({ kind, base, all } = {}) => contentReply(async () => {
      notRunning();
      const { inst, content } = contentFor();
      const found = await content.checkUpdates();
      const todo = Object.values(found).filter((u) => all || (u.kind === kind && u.base === base));
      let done = 0;
      for (const u of todo) {
        send('content:event', { type: 'progress', text: 'Updating ' + u.base + ' (' + (++done) + '/' + todo.length + ')' });
        await content.update(u.kind, u.base, u, { onProgress: (text) => send('content:event', { type: 'progress', text }) });
      }
      return { updated: todo.length, ...contentSnapshot(content, inst) };
    }));

    handle('content:pick', async (mode) => {
      const folder = mode === 'folder';
      const forced = answer();
      if (forced) return Array.isArray(forced) ? forced : [forced];
      const r = await dialog.showOpenDialog(win, folder ? { properties: ['openDirectory'] } : { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Mods and packs (.jar, .zip)', extensions: ['jar', 'zip'] }] });
      return r.canceled ? [] : r.filePaths;
    });
    handle('content:inspect', (paths) => contentReply(async () => {
      if (!Array.isArray(paths) || paths.length > 200 || !paths.every((p) => typeof p === 'string' && path.isAbsolute(p))) throw new ContentError('BAD_PATHS', 'Those files could not be used.');
      const { inst, content } = contentFor();
      const candidates = await importer.inspect(paths, { content, instance: inst, client: modrinth });
      const token = require('node:crypto').randomUUID();
      pendingImport = { token, candidates };
      return {
        token,
        candidates: candidates.map((c) => ({ id: c.id, fileName: c.fileName, kind: c.kind, name: c.name, version: c.version, icon: c.icon, loader: c.loader, issues: c.issues, blocked: c.blocked, ask: c.ask, recognised: !!c.modrinth, folder: c.folder })),
      };
    }));
    handle('content:add', ({ token, ids }) => contentReply(async () => {
      notRunning();
      if (!pendingImport || pendingImport.token !== token) throw new ContentError('STALE', 'Pick the files again.');
      const { inst, content } = contentFor();
      const result = importer.add(pendingImport.candidates, (ids || []).map(Number), { content });
      pendingImport = null;
      return { ...result, ...contentSnapshot(content, inst) };
    }));

    handle('mrpack:pick', async () => {
      const forced = answer();
      const r = forced ? { canceled: false, filePaths: [forced] } : await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Modrinth modpack (.mrpack)', extensions: ['mrpack'] }] });
      if (r.canceled || !r.filePaths[0]) return { ok: false, cancelled: true };
      return contentReply(async () => {
        const file = r.filePaths[0];
        let pack;
        try { pack = mrpack.parse(file); } catch (e) { if (e instanceof mrpack.PackError) throw new ContentError(e.code, e.message); throw e; }
        const rel = await release();
        const azureSet = rel ? azureVersions(rel) : new Set([config.minecraftVersion]);
        const fabric = pack.fabricLoader ? !!(await fabricLoaderFor(pack.mc)) : false;
        const token = require('node:crypto').randomUUID();
        pendingPack = { token, file, pack };
        return { token, summary: { name: pack.name, summary: pack.summary, mc: pack.mc, loader: pack.fabricLoader ? 'Fabric ' + pack.fabricLoader : 'Vanilla', files: pack.files.length, skipped: pack.skipped.length, azure: !!pack.fabricLoader && azureSet.has(pack.mc), fabricSupported: fabric || !pack.fabricLoader } };
      });
    });
    handle('mrpack:install', ({ token, name }) => contentReply(async () => {
      if (state !== 'idle') throw new ContentError('RUNNING', 'Close the game first.');
      if (!pendingPack || pendingPack.token !== token) throw new ContentError('STALE', 'Pick the pack again.');
      const { file, pack } = pendingPack;
      const out = await createFromPack(file, pack, name);
      pendingPack = null;
      return out;
    }));

    // Modrinth modpacks: browse (search/categories above), choose a version, and install = a new instance from its .mrpack
    handle('modpack:install', ({ projectId, versionId, name }) => contentReply(async () => {
      if (state !== 'idle') throw new ContentError('RUNNING', 'Close the game first.');
      const version = versionId ? await modrinth.version(String(versionId)) : bestVersion(await modrinth.versionsFor(String(projectId), { loader: 'fabric' }));
      if (!version) throw new ContentError('NO_VERSION', 'This modpack has no Fabric version.');
      const f = fileOf(version);
      if (!f || !f.filename.toLowerCase().endsWith('.mrpack')) throw new ContentError('NO_FILE', 'Modrinth has no safe download for this modpack.');
      const tmpDir = path.join(rootDir(), 'tmp');
      const file = path.join(tmpDir, require('node:crypto').randomUUID() + '.mrpack');
      try {
        send('content:event', { type: 'progress', text: 'Downloading the modpack…' });
        await download(f.url, file, { sha512: f.sha512 });
        let pack;
        try { pack = mrpack.parse(file); } catch (e) { if (e instanceof mrpack.PackError) throw new ContentError(e.code, e.message); throw e; }
        return await createFromPack(file, pack, name || pack.name);
      } finally {
        fs.rmSync(file, { force: true });
      }
    }));
    handle('mrpack:export', (id) => contentReply(async () => {
      const inst = store.get(String(id));
      if (!inst) throw new ContentError('NOT_FOUND', 'That instance no longer exists.');
      const forced = answer();
      const r = forced ? { canceled: false, filePath: forced } : await dialog.showSaveDialog(win, { defaultPath: inst.name.replace(/[^A-Za-z0-9._ -]/g, '_') + '.mrpack', filters: [{ name: 'Modrinth modpack (.mrpack)', extensions: ['mrpack'] }] });
      if (r.canceled || !r.filePath) return { cancelled: true };
      const dir = instanceDir(rootDir(), inst.id);
      const content = new Content({ gameDir: dir, instance: inst, client: modrinth });
      const listed = content.list();
      const items = [];
      for (const kind of ['mod', 'resourcepack', 'shader']) {
        for (const it of listed[kind]) {
          if (it.virtual || it.folder) continue;
          const full = path.join(content.dir(kind), it.file);
          items.push({ kind, base: it.base, file: full, enabled: it.enabled, modId: it.modId, hash: importer.sha512File(full), locked: it.locked });
        }
      }
      const extra = [];
      const cfg = path.join(dir, 'config');
      let bytes = 0;
      const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isSymbolicLink() || e.name.startsWith('.')) continue; const full = path.join(d, e.name); if (e.isDirectory()) walk(full, rel + e.name + '/'); else if (bytes < 20 * 1024 * 1024) { const b = fs.readFileSync(full); bytes += b.length; extra.push({ rel: 'config/' + rel + e.name, bytes: new Uint8Array(b) }); } } };
      if (fs.existsSync(cfg)) walk(cfg, '');
      const out = await mrpack.build({ instance: inst, items, lookup: (hashes) => modrinth.versionsByHashes(hashes), extraFiles: extra });
      fs.writeFileSync(r.filePath, out.bytes);
      return { path: r.filePath, files: out.files, overrides: out.overrides };
    }));

    handle('accounts:list', () => auth.listAccounts());
    handle('accounts:add', () => addAccount());
    handle('accounts:cancel', () => { if (signIn) signIn.cancelled = true; send('accounts:result', { ok: false, cancelled: true }); return true; });
    handle('accounts:select', (id) => { auth.select(id); return auth.listAccounts(); });
    handle('accounts:remove', (id) => { auth.remove(id); return auth.listAccounts(); });
    handle('accounts:head', (uuid) => headOf(String(uuid)));
    handle('settings:get', () => settings.get());
    handle('settings:set', (patch) => {
      // The game folder can't change while a game runs or a download or install is busy (AUDIT M9): they write there.
      if (patch && typeof patch.gameRoot === 'string' && patch.gameRoot !== settings.get().gameRoot && (state !== 'idle' || child || busyJobs > 0)) {
        const { gameRoot, ...rest } = patch;
        return { ...settings.set(rest), refused: 'Close the game and wait for downloads to finish before changing the game folder.' };
      }
      const r = settings.set(patch);
      if (patch && patch.language) background.refresh(); // the tray menu in the new language
      if (patch && patch.autoUpdateLauncher === true) selfUpdate.tryAuto();
      return r;
    });
    handle('settings:chooseFolder', async () => {
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
      return r.canceled ? null : path.resolve(r.filePaths[0]);
    });
    handle('settings:openFolder', () => { fs.mkdirSync(rootDir(), { recursive: true }); return shell.openPath(rootDir()); });
    handle('app:openExternal', (url) => {
      let u;
      try { u = new URL(url); } catch { return false; }
      if (u.protocol !== 'https:') return false;
      shell.openExternal(u.href);
      return true;
    });
    handle('app:openLicense', async (which) => {
      const find = LICENSE_FILES[String(which)];
      if (!find) return false;
      const file = find();
      if (!fs.existsSync(file)) return false;
      return (await shell.openPath(file)) === '';
    });
    handle('app:copy', (text) => { clipboard.writeText(String(text).slice(0, 200)); return true; });
  }

  function createWindow() {
    nativeTheme.themeSource = 'dark'; // a dark title bar on Windows
    win = new BrowserWindow({
      width: 1160, height: 820, minWidth: 1000, minHeight: 720, backgroundColor: '#111116',
      title: 'Azure Launcher', icon: path.join(__dirname, 'renderer', 'icon.png'), autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
    });
    win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(({ url }) => {
      try { if (new URL(url).protocol === 'https:') shell.openExternal(url); } catch { /* ignore */ }
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.on('close', (e) => background.onWindowClose(e));
    win.loadFile(RENDERER);
    return win;
  }

  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    const userData = app.getPath('userData');
    settings = new SettingsStore(path.join(userData, 'settings.json'));
    store = new InstanceStore(path.join(userData, 'instances.json'), {
      name: 'Azure Client ' + config.minecraftVersion, mcVersion: config.minecraftVersion, loader: 'fabric', loaderVersion: config.fabricLoader,
      mods: config.mods.map((m) => ({ ...m, locked: true })), azure: true,
    });
    const vault = new Vault(path.join(userData, 'vault'), electronCipher(safeStorage));
    const log = (m) => { if (process.env.AZURE_LAUNCHER_DEBUG) console.log('[auth] ' + m); };
    auth = createAuthService({ config, vault, log });
    registerIpc();
    createWindow();
    if (selfUpdate.enabled) selfUpdate.start(); // a moment after start, then every 30 minutes
    if (dev.enabled && dev.onReady) dev.onReady({ win, send, app, store, settings, answerDialog: (p) => devAnswers.push(p), setModrinthBase: (base) => { modrinth = new ModrinthClient({ base, sleep: async () => {} }); } });
  });
  app.on('window-all-closed', () => app.quit());
}

module.exports = { startApp };
