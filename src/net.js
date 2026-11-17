'use strict';
// Small download helpers: JSON, files with a hash check, and a worker pool. Node's own fetch, no extra HTTP library.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const UA = require('./version').userAgent;

async function getJson(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
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
async function download(url, dest, { sha1, sha256, sha512, tries = 3 } = {}) {
  const algo = sha512 ? 'sha512' : sha256 ? 'sha256' : sha1 ? 'sha1' : null;
  const want = sha512 || sha256 || sha1;
  if (fs.existsSync(dest) && (!algo || (await hashFile(dest, algo)) === want)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
      const tmp = dest + '.part';
      await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(tmp));
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
async function fetchSha1(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('No published hash at ' + url + ' (HTTP ' + r.status + '): refusing to use an unchecked file');
  const h = (await r.text()).trim().split(/\s+/)[0].toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(h)) throw new Error('Bad hash file at ' + url);
  return h;
}

module.exports = { getJson, download, hashFile, pool, fetchSha1 };
