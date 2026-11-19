'use strict';
// AUDIT H1: a dead connection must end in an error, never hang the launcher.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('../src/net');

// A server that accepts the request and then never answers: resolves only when the request is aborted.
let calls = 0;
const hanging = (url, opts) => (calls++, new Promise((_, reject) => {
  const s = opts && opts.signal;
  assert.ok(s, 'every request must carry an abort signal');
  s.addEventListener('abort', () => reject(s.reason || new Error('aborted')));
}));

// Answers, then sends a few bytes and goes silent.
const stalls = (url, opts) => (calls++, Promise.resolve({
  ok: true,
  status: 200,
  body: new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([1, 2, 3]));
      opts.signal.addEventListener('abort', () => c.error(opts.signal.reason));
    },
  }),
}));

const within = async (ms, start) => {
  const before = calls, t0 = Date.now();
  await assert.rejects(start());
  assert.ok(calls > before, 'the request went through the timed path');
  assert.ok(Date.now() - t0 < ms, 'gave up in time');
};

test('timedFetch aborts a request that never answers', async () => {
  await within(2000, () => net.timedFetch('https://example.invalid/x', {}, 100, hanging));
});

test('getJson gives up on a silent server instead of hanging', async () => {
  await within(5000, () => net.getJson('https://example.invalid/x.json', 2, { fetchFn: hanging, timeoutMs: 100 }));
});

test('fetchSha1 has a timeout', async () => {
  // the default 30 s timeout is passed through: the fake sees a signal at all
  let seen;
  await assert.rejects(net.fetchSha1('https://example.invalid/a.sha1', async (u, o) => { seen = o.signal; throw new Error('offline'); }));
  assert.ok(seen instanceof AbortSignal);
});

test('download aborts a stalled transfer and leaves no half file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-net-'));
  const dest = path.join(dir, 'f.bin');
  await within(5000, () => net.download('https://example.invalid/f.bin', dest, { tries: 1, fetchFn: stalls, stallMs: 150 }));
  assert.ok(!fs.existsSync(dest));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('download aborts when the server never answers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-net-'));
  await within(5000, () => net.download('https://example.invalid/f.bin', path.join(dir, 'f.bin'), { tries: 1, fetchFn: hanging, stallMs: 150 }));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('modules that take a fetchFn default to one with a timeout', () => {
  for (const f of ['channel.js', 'auth.js', 'modrinth.js', 'skin.js']) {
    const s = fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
    assert.ok(!/fetchFn = fetch\b(?!With)/.test(s), f + ' still defaults to plain fetch');
  }
});

test('M2: a file checked once is not read again on the next start while unchanged; a changed one is', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-net-'));
  const dest = path.join(dir, 'lib.jar');
  fs.writeFileSync(dest, 'library bytes');
  const sha1 = require('node:crypto').createHash('sha1').update('library bytes').digest('hex');
  const cacheFile = path.join(dir, 'hash-cache.json');
  const offline = async () => { throw new Error('no network needed'); };
  let c = net.openHashCache(cacheFile);
  assert.strictEqual(await net.download('https://example.invalid/lib.jar', dest, { sha1, cache: c, fetchFn: offline }), false);
  c.save();
  // next start: a new process reads the saved cache
  c = net.openHashCache(cacheFile);
  const real = fs.createReadStream;
  let reads = 0;
  fs.createReadStream = (...a) => { reads++; return real(...a); };
  try {
    assert.strictEqual(await net.download('https://example.invalid/lib.jar', dest, { sha1, cache: c, fetchFn: offline }), false);
    assert.strictEqual(reads, 0, 'unchanged file was not hashed again');
    fs.writeFileSync(dest, 'tampered library!');
    let fetched = 0;
    await assert.rejects(net.download('https://example.invalid/lib.jar', dest, { sha1, cache: c, tries: 1, fetchFn: async () => { fetched++; throw new Error('offline'); } }));
    assert.ok(reads > 0, 'a changed file is hashed again');
    assert.strictEqual(fetched, 1, 'and downloaded again because the hash no longer matches');
  } finally {
    fs.createReadStream = real;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
