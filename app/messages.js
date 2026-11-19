'use strict';
// What players read. The technical detail of an error (codes, server answers) goes to the log drawer only.
const TEXT = {
  NOT_CONFIGURED: "Sign-in isn't available yet.",
  APP_NOT_APPROVED: "Microsoft signed you in, but Minecraft hasn't approved Azure Launcher yet, so you can't play with it for now. Nothing is wrong with your account. Please try again later.",
  NO_JAVA_EDITION: "This Microsoft account doesn't own Minecraft: Java Edition.",
  NO_PROFILE: 'Finish setting up your Minecraft profile in the official Minecraft Launcher first, then try again.',
  XBOX_ACCOUNT_REQUIRED: 'This account needs an Xbox profile. Sign in once at xbox.com, then try again.',
  XBOX_RESTRICTED: "Xbox doesn't allow this account to sign in (a child account, or Xbox isn't available in your country).",
  SIGN_IN_REQUIRED: 'Please sign in again.',
  SIGN_IN_CANCELLED: 'Sign-in was cancelled or timed out. Try again.',
  NETWORK: "Can't reach Microsoft or Minecraft. Check your internet connection.",
  LAUNCH_FAILED: "The game couldn't start.",
  SECURE_STORAGE: "Windows couldn't open your saved sign-in on this PC (its secure storage isn't available). Restart the PC and open the launcher again; if it keeps happening, sign in again.",
  DISK_FULL: "There isn't enough free space on the disk. Free up some space (a few GB), then press Play again.",
  FILE_IN_USE: 'A game file is in use by another program (often the game itself, or a virus scanner). Close the game, wait a moment, then press Play again.',
  NO_PERMISSION: "Azure Launcher isn't allowed to write to the game folder. Choose another game folder in Settings, or check the folder's permissions.",
  DOWNLOAD_FAILED: "A download didn't finish. Check your internet connection, then press Play again: what is already downloaded is kept.",
  DOWNLOAD_DAMAGED: 'A downloaded file was damaged and has been thrown away. Press Play again to download it again.',
  SERVER_DOWN: "Mojang's or Fabric's download servers aren't answering right now. Try again in a few minutes.",
  VERSION_UNAVAILABLE: "This Minecraft version (or its Fabric version) can't be downloaded. Pick another version for this instance.",
  UNKNOWN: 'Something went wrong.',
};

/** Errors that point to the logs (the page adds an "Open the logs" link under them). */
const WITH_LOGS = new Set(['LAUNCH_FAILED', 'UNKNOWN', 'VERSION_UNAVAILABLE']);

/** A clear reason for a failed install or start, from the error (AUDIT M7); fallback when nothing matches. */
function classify(e, fallback = 'LAUNCH_FAILED') {
  const code = String((e && e.code) || '');
  const m = String((e && e.message) || e || '');
  if (code === 'ENOSPC' || /ENOSPC|no space left|not enough space/i.test(m)) return 'DISK_FULL';
  if (['EBUSY', 'ETXTBSY'].includes(code) || /EBUSY|resource busy|being used by another process/i.test(m)) return 'FILE_IN_USE';
  if (['EPERM', 'EACCES', 'EROFS'].includes(code) || /EPERM|EACCES|EROFS|operation not permitted|permission denied/i.test(m)) return 'NO_PERMISSION';
  if (/^Wrong sha(1|256|512) for|SHA-256 differs|Bad hash file/i.test(m)) return 'DOWNLOAD_DAMAGED';
  if (/HTTP 5\d\d|HTTP 429/.test(m)) return 'SERVER_DOWN';
  if (/Mojang has no|HTTP 404 for https:\/\/meta\.fabricmc\.net|has no client download/i.test(m)) return 'VERSION_UNAVAILABLE';
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|timeout|stalled|terminated|socket hang up/i.test(m + ' ' + code)) return 'DOWNLOAD_FAILED';
  return fallback;
}

function pointsToLogs(code) {
  return WITH_LOGS.has(code);
}

function playerMessage(code) {
  return TEXT[code] || TEXT.UNKNOWN;
}

module.exports = { playerMessage, pointsToLogs, classify, TEXT };
