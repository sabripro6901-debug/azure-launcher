'use strict';
// A signed-in account that was checked to own Minecraft Java Edition. By rule only auth.js calls makeAccount (a test
// checks that no other file in src/ does); the token lives in a private field. launch() accepts nothing else.
const KEY = Symbol('verified-account');

class MinecraftAccount {
  #accessToken;
  #player;

  constructor(key, { accessToken, name, uuid, xuid }) {
    if (key !== KEY) throw new Error('A MinecraftAccount can only be made by the sign-in code');
    this.#accessToken = accessToken;
    this.#player = Object.freeze({ name, uuid, xuid: xuid || '', accessToken, userType: 'msa' });
  }

  get name() { return this.#player.name; }
  get uuid() { return this.#player.uuid; }

  /** What the game needs on its command line (includes the token: pass it to the process, never to a log). */
  player() { return this.#player; }

  static isVerified(x) { return #accessToken in Object(x); }

  toJSON() { return { name: this.#player.name, uuid: this.#player.uuid }; } // no token in any JSON dump
  toString() { return 'MinecraftAccount(' + this.#player.name + ')'; }
}

function isVerifiedAccount(x) {
  return typeof x === 'object' && x !== null && MinecraftAccount.isVerified(x);
}

/** For auth.js only. */
function makeAccount(data) {
  return new MinecraftAccount(KEY, data);
}

module.exports = { isVerifiedAccount, makeAccount };
