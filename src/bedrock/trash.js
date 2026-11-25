'use strict';
// Removed packs and replaced worlds are moved into the launcher's own folder (not deleted) and cleaned out later.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const KEEP_DAYS = 30;

/** Moves p into removedDir under a unique name; the 30 days count from now (a rename keeps the old modified time). */
function moveToRemoved(removedDir, p) {
  fs.mkdirSync(removedDir, { recursive: true });
  const dest = path.join(removedDir, new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(2).toString('hex') + '-' + path.basename(p).replace(/[^A-Za-z0-9 _.=+()-]/g, '_'));
  try { fs.renameSync(p, dest); } catch { fs.cpSync(p, dest, { recursive: true }); fs.rmSync(p, { recursive: true, force: true }); }
  const now = new Date();
  fs.utimesSync(dest, now, now);
  return dest;
}

/** Deletes what has been in removedDir for more than KEEP_DAYS days. */
function purgeRemoved(removedDir, days = KEEP_DAYS) {
  try {
    const old = Date.now() - days * 86400000;
    for (const n of fs.readdirSync(removedDir)) { const f = path.join(removedDir, n); if (fs.statSync(f).mtimeMs < old) fs.rmSync(f, { recursive: true, force: true }); }
  } catch { /* nothing to clean */ }
}

module.exports = { moveToRemoved, purgeRemoved, KEEP_DAYS };
