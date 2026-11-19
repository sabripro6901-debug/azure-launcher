'use strict';
// A player's skin from Mojang's own servers (session server, then textures.minecraft.net), for the head in the sidebar.
// The launcher's window only ever receives a small data: image made from it, never a remote URL.
const { userAgent } = require('./version');
const { fetchWithTimeout } = require('./net');

const SESSION = 'https://sessionserver.mojang.com/session/minecraft/profile/';
const MAX_BYTES = 200 * 1024;

/** The skin PNG (a Buffer) for a Minecraft UUID, or null if the player has no custom skin or Mojang is unreachable. */
async function fetchSkinPng(uuid, fetchFn = fetchWithTimeout) {
  const id = String(uuid).replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(id)) return null;
  const r = await fetchFn(SESSION + id, { headers: { 'User-Agent': userAgent } });
  if (!r.ok) return null;
  const profile = await r.json();
  const prop = (profile.properties || []).find((p) => p.name === 'textures');
  if (!prop) return null;
  const textures = JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8'));
  const url = textures && textures.textures && textures.textures.SKIN && textures.textures.SKIN.url;
  if (!url) return null;
  const u = new URL(url);
  if (u.protocol !== 'https:' || !/(^|\.)minecraft\.net$/.test(u.hostname)) return null; // only Mojang's texture host
  const png = await fetchFn(u.href, { headers: { 'User-Agent': userAgent } });
  if (!png.ok) return null;
  const buf = Buffer.from(await png.arrayBuffer());
  return buf.length <= MAX_BYTES ? buf : null;
}

module.exports = { fetchSkinPng };
