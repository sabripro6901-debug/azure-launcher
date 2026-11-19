'use strict';
// Small download helpers: JSON, files with a hash check, and a worker pool. Node's own fetch, no extra HTTP library.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const UA = require('./version').userAgent;

// Every request gives up instead of hanging forever on a dead connection (AUDIT H1).
const TIMEOUT_MS = 30000; // a whole small request (JSON, text, a hash file, a skin)
const STALL_MS = 60000; // a download: no new bytes for this long

/** fetch that is aborted after ms (the whole request, body included). Keeps a caller's own signal too. */
function timedFetch(url, opts = {}, ms = TIMEOUT_MS, fetchFn = fetch) {
  const t = AbortSignal.timeout(ms);
  return fetchFn(url, { ...opts, signal: opts.signal ? AbortSignal.any([opts.signal, t]) : t });
}

/** A fetchFn with the default timeout, for modules that take one (channel, auth, Modrinth, skins). */
const fetchWithTimeout = (url, opts) => timedFetch(url, opts);

async function getJson(url, tries = 3, { fetchFn = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await timedFetch(url, { headers: { 'User-Agent': UA } }, timeoutMs, fetchFn);
      if (r.status === 429) { // rate limited (Modrinth, Mojang): wait as long as asked, then try again
        const wait = Math.min(15, Number(r.headers.get('retry-after')) || Number(r.headers.get('x-ratelimit-reset')) || 2);
        await new Promise((res) => setTimeout(res, wait * 1000));
        throw new Error('HTTP 429 for ' + url);
      }
      if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
      return await r.json();
    } catch (e) {
      last = e;
      await new Promise((res) => setTimeout(res, 500 * (i + 1)));
    }
  }
  throw last;
}

function hashFile(file, algo) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/** Downloads url to dest unless dest already has the expected hash. Throws if the hash is wrong after download. */
async function download(url, dest, { sha1, sha256, sha512, tries = 3, fetchFn = fetch, stallMs = STALL_MS } = {}) {
  const algo = sha512 ? 'sha512' : sha256 ? 'sha256' : sha1 ? 'sha1' : null;
  const want = sha512 || sha256 || sha1;
  if (fs.existsSync(dest) && (!algo || (await hashFile(dest, algo)) === want)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let last;
  const tmp = dest + '.part';
  for (let i = 0; i < tries; i++) {
    try {
      // Aborted when no bytes arrive for stallMs (connecting included); a slow but moving download is fine.
      const ac = new AbortController();
      let timer;
      const poke = () => {
        clearTimeout(timer);
        timer = setTimeout(() => ac.abort(new Error('Download stalled for ' + Math.round(stallMs / 1000) + ' s: ' + url)), stallMs);
      };
      poke();
      try {
        const r = await fetchFn(url, { headers: { 'User-Agent': UA }, signal: ac.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
        const body = Readable.fromWeb(r.body);
        body.on('data', poke);
        await pipeline(body, fs.createWriteStream(tmp), { signal: ac.signal });
      } catch (e) {
        throw ac.signal.aborted && ac.signal.reason ? ac.signal.reason : e;
      } finally {
        clearTimeout(timer);
      }
      if (algo && (await hashFile(tmp, algo)) !== want) {
        fs.rmSync(tmp, { force: true });
        throw new Error('Wrong ' + algo + ' for ' + url);
      }
      fs.renameSync(tmp, dest);
      return true;
    } catch (e) {
      last = e;
      await new Promise((res) => setTimeout(res, 700 * (i + 1)));
    }
  }
  throw last;
}

/** Runs fn over items with at most n at a time. */
async function pool(items, n, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/** Reads a published .sha1 side file (maven style: the hash, optionally followed by a file name). */
async function fetchSha1(url, fetchFn = fetch) {
  const r = await timedFetch(url, { headers: { 'User-Agent': UA } }, TIMEOUT_MS, fetchFn);
  if (!r.ok) throw new Error('No published hash at ' + url + ' (HTTP ' + r.status + '): refusing to use an unchecked file');
  const h = (await r.text()).trim().split(/\s+/)[0].toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(h)) throw new Error('Bad hash file at ' + url);
  return h;
}

module.exports = { getJson, download, hashFile, pool, fetchSha1, timedFetch, fetchWithTimeout, TIMEOUT_MS, STALL_MS };
