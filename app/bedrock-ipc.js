'use strict';
// The Bedrock tab's calls (main process). Everything the page sends is checked here: it names a profile by id, a pack
// by folder name and a file only by what the player picked in a dialog (a token), never by a path of its own.
// The heavy work (zip, unzip, folder sizes) runs in a worker thread; progress goes to the page as 'bedrock:progress'.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Bedrock, BedrockError } = require('../src/bedrock');
const { DIRS } = require('../src/bedrock/packs');
const { purgeRemoved } = require('../src/bedrock/trash');
const { classify, playerMessage } = require('./messages');

function registerBedrock({ text = (s) => s, handle, dialog, shell, getWin, userData, answer, logLine, send = () => {}, getSettings = () => ({}), bedrockOptions = {} }) {
  const removedDir = path.join(userData, 'bedrock-removed');
  const backupRoot = path.join(userData, 'bedrock-backups');
  const bedrock = new Bedrock({ backupRoot, removedDir, keep: () => getSettings().bedrockKeepBackups, ...bedrockOptions });
  let pending = null; // { token, kind: 'packs'|'world', profile, items }
  const picks = new Map(); // token -> file the player picked for a restore
  let busy = null; // the one heavy job that runs now

  const reply = async (fn) => {
    try {
      return { ok: true, ...(await fn()) };
    } catch (e) {
      if (e instanceof BedrockError) return { ok: false, code: e.code, message: e.message };
      logLine('[BEDROCK] ' + String((e && e.message) || e).slice(0, 300));
      return { ok: false, code: 'UNKNOWN', message: playerMessage(classify(e, 'UNKNOWN')) };
    }
  };
  /** One heavy job at a time; the page hears when it starts, how far it is, and when it ends. */
  const job = async (name, fn) => {
    if (busy) throw new BedrockError('BUSY', 'Another Bedrock job is still running.');
    busy = name; // taken before anything is awaited, so a second call at the same moment is refused
    try { await bedrock.mustBeClosed(); } catch (e) { busy = null; throw e; } // the game is checked before the page is told a job started
    send('bedrock:progress', { job: name, phase: 'start', done: 0, total: 0 });
    try {
      return await fn((m) => send('bedrock:progress', { job: name, phase: m.phase || name, done: m.done, total: m.total }));
    } finally {
      busy = null;
      send('bedrock:progress', { job: name, phase: 'end', done: 0, total: 0 });
    }
  };
  const pick = async (title, filters, multi) => {
    const forced = answer();
    if (forced) return Array.isArray(forced) ? forced : [forced];
    const r = await dialog.showOpenDialog(getWin(), { title: text(title), properties: multi ? ['openFile', 'multiSelections'] : ['openFile'], filters: filters.map((f) => ({ ...f, name: text(f.name) })) });
    return r.canceled ? [] : r.filePaths;
  };
  const absFiles = (paths) => {
    if (!Array.isArray(paths) || paths.length > 50 || !paths.every((p) => typeof p === 'string' && path.isAbsolute(p) && !p.startsWith('\\'))) throw new BedrockError('BAD_PATHS', 'Those files could not be used.');
    return paths;
  };
  const view = (info, running) => ({
    installed: info.installed, layout: info.layout, version: info.version, running: running === true,
    profiles: info.profiles.map((p) => ({ id: p.id, label: p.label, shared: p.shared })),
  });
  const profileFolder = (profileId) => bedrock.profile(String(profileId)).root;
  const packsView = (profile) => bedrock.listPacks(profile).map((p) => ({ kind: p.kind, folder: p.folder, name: p.name, version: p.version.join('.'), icon: p.icon, broken: !!p.error }));
  const worldsReply = async (profile) => ({
    worlds: (await bedrock.listWorlds(profile)).map((w) => ({ folder: w.folder, name: w.name, lastPlayed: w.lastPlayed, size: w.size, icon: w.icon, openedWith: w.openedWith.slice(0, 3).join('.') })),
    backups: bedrock.listBackups(profile).map((b) => ({ fileName: b.fileName, folder: b.folder, name: b.name, time: b.time, size: b.size })),
  });

  handle('bedrock:state', () => reply(async () => {
    const info = await bedrock.detect();
    purgeRemoved(removedDir);
    const running = info.installed ? await bedrock.running() : false;
    if (running === false) bedrock.sweep();
    return { bedrock: view(info, running), busy };
  }));
  handle('bedrock:running', () => reply(async () => ({ running: (await bedrock.running()) === true, busy })));
  handle('bedrock:launch', () => reply(async () => { await bedrock.launch(); return {}; }));

  // ----- packs -----
  handle('bedrock:packs', ({ profile } = {}) => reply(async () => ({ packs: packsView(profile) })));
  handle('bedrock:packPick', () => pick('Add packs', [{ name: 'Bedrock packs (.mcpack, .mcaddon, .zip)', extensions: ['mcpack', 'mcaddon', 'zip'] }], true));
  handle('bedrock:packInspect', ({ profile, paths } = {}) => reply(async () => {
    const candidates = bedrock.inspectPacks(profile, absFiles(paths));
    const token = crypto.randomUUID();
    pending = { token, kind: 'packs', profile: String(profile), items: candidates };
    return { token, candidates: candidates.map((c) => ({ id: c.id, fileName: c.fileName, name: c.name, version: c.version, kind: c.kind, icon: c.icon, issues: c.issues, blocked: c.blocked, ask: c.ask })) };
  }));
  handle('bedrock:packAdd', ({ profile, token, ids } = {}) => reply(async () => {
    if (!pending || pending.kind !== 'packs' || pending.token !== token || pending.profile !== String(profile)) throw new BedrockError('STALE', 'Pick the files again.');
    const items = pending.items;
    pending = null;
    const r = await job('packs', (onProgress) => bedrock.addPacks(profile, items, (ids || []).map(Number), onProgress));
    return { ...r, packs: packsView(profile) };
  }));
  handle('bedrock:packRemove', ({ profile, kind, folder } = {}) => reply(async () => { await bedrock.removePack(profile, String(kind), String(folder)); return {}; }));
  handle('bedrock:packOpen', ({ profile, kind } = {}) => reply(async () => {
    const dir = path.join(profileFolder(profile), kind && DIRS[kind] ? DIRS[kind] : '');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return {};
  }));

  // ----- worlds -----
  handle('bedrock:worlds', ({ profile } = {}) => reply(async () => worldsReply(profile)));
  handle('bedrock:worldBackup', ({ profile, folder } = {}) => reply(async () => {
    const f = await job('backup', (onProgress) => bedrock.backupWorld(profile, String(folder), onProgress));
    return { file: path.basename(f), ...(await worldsReply(profile)) };
  }));
  handle('bedrock:worldExport', ({ profile, folder } = {}) => reply(async () => {
    const w = (await bedrock.listWorlds(profile)).find((x) => x.folder === String(folder));
    if (!w) throw new BedrockError('MISSING', 'That world is not there any more.');
    const forced = answer();
    const r = forced ? { canceled: false, filePath: forced } : await dialog.showSaveDialog(getWin(), { title: text('Export world'), defaultPath: w.name.replace(/[^A-Za-z0-9._ -]/g, '_') + '.mcworld', filters: [{ name: text('Minecraft world (.mcworld)'), extensions: ['mcworld'] }] });
    if (r.canceled || !r.filePath) return { cancelled: true };
    await job('export', (onProgress) => bedrock.exportWorld(profile, w.folder, r.filePath, onProgress));
    return { path: r.filePath };
  }));
  handle('bedrock:worldImportPick', ({ profile } = {}) => reply(async () => {
    const files = await pick('Add a world', [{ name: 'Minecraft world (.mcworld, .zip)', extensions: ['mcworld', 'zip'] }], false);
    if (!files.length) return { cancelled: true };
    const info = await bedrock.inspectWorld(profile, absFiles(files)[0]);
    const token = crypto.randomUUID();
    pending = { token, kind: 'world', profile: String(profile), items: [info] };
    return { token, world: { fileName: info.fileName, name: info.name, icon: info.icon, issues: info.issues, blocked: info.blocked, ask: info.issues.some((i) => i.level === 'ask') } };
  }));
  handle('bedrock:worldImport', ({ profile, token } = {}) => reply(async () => {
    if (!pending || pending.kind !== 'world' || pending.token !== token || pending.profile !== String(profile)) throw new BedrockError('STALE', 'Pick the file again.');
    const info = pending.items[0];
    pending = null;
    const r = await job('import', (onProgress) => bedrock.importWorld(profile, info.file, onProgress));
    return { ...r, ...(await worldsReply(profile)) };
  }));
  handle('bedrock:worldPickRestore', ({ profile } = {}) => reply(async () => {
    const files = await pick('Restore from a file', [{ name: 'Minecraft world (.mcworld, .zip)', extensions: ['mcworld', 'zip'] }], false);
    if (!files.length) return { cancelled: true };
    const info = await bedrock.inspectWorld(profile, absFiles(files)[0]);
    if (info.blocked) throw new BedrockError('BLOCKED', info.issues[0].text);
    const token = crypto.randomUUID();
    picks.clear();
    picks.set(token, info.file);
    return { token, name: info.name, fileName: info.fileName, issues: info.issues };
  }));
  handle('bedrock:worldRestore', ({ profile, folder, backup, token } = {}) => reply(async () => {
    let file;
    if (token) file = picks.get(String(token));
    else file = (bedrock.listBackups(profile).find((b) => b.fileName === String(backup)) || {}).file;
    if (!file) throw new BedrockError('MISSING', 'That backup is not there any more.');
    const r = await job('restore', (onProgress) => bedrock.restoreWorld(profile, file, String(folder), onProgress));
    picks.clear();
    return { safety: r.safety ? path.basename(r.safety) : '', ...(await worldsReply(profile)) };
  }));
  handle('bedrock:worldOpen', ({ profile, what } = {}) => reply(async () => {
    const dir = what === 'backups' ? path.join(backupRoot, bedrock.profile(profile).id) : path.join(profileFolder(profile), 'minecraftWorlds');
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return {};
  }));
}

module.exports = { registerBedrock };
