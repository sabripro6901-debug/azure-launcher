'use strict';
// Dates and numbers follow the language of the UI (the page's own language, else the system one).
var UI_LANG = window.AZURE_UI_LANG || navigator.language || 'en'; // set again by i18n.js when the language changes
// Mods, Resource Packs and Shaders pages: browse Modrinth for the selected instance, and manage what is installed.
// Loaded before renderer.js; it uses the helpers defined there (el, $, api, appState, openDialog, navigate ...).

const KIND_INFO = {
  modpack: { page: 'modpacks', title: 'Modpacks', one: 'modpack', empty: '' },
  mod: { page: 'mods', title: 'Mods', one: 'mod', empty: 'No mods yet. Browse Modrinth to add some.' },
  resourcepack: { page: 'resourcepacks', title: 'Resource Packs', one: 'resource pack', empty: 'No resource packs yet.' },
  shader: { page: 'shaders', title: 'Shaders', one: 'shader pack', empty: 'No shader packs yet.' },
};
const SORTS = [['relevance', 'Relevance'], ['downloads', 'Downloads'], ['follows', 'Follows'], ['newest', 'Newest'], ['updated', 'Updated']];

const cp = {}; // per-kind page state

const compact = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K' : String(n));

function iconNode(src, letter) {
  const box = el('span', 'icon');
  if (src) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = src;
    img.addEventListener('error', () => { img.remove(); box.textContent = letter; });
    box.append(img);
  } else box.textContent = letter;
  return box;
}

function initContentPages() {
  const main = document.querySelector('main');
  for (const kind of Object.keys(KIND_INFO)) {
    const info = KIND_INFO[kind];
    const st = (cp[kind] = { kind, tab: 'browse', query: '', sort: 'relevance', cats: new Set(), offset: 0, total: 0, hits: [], busy: false, items: null, updates: {}, installing: new Set(), timer: null, categories: null, status: '' });
    const page = el('section', 'page content-page hidden');
    page.id = 'page-' + info.page;
    const header = el('header');
    header.append(el('h1', '', info.title));
    st.chip = el('div', 'chip');
    header.append(st.chip);
    const kinds = el('div', 'kindbar');
    for (const k of Object.keys(KIND_INFO)) {
      const b = el('button', 'chipbtn' + (k === kind ? ' on' : ''), KIND_INFO[k].title);
      b.addEventListener('click', () => navigate(KIND_INFO[k].page));
      kinds.append(b);
    }
    const tabs = el('div', 'tabs hidden');
    st.tabBrowse = el('button', 'tab on', 'Browse');
    st.tabInstalled = el('button', 'tab', 'Installed');
    st.tabBrowse.addEventListener('click', () => setTab(kind, 'browse'));
    st.tabInstalled.addEventListener('click', () => setTab(kind, 'installed'));
    tabs.append(st.tabBrowse, st.tabInstalled);
    st.notice = el('div', 'card note hidden');

    // browse
    st.browse = el('div', 'browse');
    const filters = el('aside', 'filters');
    filters.append(el('div', 'cap', 'Sort by'));
    const sorts = el('div', 'sorts');
    for (const [id, label] of SORTS) {
      const b = el('button', 'chipbtn' + (id === st.sort ? ' on' : ''), label);
      b.addEventListener('click', () => { st.sort = id; sorts.querySelectorAll('.chipbtn').forEach((x) => x.classList.toggle('on', x === b)); runSearch(kind, true); });
      sorts.append(b);
    }
    filters.append(sorts, el('div', 'cap', 'Categories'));
    st.catBox = el('div', 'cats');
    filters.append(st.catBox);
    const results = el('div', 'results');
    st.search = document.createElement('input');
    st.search.type = 'text';
    st.search.placeholder = 'Search ' + info.title.toLowerCase() + ' on Modrinth';
    st.search.spellcheck = false;
    st.searchBox = el('div', 'searchbox');
    st.searchBox.append(searchIcon(), st.search);
    st.search.addEventListener('input', () => { clearTimeout(st.timer); st.timer = setTimeout(() => { st.query = st.search.value.trim(); runSearch(kind, true); }, 350); });
    st.state = el('div', 'state');
    st.list = el('div', 'rlist');
    st.more = el('button', 'pill', 'Load more');
    st.more.addEventListener('click', () => runSearch(kind, false));
    results.append(st.searchBox, st.state, st.list, st.more);
    st.browse.append(filters, results);

    // installed
    st.installed = el('div', 'installed hidden');
    const bar = el('div', 'toolbar');
    st.btnCheck = el('button', 'pill', 'Check for updates');
    st.btnCheck.addEventListener('click', () => checkUpdates(kind));
    st.btnAll = el('button', 'pill accent hidden', 'Update all');
    st.btnAll.addEventListener('click', () => updateAll(kind));
    const open = el('button', 'pill', 'Open folder');
    open.addEventListener('click', () => api.instances.openFolder(appState.selected));
    st.status = el('span', 'status muted', '');
    bar.append(st.btnCheck, st.btnAll, open);
    if (typeof addImportControls === 'function') addImportControls(kind, bar, st);
    bar.append(st.status);
    st.ilist = el('div', 'ilist');
    st.installed.append(bar, st.ilist);
    if (typeof addDropZone === 'function') addDropZone(kind, st);

    if (kind === 'modpack') {
      st.tabBrowse = el('button'); st.tabInstalled = el('button');
      st.status = el('div', 'status muted', '');
      page.append(header, kinds, st.notice, st.status, st.browse);
    } else page.append(header, kinds, tabs, st.notice, st.browse, st.installed);
    main.append(page);
  }
  api.content.onEvent((e) => { if (e.type === 'progress') { const k = visibleKind(); if (k) cp[k].status.textContent = e.text; } });
  refreshChips();
}

function currentInstance() { return appState.instances.find((i) => i.id === appState.selected) || appState.instances[0]; }

function refreshChips() {
  const inst = currentInstance();
  for (const kind of Object.keys(cp)) {
    const st = cp[kind];
    if (kind === 'modpack') st.chip.replaceChildren(el('span', 'cap', 'Creates a new instance'), el('span', 'muted', 'Fabric modpacks'));
    else st.chip.replaceChildren(el('span', 'cap', 'Instance'), rawEl('span', 'val', inst.name), el('span', 'muted', 'Minecraft ' + inst.mcVersion + ' · ' + inst.loader));
  }
}

function onInstanceChanged() {
  if (!cp.mod) return;
  refreshChips();
  for (const kind of Object.keys(cp)) { if (kind === 'modpack') continue; cp[kind].items = null; cp[kind].updates = {}; cp[kind].hits = []; cp[kind].total = 0; }
  const shown = Object.keys(cp).find((k) => !document.getElementById('page-' + KIND_INFO[k].page).classList.contains('hidden'));
  if (shown) onPageShown(KIND_INFO[shown].page);
}

function kindOfPage(page) { return Object.keys(KIND_INFO).find((k) => KIND_INFO[k].page === page); }

function onPageShown(page) {
  const kind = kindOfPage(page);
  if (!kind || !cp[kind]) return;
  const st = cp[kind];
  const inst = currentInstance();
  refreshChips();
  st.status.textContent = '';
  if (kind === 'modpack') {
    showNotice(kind, 'Only Fabric modpacks are shown. Installing one creates a new instance with its Minecraft version, mods and settings; every file is checked against the pack\'s hashes.');
    if (!st.hits.length) { loadCategories(kind); runSearch(kind, true); }
    return;
  }
  const off = kind === 'mod' && !inst.fabric;
  showNotice(kind, off ? 'Mods are off for this instance: Minecraft ' + inst.mcVersion + ' has no Fabric, so it runs as plain Minecraft. Pick or create an instance on a Fabric version to use mods.'
    : kind === 'shader' ? 'Shader packs need Iris (a mod that runs shaders). Install Iris from the Mods page, then add shader packs here.' : '');
  st.browse.classList.toggle('disabled', off);
  st.tabBrowse.disabled = off;
  if (off) { setTab(kind, 'installed'); } else if (!st.hits.length && st.tab === 'browse') { loadCategories(kind); runSearch(kind, true); }
  st.items = null; // read the folder again: files may have been added or removed outside the launcher
  loadInstalled(kind);
}

function showNotice(kind, text) {
  cp[kind].notice.textContent = text;
  cp[kind].notice.classList.toggle('hidden', !text);
}

function setTab(kind, tab) {
  const st = cp[kind];
  st.tab = tab;
  st.tabBrowse.classList.toggle('on', tab === 'browse');
  st.tabInstalled.classList.toggle('on', tab === 'installed');
  st.browse.classList.toggle('hidden', tab !== 'browse');
  st.installed.classList.toggle('hidden', tab !== 'installed');
  if (tab === 'installed') loadInstalled(kind);
  if (tab === 'browse' && !st.hits.length) { loadCategories(kind); runSearch(kind, true); }
}

// ---------- browse ----------
/** The content kind whose page is on screen right now (null on any other page). */
function searchIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'sicon');
  svg.setAttribute('aria-hidden', 'true');
  const c = document.createElementNS(ns, 'circle');
  c.setAttribute('cx', '10.5'); c.setAttribute('cy', '10.5'); c.setAttribute('r', '6.5');
  const l = document.createElementNS(ns, 'path');
  l.setAttribute('d', 'M15.5 15.5 21 21');
  svg.append(c, l);
  return svg;
}

function visibleKind() {
  return Object.keys(cp).find((k) => !$('page-' + KIND_INFO[k].page).classList.contains('hidden')) || null;
}

async function loadCategories(kind) {
  const st = cp[kind];
  if (st.categories) return;
  const r = await api.content.categories(kind);
  if (!r.ok) return;
  st.categories = r.categories;
  st.catBox.replaceChildren();
  for (const c of r.categories) {
    if (['fabric', 'forge', 'neoforge', 'quilt', 'iris', 'optifine', 'canvas', 'vanilla'].includes(c.name)) continue; // loaders are chosen by the instance
    const label = el('label', 'catrow');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.addEventListener('change', () => { if (box.checked) st.cats.add(c.name); else st.cats.delete(c.name); runSearch(kind, true); });
    label.append(box, el('span', '', c.name.replace(/-/g, ' ')));
    st.catBox.append(label);
  }
}

function stateLine(kind, text, retry) {
  const st = cp[kind];
  st.state.replaceChildren();
  if (!text) { st.state.classList.add('hidden'); return; }
  st.state.classList.remove('hidden');
  st.state.append(el('div', 'state-text', text));
  if (retry) { const b = el('button', 'pill', 'Try again'); b.addEventListener('click', retry); st.state.append(b); }
}

async function runSearch(kind, fresh) {
  const st = cp[kind];
  if (st.busy) return;
  st.busy = true;
  if (fresh) { st.offset = 0; st.hits = []; st.list.replaceChildren(); st.more.classList.add('hidden'); }
  stateLine(kind, 'Searching Modrinth…');
  const r = await api.content.search({ kind, query: st.query, sort: st.sort, categories: [...st.cats], offset: st.offset });
  st.busy = false;
  if (!r.ok) {
    stateLine(kind, r.code === 'OFFLINE' ? "You're offline. Check your internet connection." : r.message, () => runSearch(kind, fresh));
    return;
  }
  st.total = r.total;
  st.offset += r.hits.length;
  st.hits = st.hits.concat(r.hits);
  for (const h of r.hits) st.list.append(resultCard(kind, h));
  if (!st.hits.length) stateLine(kind, st.query ? 'No results for “' + st.query + '” on Minecraft ' + currentInstance().mcVersion + '.' : 'Nothing found for this version.');
  else stateLine(kind, '');
  st.more.classList.toggle('hidden', st.offset >= st.total);
}

function resultCard(kind, h) {
  const st = cp[kind];
  const card = el('div', 'card result');
  card.append(iconNode(h.icon, h.title.slice(0, 1).toUpperCase()));
  const body = el('div', 'rbody');
  const head = el('div', 'rhead');
  const title = el('span', 'rtitle', h.title);
  const desc = el('div', 'rdesc', h.description);
  title.dataset.raw = '';
  desc.dataset.raw = ''; // other people's text: never translated (AUDIT M8)
  head.append(title, el('span', 'muted', 'by ' + h.author));
  body.append(head, desc);
  const tags = el('div', 'tags');
  tags.append(el('span', 'tag', compact(h.downloads) + ' downloads'));
  for (const c of h.categories.slice(0, 3)) tags.append(el('span', 'tag dim', c));
  body.append(tags);
  card.append(body);

  if (kind === 'modpack') {
    const get = el('button', 'pill accent', 'Install');
    get.addEventListener('click', () => versionDialog(kind, h, null));
    card.append(get);
    return card;
  }

  // Install the best version with one click; the arrow lets the player pick another version.
  const group = el('div', 'split');
  const btn = el('button', 'pill accent', h.installed ? 'Installed' : 'Install');
  btn.disabled = h.installed || appState.state !== 'idle';
  const more = el('button', 'pill accent caret', '▾');
  more.title = 'Choose a version';
  more.disabled = appState.state !== 'idle';
  const done = (r, version) => {
    h.installed = true;
    btn.textContent = 'Installed';
    btn.disabled = true;
    st.items = r.items;
    const extra = r.installed.length > 1 ? ' (with ' + (r.installed.length - 1) + ' required ' + (r.installed.length === 2 ? 'mod' : 'mods') + ')' : '';
    st.status.textContent = 'Installed ' + h.title + (version ? ' ' + version : '') + extra;
    refreshCounts();
  };
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Installing…';
    const r = await api.content.install(kind, h.projectId);
    if (r.ok) done(r);
    else {
      btn.disabled = false;
      btn.textContent = 'Install';
      openDialog('Could not install ' + h.title, (d) => d.append(el('p', 'muted', r.message)), [{ label: 'OK', kind: 'accent', run: closeDialog }]);
    }
  });
  more.addEventListener('click', () => versionDialog(kind, h, done));
  group.append(btn, more);
  card.append(group);
  return card;
}

const TYPE_LABEL = { release: 'Release', beta: 'Beta', alpha: 'Alpha' };
const shortDate = (iso) => (iso ? new Date(iso).toLocaleDateString(UI_LANG, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

/**
 * "Choose a version": every version Modrinth has for this instance (compatible ones first), the most compatible marked Best.
 * done(result, versionNumber) is called after a mod, resource pack or shader pack is installed; modpacks create an instance.
 */
async function versionDialog(kind, h, done) {
  const isPack = kind === 'modpack';
  const inst = currentInstance();
  let showAll = false;
  let busy = false;
  const name = isPack ? nameField(h.title, h.title) : null;
  const list = el('div', 'vlist');
  const err = el('p', 'muted');
  const foot = el('p', 'muted vfoot', isPack
    ? 'Best is the newest release. Modpacks create a new instance.'
    : 'Best is the newest release made for Minecraft ' + inst.mcVersion + (kind === 'mod' ? ' and Fabric' : '') + '.');
  const allLabel = el('label', 'toggle');
  const allBox = document.createElement('input');
  allBox.type = 'checkbox';
  allLabel.append(allBox, el('span', 'switch'), el('span', '', 'Show versions for other Minecraft versions too'));
  if (isPack) allLabel.classList.add('hidden');

  const install = async (v, btn) => {
    if (busy) return;
    if (!isPack && !v.compatible) {
      const go = await new Promise((resolve) => {
        openDialog('Different Minecraft version', (d) => d.append(el('p', 'muted', v.number + ' is made for Minecraft ' + (v.gameVersions.slice(-3).join(', ') || 'another version') + ', not ' + inst.mcVersion + '. It may not work.')), [
          { label: 'Cancel', run: () => { closeDialog(); resolve(false); } },
          { label: 'Install anyway', kind: 'accent', run: () => { closeDialog(); resolve(true); } },
        ]);
      });
      if (!go) { versionDialog(kind, h, done); return; }
      openDialog('Installing…', (d) => d.append(el('p', 'muted', 'Installing ' + h.title + ' ' + v.number + '…')), []);
    }
    busy = true;
    btn.disabled = true;
    btn.textContent = isPack ? 'Creating…' : 'Installing…';
    let stop = null;
    if (isPack) stop = api.content.onEvent((e) => { if (e.type === 'progress') err.textContent = e.text; });
    const r = isPack ? await api.modpack.install(h.projectId, v.id, name.input.value || h.title) : await api.content.install(kind, h.projectId, v.id);
    if (typeof stop === 'function') stop();
    busy = false;
    if (!r.ok) { err.textContent = r.message; btn.disabled = false; btn.textContent = 'Install'; return; }
    closeDialog();
    if (isPack) {
      appState.instances = r.instances;
      appState.selected = r.selected;
      renderHome();
      renderInstances();
      if (typeof onInstanceChanged === 'function') onInstanceChanged();
      navigate('instances');
    } else if (done) done(r, v.number);
  };

  const paint = (versions) => {
    list.replaceChildren();
    if (!versions.length) list.append(el('div', 'state-text', 'No versions found' + (showAll ? '.' : ' for Minecraft ' + inst.mcVersion + '. Try showing versions for other Minecraft versions.')));
    for (const v of versions) {
      const row = el('div', 'vrow' + (v.best ? ' best' : '') + (v.compatible ? '' : ' other'));
      const body = el('div', 'rbody');
      const head = el('div', 'rhead');
      head.append(el('span', 'rtitle', v.number));
      if (v.best) head.append(el('span', 'tag azure', 'Best'));
      if (v.latest && !v.best) head.append(el('span', 'tag', 'Latest'));
      body.append(head);
      const tags = el('div', 'tags');
      tags.append(el('span', v.type === 'release' ? 'tag' : 'tag dim', TYPE_LABEL[v.type] || v.type), el('span', 'tag dim', shortDate(v.date)));
      const gv = v.gameVersions.length > 3 ? v.gameVersions.slice(0, 3).join(', ') + ' +' + (v.gameVersions.length - 3) : v.gameVersions.join(', ');
      if (!isPack) tags.append(el('span', v.compatible ? 'tag dim' : 'tag warn', v.compatible ? 'Minecraft ' + inst.mcVersion : 'For ' + (gv || 'another version')));
      else if (gv) tags.append(el('span', 'tag dim', 'Minecraft ' + gv));
      body.append(tags);
      if (v.name && v.name !== v.number) body.append(rawEl('div', 'meta', v.name));
      row.append(body);
      const b = el('button', 'pill' + (v.best ? ' accent' : ''), 'Install');
      b.disabled = !v.safe;
      if (!v.safe) b.title = 'No safe download for this version';
      b.addEventListener('click', () => install(v, b));
      row.append(b);
      list.append(row);
    }
  };
  const load = async () => {
    list.replaceChildren(el('div', 'state-text', 'Loading versions…'));
    const r = await api.content.versions(kind, h.projectId, showAll);
    if (!r.ok) { list.replaceChildren(el('div', 'state-text', r.code === 'OFFLINE' ? "You're offline. Check your internet connection." : r.message)); return; }
    paint(r.versions);
  };
  allBox.addEventListener('change', () => { showAll = allBox.checked; load(); });

  openDialog((isPack ? 'Install ' : 'Choose a version of ') + h.title, (d) => {
    d.classList.add('wide');
    if (isPack) d.append(name.node);
    d.append(allLabel, list, foot, err);
  }, [{ label: 'Close', run: closeDialog }]);
  load();
}

// ---------- installed ----------
async function loadInstalled(kind) {
  const st = cp[kind];
  if (!st.items) {
    const r = await api.content.list();
    if (!r.ok) { st.ilist.replaceChildren(el('div', 'state-text', r.message)); return; }
    st.items = r.items;
  }
  renderInstalled(kind);
  refreshCounts();
}

function refreshCounts() {
  for (const kind of Object.keys(cp)) {
    const st = cp[kind];
    if (kind === 'modpack') continue;
    const n = st.items ? st.items[kind].length : 0;
    st.tabInstalled.textContent = 'Installed' + (st.items ? ' (' + n + ')' : '');
  }
}

function renderInstalled(kind) {
  const st = cp[kind];
  const items = st.items ? st.items[kind] : [];
  st.ilist.replaceChildren();
  const ups = Object.keys(st.updates).length;
  st.btnAll.classList.toggle('hidden', ups === 0);
  if (!items.length) { st.ilist.append(el('div', 'card empty', KIND_INFO[kind].empty)); return; }
  for (const it of items) {
    const row = el('div', 'card irow' + (it.enabled ? '' : ' off'));
    row.append(iconNode(it.icon, (it.name || '?').slice(0, 1).toUpperCase()));
    const body = el('div', 'rbody');
    const head = el('div', 'rhead');
    head.append(rawEl('span', 'rtitle', it.name), rawEl('span', 'muted', it.version));
    body.append(head);
    const tags = el('div', 'tags');
    if (it.locked) tags.append(el('span', 'tag azure', 'Included'));
    else tags.append(el('span', it.source === 'modrinth' ? 'tag' : 'tag dim', it.source === 'modrinth' ? 'Modrinth' : 'Local file'));
    if (!it.enabled) tags.append(el('span', 'tag dim', 'Off'));
    if (it.loader && it.loader !== 'fabric') tags.append(el('span', 'tag dim', it.loader));
    body.append(tags);
    row.append(body);
    const up = st.updates[kind + '/' + it.base];
    if (up) {
      const b = el('button', 'pill accent', 'Update to ' + up.to);
      b.addEventListener('click', () => updateOne(kind, it.base, b));
      row.append(b);
    }
    if (!it.locked) {
      const sw = el('label', 'toggle compact');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = it.enabled;
      box.addEventListener('change', async () => {
        const r = await api.content.toggle(kind, it.base);
        if (r.ok) { st.items = r.items; renderInstalled(kind); } else { box.checked = it.enabled; toast(r.message); }
      });
      sw.append(box, el('span', 'switch'));
      sw.title = it.enabled ? 'Turn off' : 'Turn on';
      row.append(sw);
      const rm = el('button', 'pill', 'Remove');
      rm.addEventListener('click', () => confirmDialog('Remove “' + it.name + '”?', 'The file is deleted from this instance.', 'Remove', async () => {
        const r = await api.content.remove(kind, it.base);
        if (r.ok) { st.items = r.items; delete st.updates[kind + '/' + it.base]; renderInstalled(kind); refreshCounts(); st.hits.forEach((h) => { if (h.projectId === it.projectId) h.installed = false; }); }
        else toast(r.message);
      }));
      row.append(rm);
    } else {
      row.append(el('span', 'muted', 'Always on'));
    }
    st.ilist.append(row);
  }
}

async function checkUpdates(kind) {
  const st = cp[kind];
  st.status.textContent = 'Checking for updates…';
  const r = await api.content.check();
  if (!r.ok) { st.status.textContent = r.message; return; }
  for (const k of Object.keys(cp)) { cp[k].updates = {}; }
  for (const [key, u] of Object.entries(r.updates)) cp[u.kind].updates[key] = u;
  const n = Object.keys(r.updates).length;
  st.status.textContent = n ? n + (n === 1 ? ' update available' : ' updates available') : 'Everything is up to date.';
  for (const k of Object.keys(cp)) if (cp[k].items) renderInstalled(k);
}

async function updateOne(kind, base, btn) {
  const st = cp[kind];
  btn.disabled = true;
  btn.textContent = 'Updating…';
  const r = await api.content.update(kind, base);
  if (r.ok) { st.items = r.items; delete st.updates[kind + '/' + base]; renderInstalled(kind); st.status.textContent = 'Updated.'; }
  else { btn.disabled = false; toast(r.message); }
}

async function updateAll(kind) {
  const st = cp[kind];
  st.btnAll.disabled = true;
  const r = await api.content.updateAll();
  st.btnAll.disabled = false;
  if (!r.ok) { toast(r.message); return; }
  for (const k of Object.keys(cp)) { cp[k].items = r.items; cp[k].updates = {}; renderInstalled(k); }
  st.status.textContent = r.updated ? 'Updated ' + r.updated + (r.updated === 1 ? ' item.' : ' items.') : 'Everything is up to date.';
}
