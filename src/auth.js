'use strict';
// Microsoft sign-in for Minecraft Java Edition, with prismarine-auth's device-code flow on OUR Azure app (the client ID
// from config/launcher.config.json; no other launcher's ID is ever used). Steps: Microsoft device code -> Xbox ->
// XSTS -> Minecraft services token -> ownership check (entitlements + profile). Several accounts can be signed in;
// every token is kept in the encrypted Vault and never logged or put in an error message.
const crypto = require('node:crypto');
const { makeAccount } = require('./account');
const { fetchWithTimeout } = require('./net');

const PLACEHOLDER = 'REPLACE_WITH_AZURE_APP_CLIENT_ID';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTHORITY = 'https://login.microsoftonline.com/consumers';
const ENTITLEMENTS = 'https://api.minecraftservices.com/entitlements/license';
const PROFILE = 'https://api.minecraftservices.com/minecraft/profile';
const OWNERSHIP_ITEMS = new Set(['product_minecraft', 'game_minecraft', 'product_game_pass_pc', 'product_game_pass_ultimate']);
const CACHE_IDS = ['msal', 'live', 'sisu', 'xbl', 'bed', 'mca', 'mcs', 'pfb'];

/** Takes tokens out of any text before it is logged or shown. */
function redact(text) {
  return String(text)
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '<token>')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <token>')
    .replace(/XBL3\.0 x=[^\s"']+/g, 'XBL3.0 <token>')
    .replace(/[A-Za-z0-9._~+/=-]{60,}/g, '<token>');
}

class AuthError extends Error {
  constructor(code, message) {
    super(redact(message));
    this.name = 'AuthError';
    this.code = code;
  }
}

/** Turns whatever prismarine-auth / the network threw into an AuthError with a message a player can act on. */
function classify(e) {
  if (e instanceof AuthError) return e;
  const m = String((e && e.message) || e);
  if (/Invalid app registration|AppRegInfo/i.test(m) || (/\b403\b/.test(m) && /login_with_xbox|FORBIDDEN/i.test(m))) {
    return new AuthError('APP_NOT_APPROVED',
      "Microsoft signed you in, but Minecraft's servers rejected this launcher's app ID: the Azure app has not been approved by Mojang yet. Your account is fine. Sign-in will work once the approval is through.");
  }
  if (/AADSTS7000218|client_assertion|client_secret/i.test(m)) {
    return new AuthError('NOT_CONFIGURED', 'Microsoft refused the token request: "Allow public client flows" is probably off on the Azure app (Authentication -> Advanced settings -> Allow public client flows = Yes, then Save).');
  }
  if (/AADSTS700016|AADSTS90002|AADSTS700025|invalid_client|unauthorized_client/i.test(m)) {
    return new AuthError('NOT_CONFIGURED', 'The Azure app ID in config/launcher.config.json is not valid. Check that it is the Application (client) ID of the registered app.');
  }
  if (/2148916233/.test(m)) {
    return new AuthError('XBOX_ACCOUNT_REQUIRED', 'This Microsoft account has no Xbox profile yet. Sign in once at xbox.com to create it, then try again.');
  }
  if (/2148916238|2148916235/.test(m)) {
    return new AuthError('XBOX_RESTRICTED', 'Xbox does not allow this account to sign in (a child account, or Xbox is not available in your country).');
  }
  if (/SIGN_IN_NEEDED/.test(m)) {
    return new AuthError('SIGN_IN_REQUIRED', 'This account needs to sign in again.');
  }
  if (/AADSTS70016|AADSTS70019|expired|declined|cancel/i.test(m)) {
    return new AuthError('SIGN_IN_CANCELLED', 'The sign-in was cancelled or the code expired. Start again.');
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network|timeout|stalled/i.test(m)) {
    return new AuthError('NETWORK', 'Could not reach Microsoft or Minecraft servers. Check your internet connection.');
  }
  return new AuthError('UNKNOWN', 'Sign-in failed: ' + m.slice(0, 200));
}

/** True once config/launcher.config.json holds a real Azure application (client) ID. */
function isConfigured(config) {
  const id = config && config.azureClientId;
  return !!id && id !== PLACEHOLDER && GUID.test(id);
}

function dashed(id) {
  return /^[0-9a-f]{32}$/i.test(id) ? id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5') : id;
}

/** A token cache for one account, kept in the Vault (prismarine-auth's cache factory interface). */
function vaultCache(vault, entry) {
  let data;
  const load = () => (data === undefined ? (data = vault.get(entry) || {}) : data);
  return {
    async getCached() { return load(); },
    async setCached(v) { data = v; vault.set(entry, v); },
    async setCachedPartial(v) { data = { ...load(), ...v }; vault.set(entry, data); },
    async reset() { data = {}; vault.delete(entry); return data; },
  };
}

function createAuthService({ config, vault, Authflow, fetchFn = fetchWithTimeout, log = () => {} }) {
  const say = (m) => log(redact(m));
  const clientId = config && config.azureClientId;

  function ensureConfigured() {
    if (!isConfigured(config)) {
      throw new AuthError('NOT_CONFIGURED',
        'Sign-in is not set up yet: put the Application (client) ID of the Azure app into azureClientId in config/launcher.config.json.');
    }
  }

  /** Logs each sign-in step by name (no tokens, no codes): which one worked and which one stopped. */
  function traceSteps(flow) {
    const wrap = (obj, name, label) => {
      if (!obj || typeof obj[name] !== 'function') return;
      const orig = obj[name].bind(obj);
      obj[name] = async (...a) => {
        try {
          const r = await orig(...a);
          say('Sign-in step OK: ' + label);
          return r;
        } catch (e) {
          say('Sign-in step FAILED: ' + label);
          throw e;
        }
      };
    };
    wrap(flow.msa, 'authDeviceCode', 'Microsoft device code and token');
    wrap(flow.xbl, 'getUserToken', 'Xbox Live user token');
    wrap(flow.xbl, 'getDeviceToken', 'Xbox Live device token');
    wrap(flow.xbl, 'getXSTSToken', 'XSTS token');
    wrap(flow.mca, 'getAccessToken', 'Minecraft services login');
    return flow;
  }

  function newFlow(accountId, onCode) {
    const Flow = Authflow || (() => {
      require('debug').disable(); // prismarine-auth's debug logging prints tokens: make sure it is off
      return require('prismarine-auth').Authflow;
    })();
    const factory = ({ cacheName }) => vaultCache(vault, 'cache-' + accountId + '-' + cacheName);
    return traceSteps(new Flow(accountId, factory, {
      flow: 'msal',
      authTitle: clientId,
      msalConfig: { auth: { clientId, authority: AUTHORITY } },
    }, onCode));
  }

  async function api(url, token) {
    return fetchFn(url, { headers: { Authorization: 'Bearer ' + token, 'User-Agent': require('./version').userAgent } });
  }

  /** Must own Java Edition: an ownership entitlement AND a Minecraft profile. Returns the profile {id, name}. */
  async function verifyOwnership(token) {
    let ent;
    try {
      const r = await api(ENTITLEMENTS + '?requestId=' + crypto.randomUUID(), token);
      if (r.status === 401 || r.status === 403) throw new AuthError('APP_NOT_APPROVED', 'Minecraft services refused this launcher app (HTTP ' + r.status + ').');
      if (!r.ok) throw new AuthError('UNKNOWN', 'Minecraft services answered HTTP ' + r.status + ' when checking the licence.');
      ent = await r.json();
    } catch (e) {
      throw classify(e);
    }
    const names = new Set(((ent && ent.items) || []).map((i) => i.name));
    const owns = [...OWNERSHIP_ITEMS].some((n) => names.has(n));
    let r;
    try {
      r = await api(PROFILE, token);
    } catch (e) {
      throw classify(e);
    }
    if (r.status === 404 || !owns) {
      throw new AuthError(owns ? 'NO_PROFILE' : 'NO_JAVA_EDITION', owns
        ? 'This account owns Minecraft but has no Java profile yet. Open the official Minecraft Launcher once to pick a profile name.'
        : 'This Microsoft account does not own Minecraft: Java Edition. Buy it (or use the account that has it) to play.');
    }
    if (!r.ok) throw new AuthError('UNKNOWN', 'Minecraft services answered HTTP ' + r.status + ' when reading the profile.');
    const profile = await r.json();
    if (!profile || !profile.id || !profile.name) throw new AuthError('NO_PROFILE', 'The Minecraft profile came back empty.');
    return profile;
  }

  function index() {
    return vault.get('accounts') || { accounts: [], selected: null };
  }

  function wipe(id) {
    for (const c of CACHE_IDS) vault.delete('cache-' + id + '-' + c);
  }

  return {
    /** Adds an account. onCode({ userCode, verificationUri, message }) is called once: show it to the player. */
    async signIn(onCode) {
      ensureConfigured();
      const id = crypto.randomUUID();
      try {
        const flow = newFlow(id, (resp) => onCode({ userCode: resp.userCode, verificationUri: resp.verificationUri, message: resp.message }));
        const { token } = await flow.getMinecraftJavaToken();
        say('Signed in to Microsoft, checking Java Edition ownership');
        const profile = await verifyOwnership(token);
        const idx = index();
        const same = idx.accounts.find((a) => a.uuid === dashed(profile.id));
        if (same) {
          wipe(same.id);
          idx.accounts = idx.accounts.filter((a) => a !== same);
        }
        const entry = { id, name: profile.name, uuid: dashed(profile.id), addedAt: new Date().toISOString() };
        idx.accounts.push(entry);
        idx.selected = id;
        vault.set('accounts', idx);
        say('Account added: ' + entry.name);
        return entry;
      } catch (e) {
        wipe(id);
        throw classify(e);
      }
    },

    listAccounts() {
      const idx = index();
      return idx.accounts.map((a) => ({ ...a, selected: a.id === idx.selected }));
    },

    select(id) {
      const idx = index();
      if (!idx.accounts.some((a) => a.id === id)) throw new AuthError('UNKNOWN', 'No such account.');
      idx.selected = id;
      vault.set('accounts', idx);
    },

    remove(id) {
      const idx = index();
      idx.accounts = idx.accounts.filter((a) => a.id !== id);
      if (idx.selected === id) idx.selected = idx.accounts.length ? idx.accounts[0].id : null;
      wipe(id);
      vault.set('accounts', idx);
    },

    /** A fresh, verified account for launching: refreshes the token silently, re-checks ownership. Never asks for a code. */
    async getLaunchAccount(id) {
      ensureConfigured();
      const idx = index();
      const entry = idx.accounts.find((a) => a.id === (id || idx.selected));
      if (!entry) throw new AuthError('SIGN_IN_REQUIRED', 'No account is signed in.');
      try {
        const flow = newFlow(entry.id, () => { throw new Error('SIGN_IN_NEEDED'); });
        const { token } = await flow.getMinecraftJavaToken();
        const profile = await verifyOwnership(token);
        return makeAccount({ accessToken: token, name: profile.name, uuid: dashed(profile.id) });
      } catch (e) {
        throw classify(e);
      }
    },
  };
}

module.exports = { createAuthService, AuthError, classify, redact, isConfigured, PLACEHOLDER };
