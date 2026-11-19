'use strict';
// The launcher only ever installs the public Azure Client. This is the same check as the mod repo's own jar check: a
// jar with any file that is not part of the public edition is refused before it reaches the mods folder.
// Banned files are listed by their SHA-256 only.
const crypto = require('node:crypto');
const fs = require('node:fs');
const { unzipSync } = require('fflate');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Exact file names that never belong in the public jar (by hash).
const BANNED_NAME_HASHES = new Set([
  '61bf0a374a394a93e0d12bef13c93ee968ec0f88c9a8722d22788ba07078a3cb',
  'd99e4add9758bf4512d753d469b9fd15d42ed6b879fd72452d2a65b5e12c002d',
  '5e119e926f3fe79c52a6c582e732bd403de56a18c45b32038c02d675b4d5c927',
  'c523af42095219ef61dcd4ad2bec4386498623299ac725d67cf5fd0ebc5d58b4',
  '97bcfa9e3c9d3cadf4ead167e35566db2209097f20b54d241138f0dea566790d',
  '704c1c8a5ee4c5fb3a165e1e64ef4287bf3c9d8ff415fda0ed27cb578620185e',
  'd09c2fad8dcc4abd6b9f80e06cb987864f70699914325ac5a88b320caf392089',
]);
// Folders that never belong in the public jar (by hash of the folder path, ending in "/").
const BANNED_DIR_HASHES = new Set(['1ad0a2472df23792595d5b5bcfe411834d076deaae80f5f340d7db3d852a41d9']);
// Words that never appear in any file of the public jar (by hash of the lower-case word).
const BANNED_WORD_HASHES = new Set(['2ad8c3004ffd703d45c1bd8c3e83cb6fc602b86bf20a56522c3107a0ebb50e6a']);

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
const MAX_DEPTH = 3;

function bannedByHash(name) {
  if (BANNED_NAME_HASHES.has(sha(name))) return true;
  for (let i = name.indexOf('/'); i !== -1; i = name.indexOf('/', i + 1)) {
    if (BANNED_DIR_HASHES.has(sha(name.slice(0, i + 1)))) return true;
  }
  return false;
}

/** True if the text holds a banned word (letters only, 5 to 16 long, compared by hash). */
function hasBannedWord(text, seen) {
  const re = /[a-z]{5,16}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const w = m[0];
    if (seen.has(w)) continue;
    seen.add(w);
    if (BANNED_WORD_HASHES.has(sha(w))) return true;
  }
  return false;
}

function checkSound(name, data, where) {
  const want = OWN_SOUNDS.get(name);
  if (!want) return 'sound not on the own-sounds list: ' + where + name;
  if (crypto.createHash('sha256').update(data).digest('hex') !== want) return 'sound changed since it was listed: ' + where + name;
  return null;
}

/** Checks every file of an opened zip; archives inside (.zip, .mrpack, .jar) are opened and checked the same way. */
function checkEntries(files, where, depth, problems, seen) {
  for (const [name, data] of Object.entries(files)) {
    if (bannedByHash(name) || BANNED_NAMES.has(name) || BANNED_PREFIXES.some((p) => name.startsWith(p))) problems.push('banned file: ' + where + name);
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
    if (hasBannedWord(text, seen)) problems.push('banned text in: ' + where + name);
    if (text.includes('lrclib')) problems.push("text 'lrclib' (the lyrics service) in: " + where + name);
  }
}

/** Returns a list of problems (empty = this is a clean public jar). */
function checkLegitJar(jarPath) {
  const problems = [];
  let files;
  try {
    files = unzipSync(new Uint8Array(fs.readFileSync(jarPath)));
  } catch (e) {
    return ['not a readable jar: ' + e.message];
  }
  checkEntries(files, '', 0, problems, new Set());
  const metaRaw = files['fabric.mod.json'];
  if (!metaRaw) {
    problems.push('no fabric.mod.json');
  } else {
    const meta = JSON.parse(Buffer.from(metaRaw).toString('utf8'));
    if (meta.id !== 'aurora') problems.push('mod id is ' + JSON.stringify(meta.id) + ', expected "aurora"');
    if (meta.jars && meta.jars.length) problems.push('fabric.mod.json lists nested jars');
    for (const m of meta.mixins || []) {
      const cfg = typeof m === 'string' ? m : m && m.config;
      if (!ALLOWED_MIXINS.has(String(cfg))) problems.push('fabric.mod.json lists a mixin config that is not allowed: ' + cfg);
    }
  }
  return problems;
}

module.exports = { checkLegitJar, OWN_SOUNDS };
