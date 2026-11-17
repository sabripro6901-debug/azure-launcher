'use strict';
// A small Modrinth API client (the only content source: no CurseForge). It sends a proper User-Agent, keeps requests
// one at a time, and respects the rate limit: it waits when the limit is nearly used up and on a 429 answer.
const { userAgent } = require('./version');

const API = 'https://api.modrinth.com/v2';
const SORTS = new Set(['relevance', 'downloads', 'follows', 'newest', 'updated']);
const KINDS = { mod: 'mod', resourcepack: 'resourcepack', shader: 'shader', modpack: 'modpack' };

/** Modrinth's own project id for Fabric API (used to recognise it among dependencies). */
const FABRIC_API_ID = 'P7dR8mSH';

class ModrinthError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // OFFLINE | RATE_LIMITED | HTTP | BAD_ANSWER
  }
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

class ModrinthClient {
  constructor({ fetchFn = fetch, base = API, sleep = sleepMs, maxWaitMs = 20000 } = {}) {
    this.fetchFn = fetchFn;
    this.base = base;
    this.sleep = sleep;
    this.maxWaitMs = maxWaitMs;
    this.queue = Promise.resolve();
    this.calls = 0;
  }

  /** One request at a time, so a burst can never trip the limit. */
  request(path, { method = 'GET', body } = {}) {
    const run = () => this.#send(path, method, body);
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  async #send(path, method, body, attempt = 0) {
    let r;
    try {
      this.calls++;
      r = await this.fetchFn(this.base + path, {
        method,
        headers: { 'User-Agent': userAgent, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new ModrinthError('OFFLINE', "Can't reach Modrinth. Check your internet connection.");
    }
    const header = (n) => (r.headers && r.headers.get ? r.headers.get(n) : null);
    const resetSec = Number(header('x-ratelimit-reset')) || 0;
    if (r.status === 429) {
      if (attempt >= 2) throw new ModrinthError('RATE_LIMITED', 'Modrinth is busy right now. Try again in a minute.');
      await this.sleep(Math.min(this.maxWaitMs, Math.max(1, resetSec || 5) * 1000));
      return this.#send(path, method, body, attempt + 1);
    }
    // nearly out of requests for this minute: wait for the window to reset before the next call
    const remaining = header('x-ratelimit-remaining');
    if (remaining !== null && Number(remaining) <= 2 && resetSec) await this.sleep(Math.min(this.maxWaitMs, resetSec * 1000));
    if (!r.ok) throw new ModrinthError('HTTP', 'Modrinth answered with an error (' + r.status + ').');
    try {
      return await r.json();
    } catch {
      throw new ModrinthError('BAD_ANSWER', 'Modrinth sent an answer that could not be read.');
    }
  }

  /**
   * Search. kind: mod | resourcepack | shader. mc and loader filter to the instance (loader only for mods; for shaders
   * `loader` is the shader loader, e.g. iris). categories: extra category facets (all must match).
   */
  async search({ kind, query = '', mc, loader, categories = [], sort = 'relevance', offset = 0, limit = 20 }) {
    if (!KINDS[kind]) throw new Error('Bad kind');
    const facets = [['project_type:' + KINDS[kind]]];
    if (mc) facets.push(['versions:' + mc]);
    if (loader) facets.push(['categories:' + loader]);
    for (const c of categories) facets.push(['categories:' + c]);
    const q = '?query=' + encodeURIComponent(query) + '&facets=' + encodeURIComponent(JSON.stringify(facets))
      + '&index=' + (SORTS.has(sort) ? sort : 'relevance') + '&offset=' + Math.max(0, offset | 0) + '&limit=' + Math.min(50, limit);
    const r = await this.request('/search' + q);
    return {
      total: r.total_hits || 0,
      hits: (r.hits || []).map((h) => ({
        projectId: h.project_id, slug: h.slug, title: h.title, description: h.description, icon: h.icon_url || null,
        downloads: h.downloads || 0, author: h.author || '', categories: h.display_categories || h.categories || [],
      })),
    };
  }

  /** Category names for a kind (for the filter sidebar). */
  async categories(kind) {
    const all = await this.request('/tag/category');
    return all.filter((c) => c.project_type === KINDS[kind]).map((c) => ({ name: c.name, header: c.header }));
  }

  projects(ids) {
    return ids.length ? this.request('/projects?ids=' + encodeURIComponent(JSON.stringify(ids))) : Promise.resolve([]);
  }

  /** Versions of a project for a Minecraft version (and loader), newest first. */
  versionsFor(projectId, { mc, loader }) {
    let q = '';
    if (loader) q += '&loaders=' + encodeURIComponent(JSON.stringify([loader]));
    if (mc) q += '&game_versions=' + encodeURIComponent(JSON.stringify([mc]));
    return this.request('/project/' + encodeURIComponent(projectId) + '/version' + (q ? '?' + q.slice(1) : ''));
  }

  version(id) {
    return this.request('/version/' + encodeURIComponent(id));
  }

  /** hash (sha512) -> the version that file belongs to, for hashes Modrinth knows. */
  versionsByHashes(hashes) {
    return hashes.length ? this.request('/version_files', { method: 'POST', body: { hashes, algorithm: 'sha512' } }) : Promise.resolve({});
  }

  /** hash -> the newest version for this instance (Modrinth's own update check). */
  latestByHashes(hashes, { mc, loader }) {
    if (!hashes.length) return Promise.resolve({});
    return this.request('/version_files/update', {
      method: 'POST',
      body: { hashes, algorithm: 'sha512', loaders: loader ? [loader] : undefined, game_versions: mc ? [mc] : undefined },
    });
  }
}

/** Newest release of a version list, else the newest of anything. */
function bestVersion(versions) {
  return versions.find((v) => v.version_type === 'release') || versions[0] || null;
}

/** The file to download from a Modrinth version: the primary one, with its SHA-512 (no hash, no download). */
function fileOf(version) {
  const f = (version.files || []).find((x) => x.primary) || (version.files || [])[0];
  if (!f || !f.hashes || !f.hashes.sha512 || !f.url) return null;
  let u;
  try { u = new URL(f.url); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'cdn.modrinth.com') return null; // Modrinth's own file host only
  if (!/^[A-Za-z0-9._+~()[\] -]{1,150}$/.test(f.filename) || f.filename.includes('..')) return null;
  return { filename: f.filename, url: f.url, sha512: f.hashes.sha512, sha1: f.hashes.sha1 || null, size: f.size || 0 };
}

const TYPE_RANK = { release: 0, beta: 1, alpha: 2 };

/**
 * The versions of a project in the order a player wants them, with the most compatible one marked "best".
 * Compatible = made for this Minecraft version (when given) and loader (when given) and downloadable safely.
 * Best = the newest *release* among those (a release beats a newer beta or alpha). Incompatible versions come last.
 */
function rankVersions(versions, { mc, loader } = {}) {
  const rows = versions.map((v) => ({
    id: v.id, number: v.version_number, name: v.name || v.version_number, type: v.version_type || 'release', date: v.date_published || '',
    gameVersions: v.game_versions || [], loaders: v.loaders || [], downloads: v.downloads || 0, changelog: (v.changelog || '').slice(0, 600),
    safe: !!fileOf(v),
    compatible: (!mc || (v.game_versions || []).includes(mc)) && (!loader || (v.loaders || []).includes(loader)),
    best: false, latest: false,
  }));
  const byDate = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
  rows.sort((a, b) => Number(b.compatible) - Number(a.compatible)
    || (a.compatible ? (TYPE_RANK[a.type] ?? 3) - (TYPE_RANK[b.type] ?? 3) : 0) || byDate(a, b));
  const usable = rows.filter((r) => r.compatible && r.safe);
  if (usable.length) {
    usable[0].best = true;
    usable.slice().sort(byDate)[0].latest = true;
  }
  return rows;
}

module.exports = { ModrinthClient, ModrinthError, bestVersion, fileOf, rankVersions, FABRIC_API_ID };
