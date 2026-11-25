'use strict';
// Finding Minecraft Bedrock (Windows) and where it keeps its content. Read-only: nothing here changes a file.
//   GDK build (1.21.120 and newer): %APPDATA%\Minecraft Bedrock\Users\<xuid>\games\com.mojang   (and \Users\Shared\...)
//   Older UWP build:                %LOCALAPPDATA%\Packages\Microsoft.MinecraftUWP_8wekyb3d8bbwe\LocalState\games\com.mojang
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const FAMILY = 'Microsoft.MinecraftUWP_8wekyb3d8bbwe';
const GDK_FIRST = [1, 21, 120];

function run(file, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/** The installed package: { version: '1.26.6501.0', family } or null. */
async function queryPackage(exec = run) {
  const out = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$p = Get-AppxPackage -Name Microsoft.MinecraftUWP | Select-Object -First 1; if ($p) { $id = (Get-AppxPackageManifest $p).Package.Applications.Application.Id | Select-Object -First 1; [pscustomobject]@{ Version = [string]$p.Version; PackageFamilyName = $p.PackageFamilyName; AppId = [string]$id } | ConvertTo-Json -Compress }']);
  if (out === null) return { error: true }; // PowerShell blocked or too slow: not the same as "not installed"
  if (!out.trim()) return null;
  try {
    const p = JSON.parse(out);
    if (!p || !/^\d+(\.\d+){1,3}$/.test(String(p.Version))) return null;
    const family = /^[A-Za-z0-9.]+_[a-z0-9]+$/.test(String(p.PackageFamilyName)) ? String(p.PackageFamilyName) : FAMILY;
    const appId = typeof p.AppId === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(p.AppId) ? String(p.AppId) : 'Game'; // the old build used App
    return { version: String(p.Version), family, appId };
  } catch { return { error: true }; }
}

/** The game's version from the package version: 1.21.12011.0 is 1.21.120, 1.26.6501.0 is 1.26.65. */
function gameVersionOf(packageVersion) {
  const p = String(packageVersion || '').split('.').map(Number);
  if (p.length < 3 || p.some((n) => !Number.isInteger(n))) return null;
  return [p[0], p[1], Math.floor(p[2] / 100)];
}

const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };

/** com.mojang folders: [{ id, label, root, shared }]. */
function findProfiles({ appdata, localappdata }) {
  const out = [];
  const users = path.join(appdata || '', 'Minecraft Bedrock', 'Users');
  let ids = [];
  try { ids = fs.readdirSync(users); } catch { /* no GDK folder */ }
  for (const id of ids.sort((a, b) => (a === 'Shared') - (b === 'Shared') || a.localeCompare(b))) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) continue;
    const root = path.join(users, id, 'games', 'com.mojang');
    if (!isDir(root)) continue;
    out.push(id === 'Shared' ? { id: 'shared', label: 'Shared', root, shared: true }
      : { id: 'x' + id, label: 'Xbox user …' + id.slice(-4), root, shared: false });
  }
  const uwp = path.join(localappdata || '', 'Packages', FAMILY, 'LocalState', 'games', 'com.mojang');
  if (isDir(uwp)) out.push({ id: 'uwp', label: 'Windows 10 layout', root: uwp, shared: false });
  return out;
}

/** { installed, layout: 'gdk'|'uwp'|null, version, gameVersion, family, profiles }. */
async function detect({ appdata = process.env.APPDATA, localappdata = process.env.LOCALAPPDATA, exec } = {}) {
  const pkg = await queryPackage(exec);
  const profiles = findProfiles({ appdata, localappdata });
  if (pkg && pkg.error) {
    // could not ask Windows: the folders of the game still prove it is there
    const gdkFolders = profiles.filter((p) => p.id !== 'uwp');
    if (!profiles.length) return { installed: false, layout: null, version: '', gameVersion: null, family: FAMILY, appId: 'Game', profiles: [], unsure: true };
    return { installed: true, layout: gdkFolders.length ? 'gdk' : 'uwp', version: '', gameVersion: null, family: FAMILY, appId: 'Game', profiles: gdkFolders.length ? gdkFolders : profiles };
  }
  if (!pkg) return { installed: false, layout: null, version: '', gameVersion: null, family: FAMILY, appId: 'Game', profiles: [] };
  const gameVersion = gameVersionOf(pkg.version);
  const gdk = gameVersion ? (gameVersion[0] > 1 || gameVersion[1] > 21 || (gameVersion[1] === 21 && gameVersion[2] >= GDK_FIRST[2])) : profiles.some((p) => !p.id.startsWith('uwp'));
  // after the move to the GDK build the old folder is left behind: the game never reads it, so it is not offered
  return { installed: true, layout: gdk ? 'gdk' : 'uwp', version: gameVersion ? gameVersion.join('.') : '', gameVersion, family: pkg.family, appId: pkg.appId, profiles: gdk ? profiles.filter((p) => p.id !== 'uwp') : profiles };
}

/** True when Bedrock is running (its process Minecraft.Windows.exe). null if that could not be found out. */
async function isRunning(exec = run) {
  const out = await exec('tasklist.exe', ['/FI', 'IMAGENAME eq Minecraft.Windows.exe', '/FO', 'CSV', '/NH']);
  if (out === null) return null;
  return /Minecraft\.Windows\.exe/i.test(out);
}

module.exports = { FAMILY, detect, queryPackage, findProfiles, gameVersionOf, isRunning, run };
