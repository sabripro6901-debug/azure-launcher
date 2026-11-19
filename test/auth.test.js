'use strict';
// Sign-in with mocked Microsoft / Minecraft responses: everything up to the Minecraft services call, and that call's
// failure while the Azure app is not approved.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAuthService, AuthError, redact, PLACEHOLDER } = require('../src/auth');
const { Vault } = require('../src/vault');
const { isVerifiedAccount } = require('../src/account');

const CLIENT_ID = '11111111-2222-3333-4444-555555555555';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.' + 'A'.repeat(80) + '.' + 'B'.repeat(40);
const fakeCipher = { isAvailable: () => true, encrypt: (t) => Buffer.from(t, 'utf8').reverse(), decrypt: (b) => Buffer.from(b).reverse().toString('utf8') };

function newVault(cipher = fakeCipher) {
  return new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'azure-auth-')), cipher);
}

/** A stand-in for prismarine-auth's Authflow: records how it was built, shows a device code, then answers. */
function fakeAuthflow(script) {
  const built = [];
  class Authflow {
    constructor(username, cache, options, codeCallback) {
      this.username = username; this.cache = cache; this.options = options; this.codeCallback = codeCallback;
      built.push({ username, options });
    }
    async getMinecraftJavaToken() {
      const cache = this.cache({ cacheName: 'mca', username: this.username });
      return script.call(this, cache);
    }
  }
  Authflow.built = built;
  return Authflow;
}

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

/** Minecraft services: entitlements and profile. */
function services({ items = [{ name: 'product_minecraft' }, { name: 'game_minecraft' }], profile = { id: 'a'.repeat(32), name: 'Steve' }, profileStatus = 200, entStatus = 200 } = {}) {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, auth: opts && opts.headers && opts.headers.Authorization });
    if (url.includes('/entitlements/')) return response(entStatus, { items });
    if (url.includes('/minecraft/profile')) return response(profileStatus, profileStatus === 200 ? profile : { error: 'NOT_FOUND' });
    throw new Error('unexpected url ' + url);
  };
  fetchFn.calls = calls;
  return fetchFn;
}

const goodFlow = (token = TOKEN) => fakeAuthflow(async function (cache) {
  this.codeCallback({ userCode: 'ABCD1234', verificationUri: 'https://microsoft.com/link', message: 'Go to the link' });
  await cache.setCachedPartial({ msal: { account: 'refresh-secret-value' } });
  return { token };
});

const config = { azureClientId: CLIENT_ID };

test('not configured: the placeholder client ID stops before anything is built or sent', async () => {
  const Authflow = goodFlow();
  const auth = createAuthService({ config: { azureClientId: PLACEHOLDER }, vault: newVault(), Authflow, fetchFn: services() });
  await assert.rejects(() => auth.signIn(() => {}), (e) => e instanceof AuthError && e.code === 'NOT_CONFIGURED');
  assert.strictEqual(Authflow.built.length, 0);
  const bad = createAuthService({ config: { azureClientId: 'not-a-guid' }, vault: newVault(), Authflow, fetchFn: services() });
  await assert.rejects(() => bad.signIn(() => {}), /NOT_CONFIGURED|not set up/);
});

test('sign-in builds the flow on our own Azure app (msal, consumers), shows the device code, saves the account', async () => {
  const Authflow = goodFlow();
  const vault = newVault();
  const auth = createAuthService({ config, vault, Authflow, fetchFn: services() });
  let shown;
  const entry = await auth.signIn((c) => { shown = c; });
  assert.strictEqual(shown.userCode, 'ABCD1234');
  const opts = Authflow.built[0].options;
  assert.strictEqual(opts.flow, 'msal');
  assert.strictEqual(opts.authTitle, CLIENT_ID);
  assert.strictEqual(opts.msalConfig.auth.clientId, CLIENT_ID);
  assert.match(opts.msalConfig.auth.authority, /\/consumers$/);
  assert.strictEqual(entry.name, 'Steve');
  assert.strictEqual(entry.uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  assert.deepStrictEqual(auth.listAccounts().map((a) => [a.name, a.selected]), [['Steve', true]]);
  assert.ok(!JSON.stringify(auth.listAccounts()).includes(TOKEN));
});

test('Mojang has not approved the app yet: a clear AuthError, no crash, no account saved', async () => {
  const body = '403 Forbidden {"path":"/authentication/login_with_xbox","errorType":"FORBIDDEN","errorMessage":"Invalid app registration, see https://aka.ms/AppRegInfo for more information"}';
  const Authflow = fakeAuthflow(async function () { throw new Error(body); });
  const vault = newVault();
  const auth = createAuthService({ config, vault, Authflow, fetchFn: services() });
  await assert.rejects(() => auth.signIn(() => {}), (e) => {
    assert.ok(e instanceof AuthError);
    assert.strictEqual(e.code, 'APP_NOT_APPROVED');
    assert.match(e.message, /not been approved by Mojang/);
    return true;
  });
  assert.deepStrictEqual(auth.listAccounts(), []);
  // and the same thing if the entitlement call is the one refused
  const auth2 = createAuthService({ config, vault, Authflow: goodFlow(), fetchFn: services({ entStatus: 403 }) });
  await assert.rejects(() => auth2.signIn(() => {}), (e) => e.code === 'APP_NOT_APPROVED');
});

test('an account without Java Edition is refused (and so is one with no profile)', async () => {
  const none = createAuthService({ config, vault: newVault(), Authflow: goodFlow(), fetchFn: services({ items: [], profileStatus: 404 }) });
  await assert.rejects(() => none.signIn(() => {}), (e) => e.code === 'NO_JAVA_EDITION' && /does not own/.test(e.message));
  const noProfile = createAuthService({ config, vault: newVault(), Authflow: goodFlow(), fetchFn: services({ profileStatus: 404 }) });
  await assert.rejects(() => noProfile.signIn(() => {}), (e) => e.code === 'NO_PROFILE');
  const bedrockOnly = createAuthService({ config, vault: newVault(), Authflow: goodFlow(), fetchFn: services({ items: [{ name: 'something_else' }] }) });
  await assert.rejects(() => bedrockOnly.signIn(() => {}), (e) => e.code === 'NO_JAVA_EDITION');
});

test('other failures map to readable codes', async () => {
  const cases = [
    ['AADSTS700016: Application with identifier was not found', 'NOT_CONFIGURED'],
    ['AADSTS7000218: The request body must contain client_assertion or client_secret', 'NOT_CONFIGURED'],
    ['XErr 2148916233', 'XBOX_ACCOUNT_REQUIRED'],
    ['XErr 2148916238', 'XBOX_RESTRICTED'],
    ['fetch failed ENOTFOUND login.live.com', 'NETWORK'],
    ['The device code has expired', 'SIGN_IN_CANCELLED'],
  ];
  for (const [msg, code] of cases) {
    const auth = createAuthService({ config, vault: newVault(), Authflow: fakeAuthflow(async () => { throw new Error(msg); }), fetchFn: services() });
    await assert.rejects(() => auth.signIn(() => {}), (e) => e instanceof AuthError && e.code === code, msg);
  }
});

test('launching: a silent refresh gives a verified account; needing a new code is SIGN_IN_REQUIRED, never a prompt', async () => {
  const vault = newVault();
  const auth = createAuthService({ config, vault, Authflow: goodFlow('FRESH.' + 'z'.repeat(70)), fetchFn: services() });
  const entry = await auth.signIn(() => {});
  const silent = fakeAuthflow(async function () { return { token: 'REFRESHED.' + 'q'.repeat(70) }; });
  const auth2 = createAuthService({ config, vault, Authflow: silent, fetchFn: services() });
  const account = await auth2.getLaunchAccount(entry.id);
  assert.ok(isVerifiedAccount(account));
  assert.strictEqual(account.name, 'Steve');
  assert.ok(account.player().accessToken.startsWith('REFRESHED.'));

  const stale = fakeAuthflow(async function () { this.codeCallback({ userCode: 'X' }); return { token: 'never' }; });
  const auth3 = createAuthService({ config, vault, Authflow: stale, fetchFn: services() });
  await assert.rejects(() => auth3.getLaunchAccount(entry.id), (e) => e.code === 'SIGN_IN_REQUIRED');
  await assert.rejects(() => auth3.getLaunchAccount('nope'), (e) => e.code === 'SIGN_IN_REQUIRED');
});

test('launching re-checks ownership every time', async () => {
  const vault = newVault();
  const entry = await createAuthService({ config, vault, Authflow: goodFlow(), fetchFn: services() }).signIn(() => {});
  const silent = fakeAuthflow(async function () { return { token: 'STILL.' + 'w'.repeat(70) }; });
  const lost = createAuthService({ config, vault, Authflow: silent, fetchFn: services({ items: [], profileStatus: 404 }) });
  await assert.rejects(() => lost.getLaunchAccount(entry.id), (e) => e.code === 'NO_JAVA_EDITION');
});

test('several accounts: add, switch, remove; the same Minecraft account twice is one entry', async () => {
  const vault = newVault();
  const make = (profile) => createAuthService({ config, vault, Authflow: goodFlow(), fetchFn: services({ profile }) });
  const a = await make({ id: '1'.repeat(32), name: 'Alex' }).signIn(() => {});
  const b = await make({ id: '2'.repeat(32), name: 'Beth' }).signIn(() => {});
  const auth = make({ id: '1'.repeat(32), name: 'Alex' });
  assert.deepStrictEqual(auth.listAccounts().map((x) => x.name), ['Alex', 'Beth']);
  assert.strictEqual(auth.listAccounts().find((x) => x.selected).name, 'Beth');
  auth.select(a.id);
  assert.strictEqual(auth.listAccounts().find((x) => x.selected).name, 'Alex');
  const again = await make({ id: '1'.repeat(32), name: 'Alex' }).signIn(() => {});
  assert.deepStrictEqual(auth.listAccounts().map((x) => x.name).sort(), ['Alex', 'Beth']);
  assert.notStrictEqual(again.id, a.id);
  assert.strictEqual(vault.get('cache-' + a.id + '-mca'), undefined); // the replaced sign-in's tokens are gone
  auth.remove(b.id);
  assert.deepStrictEqual(auth.listAccounts().map((x) => x.name), ['Alex']);
  assert.strictEqual(vault.get('cache-' + b.id + '-msal'), undefined);
});

test('tokens are encrypted at rest, and nothing is written when the system cannot encrypt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-auth-'));
  const vault = new Vault(dir, fakeCipher);
  await createAuthService({ config, vault, Authflow: goodFlow(), fetchFn: services() }).signIn(() => {});
  const bytes = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f)));
  assert.ok(bytes.length >= 2);
  for (const b of bytes) {
    assert.ok(!b.includes(Buffer.from('refresh-secret-value')));
    assert.ok(!b.includes(Buffer.from('Steve')));
  }
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-auth-'));
  const locked = new Vault(empty, { isAvailable: () => false, encrypt() { throw new Error('no'); }, decrypt() { throw new Error('no'); } });
  const auth = createAuthService({ config, vault: locked, Authflow: goodFlow(), fetchFn: services() });
  await assert.rejects(() => auth.signIn(() => {}), /Secure storage is not available/);
  assert.deepStrictEqual(fs.readdirSync(empty), []);
});

test('tokens never reach the log or an error message', async () => {
  const logged = [];
  const vault = newVault();
  const auth = createAuthService({ config, vault, Authflow: goodFlow(), fetchFn: services(), log: (m) => logged.push(m) });
  await auth.signIn(() => {});
  const failing = fakeAuthflow(async function () { throw new Error('boom ' + TOKEN + ' Bearer ' + TOKEN); });
  const bad = createAuthService({ config, vault, Authflow: failing, fetchFn: services(), log: (m) => logged.push(m) });
  const err = await bad.signIn(() => {}).catch((e) => e);
  logged.push(err.message);
  assert.ok(logged.length >= 2);
  for (const line of logged) assert.ok(!line.includes(TOKEN) && !line.includes('A'.repeat(40)), line);
  assert.ok(!redact('Authorization: Bearer ' + TOKEN).includes('AAAA'));
  assert.ok(!redact('x=' + 'k'.repeat(70)).includes('kkkk'));
});

test('each sign-in step is logged by name, with no tokens or codes', async () => {
  const lines = [];
  class Authflow {
    constructor() {
      this.msa = { authDeviceCode: async () => ({ accessToken: TOKEN }) };
      this.xbl = { getUserToken: async () => 'u', getDeviceToken: async () => 'd', getXSTSToken: async () => { throw new Error('XErr 2148916233'); } };
      this.mca = { getAccessToken: async () => TOKEN };
    }
    async getMinecraftJavaToken() {
      await this.msa.authDeviceCode(); await this.xbl.getUserToken(); await this.xbl.getDeviceToken(); await this.xbl.getXSTSToken();
    }
  }
  const auth = createAuthService({ config, vault: newVault(), Authflow, fetchFn: services(), log: (m) => lines.push(m) });
  await assert.rejects(() => auth.signIn(() => {}), (e) => e.code === 'XBOX_ACCOUNT_REQUIRED');
  const text = lines.join(String.fromCharCode(10));
  assert.match(text, /OK: Microsoft device code and token/);
  assert.match(text, /OK: Xbox Live user token/);
  assert.match(text, /FAILED: XSTS token/);
  assert.ok(!text.includes(TOKEN));
});

test('M11: when Windows secure storage fails, the account list is empty with a reason, not an error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-auth-'));
  new Vault(dir, fakeCipher).set('accounts', { accounts: [{ id: 'a', name: 'Steve' }], selected: 'a' });
  const broken = { isAvailable: () => false, encrypt: () => { throw new Error('no'); }, decrypt: () => { throw new Error('no'); } };
  const auth = createAuthService({ config: { azureClientId: PLACEHOLDER }, vault: new Vault(dir, broken), Authflow: class {}, fetchFn: async () => ({}) });
  assert.deepStrictEqual(auth.listAccounts(), []);
  assert.strictEqual(auth.storageProblem(), 'SECURE_STORAGE');
  const ok = createAuthService({ config: { azureClientId: PLACEHOLDER }, vault: new Vault(dir, fakeCipher), Authflow: class {}, fetchFn: async () => ({}) });
  assert.strictEqual(ok.listAccounts().length, 1);
  assert.strictEqual(ok.storageProblem(), null);
  const { playerMessage } = require('../app/messages');
  assert.match(playerMessage('SECURE_STORAGE'), /secure storage/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8'), /storageProblem: auth\.storageProblem\(\)/);
});
