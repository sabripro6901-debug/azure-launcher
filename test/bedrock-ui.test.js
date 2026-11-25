'use strict';
// Bedrock tab: French for every fixed text, the page wiring, and the design rules.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { tr } = require('../app/renderer/i18n');

const src = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

// Single-quoted texts of the code that a player can read: start with a capital, contain a space or end like a sentence.
function playerTexts(code) {
  const out = new Set();
  for (const m of code.matchAll(/'((?:[^'\\\n]|\\.)+)'/g)) {
    const t = m[1].replace(/\\'/g, "'");
    if (!/^[A-Z.]/.test(t) || t.length < 3) continue;
    if (!(t.includes(' ') || /[.…?]$/.test(t))) continue;
    if (/^[A-Z_]+$/.test(t) || /^[A-Z][a-z]+\.[a-z]+$/.test(t)) continue;
    out.add(t);
  }
  return out;
}

// Texts that are names, file types or built from parts: checked by the explicit cases below.
const SKIP = new Set(['Xbox user …', 'Windows 10 layout', 'Shared', 'Minecraft Bedrock', 'Refused.', 'No manifest.json.', 'Needs ', '. It may not open.']);

test('every fixed text of the Bedrock tab and its messages has a French version', () => {
  const files = [['app', 'renderer', 'bedrock.js'], ['app', 'bedrock-ipc.js'], ['src', 'bedrock', 'archive.js'], ['src', 'bedrock', 'index.js'],
    ['src', 'bedrock', 'manifest.js'], ['src', 'bedrock', 'packs.js'], ['src', 'bedrock', 'worlds.js']];
  const texts = new Set();
  for (const f of files) for (const t of playerTexts(src(...f))) texts.add(t);
  const dynamic = /^(Needs Minecraft|Already installed|Version |A newer version|Last played on|Refused:|Needs \d|Last played|Saved|Folder|Open|ZIP64|Unexpected|Damaged|Too many|Not a zip|Encrypted|Unsupported)/;
  const missing = [...texts].filter((t) => !SKIP.has(t) && !dynamic.test(t) && tr(t) === t);
  assert.deepStrictEqual(missing, []);
});

test('texts with numbers and names in the Bedrock tab are translated', () => {
  const cases = [
    ['Needs Minecraft 1.99.0 or newer; you have 1.26.65.', 'Demande Minecraft 1.99.0 ou plus récent ; vous avez 1.26.65.'],
    ['Already installed (same version 1.0.0). Adding replaces it.', 'Déjà installé (même version 1.0.0). L’ajouter le remplace.'],
    ['Version 1.0.0 is installed. Adding replaces it with 2.0.0.', 'La version 1.0.0 est installée. L’ajouter la remplace par la 2.0.0.'],
    ['A newer version 3.0.0 is installed. Adding replaces it with the older 2.0.0.', 'Une version plus récente 3.0.0 est installée. L’ajouter la remplace par la plus ancienne 2.0.0.'],
    ['Last played on Minecraft 1.30.0; you have 1.26.65. It may not open.', 'Dernière partie sur Minecraft 1.30.0 ; vous avez 1.26.65. Il peut ne pas s’ouvrir.'],
    ['Refused: it holds files a Bedrock pack never has (a.dll, b.exe).', 'Refusé : il contient des fichiers qu’un pack Bedrock n’a jamais (a.dll, b.exe).'],
    ['Needs 3 other packs that are not installed.', 'Demande 3 autres packs qui ne sont pas installés.'],
    ['12 MB', '12 Mo'], ['1.5 GB', '1,5 Go'],
    ['My Pack: not allowed', 'My Pack : non autorisé'],
  ];
  for (const [en, fr] of cases) assert.strictEqual(tr(en), fr, en);
});

test('the Bedrock page is on the nav, loaded, and every call it makes is in the preload', () => {
  const html = src('app', 'renderer', 'index.html');
  assert.ok(/data-page="bedrock"/.test(html) && /id="page-bedrock"/.test(html) && /src="bedrock\.js"/.test(html));
  const pre = src('app', 'preload.js');
  const calls = [...src('app', 'bedrock-ipc.js').matchAll(/handle\('(bedrock:[A-Za-z]+)'/g)].map((m) => m[1]);
  assert.ok(calls.length >= 15);
  for (const c of calls) assert.ok(pre.includes("'" + c + "'"), c + ' is not in the preload');
});

test('the page never sends a path of its own except the files the player dropped (checked again in the main process)', () => {
  const ipc = src('app', 'bedrock-ipc.js');
  assert.ok(/absFiles/.test(ipc));
  // restore and import work from tokens / backup names, not from page paths
  assert.ok(!/worldRestore:.*path/.test(src('app', 'preload.js')));
});
