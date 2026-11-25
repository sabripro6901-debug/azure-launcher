'use strict';
// The Bedrock tab: play the game the player already owns, and manage their own packs and worlds. Loaded last; it uses
// el / rawEl / iconNode / openDialog / confirmDialog / toast from the other scripts.

const bd = { busy: null, info: null, profile: '', tab: 'packs', packs: [], worlds: [], backups: [], poll: null, ready: false };
const MS_STORE = 'https://apps.microsoft.com/detail/9nblggh2jhxj';
const PACK_KIND = { resource: 'Resource pack', behavior: 'Behavior pack', skin: 'Skin pack' };
const PACK_GROUP = { resource: 'Resource packs', behavior: 'Behavior packs', skin: 'Skin packs' };

function bdSize(bytes) {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
  return Math.max(1, Math.round(mb)) + ' MB';
}
function bdDate(ms) {
  return ms ? new Date(ms).toLocaleDateString(UI_LANG, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
}
const bdRunning = () => !!(bd.info && bd.info.running);
// Changes are off while the game runs and while one of our own heavy jobs (backup, restore, import ...) is working.
const bdLocked = () => bdRunning() || !!bd.busy;
const BD_JOB_LABEL = { backup: 'Backing up…', export: 'Exporting…', import: 'Importing…', restore: 'Restoring…', safety: 'Saving a backup of the current world first…', packs: 'Adding packs…' };

function bdRenderBusy() {
  const b = bd.busy;
  $('bd-busy').classList.toggle('hidden', !b);
  if (!b) return;
  $('bd-busy-label').textContent = BD_JOB_LABEL[b.phase] || BD_JOB_LABEL[b.job] || 'Working…';
  const known = b.total > 0;
  $('bd-busy-fill').parentElement.classList.toggle('wait', !known);
  $('bd-busy-fill').style.width = known ? Math.min(100, Math.round(100 * b.done / b.total)) + '%' : '';
  $('bd-busy-pct').textContent = known ? Math.min(100, Math.round(100 * b.done / b.total)) + '%' : '';
}

api.bedrock.onProgress((m) => {
  const was = !!bd.busy;
  if (m.phase === 'end') bd.busy = null;
  else if (m.phase === 'start') bd.busy = { job: m.job, phase: m.job, done: 0, total: 0 };
  else bd.busy = { job: m.job, phase: m.phase, done: m.done, total: m.total };
  bdRenderBusy();
  if (was !== !!bd.busy) { bdRender(); }
});

function bdAnswer(r) { if (r && r.ok === false) { toast(r.message); return false; } return true; }

async function bdLoad() {
  const r = await api.bedrock.state();
  if (!bdAnswer(r)) return;
  bd.info = r.bedrock;
  if (r.busy && !bd.busy) bd.busy = { job: r.busy, phase: r.busy, done: 0, total: 0 };
  bdHome.installed = !!bd.info.installed;
  bdHome.version = bd.info.version;
  if (!bd.info.profiles.some((p) => p.id === bd.profile)) bd.profile = bd.info.profiles.length ? bd.info.profiles[0].id : '';
  bdRender();
  if (bd.info.installed && bd.profile) await bdReloadLists();
}

async function bdReloadLists() {
  if (!bd.profile) return;
  const [p, w] = await Promise.all([api.bedrock.packs(bd.profile), api.bedrock.worlds(bd.profile)]);
  if (p.ok) bd.packs = p.packs;
  if (w.ok) { bd.worlds = w.worlds; bd.backups = w.backups; }
  bdRenderPacks();
  bdRenderWorlds();
}

function bdRender() {
  const i = bd.info;
  const installed = !!(i && i.installed);
  $('bd-missing').classList.toggle('hidden', installed || !i);
  $('bd-game').classList.toggle('hidden', !installed);
  $('bd-tabs').classList.toggle('hidden', !installed);
  $('bd-running').classList.toggle('hidden', !(installed && i.running));
  $('bd-packs').classList.toggle('hidden', !installed || bd.tab !== 'packs');
  $('bd-worlds').classList.toggle('hidden', !installed || bd.tab !== 'worlds');
  $('bd-tab-packs').classList.toggle('on', bd.tab === 'packs');
  $('bd-tab-worlds').classList.toggle('on', bd.tab === 'worlds');
  const sel = $('bd-profile');
  sel.classList.toggle('hidden', !installed || i.profiles.length < 2);
  sel.replaceChildren(...(installed ? i.profiles : []).map((p) => { const o = el('option', '', p.label); o.value = p.id; return o; }));
  sel.value = bd.profile;
  if (!installed) return;
  const tags = $('bd-tags');
  tags.replaceChildren();
  if (i.version) tags.append(rawEl('span', 'tag', 'Version ' + i.version));
  tags.append(el('span', 'tag dim', i.layout === 'gdk' ? 'Current layout' : 'Older Windows 10 layout'));
  if (!i.profiles.length) tags.append(el('span', 'tag dim', 'Start the game once to create its folders'));
  const play = $('bd-play');
  play.disabled = i.running;
  play.textContent = i.running ? 'Playing' : 'Play Bedrock';
  for (const id of ['bd-add-packs', 'bd-add-world']) $(id).disabled = bdLocked() || !bd.profile;
  bdRenderBusy();
  for (const id of ['bd-open-packs', 'bd-open-worlds', 'bd-open-backups']) $(id).disabled = !bd.profile;
  bdRenderPacks();
  bdRenderWorlds();
}

// ---------- packs ----------
function bdRenderPacks() {
  const list = $('bd-pack-list');
  list.replaceChildren();
  if (!bd.packs.length) { list.append(el('div', 'bd-empty', bd.profile ? 'No packs installed yet.' : 'No Minecraft folder was found yet.')); return; }
  for (const kind of Object.keys(PACK_GROUP)) {
    const items = bd.packs.filter((p) => p.kind === kind);
    if (!items.length) continue;
    list.append(el('div', 'bd-section', PACK_GROUP[kind]));
    for (const p of items) {
      const row = el('div', 'card irow');
      row.append(iconNode(p.icon, (p.name || '?').slice(0, 1).toUpperCase()));
      const body = el('div', 'rbody');
      const head = el('div', 'rhead');
      head.append(rawEl('span', 'rtitle', p.name));
      if (p.version) head.append(rawEl('span', 'muted', p.version));
      body.append(head);
      const tags = el('div', 'tags');
      tags.append(el('span', 'tag dim', PACK_KIND[p.kind]));
      if (p.broken) tags.append(el('span', 'tag warn', 'Damaged manifest'));
      body.append(tags);
      const rm = el('button', 'pill small danger', 'Remove');
      rm.disabled = bdLocked();
      rm.addEventListener('click', () => {
        confirmDialog('Remove this pack?', 'It moves out of Minecraft. The launcher keeps a copy for 30 days in its own folder.', 'Remove', async () => {
          const r = await api.bedrock.packRemove(bd.profile, p.kind, p.folder);
          if (!bdAnswer(r)) return;
          await bdReloadLists();
        });
      });
      row.append(body, rm);
      list.append(row);
    }
  }
}

async function bdImportPacks(paths) {
  if (!paths || !paths.length || !bd.profile) return;
  if (bdLocked()) { toast(bdRunning() ? 'Minecraft Bedrock is running. Close it to change packs or worlds.' : 'Another Bedrock job is still running.'); return; }
  if (false) { toast('Minecraft Bedrock is running. Close it to change packs or worlds.'); return; }
  const r = await api.bedrock.packInspect(bd.profile, paths);
  if (!bdAnswer(r)) return;
  if (!r.candidates.length) { toast('Nothing to add: pick .mcpack, .mcaddon or .zip files.'); return; }
  const chosen = new Set(r.candidates.filter((c) => !c.blocked && !c.ask).map((c) => c.id));
  const summary = el('div', 'muted import-count', '');
  const refresh = () => {
    summary.replaceChildren(rawEl('span', '', chosen.size + ' / ' + r.candidates.length), el('span', '', ' will be added'));
    dlg.actions[1].disabled = chosen.size === 0;
  };
  const dlg = openDialog('Add packs', (d) => {
    d.classList.add('wide');
    d.append(el('p', 'muted', 'These are copied into Minecraft. Nothing is run, and your originals are not touched.'));
    const list = el('div', 'import-list');
    for (const c of r.candidates) {
      const row = el('div', 'import-row' + (c.blocked ? ' blocked' : ''));
      row.append(iconNode(c.icon, (c.name || '?').slice(0, 1).toUpperCase()));
      const body = el('div', 'rbody');
      const head = el('div', 'rhead');
      head.append(rawEl('span', 'rtitle', c.name), rawEl('span', 'muted', c.version));
      body.append(head);
      if (c.kind) { const tags = el('div', 'tags'); tags.append(el('span', 'tag', PACK_KIND[c.kind] || 'Pack')); body.append(tags); }
      for (const i of c.issues) body.append(el('div', 'issue ' + i.level, i.text));
      row.append(body);
      if (c.ask) {
        const lab = el('label', 'toggle');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.addEventListener('change', () => { if (box.checked) chosen.add(c.id); else chosen.delete(c.id); refresh(); });
        lab.append(box, el('span', 'switch'), el('span', '', 'Add anyway'));
        row.append(lab);
      } else if (c.blocked) row.append(el('span', 'muted', "Can't add"));
      list.append(row);
    }
    d.append(list, summary);
  }, [
    { label: 'Cancel', run: closeDialog },
    { label: 'Add', kind: 'accent', run: async () => {
      const res = await api.bedrock.packAdd(bd.profile, r.token, [...chosen]);
      closeDialog();
      if (!bdAnswer(res)) return;
      bd.packs = res.packs;
      bdRenderPacks();
      if (res.skipped.length) toast(res.skipped.map((s) => s.name + ': ' + tr(s.reason)).join('\n'));
    } },
  ]);
  refresh();
}

// ---------- worlds ----------
function bdRenderWorlds() {
  const list = $('bd-world-list');
  list.replaceChildren();
  if (!bd.worlds.length) { list.append(el('div', 'bd-empty', bd.profile ? 'No worlds yet.' : 'No Minecraft folder was found yet.')); return; }
  const locked = bdLocked();
  for (const w of bd.worlds) {
    const row = el('div', 'card irow');
    row.append(iconNode(w.icon, (w.name || '?').slice(0, 1).toUpperCase()));
    const body = el('div', 'rbody');
    body.append(rawEl('span', 'rtitle', w.name));
    const tags = el('div', 'tags');
    if (w.lastPlayed) { tags.append(el('span', 'tag dim', 'Last played')); tags.append(rawEl('span', 'tag dim', bdDate(w.lastPlayed))); } else tags.append(el('span', 'tag dim', 'Never played'));
    tags.append(el('span', 'tag dim', bdSize(w.size)));
    const n = bd.backups.filter((b) => b.folder === w.folder).length;
    if (n) { tags.append(el('span', 'tag', 'Backed up')); tags.append(rawEl('span', 'tag', String(n))); }
    body.append(tags);
    const acts = el('span', 'row-tight');
    const mk = (label, fn) => { const b = el('button', 'pill small', label); b.disabled = locked; b.addEventListener('click', fn); acts.append(b); };
    mk('Back up', async () => {
      const r = await api.bedrock.worldBackup(bd.profile, w.folder);
      if (!bdAnswer(r)) return;
      bd.worlds = r.worlds; bd.backups = r.backups; bdRenderWorlds();
      notice('Backup saved', 'Your world was copied to a .mcworld file in the launcher’s backup folder. The world itself is unchanged.');
    });
    mk('Restore…', () => bdRestore(w));
    mk('Export…', async () => {
      const r = await api.bedrock.worldExport(bd.profile, w.folder);
      if (!bdAnswer(r) || r.cancelled) return;
      notice('World exported', 'Saved as a .mcworld file. The world itself is unchanged.');
    });
    row.append(body, acts);
    list.append(row);
  }
}

// Restoring replaces the world (after a safety backup): ask first, and show the file's own warnings.
function bdConfirmRestore(w, spec, shownName, issues) {
  let ok = !issues.some((i) => i.level === 'ask');
  const dlg = openDialog('Restore this world?', (d) => {
    d.append(el('p', 'muted', 'The backup replaces this world. A backup of the world as it is now is saved first, so you can undo this.'));
    const row = el('div', 'import-row');
    const body = el('div', 'rbody');
    body.append(rawEl('span', 'rtitle', shownName));
    for (const i of issues) body.append(el('div', 'issue ' + i.level, i.text));
    row.append(body);
    if (!ok) {
      const lab = el('label', 'toggle');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.addEventListener('change', () => { dlg.actions[1].disabled = !box.checked; });
      lab.append(box, el('span', 'switch'), el('span', '', 'Add anyway'));
      row.append(lab);
    }
    d.append(row);
  }, [
    { label: 'Cancel', run: closeDialog },
    { label: 'Restore', kind: 'confirm-danger', run: () => bdRestoreNow(w, spec) },
  ]);
  dlg.actions[1].disabled = !ok;
}

async function bdRestoreNow(w, spec) {
  closeDialog();
  const r = await api.bedrock.worldRestore(bd.profile, w.folder, spec);
  if (!bdAnswer(r)) return;
  bd.worlds = r.worlds; bd.backups = r.backups; bdRenderWorlds();
  notice('World restored', 'A backup of the world as it was has been saved first, so you can undo this.');
}

function bdRestore(w) {
  const mine = bd.backups.filter((b) => b.folder === w.folder);
  const run = async (spec, name, issues) => {
    closeDialog();
    bdConfirmRestore(w, spec, name, issues || []);
  };
  openDialog('Restore a world', (d) => {
    d.classList.add('wide');
    d.append(el('p', 'muted', 'The backup replaces this world. A backup of the world as it is now is saved first.'));
    const list = el('div', 'import-list');
    if (!mine.length) list.append(el('div', 'bd-empty', 'No backups of this world yet.'));
    for (const b of mine) {
      const row = el('div', 'bd-pick');
      const body = el('div', 'rbody');
      body.append(rawEl('span', 'rtitle', b.name));
      const tags = el('div', 'tags');
      tags.append(rawEl('span', 'tag dim', new Date(b.time).toLocaleString(UI_LANG)), el('span', 'tag dim', bdSize(b.size)));
      body.append(tags);
      const go = el('button', 'pill small accent', 'Restore');
      go.addEventListener('click', () => run({ backup: b.fileName }, b.name, []));
      row.append(body, go);
      list.append(row);
    }
    d.append(list);
  }, [
    { label: 'Cancel', run: closeDialog },
    { label: 'Choose a file…', run: async () => {
      const r = await api.bedrock.worldPickRestore(bd.profile);
      if (!bdAnswer(r) || r.cancelled) return;
      await run({ token: r.token }, r.name, r.issues);
    } },
  ]);
}

async function bdAddWorld() {
  const r = await api.bedrock.worldImportPick(bd.profile);
  if (!bdAnswer(r) || r.cancelled) return;
  const w = r.world;
  let ok = !w.blocked && !w.ask;
  const dlg = openDialog('Add a world', (d) => {
    d.classList.add('wide');
    d.append(el('p', 'muted', 'The world is copied in as a new world. Nothing is replaced, and your file is not touched.'));
    const row = el('div', 'import-row' + (w.blocked ? ' blocked' : ''));
    row.append(iconNode(w.icon, (w.name || '?').slice(0, 1).toUpperCase()));
    const body = el('div', 'rbody');
    body.append(rawEl('span', 'rtitle', w.name));
    for (const i of w.issues) body.append(el('div', 'issue ' + i.level, i.text));
    row.append(body);
    if (w.ask) {
      const lab = el('label', 'toggle');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.addEventListener('change', () => { ok = box.checked; dlg.actions[1].disabled = !ok; });
      lab.append(box, el('span', 'switch'), el('span', '', 'Add anyway'));
      row.append(lab);
    } else if (w.blocked) row.append(el('span', 'muted', "Can't add"));
    d.append(row);
  }, [
    { label: 'Cancel', run: closeDialog },
    { label: 'Add', kind: 'accent', run: async () => {
      closeDialog();
      const res = await api.bedrock.worldImport(bd.profile, r.token);
      if (!bdAnswer(res)) return;
      bd.worlds = res.worlds; bd.backups = res.backups; bdRenderWorlds();
    } },
  ]);
  dlg.actions[1].disabled = !ok;
}

// ---------- wiring ----------
function bdTab(tab) { bd.tab = tab; bdRender(); }
$('bd-tab-packs').addEventListener('click', () => bdTab('packs'));
$('bd-tab-worlds').addEventListener('click', () => bdTab('worlds'));
$('bd-profile').addEventListener('change', async (e) => { bd.profile = e.target.value; bdRender(); await bdReloadLists(); });
$('bd-get').addEventListener('click', () => api.openExternal(MS_STORE));
$('bd-recheck').addEventListener('click', bdLoad);
$('bd-play').addEventListener('click', async () => {
  const r = await api.bedrock.launch();
  if (!bdAnswer(r)) return;
  bd.info.running = true;
  bdRender();
  bdHome.running = true;
  if (homeBedrock) renderHome();
});
$('bd-add-packs').addEventListener('click', async () => bdImportPacks(await api.bedrock.packPick()));
$('bd-open-packs').addEventListener('click', () => api.bedrock.packOpen(bd.profile, ''));
$('bd-add-world').addEventListener('click', bdAddWorld);
$('bd-open-worlds').addEventListener('click', () => api.bedrock.worldOpen(bd.profile, 'worlds'));
$('bd-open-backups').addEventListener('click', () => api.bedrock.worldOpen(bd.profile, 'backups'));
{
  const zone = $('bd-packs');
  const over = (on) => $('bd-drop').classList.toggle('over', on);
  zone.addEventListener('dragenter', (e) => { e.preventDefault(); over(true); });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); over(true); });
  zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) over(false); });
  zone.addEventListener('drop', (e) => { e.preventDefault(); over(false); bdImportPacks(api.content.pathsFor(e.dataTransfer.files)); });
}

// While the page is open, the "game is running" state is checked every few seconds so the buttons follow it.
function onBedrockPageShown(page) {
  clearInterval(bd.poll);
  bd.poll = null;
  if (page !== 'bedrock') return;
  bdLoad();
  bd.poll = setInterval(async () => {
    if (!bd.info || !bd.info.installed || document.hidden) return;
    const r = await api.bedrock.running();
    if (!r.ok) return;
    const was = bdRunning();
    bd.info.running = r.running;
    if (was !== bd.info.running) { bdRender(); if (!bd.info.running) bdReloadLists(); }
  }, 4000);
}

// ---------- Home page: Bedrock as one more thing to play ----------
var bdHome = { installed: false, version: '', running: false, timer: null };
const BD_HOME_KEY = 'azure.homeBedrock';

function bdHomeSave() { try { localStorage.setItem(BD_HOME_KEY, homeBedrock ? '1' : '0'); } catch { /* not saved: fine */ } }

function bedrockPickerItem(menu) {
  if (!bdHome.installed) return;
  const b = el('button', homeBedrock ? 'on' : '', 'Minecraft Bedrock');
  b.addEventListener('click', () => {
    menu.classList.add('hidden');
    homeBedrock = true;
    bdHomeSave();
    renderHome();
    bdHomePoll();
  });
  menu.append(b);
}

function bedrockHomeOff() {
  homeBedrock = false;
  bdHomeSave();
  clearInterval(bdHome.timer);
  bdHome.timer = null;
}

/** Draws the Home page for Bedrock; true when it did (renderHome then stops). */
function renderHomeBedrock() {
  setNameText($('picker-name'), 'Minecraft Bedrock', true);
  $('sum-version').textContent = 'Minecraft Bedrock' + (bdHome.version ? ' · ' + bdHome.version : '');
  $('sum-note').classList.add('hidden');
  const btn = $('launch');
  btn.classList.remove('progress', 'busy', 'playing', 'off');
  $('launch-group').classList.remove('off');
  $('launch-fill').style.width = '';
  $('under').className = 'under';
  $('under').textContent = '';
  $('stop-game').classList.add('hidden');
  btn.disabled = bdHome.running;
  btn.classList.toggle('playing', bdHome.running);
  $('launch-group').classList.toggle('off', bdHome.running);
  $('launch-label').textContent = bdHome.running ? 'Playing' : 'Play Bedrock';
  return true;
}

async function bedrockHomePlay() {
  if (bdHome.running) return;
  const r = await api.bedrock.launch();
  if (!bdAnswer(r)) return;
  bdHome.running = true;
  renderHome();
  bdHomePoll();
}

// While Bedrock is the chosen game, the button follows whether it is running.
function bdHomePoll() {
  clearInterval(bdHome.timer);
  bdHome.timer = setInterval(async () => {
    if (!homeBedrock || document.hidden) return;
    const r = await api.bedrock.running();
    if (!r.ok || r.running === bdHome.running) return;
    bdHome.running = r.running;
    renderHome();
  }, 4000);
}

(async () => {
  let want = false;
  try { want = localStorage.getItem(BD_HOME_KEY) === '1'; } catch { /* default */ }
  const r = await api.bedrock.state();
  if (!r.ok) return;
  bdHome.installed = !!r.bedrock.installed;
  bdHome.version = r.bedrock.version;
  bdHome.running = !!r.bedrock.running;
  homeBedrock = want && bdHome.installed;
  renderPicker();
  renderHome();
  if (homeBedrock) bdHomePoll();
})();
