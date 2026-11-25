'use strict';
// The only door between the page and the launcher: a small, fixed set of calls. The page gets no Node, no Electron
// objects and no generic IPC.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel, cb) => {
  const handler = (_event, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('azure', {
  state: () => ipcRenderer.invoke('app:state'),
  launch: (opts) => ipcRenderer.invoke('launch:start', { skipCheck: !!(opts && opts.skipCheck) }),
  modcheck: {
    report: (session) => ipcRenderer.invoke('modcheck:report', String(session || '')),
    fix: (session, file, index) => ipcRenderer.invoke('modcheck:fix', { session: String(session), file: String(file), index: Number(index) }),
    fixAll: (session) => ipcRenderer.invoke('modcheck:fixAll', String(session)),
    undo: (session) => ipcRenderer.invoke('modcheck:undo', String(session)),
  },
  stopGame: () => ipcRenderer.invoke('launch:stop'),
  versions: { list: (opts) => ipcRenderer.invoke('versions:list', opts) },
  modpack: {
    install: (projectId, versionId, name) => ipcRenderer.invoke('modpack:install', { projectId: String(projectId), versionId: versionId ? String(versionId) : undefined, name: name ? String(name) : undefined }),
  },
  mrpack: {
    pick: () => ipcRenderer.invoke('mrpack:pick'),
    install: (token, name) => ipcRenderer.invoke('mrpack:install', { token: String(token), name: String(name) }),
    exportPack: (id) => ipcRenderer.invoke('mrpack:export', String(id)),
  },
  instances: {
    create: (spec) => ipcRenderer.invoke('instances:create', spec),
    update: (id, patch) => ipcRenderer.invoke('instances:update', String(id), patch),
    duplicate: (id) => ipcRenderer.invoke('instances:duplicate', String(id)),
    remove: (id) => ipcRenderer.invoke('instances:delete', String(id)),
    select: (id) => ipcRenderer.invoke('instances:select', String(id)),
    openFolder: (id) => ipcRenderer.invoke('instances:openFolder', String(id)),
    openSub: (id, sub) => ipcRenderer.invoke('instances:openSub', String(id), String(sub)),
    pickIcon: (id) => ipcRenderer.invoke('instances:pickIcon', String(id)),
    resetIcon: (id) => ipcRenderer.invoke('instances:resetIcon', String(id)),
    worlds: (id) => ipcRenderer.invoke('instances:worlds', String(id)),
    openWorld: (id, name) => ipcRenderer.invoke('instances:openWorld', String(id), String(name)),
    log: (id) => ipcRenderer.invoke('instances:log', String(id)),
    onChanged: (cb) => on('instances:changed', cb),
  },
  onLaunch: (cb) => on('launch:event', cb),
  update: {
    state: () => ipcRenderer.invoke('update:state'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    onEvent: (cb) => on('update:event', cb),
  },
  accounts: {
    list: () => ipcRenderer.invoke('accounts:list'),
    add: () => ipcRenderer.invoke('accounts:add'),
    cancel: () => ipcRenderer.invoke('accounts:cancel'),
    select: (id) => ipcRenderer.invoke('accounts:select', String(id)),
    remove: (id) => ipcRenderer.invoke('accounts:remove', String(id)),
    head: (uuid) => ipcRenderer.invoke('accounts:head', String(uuid)),
    onCode: (cb) => on('accounts:code', cb),
    onResult: (cb) => on('accounts:result', cb),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    chooseFolder: () => ipcRenderer.invoke('settings:chooseFolder'),
    openFolder: () => ipcRenderer.invoke('settings:openFolder'),
  },
  content: {
    search: (q) => ipcRenderer.invoke('content:search', q),
    categories: (kind) => ipcRenderer.invoke('content:categories', String(kind)),
    list: () => ipcRenderer.invoke('content:list'),
    install: (kind, projectId, versionId) => ipcRenderer.invoke('content:install', { kind: String(kind), projectId: String(projectId), versionId: versionId ? String(versionId) : undefined }),
    versions: (kind, projectId, all) => ipcRenderer.invoke('content:versions', { kind: String(kind), projectId: String(projectId), all: !!all }),
    toggle: (kind, base) => ipcRenderer.invoke('content:toggle', { kind: String(kind), base: String(base) }),
    remove: (kind, base) => ipcRenderer.invoke('content:remove', { kind: String(kind), base: String(base) }),
    check: () => ipcRenderer.invoke('content:check'),
    reveal: (kind, file) => ipcRenderer.invoke('content:reveal', { kind: String(kind), file: String(file) }),
    unqueue: (id) => ipcRenderer.invoke('content:unqueue', String(id)),
    update: (kind, base) => ipcRenderer.invoke('content:update', { kind: String(kind), base: String(base) }),
    updateAll: () => ipcRenderer.invoke('content:update', { all: true }),
    onEvent: (cb) => on('content:event', cb),
    pick: (mode) => ipcRenderer.invoke('content:pick', String(mode)),
    inspect: (paths) => ipcRenderer.invoke('content:inspect', Array.from(paths).map(String)),
    add: (token, ids) => ipcRenderer.invoke('content:add', { token: String(token), ids: Array.from(ids).map(Number) }),
    // the real path of files dropped on the page (the page itself cannot see paths)
    pathsFor: (files) => Array.from(files).map((f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } }).filter(Boolean),
  },
  bedrock: {
    state: () => ipcRenderer.invoke('bedrock:state'),
    running: () => ipcRenderer.invoke('bedrock:running'),
    launch: () => ipcRenderer.invoke('bedrock:launch'),
    packs: (profile) => ipcRenderer.invoke('bedrock:packs', { profile: String(profile) }),
    packPick: () => ipcRenderer.invoke('bedrock:packPick'),
    packInspect: (profile, paths) => ipcRenderer.invoke('bedrock:packInspect', { profile: String(profile), paths: Array.from(paths).map(String) }),
    packAdd: (profile, token, ids) => ipcRenderer.invoke('bedrock:packAdd', { profile: String(profile), token: String(token), ids: Array.from(ids).map(Number) }),
    packRemove: (profile, kind, folder) => ipcRenderer.invoke('bedrock:packRemove', { profile: String(profile), kind: String(kind), folder: String(folder) }),
    packOpen: (profile, kind) => ipcRenderer.invoke('bedrock:packOpen', { profile: String(profile), kind: kind ? String(kind) : '' }),
    worlds: (profile) => ipcRenderer.invoke('bedrock:worlds', { profile: String(profile) }),
    worldBackup: (profile, folder) => ipcRenderer.invoke('bedrock:worldBackup', { profile: String(profile), folder: String(folder) }),
    worldExport: (profile, folder) => ipcRenderer.invoke('bedrock:worldExport', { profile: String(profile), folder: String(folder) }),
    worldImportPick: (profile) => ipcRenderer.invoke('bedrock:worldImportPick', { profile: String(profile) }),
    worldImport: (profile, token) => ipcRenderer.invoke('bedrock:worldImport', { profile: String(profile), token: String(token) }),
    worldPickRestore: (profile) => ipcRenderer.invoke('bedrock:worldPickRestore', { profile: String(profile) }),
    worldRestore: (profile, folder, spec) => ipcRenderer.invoke('bedrock:worldRestore', { profile: String(profile), folder: String(folder), backup: spec && spec.backup ? String(spec.backup) : '', token: spec && spec.token ? String(spec.token) : '' }),
    onProgress: (cb) => on('bedrock:progress', cb),
    worldOpen: (profile, what) => ipcRenderer.invoke('bedrock:worldOpen', { profile: String(profile), what: String(what || '') }),
  },
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', String(url)),
  openLicense: (which) => ipcRenderer.invoke('app:openLicense', String(which)),
  copy: (text) => ipcRenderer.invoke('app:copy', String(text)),
});
