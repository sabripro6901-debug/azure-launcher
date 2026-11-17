'use strict';
// Adding files the player already has: "Add files", "Add folder", drag and drop, and the confirmation dialog.
// Loaded after content.js (which calls addImportControls / addDropZone while it builds the pages).

function addImportControls(kind, bar) {
  const files = el('button', 'pill', 'Add files');
  files.addEventListener('click', async () => runImport(await api.content.pick('files')));
  const folder = el('button', 'pill', 'Add folder');
  folder.addEventListener('click', async () => runImport(await api.content.pick('folder')));
  bar.append(files, folder);
}

function addDropZone(kind, st) {
  const zone = el('div', 'dropzone', 'Drop .jar mods, .zip resource packs or shader packs here, or a folder. They are copied; your originals stay where they are.');
  st.installed.insertBefore(zone, st.ilist);
  const over = (on) => zone.classList.toggle('over', on);
  const target = st.installed;
  target.addEventListener('dragenter', (e) => { e.preventDefault(); over(true); });
  target.addEventListener('dragover', (e) => { e.preventDefault(); over(true); });
  target.addEventListener('dragleave', (e) => { if (!target.contains(e.relatedTarget)) over(false); });
  target.addEventListener('drop', (e) => {
    e.preventDefault();
    over(false);
    runImport(api.content.pathsFor(e.dataTransfer.files));
  });
}

const KIND_LABEL = { mod: 'Mod', resourcepack: 'Resource pack', shader: 'Shader pack' };

async function runImport(paths) {
  if (!paths || !paths.length) return;
  const r = await api.content.inspect(paths);
  if (!r.ok) { toast(r.message); return; }
  if (!r.candidates.length) { toast('Nothing to add: pick .jar mods or .zip packs.'); return; }
  const chosen = new Set(r.candidates.filter((c) => !c.blocked && !c.ask).map((c) => c.id));
  const summary = el('div', 'muted import-count', '');
  const refresh = () => {
    summary.textContent = chosen.size + ' of ' + r.candidates.length + ' will be added';
    dlg.actions[1].disabled = chosen.size === 0;
  };
  const dlg = openDialog('Add files', (d) => {
    d.classList.add('wide');
    d.append(el('p', 'muted', 'These are copied into the selected instance. Nothing is run, and your originals are not touched.'));
    const list = el('div', 'import-list');
    for (const c of r.candidates) {
      const row = el('div', 'import-row' + (c.blocked ? ' blocked' : ''));
      row.append(iconNode(c.icon, (c.name || '?').slice(0, 1).toUpperCase()));
      const body = el('div', 'rbody');
      const head = el('div', 'rhead');
      head.append(el('span', 'rtitle', c.name), el('span', 'muted', c.version));
      body.append(head);
      const tags = el('div', 'tags');
      if (c.kind) tags.append(el('span', 'tag', (c.folder ? 'Folder · ' : '') + KIND_LABEL[c.kind]));
      if (c.loader) tags.append(el('span', 'tag dim', c.loader));
      tags.append(el('span', c.recognised ? 'tag azure' : 'tag dim', c.recognised ? 'Found on Modrinth' : 'Local file'));
      body.append(tags);
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
      const res = await api.content.add(r.token, [...chosen]);
      closeDialog();
      if (!res.ok) { toast(res.message); return; }
      for (const k of Object.keys(cp)) {
        cp[k].items = res.items;
        if (!$('page-' + KIND_INFO[k].page).classList.contains('hidden')) renderInstalled(k);
      }
      if (typeof onContentChanged === 'function') onContentChanged(res.items);
      refreshCounts();
      const msg = 'Added ' + res.added.length + (res.added.length === 1 ? ' file' : ' files') + (res.skipped.length ? ' · skipped ' + res.skipped.length : '');
      { const k = visibleKind(); if (k) cp[k].status.textContent = msg; }
      if (res.skipped.length) toast(res.skipped.map((s) => s.name + ': ' + s.reason).join('\n'));
    } },
  ]);
  refresh();
}
