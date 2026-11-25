'use strict';
// The launcher only ever installs the public Azure Client. This is the same check as the mod repo's own jar check: a
// jar with any file that is not part of the public edition is refused before it reaches the mods folder.
// It knows only the folders and root files of the public jar (guard-allow.json,
// written from a checked public jar by the mod repo's tools/sync_launcher_guard.py) and refuses any entry outside them.
const crypto = require('node:crypto');
const fs = require('node:fs');
const { unzipSync } = require('fflate');

const path = require('node:path');

// What a public jar is made of: its folders and its files at the top level. Anything else is refused.
const ALLOW = JSON.parse(fs.readFileSync(path.join(__dirname, 'guard-allow.json'), 'utf8'));
const ALLOWED_DIRS = new Set(ALLOW.dirs);
const ALLOWED_ROOT = new Set(ALLOW.root);

/** True if this entry of the jar itself (not of an archive inside it) is outside the public jar's folders. */
function notAllowed(name) {
  const i = name.endsWith('/') ? name.length - 1 : name.lastIndexOf('/') + 0;
  if (name.endsWith('/')) return !ALLOWED_DIRS.has(name);
  return i < 0 ? !ALLOWED_ROOT.has(name) : !ALLOWED_DIRS.has(name.slice(0, i + 1));
}

// Lyrics (and everything that contacts the lyrics service) is not in the public edition (licensing not clear yet).
// The Music Player (MusicHud, NowPlaying, CoverArt) is allowed: it only reads the PC's now-playing session.
const BANNED_NAMES = new Set([
  'com/aurora/client/module/LyricsModules.class',
  'com/aurora/client/module/hud/LyricsHud.class',
  'com/aurora/client/gui/LyricsScreen.class',
]);
const BANNED_PREFIXES = ['META-INF/jars/', 'com/aurora/client/lyrics/LrcLib', 'com/aurora/client/lyrics/Lyrics', 'com/aurora/client/lyrics/LyricLook',
  'com/aurora/client/lyrics/SkyLyrics', 'com/aurora/client/lyrics/SyncClock', 'assets/aurora/lyrics/', 'assets/aurora/font/lyrics'];
// The only mixin configs the public jar may list.
const ALLOWED_MIXINS = new Set(['aurora.mixins.json']);
// Our own sounds (made from scratch), by exact name and SHA-256. Any other .ogg is refused: no Minecraft (Mojang)
// audio is shipped (AUDIT M1, same list as the mod repo's tools/check_legit_jar.py OWN_SOUNDS).
const OWN_SOUNDS = new Map([
  ['assets/aurora/sounds/white_hole_beat.ogg', 'dcc72b706d1e42e2e40e89c8da57969e57f6792910ddaea3ff51f284c0851298'],
]);
const ARCHIVE = /\.(zip|mrpack|jar)$/i;
const MAX_JAR = 200 * 1024 * 1024;
const MAX_ENTRIES = 50000;
const MAX_ENTRY = 64 * 1024 * 1024; // unpacked size of one file
const MAX_DEPTH = 3;

function checkSound(name, data, where) {
  const want = OWN_SOUNDS.get(name);
  if (!want) return 'sound not on the own-sounds list: ' + where + name;
  if (crypto.createHash('sha256').update(data).digest('hex') !== want) return 'sound changed since it was listed: ' + where + name;
  return null;
}

/** Checks every file of an opened zip; archives inside (.zip, .mrpack, .jar) are opened and checked the same way. */
function checkEntries(files, where, depth, problems, seen) {
  for (const [name, data] of Object.entries(files)) {
    if (BANNED_NAMES.has(name) || BANNED_PREFIXES.some((p) => name.startsWith(p))) problems.push('banned file: ' + where + name);
    if (depth === 0 && notAllowed(name)) problems.push('not part of the public edition: ' + name);
    if (name.endsWith('/')) continue;
    if (/\.ogg$/i.test(name)) {
      const bad = checkSound(name, data, where);
      if (bad) problems.push(bad);
    }
    if (ARCHIVE.test(name)) {
      if (depth >= MAX_DEPTH) { problems.push('archives nested too deep: ' + where + name); continue; }
      let inner;
      try { inner = unzipSync(data); } catch { problems.push('unreadable archive inside: ' + where + name); continue; }
      checkEntries(inner, where + name + '!/', depth + 1, problems, seen);
      continue;
    }
    const text = Buffer.from(data).toString('latin1').toLowerCase();
    if (text.includes('lrclib')) problems.push("text 'lrclib' (the lyrics service) in: " + where + name);
  }
}

/** Returns a list of problems (empty = this is a clean public jar). */
function checkLegitJar(jarPath) {
  const problems = [];
  let files;
  try {
    // the Azure jar is a few MB: anything much bigger, or with a huge number of files, is not ours (AUDIT L10)
    if (fs.statSync(jarPath).size > MAX_JAR) return ['jar is too large to be the Azure Client'];
    let count = 0;
    let huge = null;
    files = unzipSync(new Uint8Array(fs.readFileSync(jarPath)), {
      filter: (f) => {
        if (f.originalSize > MAX_ENTRY) { huge = f.name; return false; }
        return ++count <= MAX_ENTRIES;
      },
    });
    if (huge) return ['a file in the jar is too large to be part of the Azure Client: ' + huge];
    if (count > MAX_ENTRIES) return ['jar has too many files to be the Azure Client'];
  } catch (e) {
    return ['not a readable jar: ' + e.message];
  }
  checkEntries(files, '', 0, problems, new Set());
  const metaRaw = files['fabric.mod.json'];
  if (!metaRaw) {
    problems.push('no fabric.mod.json');
  } else {
    let meta;
    try { meta = JSON.parse(Buffer.from(metaRaw).toString('utf8')); } catch { meta = null; }
    // a damaged fabric.mod.json is a refused jar, not a crash of the check (AUDIT L2)
    if (!meta || typeof meta !== 'object') { problems.push('fabric.mod.json is not valid JSON'); return problems; }
    if (meta.id !== 'aurora') problems.push('mod id is ' + JSON.stringify(meta.id) + ', expected "aurora"');
    if (meta.jars && meta.jars.length) problems.push('fabric.mod.json lists nested jars');
    for (const m of Array.isArray(meta.mixins) ? meta.mixins : []) {
      const cfg = typeof m === 'string' ? m : m && m.config;
      if (!ALLOWED_MIXINS.has(String(cfg))) problems.push('fabric.mod.json lists a mixin config that is not allowed: ' + cfg);
    }
  }
  return problems;
}

module.exports = { checkLegitJar, OWN_SOUNDS };
