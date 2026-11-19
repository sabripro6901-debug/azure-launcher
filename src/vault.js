'use strict';
// Encrypted storage for tokens and the account list. In the app the cipher is Electron's safeStorage (Windows DPAPI,
// macOS Keychain, Linux libsecret/kwallet): the files on disk are useless on another PC or another user.
// It fails closed: if the system cannot encrypt, nothing is written (there is no plain-text fallback).
const fs = require('node:fs');
const path = require('node:path');

/** Wraps Electron's safeStorage (main process, after app.whenReady) as { isAvailable, encrypt, decrypt }. */
function electronCipher(safeStorage) {
  return {
    isAvailable() {
      if (!safeStorage.isEncryptionAvailable()) return false;
      // Linux without a keyring falls back to a hard-coded password ("basic_text"): that is not encryption.
      if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
        return safeStorage.getSelectedStorageBackend() !== 'basic_text';
      }
      return true;
    },
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (buf) => safeStorage.decryptString(buf),
  };
}

class Vault {
  constructor(dir, cipher) {
    this.dir = dir;
    this.cipher = cipher;
  }

  #file(name) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('Bad vault entry name');
    return path.join(this.dir, name + '.bin');
  }

  #check() {
    if (!this.cipher.isAvailable()) {
      throw new Error('Secure storage is not available on this computer, so accounts cannot be saved. Nothing was written.');
    }
  }

  set(name, value) {
    this.#check();
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.#file(name);
    require('./atomic').writeFileAtomic(file, this.cipher.encrypt(JSON.stringify(value)));
  }

  get(name) {
    const file = this.#file(name);
    if (!fs.existsSync(file)) return undefined;
    this.#check();
    try {
      return JSON.parse(this.cipher.decrypt(fs.readFileSync(file)));
    } catch {
      return undefined; // unreadable (other user or PC, or damaged): treated as signed out
    }
  }

  delete(name) {
    fs.rmSync(this.#file(name), { force: true });
  }
}

module.exports = { Vault, electronCipher };
