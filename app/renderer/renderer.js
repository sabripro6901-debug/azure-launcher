'use strict';
// The page. It only talks to the launcher through window.azure (see preload.js).
const $ = (id) => document.getElementById(id);
const api = window.azure;

let appState = null;
let codeInfo = null;
const headUrls = new Map();

const SIGNIN_OFF = "Sign-in isn't available yet.";

// What the launch is doing, from the launcher's progress messages.
const run = { downloading: false, starting: false, lib: 0, assets: 0, java: 0, stage: '', error: '', logs: false };
const resetRun = () => Object.assign(run, { downloading: false, starting: false, lib: 0, assets: 0, java: 0, stage: '', error: '', logs: false });
const percent = () => Math.min(100, Math.round(100 * (0.1 * run.lib + 0.6 * run.assets + 0.3 * run.java)));

const gb = (mb) => (mb / 1024).toFixed(2).replace(/\.?0+$/, '') + ' GB';
const instance = () => appState.instances.find((i) => i.id === appState.selected) || appState.instances[0];
const selectedAccount = () => (appState.accounts || []).find((a) => a.selected) || null;

/** The account list from main; when something went wrong it also carries a message to show. */
function accountsAnswer(r) {
  if (Array.isArray(r)) return r;
  if (r && r.message) toast(r.message);
  return (r && r.accounts) || [];
}

/** Puts text into a fixed element; a name (isName) is marked never to translate, our own text is translated. */
function setNameText(node, text, isName) {
  if (isName) node.dataset.raw = ''; else delete node.dataset.raw;
  node.textContent = text;
}

/** An element showing a name the player or a mod author chose: never translated (AUDIT M8). */
function rawEl(tag, cls, text) {
  const e = el(tag, cls, text);
  e.dataset.raw = '';
  return e;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// The Browse button opens the Modrinth pages (modpacks, mods, resource packs, shaders), on the one used last.
const BROWSE_PAGES = ['modpacks', 'mods', 'resourcepacks', 'shaders'];
let lastBrowse = 'mods';
function navigate(page) {
  if (page === 'browse') page = lastBrowse;
  if (BROWSE_PAGES.includes(page)) lastBrowse = page;
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('hidden', p.id !== 'page-' + page));
  document.querySelectorAll('.nav').forEach((n) => n.classList.toggle('active', n.dataset.page === page || (n.dataset.page === 'browse' && BROWSE_PAGES.includes(page))));
  $('side-account').classList.toggle('active', page === 'accounts');
  if (typeof onPageShown === 'function') onPageShown(page);
  if (typeof onInstancePageShown === 'function') onInstancePageShown(page);
}
// Test hooks for the dev screenshot scripts: only defined in a dev run (never in the packaged launcher).
function installTestHooks() {
  window.__nav = navigate; // used by the screenshot test
  window.__refresh = async () => { appState = await api.state(); renderAccounts(appState.accounts); renderInstances(); renderHome(); if (typeof onInstanceChanged === 'function') onInstanceChanged(); }; // same
}
document.querySelectorAll('[data-page]').forEach((n) => n.addEventListener('click', () => navigate(n.dataset.page)));

// ---------- dialogs ----------
function closeDialog() { $('modal').classList.add('hidden'); $('dialog').replaceChildren(); }
function openDialog(title, build, actions) {
  const d = $('dialog');
  d.replaceChildren(el('h2', '', title));
  build(d);
  const row = el('div', 'actions');
  for (const a of actions) {
    const b = el('button', 'pill' + (a.kind ? ' ' + a.kind : ''), a.label);
    b.addEventListener('click', () => a.run(b));
    row.append(b);
  }
  d.append(row);
  $('modal').classList.remove('hidden');
  return { actions: [...row.children] };
}
function confirmDialog(title, text, label, onYes) {
  openDialog(title, (d) => d.append(el('p', 'muted', text)), [
    { label: 'Cancel', run: closeDialog },
    { label, kind: 'confirm-danger', run: async () => { closeDialog(); await onYes(); } },
  ]);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDialog(); openLogs(false); } });
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeDialog(); });

// ---------- heads ----------
function setHead(node, account) {
  node.replaceChildren();
  if (!account) { node.textContent = '?'; return; }
  node.textContent = (account.name || '?').slice(0, 1).toUpperCase();
  const apply = (urls) => {
    if (!urls) return;
    node.replaceChildren();
    for (const src of [urls.head, urls.hat]) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = src;
      node.append(img);
    }
  };
  if (headUrls.has(account.uuid)) { apply(headUrls.get(account.uuid)); return; }
  api.accounts.head(account.uuid).then((urls) => { headUrls.set(account.uuid, urls); apply(urls); });
}

// ---------- the launch button ----------
function renderHome() {
  const inst = instance();
  const acc = selectedAccount();
  const signinOff = !appState.configured;
  setNameText($('picker-name'), inst.name, true);
  $('sum-version').textContent = 'Minecraft ' + inst.mcVersion + ' · ' + inst.loader + (inst.azure ? ' · Azure' : '');
  const note = $('sum-note');
  note.textContent = inst.azure ? '' : 'Azure features not available on this version';
  note.classList.toggle('hidden', inst.azure);
  setNameText($('sum-account'), acc ? acc.name : 'Not signed in', !!acc);
  setHead($('sum-head'), acc);
  setNameText($('side-name'), acc ? acc.name : 'Sign in', !!acc);
  setHead($('side-head'), acc);
  $('launcher-version').textContent = 'Azure Launcher ' + appState.version;
  $('dev-badge').classList.toggle('hidden', !appState.dev);
  $('dev-badge-side').classList.toggle('hidden', !appState.dev);

  const btn = $('launch');
  const label = $('launch-label');
  const fill = $('launch-fill');
  const under = $('under');
  const group = $('launch-group');
  btn.disabled = false;
  btn.classList.remove('progress', 'busy', 'playing', 'off');
  group.classList.remove('off');
  fill.style.width = '';
  under.className = 'under';
  under.textContent = '';
  $('stop-game').classList.toggle('hidden', appState.state !== 'running');
  const st = appState.state;
  if (st === 'preparing') {
    btn.disabled = true;
    btn.classList.add('progress');
    if (run.starting) {
      label.textContent = 'Starting…';
      fill.style.width = '100%';
      under.textContent = 'Starting the game…';
    } else if (run.downloading) {
      label.textContent = 'Installing ' + percent() + '%';
      fill.style.width = percent() + '%';
      under.textContent = 'Downloading game files…';
    } else {
      label.textContent = 'Preparing…';
      btn.classList.add('busy');
      under.textContent = run.stage || 'Getting ready…';
    }
  } else if (st === 'running') {
    btn.disabled = true;
    btn.classList.add('playing');
    group.classList.add('off');
    label.textContent = 'Playing';
  } else if (!acc) {
    label.textContent = 'Sign in';
    if (signinOff) {
      btn.disabled = true;
      btn.classList.add('off');
      group.classList.add('off');
      under.textContent = SIGNIN_OFF;
    }
  } else {
    label.textContent = 'Launch';
    if (run.error) {
      under.className = 'under error';
      under.textContent = run.error + ' ';
      if (run.logs) {
        const link = el('button', 'link', 'Open the logs');
        link.addEventListener('click', () => openLogs(true));
        under.append(link);
      }
    }
  }
}

function noteProgress(text) {
  let m;
  if ((m = /^libraries (\d+)\/(\d+)/.exec(text))) { run.downloading = true; run.lib = m[1] / m[2]; }
  else if (/^libraries ok/.test(text)) run.lib = 1;
  else if ((m = /^assets (\d+)\/(\d+)/.exec(text))) { run.downloading = true; run.assets = m[1] / m[2]; }
  else if (/^assets ok/.test(text)) run.assets = 1;
  else if ((m = /^\s*java (\d+)\/(\d+)/.exec(text))) { run.downloading = true; run.java = m[1] / m[2]; }
  else if (/^Azure jar:/.test(text)) { run.lib = run.assets = run.java = 1; }
  else if (/^Starting the game/.test(text)) run.starting = true;
}

$('launch').addEventListener('click', async () => {
  if (!selectedAccount()) { navigate('accounts'); return; }
  resetRun();
  renderHome();
  await api.launch();
});

$('stop-game').addEventListener('click', () => {
  confirmDialog('Stop the game?', "Minecraft will close right away. Anything you haven't saved in the game is lost.", 'Stop game', () => api.stopGame());
});

// ---------- instance picker (Home) ----------
function renderPicker() {
  const menu = $('picker-menu');
  menu.replaceChildren();
  for (const i of appState.instances) {
    const b = rawEl('button', i.id === appState.selected ? 'on' : '', i.name);
    b.addEventListener('click', async () => { menu.classList.add('hidden'); await applyInstances(await api.instances.select(i.id)); });
    menu.append(b);
  }
}
$('picker').addEventListener('click', (e) => {
  e.stopPropagation();
  if (appState.state !== 'idle') return;
  renderPicker();
  $('picker-menu').classList.toggle('hidden');
});
document.addEventListener('click', () => $('picker-menu').classList.add('hidden'));

// ---------- logs drawer ----------
const logEl = $('log');
const drawer = $('drawer');
function openLogs(open) {
  drawer.classList.toggle('open', open);
  drawer.setAttribute('aria-hidden', String(!open));
  $('scrim').classList.toggle('hidden', !open);
  if (open) logEl.scrollTop = logEl.scrollHeight;
}
$('logs-open').addEventListener('click', () => openLogs(true));
$('log-close').addEventListener('click', () => openLogs(false));
$('scrim').addEventListener('click', () => openLogs(false));
$('log-clear').addEventListener('click', () => { logEl.textContent = ''; });

function addLog(line) {
  const atEnd = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 24;
  logEl.append(document.createTextNode(line + '\n'));
  while (logEl.childNodes.length > 1500) logEl.removeChild(logEl.firstChild);
  if (atEnd) logEl.scrollTop = logEl.scrollHeight;
}

api.onLaunch((e) => {
  if (e.type === 'state') {
    appState.state = e.state;
    renderHome();
    renderInstances();
  } else if (e.type === 'status') {
    if (e.clear) logEl.textContent = '';
    if (e.text) { run.stage = e.text.endsWith('…') ? e.text : e.text + '…'; noteProgress(e.text); }
    renderHome();
  } else if (e.type === 'log') {
    addLog(e.line);
    noteProgress(e.line);
    if (appState.state === 'preparing') renderHome();
  } else if (e.type === 'openLog') {
    openLogs(true);
  } else if (e.type === 'error') {
    run.error = e.message;
    run.logs = !!e.logs;
    renderHome();
  } else if (e.type === 'modproblems') {
    resetRun();
    renderHome();
    showModProblems(e.report);
  } else if (e.type === 'exit') {
    resetRun();
    if (e.code !== 0 && !e.stopped) { run.error = 'The game closed unexpectedly.'; run.logs = true; }
    renderHome();
  }
});

// ---------- instances ----------
async function applyInstances(r) {
  if (!r || !r.ok) { return r; }
  appState.instances = r.instances;
  appState.selected = r.selected;
  renderHome();
  renderInstances();
  if (typeof onInstanceChanged === 'function') onInstanceChanged();
  if (typeof onInstancesUpdated === 'function') onInstancesUpdated();
  return r;
}

function ramText(i) { return i.ram ? gb(i.ram) : 'Default (' + gb(appState.settings.ram) + ')'; }

function when(iso) {
  if (!iso) return 'Never played';
  const d = new Date(iso);
  return 'Played ' + d.toLocaleDateString(UI_LANG, { day: 'numeric', month: 'short', year: 'numeric' });
}

function closeMenus() { document.querySelectorAll('.card .menu').forEach((m) => m.remove()); }
document.addEventListener('click', closeMenus);

async function playInstance(i) {
  await applyInstances(await api.instances.select(i.id));
  navigate('home');
  if (!selectedAccount()) { navigate('accounts'); return; }
  resetRun();
  renderHome();
  await api.launch();
}

function renderInstances() {
  const host = $('instance-list');
  host.replaceChildren();
  host.className = 'grid';
  const busy = appState.state !== 'idle';
  for (const i of appState.instances) {
    const card = el('div', 'card instance' + (i.id === appState.selected ? ' selected' : ''));
    card.addEventListener('click', async (e) => {
      if (e.target.closest('button, .menu')) return;
      if (i.id !== appState.selected) await applyInstances(await api.instances.select(i.id));
    });
    const top = el('div', 'top');
    top.append(rawEl('div', 'title', i.name));
    const more = el('button', 'more', '⋯');
    more.title = 'More';
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      const had = card.querySelector('.menu');
      closeMenus();
      if (had) return;
      const menu = el('div', 'menu');
      const item = (label, fn, cls) => { const b = el('button', cls || '', label); b.addEventListener('click', () => { closeMenus(); fn(); }); menu.append(b); return b; };
      item('Edit', () => editDialog(i));
      item('Duplicate', async () => { const r = await applyInstances(await api.instances.duplicate(i.id)); if (r && !r.ok) toast(r.message); });
      item('Export as .mrpack', () => exportMrpack(i));
      item('Open folder', () => api.instances.openFolder(i.id));
      const del = item('Delete', () => confirmDialog('Delete “' + i.name + '”?', 'This deletes its worlds, mods and settings from your computer. It cannot be undone.', 'Delete', async () => {
        const r = await applyInstances(await api.instances.remove(i.id));
        if (r && !r.ok) toast(r.message);
      }), 'danger-item');
      del.disabled = appState.instances.length < 2 || busy;
      card.append(menu);
    });
    top.append(more);
    const tags = el('div', 'tags');
    tags.append(el('span', 'tag', 'Minecraft ' + i.mcVersion), el('span', 'tag', i.loader));
    tags.append(el('span', i.azure ? 'tag azure' : 'tag dim', i.azure ? 'Includes Azure Client' : 'No Azure'));
    const meta = el('div', 'meta', 'Memory: ' + ramText(i) + '  ·  ' + when(i.lastPlayed));
    const notes = [];
    if (!i.azure) notes.push('Azure features not available on this version');
    if (!i.fabric) notes.push('Mods are off (no Fabric for this version)');
    const foot = el('div', 'foot-row');
    const play = el('button', 'pill accent', 'Play');
    play.disabled = busy;
    play.addEventListener('click', () => playInstance(i));
    foot.append(play);
    card.append(top, tags, meta);
    if (notes.length) card.append(el('div', 'meta', notes.join('  ·  ')));
    card.append(foot);
    host.append(card);
  }
}

let toastTimer = null;
function toast(text) {
  const note = $('under');
  note.className = 'under error';
  note.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { note.textContent = ''; note.className = 'under'; }, 6000);
  openDialog('Something went wrong', (d) => d.append(el('p', 'muted', text)), [{ label: 'OK', kind: 'accent', run: closeDialog }]);
}

/** Memory choice used by the create and edit dialogs: default, or an own amount. */
function ramField(current) {
  const wrap = el('label', 'field');
  wrap.append(el('span', 'cap', 'Memory'));
  const toggle = el('label', 'toggle');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = !current;
  toggle.append(box, el('span', 'switch'), el('span', '', 'Use the launcher\'s default (' + gb(appState.settings.ram) + ')'));
  const row = el('div', 'slider-row');
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '1024'; slider.max = '16384'; slider.step = '256';
  slider.value = String(current || appState.settings.ram);
  const out = el('span', '', gb(Number(slider.value)));
  row.append(slider, out);
  const sync = () => { row.classList.toggle('hidden', box.checked); out.textContent = gb(Number(slider.value)); };
  box.addEventListener('change', sync);
  slider.addEventListener('input', sync);
  sync();
  wrap.append(toggle, row);
  return { node: wrap, value: () => (box.checked ? null : Number(slider.value)) };
}

function nameField(value, placeholder) {
  const wrap = el('label', 'field');
  wrap.append(el('span', 'cap', 'Name'));
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value || '';
  input.placeholder = placeholder || '';
  input.maxLength = 40;
  input.spellcheck = false;
  wrap.append(input);
  return { node: wrap, input };
}

function editDialog(i) {
  const name = nameField(i.name);
  const ram = ramField(i.ram);
  const err = el('p', 'muted');
  openDialog('Edit instance', (d) => d.append(name.node, ram.node, err), [
    { label: 'Cancel', run: closeDialog },
    { label: 'Save', kind: 'accent', run: async () => {
      const r = await applyInstances(await api.instances.update(i.id, { name: name.input.value, ram: ram.value() }));
      if (r && r.ok) closeDialog(); else err.textContent = (r && r.message) || '';
    } },
  ]);
}

function infoLines(v, azureKnown) {
  const lines = [];
  if (v.fabric) lines.push('Fabric is installed, so mods work.');
  else lines.push('No Fabric for this version: it runs as plain Minecraft, and the Mods page is off.');
  if (v.azure) lines.push('Azure Client is included, and Azure and Fabric API are locked (they can\'t be removed).');
  else lines.push(azureKnown ? 'Azure features not available on this version.' : 'Could not check which versions have Azure right now.');
  return lines;
}

/** A styled picker with a search box: the same look as the Home instance picker. */
function searchPicker({ placeholder, empty }) {
  const wrap = el('div', 'sp');
  const btn = el('button', 'sp-btn');
  const label = el('span', 'sp-label', '');
  btn.append(label, el('span', 'sp-chev', '▾'));
  const panel = el('div', 'sp-panel hidden');
  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = placeholder || 'Search';
  search.spellcheck = false;
  const list = el('div', 'sp-list');
  panel.append(search, list);
  wrap.append(btn, panel);
  let items = [];
  let value = '';
  let onChange = () => {};
  const paint = () => {
    const q = search.value.trim().toLowerCase();
    list.replaceChildren();
    const shown = items.filter((i) => !q || i.label.toLowerCase().includes(q) || (i.tag || '').toLowerCase().includes(q));
    if (!shown.length) list.append(el('div', 'sp-empty', empty || 'Nothing found'));
    for (const i of shown) {
      const b = el('button', 'sp-item' + (i.value === value ? ' on' : ''));
      b.append(el('span', '', i.label));
      if (i.tag) b.append(el('span', 'sp-tag' + (i.accent ? ' azure' : ''), i.tag));
      b.addEventListener('click', () => { set(i.value); panel.classList.add('hidden'); onChange(i.value); });
      list.append(b);
    }
  };
  const set = (v) => {
    value = v;
    const cur = items.find((i) => i.value === v);
    label.textContent = cur ? cur.label + (cur.tag ? '  ·  ' + cur.tag : '') : '';
    paint();
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (btn.disabled) return;
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) { search.value = ''; paint(); search.focus(); }
  });
  panel.addEventListener('click', (e) => e.stopPropagation());
  search.addEventListener('input', paint);
  document.addEventListener('click', () => panel.classList.add('hidden'));
  return {
    node: wrap,
    get value() { return value; },
    setItems(next, selected) { items = next; set(selected !== undefined ? selected : value); },
    setBusy(text) { btn.disabled = true; label.textContent = text; },
    enable() { btn.disabled = false; },
    onChange(cb) { onChange = cb; },
  };
}

async function createDialog() {
  const name = nameField('', 'Minecraft 1.21.11');
  const version = el('div', 'field');
  version.append(el('span', 'cap', 'Minecraft version'));
  const picker = searchPicker({ placeholder: 'Search versions, e.g. 1.20', empty: 'No version matches' });
  picker.setBusy('Loading versions…');
  const snaps = el('label', 'toggle');
  const snapBox = document.createElement('input');
  snapBox.type = 'checkbox';
  snaps.append(snapBox, el('span', 'switch'), el('span', '', 'Show snapshots'));
  version.append(picker.node, snaps);
  const info = el('div', 'infobox');
  const ram = ramField(null);
  const err = el('p', 'muted');
  let versions = [];
  let azureKnown = true;
  let busy = false;

  const dlg = openDialog('New instance', (d) => d.append(name.node, version, info, ram.node, err), [
    { label: 'Cancel', run: closeDialog },
    { label: 'Create instance', kind: 'accent', run: async (b) => {
      if (busy || !picker.value) return;
      busy = true;
      b.disabled = true;
      b.textContent = 'Creating…';
      const r = await applyInstances(await api.instances.create({ name: name.input.value || name.input.placeholder, mcVersion: picker.value, ram: ram.value() }));
      if (r && r.ok) { closeDialog(); navigate('instances'); }
      else { err.textContent = (r && r.message) || 'Could not create the instance.'; busy = false; b.disabled = false; b.textContent = 'Create instance'; }
    } },
  ]);
  const createBtn = dlg.actions[1];
  createBtn.disabled = true;

  const showInfo = () => {
    const v = versions.find((x) => x.id === picker.value);
    info.replaceChildren();
    if (!v) return;
    name.input.placeholder = 'Minecraft ' + v.id;
    for (const l of infoLines(v, azureKnown)) info.append(el('div', '', l));
  };
  const load = async () => {
    createBtn.disabled = true;
    picker.setBusy('Loading versions…');
    const r = await api.versions.list({ snapshots: snapBox.checked });
    if (!r.ok) { picker.setBusy('Could not load versions'); err.textContent = r.message; return; }
    versions = r.versions;
    azureKnown = r.azureKnown;
    const keep = versions.find((v) => v.id === (appState.instances[0] && appState.instances[0].mcVersion));
    picker.setItems(versions.map((v, n) => ({
      value: v.id,
      label: v.id + (v.type === 'snapshot' ? ' (snapshot)' : '') + (n === 0 ? ' (latest)' : ''),
      tag: v.azure ? 'Azure' : v.fabric ? 'Fabric' : 'Vanilla',
      accent: v.azure,
    })), (keep || versions[0] || {}).id);
    picker.enable();
    createBtn.disabled = false;
    showInfo();
  };
  picker.onChange(showInfo);
  snapBox.addEventListener('change', load);
  load();
}
$('new-instance').addEventListener('click', createDialog);

async function exportMrpack(i) {
  const r = await api.mrpack.exportPack(i.id);
  if (r.cancelled) return;
  if (!r.ok) { toast(r.message); return; }
  openDialog('Exported', (d) => {
    d.append(el('p', 'muted', 'Saved ' + r.files + ' mods and packs as download links' + (r.overrides ? ' and ' + r.overrides + ' files inside the pack' : '') + '. Azure Client is not included: the launcher adds it itself.'));
    d.append(el('code', '', r.path));
  }, [{ label: 'OK', kind: 'accent', run: closeDialog }]);
}

async function importMrpack() {
  const r = await api.mrpack.pick();
  if (r.cancelled) return;
  if (!r.ok) { toast(r.message); return; }
  const s = r.summary;
  const name = nameField(s.name, s.name);
  const lines = [
    'Minecraft ' + s.mc + ' · ' + s.loader,
    s.files + ' files to download, each checked against the pack\'s hashes.',
    s.azure ? 'Azure Client will be added by the launcher.' : 'Azure features not available on this version.',
  ];
  if (s.skipped) lines.push(s.skipped + ' entries are skipped (not allowed).');
  if (!s.fabricSupported) lines.push('Fabric does not support this Minecraft version yet.');
  const err = el('p', 'muted');
  const dlg = openDialog('Import modpack', (d) => {
    if (s.summary) d.append(el('p', 'muted', s.summary));
    d.append(name.node, (() => { const b = el('div', 'infobox'); lines.forEach((l) => b.append(el('div', '', l))); return b; })(), err);
  }, [
    { label: 'Cancel', run: closeDialog },
    { label: 'Create instance', kind: 'accent', run: async (b) => {
      b.disabled = true;
      b.textContent = 'Importing…';
      const stop = api.content.onEvent((e) => { if (e.type === 'progress') err.textContent = e.text; });
      const res = await api.mrpack.install(r.token, name.input.value || s.name);
      if (typeof stop === 'function') stop();
      if (res.ok) {
        appState.instances = res.instances;
        appState.selected = res.selected;
        closeDialog();
        renderHome();
        renderInstances();
        if (typeof onInstanceChanged === 'function') onInstanceChanged();
        navigate('instances');
      } else { err.textContent = res.message; b.disabled = false; b.textContent = 'Create instance'; }
    } },
  ]);
  void dlg;
}
$('import-mrpack').addEventListener('click', importMrpack);

// ---------- accounts ----------
function showNote(node, text) {
  node.textContent = text || '';
  node.classList.toggle('hidden', !text);
}

function renderAccounts(list) {
  appState.accounts = list;
  const host = $('account-list');
  host.replaceChildren();
  $('account-empty').classList.toggle('hidden', list.length > 0);
  const off = !appState.configured;
  $('add-account').disabled = off;
  showNote($('signin-off'), off ? SIGNIN_OFF : '');
  for (const a of list) {
    const card = el('div', 'card account');
    const head = el('span', 'head');
    setHead(head, a);
    const who = el('div', 'who');
    who.append(rawEl('div', 'name', a.name), rawEl('div', 'uuid', a.uuid));
    card.append(head, who);
    if (a.selected) card.append(el('span', 'badge', 'Playing as'));
    else {
      const use = el('button', 'pill', 'Use');
      use.addEventListener('click', async () => renderAccounts(accountsAnswer(await api.accounts.select(a.id))));
      card.append(use);
    }
    const rm = el('button', 'pill danger', 'Remove');
    rm.addEventListener('click', async () => renderAccounts(accountsAnswer(await api.accounts.remove(a.id))));
    card.append(rm);
    host.append(card);
  }
  renderHome();
}

$('add-account').addEventListener('click', async () => {
  showNote($('account-error'), '');
  codeInfo = null;
  $('code-card').classList.add('hidden');
  const r = await api.accounts.add();
  if (r && !r.ok && !r.cancelled && !codeInfo) showNote($('account-error'), r.message);
});

api.accounts.onCode((c) => {
  codeInfo = c;
  $('code-value').textContent = c.userCode || '';
  $('code-card').classList.remove('hidden');
});

api.accounts.onResult(async (r) => {
  $('code-card').classList.add('hidden');
  codeInfo = null;
  if (r.ok) renderAccounts(await api.accounts.list());
  else if (!r.cancelled) showNote($('account-error'), r.message);
});

$('code-open').addEventListener('click', () => { if (codeInfo) api.openExternal(codeInfo.verificationUri || 'https://www.microsoft.com/link'); });
$('code-copy').addEventListener('click', () => { if (codeInfo) api.copy(codeInfo.userCode); });
$('code-cancel').addEventListener('click', () => api.accounts.cancel());

// ---------- settings ----------
function renderSettings() {
  const s = appState.settings;
  $('set-ram').value = s.ram;
  $('set-ram-value').textContent = gb(s.ram);
  $('set-java').value = s.javaArgs;
  $('set-root').textContent = appState.root;
  renderAbout();
  $('set-close').checked = s.closeOnLaunch;
  $('set-autoupd').checked = s.autoUpdateLauncher !== false;
  $('set-log').checked = s.openLogOnLaunch;
  $('set-lang').value = s.language || 'system';
  setLanguage(s.language || 'system');
}

async function saveSettings(patch) {
  const saved = await api.settings.set(patch);
  if (saved && saved.refused) { toast(saved.refused); delete saved.refused; }
  appState.settings = saved;
  const fresh = await api.state();
  appState.root = fresh.root;
  appState.instances = fresh.instances;
  renderSettings();
  renderInstances();
}

$('set-ram').addEventListener('input', () => { $('set-ram-value').textContent = gb(Number($('set-ram').value)); });
$('set-ram').addEventListener('change', () => saveSettings({ ram: Number($('set-ram').value) }));
$('set-java').addEventListener('change', () => saveSettings({ javaArgs: $('set-java').value }));
$('set-close').addEventListener('change', () => saveSettings({ closeOnLaunch: $('set-close').checked }));
$('set-autoupd').addEventListener('change', () => saveSettings({ autoUpdateLauncher: $('set-autoupd').checked }));
$('set-log').addEventListener('change', () => saveSettings({ openLogOnLaunch: $('set-log').checked }));
$('set-lang').addEventListener('change', () => saveSettings({ language: $('set-lang').value }));
function renderAbout() {
  const a = appState.about || {};
  $('about-version').textContent = 'Azure Launcher ' + appState.version;
  $('about-publisher').textContent = a.publisher || '';
  const contact = $('about-contact');
  contact.textContent = a.contactEmail || '';
  $('about-privacy').disabled = !a.privacyUrl;
}
$('about-privacy').addEventListener('click', () => { const a = appState.about || {}; if (a.privacyUrl) api.openExternal(a.privacyUrl); });
for (const [id, which] of [['about-notices', 'notices'], ['about-electron', 'electron'], ['about-chromium', 'chromium']]) {
  $(id).addEventListener('click', async () => { $('about-licfail').classList.toggle('hidden', !!(await api.openLicense(which))); });
}
$('set-root-open').addEventListener('click', () => api.settings.openFolder());
$('set-root-choose').addEventListener('click', async () => { const f = await api.settings.chooseFolder(); if (f) saveSettings({ gameRoot: f }); });
$('set-root-reset').addEventListener('click', () => saveSettings({ gameRoot: '' }));

// ---------- hero: twinkling stars and mouse parallax, like the in-game title screen ----------
function startHero() {
  const hero = $('hero');
  const canvas = $('stars');
  const ctx = canvas.getContext('2d');
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const stars = Array.from({ length: 90 }, () => ({ x: rnd(), y: Math.pow(rnd(), 1.4) * 0.55, big: rnd() < 0.15, speed: 0.6 + rnd() * 1.8, phase: rnd() * 6.28 }));
  function draw(t) {
    const w = (canvas.width = hero.clientWidth);
    const h = (canvas.height = hero.clientHeight);
    ctx.clearRect(0, 0, w, h);
    for (const s of stars) {
      ctx.globalAlpha = calm ? 0.8 : 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t / 1000 * s.speed + s.phase));
      ctx.fillStyle = '#ffffff';
      const size = s.big ? 2.4 : 1.4;
      ctx.fillRect(Math.round(s.x * w), Math.round(s.y * h), size, size);
    }
  }
  let last = 0;
  const frame = (t) => { if (t - last > 50) { draw(t); last = t; } if (!calm) requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  if (calm) return;
  hero.addEventListener('mousemove', (e) => {
    const r = hero.getBoundingClientRect();
    const dx = (e.clientX - r.left) / r.width - 0.5;
    hero.querySelectorAll('.layer[data-depth]').forEach((l) => { l.style.transform = 'translateX(' + (-dx * 36 * Number(l.dataset.depth)).toFixed(1) + 'px)'; });
  });
}

// ---------- start ----------
(async () => {
  appState = await api.state();
  if (appState.dev) installTestHooks();
  renderAccounts(appState.accounts);
  renderSettings();
  renderInstances();
  renderHome();
  if (typeof initContentPages === 'function') initContentPages();
  if (typeof initInstancePage === 'function') initInstancePage();
  navigate('home');
  startHero();
  showUpdate(await api.update.state());
  if (appState.justUpdated && typeof toast === 'function') toast('Launcher updated to ' + appState.justUpdated.to + '.');
  if (appState.storageProblem && typeof toast === 'function') toast(appState.storageProblem);
})();


// ---------- launcher updates (Settings) ----------
function showUpdate(u) {
  $('upd-text').textContent = 'Version ' + (appState ? appState.version : '') + (u.message ? ' · ' + u.message : '');
  $('upd-check').classList.toggle('hidden', u.status === 'off' || u.status === 'ready');
  $('upd-check').disabled = u.status === 'checking' || u.status === 'downloading';
  $('upd-install').classList.toggle('hidden', u.status !== 'ready');
}
$('upd-check').addEventListener('click', async () => showUpdate(await api.update.check()));
$('upd-install').addEventListener('click', async () => { const r = await api.update.install(); if (r && !r.ok && r.message && typeof toast === 'function') toast(r.message); });
api.update.onEvent(showUpdate);
