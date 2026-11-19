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

/** A file that exists but can't be read as JSON is kept as <file>.broken-<time> instead of being overwritten. */
function setAsideBroken(file) {
  if (!fs.existsSync(file)) return null;
  const to = file + '.broken-' + new Date().toISOString().replace(/[:.]/g, '-');
  try { fs.renameSync(file, to); return to; } catch { return null; }
}

module.exports = { writeFileAtomic, writeJsonAtomic, setAsideBroken };
