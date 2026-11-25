'use strict';
// AUDIT M8: French as a second language, following the system language, with a switch in Settings.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { FR, tr } = require('../app/renderer/i18n');
const { TEXT } = require('../app/messages');
const { validate } = require('../src/settings');

const R = (f) => fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', f), 'utf8');
// Texts that are the same in French (names, units, codes).
const SAME = new Set(['Azure Launcher', 'Instances', 'Instance', 'Mods', 'Modpacks', 'Shaders', 'Modrinth', 'Version', 'Actions', 'Contact', 'Azure',
  'Fabric', 'Vanilla', 'Bedrock', 'Minecraft Bedrock', 'Packs', 'Pack', 'Electron', 'Chromium', 'OK', 'Mod', 'Alpha', 'DEV', 'AZURE CLIENT', 'English', 'Français', 'e.g. -XX:+UseZGC', 'mod']);

test('every text and hint in the page has a French version', () => {
  const html = R('index.html');
  const texts = [...html.matchAll(/>([^<>]*[A-Za-z]{2,}[^<>]*)</g)].map((m) => m[1].trim()).filter(Boolean)
    .concat([...html.matchAll(/(?:placeholder|title|aria-label)="([^"]+)"/g)].map((m) => m[1]));
  const missing = texts.filter((t) => tr(t) === t && !SAME.has(t));
  assert.deepStrictEqual(missing, []);
});

test('every player message from app/messages.js has a French version', () => {
  const missing = Object.values(TEXT).filter((t) => tr(t) === t);
  assert.deepStrictEqual(missing, []);
});

test('texts with numbers and names are translated, the names kept as they are', () => {
  const cases = [
    ['Last played 3 days ago', 'Joué il y a 3 jours'],
    ['Search mods on Modrinth', 'Rechercher des mods sur Modrinth'],
    ['No results for “sodium” on Minecraft 1.21.11.', 'Aucun résultat pour « sodium » sur Minecraft 1.21.11.'],
    ['Installed Sodium 0.6.0 (with 1 required mod)', 'Sodium 0.6.0 installé (avec 1 mod requis)'],
    ['Delete “My world”?', 'Supprimer « My world » ?'],
    ['Updated 2 items.', '2 éléments mis à jour'],
    ['Downloading sodium.jar (3/12)', 'Téléchargement de sodium.jar (3/12)'],
    ['Needs fabric-api, which is not installed.', 'Demande fabric-api, qui n’est pas installé.'],
    ['Version 1.2.0 · You have the latest launcher.', 'Version 1.2.0 · Vous avez la dernière version du launcher.'],
    ['Memory: Default (4 GB)  ·  Never played', 'Mémoire : Par défaut (4 Go)  ·  Jamais joué'],
  ];
  for (const [en, fr] of cases) assert.strictEqual(tr(en), fr, en);
  assert.strictEqual(tr('  Play  '), '  Jouer  ', 'spaces around a text are kept');
  assert.strictEqual(tr('My world'), 'My world', 'unknown text (a name) is left alone');
  assert.strictEqual(tr('Play', 'en'), 'Play', 'English shows English');
});

test('the dictionary has no empty or untranslated-by-mistake entries', () => {
  for (const [en, fr] of Object.entries(FR)) {
    assert.ok(typeof fr === 'string' && fr.trim(), en);
    if (fr === en) assert.ok(SAME.has(en), 'same text in French: add it to SAME if that is right: ' + en);
  }
});

test('the language setting: system (default), English or French; anything else is ignored', () => {
  assert.strictEqual(validate({}).language, 'system');
  assert.strictEqual(validate({ language: 'fr' }).language, 'fr');
  assert.strictEqual(validate({ language: 'de' }).language, 'system');
  const html = R('index.html');
  assert.ok(html.indexOf('i18n.js') < html.indexOf('content.js'), 'i18n.js loads before the other scripts');
  assert.match(html, /<select id="set-lang">/);
  assert.match(R('renderer.js'), /saveSettings\(\{ language: \$\('set-lang'\)\.value \}\)/);
  assert.match(R('content.js'), /desc\.dataset\.raw = ''/, "Modrinth descriptions (other people's text) are not translated");
});

test('texts written by the window scripts (whole sentences and labels) have a French version', () => {
  // Every quoted text in the renderer scripts that is a whole label or sentence: starts with a capital letter, has a
  // letter after it, and is not glued to other text (no leading or trailing space). Code-like strings are skipped.
  const lit = /'((?:[^'\\\n]|\\.)*)'/g;
  const missing = new Set();
  for (const f of ['content.js', 'import.js', 'renderer.js', 'instance.js', 'modcheck.js']) {
    for (const m of R(f).matchAll(lit)) {
      const t = m[1].replace(/\\'/g, "'");
      if (!/^[A-Z][a-z]/.test(t) || /^\s|\s$/.test(t)) continue;
      if (/“$/.test(t) || /^Minecraft \d/.test(t) || t === 'No versions found') continue; // the start of a longer text (its pattern is tested above)
      if (/[#=<>{}()[\]]|\.(js|json|png|jar|zip|mrpack|log)\b|^[A-Z][a-zA-Z]+[A-Z]/.test(t)) continue; // code, files, CamelCase
      if (tr(t) === t && !SAME.has(t)) missing.add(t + '  (' + f + ')');
    }
  }
  assert.deepStrictEqual([...missing], []);
});

test('names chosen by players or mod authors are marked never to translate', () => {
  const all = ['content.js', 'import.js', 'renderer.js', 'instance.js', 'modcheck.js'].map(R).join('\n');
  for (const site of ["rawEl('span', 'rail-name', i.name)", "rawEl('h1', '', i.name)", "rawEl('span', 'rtitle', it.name)", "rawEl('span', 'rtitle', w.name)",
    "rawEl('div', 'title', i.name)", "rawEl('div', 'name', a.name)", "rawEl('strong', '', p.name)", "rawEl('span', 'val', inst.name)"]) {
    assert.ok(all.includes(site), site);
  }
  assert.ok(!/el\('[a-z0-9]+', '[^']*', (i|it|w|a|p|inst|c)\.name\)/.test(all.replace(/rawEl\(/g, 'RAW(')), 'a name shown without rawEl');
});
