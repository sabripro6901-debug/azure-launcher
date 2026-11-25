'use strict';
// The instance page, opened from the instance list in the sidebar: its picture (changeable), name, version, play time
// and last played, Play, settings and a menu; tabs for Content (mods, resource packs, shaders), Files, Worlds and Logs.
// Loaded after renderer.js and content.js; it uses their helpers (el, $, api, appState, openDialog, cp, iconNode ...).

const ip = { id: null, tab: 'content', filter: 'all', sort: 'az', query: '', items: null, updates: {}, checking: false, status: '' };
const IKINDS = [['mod', 'Mods'], ['resourcepack', 'Resource Packs'], ['shader', 'Shaders']];
const ONE_KIND = { mod: 'Mod', resourcepack: 'Resource pack', shader: 'Shader pack' };
const SVG_NS = 'http://www.w3.org/2000/svg';

/** A small line icon from path data (same style as the sidebar icons). */
function svgIcon(paths, cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}
const ICONS = {
  play: ['M7 4.5v15l12-7.5z'],
  gear: ['M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z', 'M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.6 7.6 0 0 0 7 6.5l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.6 7.6 0 0 0 2.6-1.5l2.4 1 2-3.4z'],
  dots: ['M12 5.5h.01M12 12h.01M12 18.5h.01'],
  trash: ['M4.5 7h15', 'M9.5 7V4.5h5V7', 'M6.5 7l1 12.5h9l1-12.5', 'M10 11v5.5M14 11v5.5'],
  tag: ['M3.5 12.5V4.5h8l8.5 8.5-8 8z', 'M8 8.5h.01'],
  timer: ['M12 21a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15z', 'M12 9.5v4l2.5 1.5', 'M9.5 2.5h5'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7.5V12l3 2'],
  upload: ['M12 15.5v-11', 'M7.5 9 12 4.5 16.5 9', 'M4.5 15v4.5h15V15'],
  refresh: ['M19.5 12a7.5 7.5 0 1 1-2.2-5.3', 'M19.5 4.5v4h-4'],
  download: ['M12 4.5v11', 'M7.5 11 12 15.5 16.5 11', 'M4.5 19.5h15'],
  folder: ['M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z'],
  plus: ['M12 5v14M5 12h14'],
  compass: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M15.6 8.4 13.3 13.3 8.4 15.6 10.7 10.7z'],
};

/** An instance's picture: its own one, the Azure logo for Azure instances, else its first letter. */
function instIcon(i, cls) {
  const box = el('span', 'inst-icon' + (cls ? ' ' + cls : ''));
  const src = i.icon || (i.azure ? 'icon.png' : null);
  if (src) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = src;
    img.addEventListener('error', () => { img.remove(); box.textContent = (i.name || '?').slice(0, 1).toUpperCase(); });
    box.append(img);
  } else box.textContent = (i.name || '?').slice(0, 1).toUpperCase();
  return box;
}

const instById = (id) => appState.instances.find((x) => x.id === id) || null;
const instancePageShown = () => !$('page-instance').classList.contains('hidden');

function playText(ms) {
  const m = Math.round((ms || 0) / 60000);
  if (!ms) return 'Not played yet';
  if (m < 1) return 'Less than a minute';
  if (m < 60) return m + (m === 1 ? ' minute' : ' minutes');
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h + (h === 1 ? ' hour' : ' hours') + (r ? ' ' + r + ' min' : '');
}

function lastPlayedText(iso) {
  if (!iso) return 'Never played';
  const d = new Date(iso);
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
  if (days <= 0) return 'Last played today';
  if (days === 1) return 'Last played yesterday';
  if (days < 7) return 'Last played ' + days + ' days ago';
  if (days < 14) return 'Last played last week';
  if (days < 31) return 'Last played ' + Math.floor(days / 7) + ' weeks ago';
  return 'Last played ' + d.toLocaleDateString(UI_LANG, { day: 'numeric', month: 'short', year: 'numeric' });
}

// ---------- sidebar list ----------
function renderRail() {
  const host = $('side-instances');
  if (!host) return;
  host.replaceChildren();
  const open = instancePageShown() ? ip.id : null;
  for (const i of appState.instances) {
    const b = el('button', 'rail' + (i.id === open ? ' active' : ''));
    b.title = i.name + ' · ' + i.loader + ' ' + i.mcVersion;
    b.append(instIcon(i), rawEl('span', 'rail-name', i.name));
    b.addEventListener('click', () => openInstance(i.id));
    host.append(b);
  }
  const add = el('button', 'rail add');
  add.title = 'New instance';
  const plus = el('span', 'inst-icon plus');
  plus.append(svgIcon(ICONS.plus));
  add.append(plus, el('span', 'rail-name', 'New instance'));
  add.addEventListener('click', () => createDialog());
  host.append(add);
}

async function openInstance(id) {
  if (id !== appState.selected) {
    if (homeBedrock) bedrockHomeOff();
    const r = await applyInstances(await api.instances.select(id));
    if (r && !r.ok) { toast(r.message); return; }
  }
  if (ip.id !== id) Object.assign(ip, { id, items: null, updates: {}, query: '', status: '', checked: false });
  navigate('instance');
}

function initInstancePage() {
  renderRail();
  api.instances.onChanged((r) => { appState.instances = r.instances; appState.selected = r.selected; renderRail(); if (instancePageShown()) renderHeader(); });
}

/** Called by navigate(): the sidebar list shows which instance is open. */
function onInstancePageShown(page) {
  renderRail();
  if (page === 'instance') {
    ip.items = null; // read the folder again: files may have been added or removed outside the launcher
    renderInstancePage();
  }
}

/** Called by applyInstances(): names, pictures or the selected instance changed. */
function onInstancesUpdated() {
  renderRail();
  if (!instancePageShown()) return;
  if (!instById(ip.id)) { navigate('instances'); return; }
  if (ip.id !== appState.selected) { Object.assign(ip, { id: appState.selected, items: null, updates: {}, checked: false }); renderInstancePage(); return; }
  renderHeader();
}

/** Called after files were added (Upload files / drop): the list is fresh. */
function onContentChanged(items) {
  ip.items = items;
  if (instancePageShown() && ip.tab === 'content') renderContentList();
}

// ---------- page ----------
const ipEls = {};

function renderInstancePage() {
  const page = $('page-instance');
  const i = instById(ip.id);
  if (!i) return;
  page.replaceChildren();
  ipEls.head = el('div', 'ihead');
  const tabs = el('div', 'itabs');
  for (const [id, label, icon] of [['content', 'Content', ICONS.compass], ['files', 'Files', ICONS.folder], ['worlds', 'Worlds', ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M3.5 9h17M3.5 15h17', 'M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z']], ['logs', 'Logs', ['M4.5 4.5h15v15h-15z', 'M8 9l3 3-3 3', 'M12.5 15h3.5']]]) {
    const b = el('button', 'itab' + (ip.tab === id ? ' on' : ''));
    b.append(svgIcon(icon), el('span', '', label));
    b.addEventListener('click', () => { ip.tab = id; if (id === 'content') ip.items = null; renderInstancePage(); });
    tabs.append(b);
  }
  ipEls.body = el('div', 'ibody');
  page.append(ipEls.head, tabs, ipEls.body);
  renderHeader();
  if (ip.tab === 'content') renderContentTab();
  else if (ip.tab === 'files') renderFilesTab();
  else if (ip.tab === 'worlds') renderWorldsTab();
  else renderLogsTab();
}

function menuAt(anchor, items) {
  const had = anchor.querySelector('.menu');
  document.querySelectorAll('.imenu-host .menu').forEach((m) => m.remove());
  if (had) return;
  const menu = el('div', 'menu');
  for (const it of items) {
    if (!it) continue;
    const b = el('button', it.cls || '', it.label);
    b.disabled = !!it.disabled;
    b.addEventListener('click', (e) => { e.stopPropagation(); menu.remove(); it.run(); });
    menu.append(b);
  }
  anchor.append(menu);
}
document.addEventListener('click', (e) => { if (!e.target.closest('.imenu-host')) document.querySelectorAll('.imenu-host .menu').forEach((m) => m.remove()); });

function renderHeader() {
  const i = instById(ip.id);
  if (!i || !ipEls.head) return;
  const busy = appState.state !== 'idle';
  const h = ipEls.head;
  h.replaceChildren();
  // picture: click to change it
  const pic = el('div', 'imenu-host ipic');
  const picBtn = el('button', 'ipic-btn');
  picBtn.title = 'Change picture';
  picBtn.append(instIcon(i, 'big'), el('span', 'ipic-hint', 'Change'));
  picBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    menuAt(pic, [
      { label: 'Choose a picture…', run: async () => { const r = await api.instances.pickIcon(i.id); if (r && !r.ok) toast(r.message); else if (r && !r.cancelled) applyInstances(r); } },
      i.icon ? { label: 'Use the default picture', run: async () => { const r = await applyInstances(await api.instances.resetIcon(i.id)); if (r && !r.ok) toast(r.message); } } : null,
    ]);
  });
  pic.append(picBtn);
  const title = el('div', 'ititle');
  title.append(rawEl('h1', '', i.name));
  const meta = el('div', 'imeta');
  const part = (icon, text) => { const s = el('span', 'imeta-part'); s.append(svgIcon(icon), el('span', '', text)); return s; };
  meta.append(part(ICONS.tag, (i.fabric ? 'Fabric ' : 'Minecraft ') + i.mcVersion), el('span', 'dot', '•'), part(ICONS.timer, playText(i.playTime)), el('span', 'dot', '•'), part(ICONS.clock, lastPlayedText(i.lastPlayed)));
  title.append(meta);
  const acts = el('div', 'iactions');
  const play = el('button', 'iplay');
  play.append(svgIcon(ICONS.play), el('span', '', busy && i.id === appState.selected ? 'Playing' : 'Play'));
  play.disabled = busy;
  play.addEventListener('click', () => playInstance(i));
  const gear = el('button', 'iround');
  gear.title = 'Instance settings';
  gear.append(svgIcon(ICONS.gear));
  gear.addEventListener('click', () => editDialog(i));
  const moreHost = el('div', 'imenu-host');
  const more = el('button', 'iround plain');
  more.title = 'More';
  more.append(svgIcon(ICONS.dots, 'thick'));
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    menuAt(moreHost, [
      { label: 'Open folder', run: () => api.instances.openFolder(i.id) },
      { label: 'Duplicate', run: async () => { const r = await applyInstances(await api.instances.duplicate(i.id)); if (r && !r.ok) toast(r.message); } },
      { label: 'Export as .mrpack', run: () => exportMrpack(i) },
      { label: 'Delete', cls: 'danger-item', disabled: appState.instances.length < 2 || busy, run: () => confirmDialog('Delete “' + i.name + '”?', 'This deletes its worlds, mods and settings from your computer. It cannot be undone.', 'Delete', async () => {
        const r = await applyInstances(await api.instances.remove(i.id));
        if (r && !r.ok) toast(r.message); else navigate('instances');
      }) },
    ]);
  });
  moreHost.append(more);
  acts.append(play, gear, moreHost);
  h.append(pic, title, acts);
}

// ---------- Content ----------
async function loadItems(force) {
  if (ip.items && !force) return true;
  const r = await api.content.list();
  if (!r.ok) { ipEls.list && ipEls.list.replaceChildren(el('div', 'state-text', r.message)); return false; }
  ip.items = r.items;
  ip.queue = r.queue || [];
  return true;
}

function shareItems(items) {
  ip.items = items;
  if (typeof cp === 'object') for (const k of ['mod', 'resourcepack', 'shader']) if (cp[k]) cp[k].items = items;
}

function renderContentTab() {
  const b = ipEls.body;
  const top = el('div', 'ibar');
  const search = document.createElement('input');
  search.type = 'text';
  search.spellcheck = false;
  search.value = ip.query;
  search.placeholder = 'Search ' + countAll() + ' projects…';
  ipEls.search = search;
  const box = el('div', 'searchbox grow');
  box.append(searchIcon(), search);
  search.addEventListener('input', () => { ip.query = search.value.trim().toLowerCase(); renderContentList(); });
  const up = el('button', 'pill with-icon');
  up.append(svgIcon(ICONS.upload), el('span', '', 'Upload files'));
  up.addEventListener('click', async () => runImport(await api.content.pick('files')));
  const browse = el('button', 'pill accent with-icon');
  browse.append(svgIcon(ICONS.compass), el('span', '', 'Browse content'));
  browse.addEventListener('click', () => navigate(ip.filter === 'resourcepack' ? 'resourcepacks' : ip.filter === 'shader' ? 'shaders' : 'mods'));
  top.append(box, up, browse);

  const bar = el('div', 'ibar');
  const sort = document.createElement('select');
  for (const [v, t] of [['az', 'Name (A-Z)'], ['za', 'Name (Z-A)'], ['off', 'Turned off first']]) {
    const o = document.createElement('option');
    o.value = v; o.textContent = t; o.selected = ip.sort === v;
    sort.append(o);
  }
  sort.addEventListener('change', () => { ip.sort = sort.value; renderContentList(); });
  ipEls.pills = el('div', 'ipills');
  ipEls.status = el('span', 'muted istatus', ip.status);
  const right = el('div', 'iright');
  ipEls.updAll = el('button', 'link with-icon');
  ipEls.updAll.append(svgIcon(ICONS.download), el('span', '', 'Update all'));
  ipEls.updAll.addEventListener('click', updateAllHere);
  const refresh = el('button', 'link with-icon');
  refresh.append(svgIcon(ICONS.refresh), el('span', '', 'Refresh'));
  refresh.addEventListener('click', async () => { ip.status = ''; await loadItems(true); renderContentList(); checkHere(); });
  right.append(ipEls.status, ipEls.updAll, refresh);
  bar.append(sort, ipEls.pills, right);

  ipEls.table = el('div', 'itable');
  const head = el('div', 'ithead');
  head.append(el('span', 'c-proj', 'Project'), el('span', 'c-ver', 'Version'), el('span', 'c-act', 'Actions'));
  ipEls.list = el('div', 'ilist2');
  ipEls.table.append(head, ipEls.list);
  const zone = el('div', 'dropzone small', 'Drop mods (.jar), resource packs or shader packs (.zip) here to add them.');
  b.append(top, bar, ipEls.table, zone);
  // dropping files anywhere on the tab adds them
  const over = (on) => zone.classList.toggle('over', on);
  b.addEventListener('dragenter', (e) => { e.preventDefault(); over(true); });
  b.addEventListener('dragover', (e) => { e.preventDefault(); over(true); });
  b.addEventListener('dragleave', (e) => { if (!b.contains(e.relatedTarget)) over(false); });
  b.addEventListener('drop', (e) => { e.preventDefault(); over(false); const paths = api.content.pathsFor(e.dataTransfer.files); if (paths.length) runImport(paths); });

  ipEls.list.replaceChildren(el('div', 'state-text', 'Loading…'));
  loadItems(false).then((ok) => { if (ok) { renderContentList(); if (!ip.checked) checkHere(); } });
}

function countAll() {
  if (!ip.items) return '';
  return IKINDS.reduce((n, [k]) => n + ip.items[k].length, 0);
}

function renderContentList() {
  if (!ipEls.list || !ip.items) return;
  if (ipEls.search) ipEls.search.placeholder = 'Search ' + countAll() + ' projects…';
  // filter pills with counts
  ipEls.pills.replaceChildren();
  for (const [k, label] of [['all', 'All'], ...IKINDS]) {
    const n = k === 'all' ? countAll() : ip.items[k].length;
    if (k !== 'all' && !n) continue;
    const b = el('button', 'chipbtn' + (ip.filter === k ? ' on' : ''), label);
    b.addEventListener('click', () => { ip.filter = k; renderContentList(); });
    ipEls.pills.append(b);
  }
  const ups = Object.keys(ip.updates).length;
  ipEls.updAll.classList.toggle('hidden', ups === 0);
  ipEls.updAll.lastChild.textContent = ups ? 'Update all (' + ups + ')' : 'Update all';
  let rows = [];
  for (const [k] of IKINDS) if (ip.filter === 'all' || ip.filter === k) rows.push(...ip.items[k]);
  if (ip.query) rows = rows.filter((it) => (it.name + ' ' + it.base + ' ' + (it.version || '')).toLowerCase().includes(ip.query));
  rows.sort((a, b) => (ip.sort === 'off' ? Number(a.enabled) - Number(b.enabled) : 0) || Number(b.locked) - Number(a.locked) || (ip.sort === 'za' ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name)));
  ipEls.list.replaceChildren();
  // Changes queued in the game's Mod Manager (or here): they apply when the game starts next.
  for (const q of ip.queue || []) {
    const row = el('div', 'itrow queued');
    const proj = el('div', 'c-proj');
    proj.append(iconNode(null, (q.name || '?').slice(0, 1).toUpperCase()));
    const names = el('div', 'names');
    names.append(rawEl('span', 'rtitle', q.name), el('span', 'muted small', q.text));
    proj.append(names);
    const ver = el('div', 'c-ver');
    ver.append(rawEl('span', 'vnum', q.newVersion || q.oldVersion || '—'), rawEl('span', 'muted small', q.file));
    const act = el('div', 'c-act');
    act.append(el('span', 'qtag', 'Applies on restart'));
    const undo = el('button', 'pill small', 'Undo');
    undo.addEventListener('click', async () => {
      const r = await api.content.unqueue(q.id);
      if (r && !r.ok) { toast(r.message); return; }
      await loadItems(true);
      renderContentList();
    });
    act.append(undo);
    row.append(proj, ver, act);
    ipEls.list.append(row);
  }
  if (!rows.length && !(ip.queue || []).length) {
    ipEls.list.append(el('div', 'state-text', ip.query ? 'Nothing matches “' + ip.query + '”.' : 'Nothing here yet. Use Browse content or drop files here.'));
    return;
  }
  for (const it of rows) ipEls.list.append(contentRow(it));
}

function contentRow(it) {
  const row = el('div', 'itrow' + (it.enabled ? '' : ' off'));
  const proj = el('div', 'c-proj');
  proj.append(iconNode(it.icon || (it.locked && /azure/i.test(it.name) ? 'icon.png' : null), (it.name || '?').slice(0, 1).toUpperCase()));
  const names = el('div', 'names');
  names.append(rawEl('span', 'rtitle', it.name));
  const src = it.locked ? 'Included with Azure' : it.source === 'modrinth' ? 'Modrinth' : 'Uploaded file';
  names.append(el('span', 'muted small', ONE_KIND[it.kind] + ' · ' + src));
  proj.append(names);
  const ver = el('div', 'c-ver');
  ver.append(el('span', 'vnum', it.version || (it.folder ? 'Folder' : '—')), el('span', 'muted small', it.file || 'Added when the game starts'));
  const act = el('div', 'c-act');
  const up = ip.updates[it.kind + '/' + it.base];
  if (up) {
    const b = el('button', 'pill accent small', 'Update to ' + up.to);
    b.addEventListener('click', () => updateOneHere(it, b));
    act.append(b);
  }
  if (it.locked) {
    act.append(el('span', 'muted small', 'Always on'));
  } else {
    const sw = el('label', 'toggle compact');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = it.enabled;
    box.addEventListener('change', async () => {
      const r = await api.content.toggle(it.kind, it.base);
      if (r.ok) { shareItems(r.items); renderContentList(); } else { box.checked = it.enabled; toast(r.message); }
    });
    sw.append(box, el('span', 'switch'));
    sw.title = it.enabled ? 'Turn off' : 'Turn on';
    const del = el('button', 'iicon');
    del.title = 'Delete';
    del.append(svgIcon(ICONS.trash));
    del.addEventListener('click', () => confirmDialog('Delete “' + it.name + '”?', 'The file is deleted from this instance.', 'Delete', async () => {
      const r = await api.content.remove(it.kind, it.base);
      if (r.ok) { delete ip.updates[it.kind + '/' + it.base]; shareItems(r.items); renderContentList(); } else toast(r.message);
    }));
    act.append(sw, del);
  }
  const host = el('div', 'imenu-host');
  const more = el('button', 'iicon');
  more.title = 'More';
  more.append(svgIcon(ICONS.dots, 'thick'));
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    menuAt(host, [
      it.file ? { label: 'Show file', run: () => api.content.reveal(it.kind, it.file) } : null,
      it.projectId ? { label: 'Open on Modrinth', run: () => api.openExternal('https://modrinth.com/project/' + encodeURIComponent(it.projectId)) } : null,
      { label: 'Open folder', run: () => api.instances.openSub(ip.id, it.kind === 'mod' ? 'mods' : it.kind === 'shader' ? 'shaderpacks' : 'resourcepacks') },
    ]);
  });
  host.append(more);
  act.append(host);
  row.append(proj, ver, act);
  return row;
}

async function checkHere() {
  ip.checked = true;
  setStatus('Checking for updates…');
  const r = await api.content.check();
  if (!r.ok) { setStatus(r.message); return; }
  ip.updates = r.updates;
  const n = Object.keys(r.updates).length;
  setStatus(n ? n + (n === 1 ? ' update available' : ' updates available') : 'Everything is up to date');
  renderContentList();
}

function setStatus(t) { ip.status = t; if (ipEls.status) ipEls.status.textContent = t; }

async function updateOneHere(it, btn) {
  btn.disabled = true;
  btn.textContent = 'Updating…';
  const r = await api.content.update(it.kind, it.base);
  if (r.ok) { delete ip.updates[it.kind + '/' + it.base]; shareItems(r.items); renderContentList(); setStatus('Updated ' + it.name); }
  else { btn.disabled = false; btn.textContent = 'Update'; toast(r.message); }
}

async function updateAllHere() {
  ipEls.updAll.disabled = true;
  setStatus('Updating…');
  const r = await api.content.updateAll();
  ipEls.updAll.disabled = false;
  if (!r.ok) { setStatus(''); toast(r.message); return; }
  ip.updates = {};
  shareItems(r.items);
  setStatus(r.updated ? 'Updated ' + r.updated + (r.updated === 1 ? ' item' : ' items') : 'Everything is up to date');
  renderContentList();
}
api.content.onEvent((e) => { if (e.type === 'progress' && instancePageShown()) setStatus(e.text); });

// ---------- Files ----------
function renderFilesTab() {
  const list = el('div', 'flist');
  for (const [sub, label, note] of [['', 'Instance folder', 'Everything of this instance'], ['mods', 'Mods', 'mods'], ['resourcepacks', 'Resource packs', 'resourcepacks'], ['shaderpacks', 'Shader packs', 'shaderpacks'], ['saves', 'Worlds', 'saves'], ['config', 'Mod settings', 'config'], ['screenshots', 'Screenshots', 'screenshots'], ['logs', 'Logs', 'logs']]) {
    const row = el('div', 'frow');
    const ic = el('span', 'ficon');
    ic.append(svgIcon(ICONS.folder));
    const names = el('div', 'names');
    names.append(el('span', 'rtitle', label), el('span', 'muted small', note));
    const open = el('button', 'pill small', 'Open');
    open.addEventListener('click', () => api.instances.openSub(ip.id, sub));
    row.append(ic, names, open);
    list.append(row);
  }
  ipEls.body.append(list);
}

// ---------- Worlds ----------
async function renderWorldsTab() {
  const host = el('div', 'wgrid');
  ipEls.body.append(host);
  host.append(el('div', 'state-text', 'Loading…'));
  const worlds = await api.instances.worlds(ip.id);
  host.replaceChildren();
  if (!worlds.length) { host.append(el('div', 'state-text', 'No worlds yet. Play this instance and create one.')); return; }
  for (const w of worlds) {
    const card = el('div', 'wcard');
    card.append(iconNode(w.icon, (w.name || '?').slice(0, 1).toUpperCase()));
    const names = el('div', 'names');
    names.append(rawEl('span', 'rtitle', w.name), el('span', 'muted small', lastPlayedText(w.played)));
    const open = el('button', 'pill small', 'Open folder');
    open.addEventListener('click', () => api.instances.openWorld(ip.id, w.name));
    card.append(names, open);
    host.append(card);
  }
}

// ---------- Logs ----------
async function renderLogsTab() {
  const bar = el('div', 'ibar');
  const when = el('span', 'muted', '');
  const refresh = el('button', 'pill small with-icon');
  refresh.append(svgIcon(ICONS.refresh), el('span', '', 'Refresh'));
  const folder = el('button', 'pill small', 'Open logs folder');
  folder.addEventListener('click', () => api.instances.openSub(ip.id, 'logs'));
  bar.append(when, el('span', 'grow'), refresh, folder);
  const pre = el('pre', 'ilog');
  ipEls.body.append(bar, pre);
  const load = async () => {
    const r = await api.instances.log(ip.id);
    pre.textContent = r.text || 'No log yet. It appears here after the game has started once.';
    when.textContent = r.when ? 'latest.log · ' + new Date(r.when).toLocaleString(UI_LANG) : '';
    pre.scrollTop = pre.scrollHeight;
  };
  refresh.addEventListener('click', load);
  load();
}
