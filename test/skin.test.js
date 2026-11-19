'use strict';
// AUDIT L8: the skin download only talks to Mojang's own hosts and stays small.
const test = require('node:test');
const assert = require('node:assert');
const { fetchSkinPng } = require('../src/skin');

const UUID = '0123456789abcdef0123456789abcdef';
function mojang(skinUrl, png = Buffer.from('PNG')) {
  const asked = [];
  const value = Buffer.from(JSON.stringify({ textures: skinUrl ? { SKIN: { url: skinUrl } } : {} })).toString('base64');
  const fetchFn = async (url) => {
    asked.push(url);
    if (url.startsWith('https://sessionserver.mojang.com/')) return { ok: true, json: async () => ({ properties: [{ name: 'textures', value }] }) };
    return { ok: true, arrayBuffer: async () => png };
  };
  return { asked, fetchFn };
}

test('a skin from textures.minecraft.net is fetched', async () => {
  const m = mojang('https://textures.minecraft.net/texture/abc');
  assert.deepStrictEqual(await fetchSkinPng(UUID, m.fetchFn), Buffer.from('PNG'));
  assert.strictEqual(m.asked.length, 2);
});

test('nothing is fetched for a bad UUID; a texture URL on another host or over http is refused', async () => {
  const m = mojang('https://textures.minecraft.net/texture/abc');
  assert.strictEqual(await fetchSkinPng('../../etc', m.fetchFn), null);
  assert.deepStrictEqual(m.asked, []);
  for (const bad of ['https://evil.example/skin.png', 'http://textures.minecraft.net/texture/abc', 'https://minecraft.net.evil.example/x']) {
    const b = mojang(bad);
    assert.strictEqual(await fetchSkinPng(UUID, b.fetchFn), null, bad);
    assert.strictEqual(b.asked.length, 1, 'only the session server was asked for ' + bad);
  }
});

test('no custom skin, or a skin over 200 KB, gives null', async () => {
  assert.strictEqual(await fetchSkinPng(UUID, mojang(null).fetchFn), null);
  assert.strictEqual(await fetchSkinPng(UUID, mojang('https://textures.minecraft.net/t', Buffer.alloc(201 * 1024)).fetchFn), null);
});
