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
  UNKNOWN: 'Something went wrong.',
};

/** Errors that point to the logs (the page adds an "Open the logs" link under them). */
const WITH_LOGS = new Set(['LAUNCH_FAILED', 'UNKNOWN']);

function pointsToLogs(code) {
  return WITH_LOGS.has(code);
}

function playerMessage(code) {
  return TEXT[code] || TEXT.UNKNOWN;
}

module.exports = { playerMessage, pointsToLogs, TEXT };
