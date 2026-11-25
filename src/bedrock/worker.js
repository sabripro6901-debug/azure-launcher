'use strict';
// Runs one heavy Bedrock job (zip, unzip, folder sizes) away from the launcher's main thread and reports progress.
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
const worlds = require('./worlds');
const packs = require('./packs');
const { moveToRemoved } = require('./trash');
const { BedrockError } = require('./archive');

let last = 0;
const progress = (done, total, phase = '') => {
  const now = Date.now();
  if (now - last < 100 && done < total) return; // at most ten updates a second
  last = now;
  parentPort.postMessage({ type: 'progress', done, total, phase });
};

const JOBS = {
  backup: (a) => path.basename(worlds.backup({ root: a.root }, a.folder, a.backupDir, { keep: a.keep, onProgress: (d, t) => progress(d, t) })),
  export: (a) => worlds.exportWorld({ root: a.root }, a.folder, a.dest, { onProgress: (d, t) => progress(d, t) }),
  import: (a) => worlds.importWorld({ root: a.root }, a.file, { onProgress: (d, t) => progress(d, t) }),
  restore: (a) => {
    const r = worlds.restore({ root: a.root }, a.file, a.folder, { backupDir: a.backupDir, keep: a.keep, trash: (p) => moveToRemoved(a.removedDir, p), onProgress: progress });
    return { folder: r.folder, safety: r.safety ? path.basename(r.safety) : '' };
  },
  packs: (a) => packs.add(a.candidates, a.ids, { profile: { root: a.root }, trash: (p) => moveToRemoved(a.removedDir, p), onProgress: (d, t) => progress(d, t) }),
  worlds: (a) => worlds.listWorlds({ root: a.root }),
};

try {
  const result = JOBS[workerData.name](workerData.args);
  parentPort.postMessage({ type: 'done', result });
} catch (e) {
  parentPort.postMessage({ type: 'error', bedrock: e instanceof BedrockError, code: e && e.code, message: String((e && e.message) || e) });
}
