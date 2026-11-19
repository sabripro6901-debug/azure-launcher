'use strict';
// The launcher only ever installs the public Azure Client. This is the same check as the mod repo's own jar check: a
// jar with any file that is not part of the public edition is refused before it reaches the mods folder.
// Files of other editions are listed by their SHA-256 only, so this file names none of them.
const crypto = require('node:crypto');
const fs = require('node:fs');
const { unzipSync } = require('fflate');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Exact file names that never belong in the public jar (by hash).
const BANNED_NAME_HASHES = new Set([
  '981b33d398d83a8752228ba9970960aa94a9a301bf6cbf06baf89d81d2025c09',
  '83376e9af2746d515bf1e76d8ab88cfd27f521a5bc62f0524497b4a699c2bac9',
  '3254c0dab7f9d99f67c96197c6a923e5a9f49e188686013b68462495959f48a1',
  '68993485c3ebb13c5901993b9af01a8d22e70fc514c1ace7d090f4d0b61359af',
  '5a3705e9d6bfb9a7dc73cd78c10770d96c1534658a210a3fe57881d8f6bcbee3',
  '7ce051f5626134a6fa9c0162adfdc9f55f3cde02c269fcc0c2ed5d6b2cbc501a',
  'c709cf414fc42b6d6c5fde5f0967e3a1468f9b4d6aa3c265c1d8dd413c9f387a',
]);
// Folders that never belong in the public jar (by hash of the folder path, ending in "/").
const BANNED_DIR_HASHES = new Set(['83e1134c71d2de1da2a7a1432bf2378555b419e93af8c6b51140c88c7b2bdd6e']);
// Words that never appear in any file of the public jar (by hash of the lower-case word).
const BANNED_WORD_HASHES = new Set(['9dc462edb656a0d98f5683b09c1d8765a5a6c74ab3d69ca962c48e9689149ba3']);

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
    // the Azure jar is a few MB: anything much bigger, or with a huge number of files, is not ours (AUDIT L10)
    if (fs.statSync(jarPath).size > MAX_JAR) return ['jar is too large to be the Azure Client'];
    let count = 0;
    files = unzipSync(new Uint8Array(fs.readFileSync(jarPath)), { filter: () => ++count <= MAX_ENTRIES });
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
