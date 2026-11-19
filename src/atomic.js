'use strict';
// Saving a file so a crash, power cut or full disk mid-write never leaves it half written (AUDIT H2): the data goes
// to a temporary file next to it, is flushed to disk, and only then replaces the old file in one step.
const fs = require('node:fs');
const path = require('node:path');

let n = 0;

function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + (n++) + '.tmp';
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Windows: a virus scanner or the indexer can hold the old file for a moment; try again briefly.
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (e) {
        if (i >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (i + 1));
      }
    }
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

const writeJsonAtomic = (file, value) => writeFileAtomic(file, JSON.stringify(value, null, 2));

/** A damaged file is kept as <file>.broken-<time> instead of being overwritten (moved, or copied if it can't be moved). */
function setAsideBroken(file) {
  if (!fs.existsSync(file)) return null;
  const to = file + '.broken-' + new Date().toISOString().replace(/[:.]/g, '-');
  try { fs.renameSync(file, to); return to; } catch { /* locked: keep a copy instead */ }
  try { fs.copyFileSync(file, to); return to; } catch (e) {
    console.warn('[azure] could not keep a copy of ' + file + ': ' + e.message);
    return null;
  }
}

/**
 * Reads a JSON file of the launcher's own data. state: 'missing' (first run), 'ok', 'broken' (not JSON, or not the
 * expected shape: kept aside as <file>.broken-<time>), or 'unreadable' (still locked by another program, such as a
 * virus scanner, after a few tries: left exactly as it is). Only real damage is set aside, never a passing lock.
 */
function readJsonSafe(file, isValid = () => true) {
  for (let i = 0; ; i++) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return { state: 'missing', value: null };
      if (i < 5 && ['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (i + 1));
        continue;
      }
      return { state: 'unreadable', value: null, error: e };
    }
    let v;
    try { v = JSON.parse(text); } catch { v = undefined; }
    if (v !== undefined && isValid(v)) return { state: 'ok', value: v };
    return { state: 'broken', value: null, keptAs: setAsideBroken(file) };
  }
}

module.exports = { writeFileAtomic, writeJsonAtomic, setAsideBroken, readJsonSafe };
