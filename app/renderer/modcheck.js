'use strict';
// The mod check screen: when the launcher finds mods that would stop the game (or Fabric refused them), this
// explains each one in a line or two and offers fixes. Every fix done here can be undone with one button.
let mcSession = null;

function mcNewSession() { mcSession = 's' + Date.now(); }

function showModProblems(report) {
  if (!mcSession) mcNewSession();
  renderModProblems(report);
}

function renderModProblems(report, busyText, errorText) {
  const problems = report.problems || [];
  const ok = problems.length === 0;
  const title = ok ? (report.fromCrash ? 'Fabric did not start the game' : 'Your mods are ready') : (problems.length === 1 ? 'One mod needs attention' : problems.length + ' mods need attention');
  let busy = !!busyText;
  const run = async (fn, text) => {
    if (busy) return;
    renderModProblems(report, text);
    const r = await fn();
    if (r && r.ok) renderModProblems(r.report);
    else renderModProblems(report, null, r ? r.message : 'Something went wrong.');
  };
  const actions = [];
  if (report.canUndo) actions.push({ label: 'Undo fixes', run: () => run(() => api.modcheck.undo(mcSession), 'Putting your mods back') });
  actions.push({ label: 'Cancel', run: () => { closeDialog(); mcSession = null; } });
  if (!ok) {
    if (problems.some((p) => p.fixes && p.fixes.length)) actions.push({ label: 'Fix all', run: () => run(() => api.modcheck.fixAll(mcSession), 'Fixing') });
    actions.push({ label: 'Play anyway', run: () => { closeDialog(); mcSession = null; api.launch({ skipCheck: true }); } });
  } else {
    actions.push({ label: 'Play', kind: 'accent', run: () => { closeDialog(); mcSession = null; api.launch(); } });
  }
  const dlg = openDialog(title, (d) => {
    d.classList.add('wide');
    const inst = report.instance || {};
    d.append(el('p', 'muted', (report.fromCrash
      ? 'Fabric refused this set of mods, so the game closed. '
      : ok ? 'Nothing left that would stop the game. ' : 'These would stop the game from starting, so it was not started. ')
      + (inst.name || '') + ': Minecraft ' + (inst.mc || '?') + ', Fabric Loader ' + (inst.loader || '?') + '.'));
    const list = el('div', 'mc-list');
    for (const p of problems) {
      const row = el('div', 'mc-row');
      const head = el('div', 'mc-head');
      head.append(rawEl('strong', '', p.name), rawEl('span', 'muted mc-file', p.file + (p.version ? ' · ' + p.version : '')));
      row.append(head);
      const ul = el('ul', 'mc-reasons');
      for (const r of p.reasons) ul.append(el('li', '', r.text));
      row.append(ul);
      if (p.locked) {
        row.append(el('p', 'muted mc-note', 'The launcher adds this one itself, so it cannot be turned off here. Fix the other mods first.'));
      } else if (p.fixes && p.fixes.length) {
        const fixes = el('div', 'mc-fixes');
        p.fixes.forEach((f, i) => {
          const b = el('button', 'pill small' + (i === 0 && f.action !== 'disable' ? ' accent' : ''), f.label);
          b.disabled = busy;
          b.addEventListener('click', () => run(() => api.modcheck.fix(mcSession, p.file, i), f.label));
          fixes.append(b);
        });
        row.append(fixes);
      }
      list.append(row);
    }
    if (problems.length) d.append(list);
    if (report.fabric && report.fabric.length) {
      const box = el('details', 'mc-fabric');
      if (ok || report.fromCrash) box.open = true;
      box.append(el('summary', '', 'What Fabric says'));
      const ul = el('ul', 'mc-reasons');
      for (const line of report.fabric) ul.append(el('li', '', line));
      box.append(ul);
      d.append(box);
    }
    const status = el('p', 'muted mc-status', busyText ? busyText + '…' : (errorText || ''));
    d.append(status);
  }, actions);
  if (busy) dlg.actions.forEach((b) => { b.disabled = true; });
}
