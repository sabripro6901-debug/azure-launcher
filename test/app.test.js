'use strict';
// Settings, the log reader, the signed channel (with a throw-away key and a local server), and the window's security setup.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { zipSync } = require('fflate');
const { SettingsStore, validate, splitArgs, defaults, defaultRam } = require('../src/settings');
const DEFAULTS = defaults();
const { createLogParser, progressOf } = require('../app/logfmt');
const { ensureLegitJar, verifySignature } = require('../src/channel');

test('settings: defaults, clamping, unknown keys dropped, saved to disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-set-'));
  const store = new SettingsStore(path.join(dir, 's.json'));
  assert.deepStrictEqual(store.get(), { ...DEFAULTS });
  const s = store.set({ ram: 999999, javaArgs: '-XX:+UseZGC', evil: 1, closeOnLaunch: true, selectedInstance: '../x' });
  assert.strictEqual(s.ram, 32768);
  assert.strictEqual(s.javaArgs, '-XX:+UseZGC');
  assert.strictEqual(s.closeOnLaunch, true);
  assert.strictEqual(s.selectedInstance, 'default');
  assert.ok(!('evil' in s));
  assert.strictEqual(store.set({ ram: 10 }).ram, 1024);
  assert.strictEqual(new SettingsStore(path.join(dir, 's.json')).get().javaArgs, '-XX:+UseZGC');
  fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
  assert.deepStrictEqual(new SettingsStore(path.join(dir, 'bad.json')).get(), { ...DEFAULTS });
  assert.strictEqual(validate({ ram: 'lots', gameRoot: 5 }).ram, DEFAULTS.ram);
});

test('memory default: 4 GB on a PC with 16 GB or more, otherwise 2 GB; the log drawer is off by default', () => {
  const GB = 1024 ** 3;
  assert.strictEqual(defaultRam(16 * GB), 4096);
  assert.strictEqual(defaultRam(15.9 * GB), 4096); // Windows shows a 16 GB PC as about 15.9
  assert.strictEqual(defaultRam(32 * GB), 4096);
  assert.strictEqual(defaultRam(12 * GB), 2048);
  assert.strictEqual(defaultRam(8 * GB), 2048);
  assert.strictEqual(defaults().openLogOnLaunch, false);
});

test('java arguments are split on spaces, quotes keep a value together', () => {
  assert.deepStrictEqual(splitArgs('-Xss1M "-Dpath=C:/a b/c" -XX:+UseZGC'), ['-Xss1M', '-Dpath=C:/a b/c', '-XX:+UseZGC']);
  assert.deepStrictEqual(splitArgs(''), []);
});

test('the game log (log4j XML) becomes plain text, also for multi-line messages', () => {
  const p = createLogParser();
  const out = [
    '<log4j:Event logger="net.minecraft.client.Main" level="INFO">',
    '    <log4j:Message><![CDATA[Setting user: Steve]]></log4j:Message>',
    '  </log4j:Event>',
    '    <log4j:Message><![CDATA[Loading 3 mods:',
    '\t- fabricloader 0.18.3',
    '\t- java 21]]></log4j:Message>',
    'Exception in thread "main"',
  ].map(p).filter((x) => x !== null);
  assert.deepStrictEqual(out, ['Setting user: Steve', 'Loading 3 mods:', '\t- fabricloader 0.18.3', '\t- java 21', 'Exception in thread "main"']);
  assert.deepStrictEqual(progressOf('libraries 25/160'), { done: 25, total: 160 });
  assert.strictEqual(progressOf('Fabric profile: x'), null);
});

function channel(files, keyPair, { badSig = false } = {}) {
  const jar = files.jar;
  const sha = crypto.createHash('sha256').update(jar).digest('hex');
  const latest = JSON.stringify({ version: '9.9.9', legit: { file: 'azure-client-legit-9.9.9.jar', sha256: files.sha || sha, size: jar.length } });
  const sig = crypto.sign(null, Buffer.from(badSig ? latest + ' ' : latest), keyPair.privateKey).toString('base64');
  const server = http.createServer((req, res) => {
    if (req.url === '/latest.json') res.end(latest);
    else if (req.url === '/latest.json.sig') res.end(sig);
    else if (req.url === '/azure-client-legit-9.9.9.jar') res.end(jar);
    else { res.statusCode = 404; res.end(); }
  }).listen(0, '127.0.0.1');
  return server;
}

function jarBytes(extra = {}) {
  const entries = { 'fabric.mod.json': new TextEncoder().encode(JSON.stringify({ id: 'aurora' })), 'a.class': new TextEncoder().encode('x') };
  for (const [k, v] of Object.entries(extra)) entries[k] = new TextEncoder().encode(v);
  return Buffer.from(zipSync(entries));
}

test('signed channel: a good release is downloaded, checked and kept; bad ones are refused', async () => {
  const kp = crypto.generateKeyPairSync('ed25519');
  const keyB64 = kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.ok(verifySignature('hi', crypto.sign(null, Buffer.from('hi'), kp.privateKey).toString('base64'), keyB64));
  assert.ok(!verifySignature('ho', crypto.sign(null, Buffer.from('hi'), kp.privateKey).toString('base64'), keyB64));

  const run = async (files, opts, key = keyB64) => {
    const server = channel(files, kp, opts);
    await new Promise((r) => server.once('listening', r));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-ch-'));
    try {
      return { dir, result: await ensureLegitJar({ base: 'http://127.0.0.1:' + server.address().port, keyBase64: key, dir }).catch((e) => e) };
    } finally {
      server.close();
    }
  };

  const ok = await run({ jar: jarBytes() });
  assert.strictEqual(ok.result.version, '9.9.9');
  assert.ok(fs.existsSync(ok.result.path));

  const forged = await run({ jar: jarBytes() }, { badSig: true });
  assert.match(forged.result.message, /not signed/);
  const otherKey = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.match((await run({ jar: jarBytes() }, {}, otherKey)).result.message, /not signed/);

  const wrongHash = await run({ jar: jarBytes(), sha: 'a'.repeat(64) });
  assert.match(wrongHash.result.message, /Wrong sha256/);
  assert.deepStrictEqual(fs.readdirSync(wrongHash.dir), []);

  const other = await run({ jar: jarBytes({ [Buffer.from('Y29tL2F1cm9yYS9jbGllbnQvbW9kdWxlL093bmVyTW9kdWxlcy5jbGFzcw==', 'base64').toString()]: 'x' }) });
  assert.match(other.result.message, /not a clean Legit jar/);
  assert.deepStrictEqual(fs.readdirSync(other.dir), []); // the refused jar is deleted
});

test('the window is locked down: context isolation, no node, sandbox, a strict content policy', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');
  assert.match(app, /contextIsolation: true/);
  assert.match(app, /nodeIntegration: false/);
  assert.match(app, /sandbox: true/);
  assert.match(app, /setPermissionRequestHandler/);
  assert.match(app, /protocol !== 'https:'/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /default-src 'none'/);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(html));
  assert.ok(!/<script(?![^>]*src=)/.test(html)); // no inline scripts
  const urls = html.match(/https?:\/\/[^\s"')]+/g) || [];
  assert.deepStrictEqual(urls.filter((u) => !u.startsWith('https://cdn.modrinth.com')), []);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'app', 'preload.js'), 'utf8');
  assert.ok(!/exposeInMainWorld\('[a-z]+',\s*ipcRenderer/.test(preload));
});


test('a failed or tampered jar update leaves the working Azure jar in place (and is reported)', async () => {
  const kp = crypto.generateKeyPairSync('ed25519');
  const keyB64 = kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-upd-'));
  const serve = async (files, opts) => { const s = channel(files, kp, opts); await new Promise((r) => s.once('listening', r)); return s; };
  const go = async (files, opts) => {
    const s = await serve(files, opts);
    try { return await ensureLegitJar({ base: 'http://127.0.0.1:' + s.address().port, keyBase64: keyB64, dir }).catch((e) => e); } finally { s.close(); }
  };
  const good = await go({ jar: jarBytes() });
  assert.strictEqual(good.version, '9.9.9');
  const before = fs.readFileSync(good.path);

  // every kind of failure falls back to the installed jar, byte for byte unchanged
  const cases = {
    'forged list': [{ jar: jarBytes({ 'x.txt': 'new' }) }, { badSig: true }],
    'tampered file (hash differs)': [{ jar: jarBytes({ 'x.txt': 'new' }), sha: 'b'.repeat(64) }, {}],
    'jar of another edition': [{ jar: jarBytes({ [Buffer.from('Y29tL2F1cm9yYS9jbGllbnQvbW9kdWxlL093bmVyTW9kdWxlcy5jbGFzcw==', 'base64').toString()]: 'x' }) }, {}],
  };
  for (const [name, [files, opts]] of Object.entries(cases)) {
    const r = await go(files, opts);
    assert.ok(!(r instanceof Error), name + ' must not break the launch');
    assert.ok(r.fallback, name + ' is reported');
    assert.strictEqual(r.path, good.path);
    assert.ok(fs.readFileSync(good.path).equals(before), name + ': the installed jar is unchanged');
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['azure-client-legit-9.9.9.jar', 'installed.json']);
  }
  // offline: nothing to ask, still the installed jar
  const off = await ensureLegitJar({ base: 'http://127.0.0.1:9', keyBase64: keyB64, dir });
  assert.ok(off.fallback && off.path === good.path);
  // the installed jar itself was damaged: no silent use of it
  fs.appendFileSync(good.path, 'x');
  const dead = await ensureLegitJar({ base: 'http://127.0.0.1:9', keyBase64: keyB64, dir }).catch((e) => e);
  assert.ok(dead instanceof Error);
});

test('a newer signed jar replaces the old one only after it passed every check', async () => {
  const kp = crypto.generateKeyPairSync('ed25519');
  const keyB64 = kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-upd2-'));
  const jar2 = jarBytes({ 'v.txt': 'two' });
  const latest = JSON.stringify({ version: '10.0.0', legit: { file: 'azure-client-legit-10.0.0.jar', sha256: crypto.createHash('sha256').update(jar2).digest('hex'), size: jar2.length } });
  const sig = crypto.sign(null, Buffer.from(latest), kp.privateKey).toString('base64');
  const server = http.createServer((req, res) => { if (req.url === '/latest.json') res.end(latest); else if (req.url === '/latest.json.sig') res.end(sig); else if (req.url === '/azure-client-legit-10.0.0.jar') res.end(jar2); else { res.statusCode = 404; res.end(); } }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const s1 = channel({ jar: jarBytes() }, kp); await new Promise((r) => s1.once('listening', r));
    const first = await ensureLegitJar({ base: 'http://127.0.0.1:' + s1.address().port, keyBase64: keyB64, dir });
    s1.close();
    assert.strictEqual(first.version, '9.9.9');
    const second = await ensureLegitJar({ base: 'http://127.0.0.1:' + server.address().port, keyBase64: keyB64, dir });
    assert.strictEqual(second.version, '10.0.0');
    assert.ok(!second.fallback);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['azure-client-legit-10.0.0.jar', 'installed.json']);
  } finally {
    server.close();
  }
});
