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
