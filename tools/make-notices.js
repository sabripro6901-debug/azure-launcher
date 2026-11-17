'use strict';
// Writes build-resources/THIRD-PARTY-NOTICES.txt: the name, version, licence and licence text of every package the
// launcher ships (production dependencies from package-lock.json). Electron's and Chromium's own licence files are
// installed next to the program by Electron itself. Run before building the installer (npm run dist does it).
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const out = [];
out.push('Azure Launcher bundles the open-source software below. Each package is under its own licence.');
out.push('Electron and Chromium licences: LICENSE.electron.txt and LICENSES.chromium.html in the installation folder.');
out.push('');
let n = 0;
for (const [key, meta] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
  if (!key || meta.dev || meta.optional && meta.dev) continue;
  const dir = path.join(root, key);
  if (!fs.existsSync(dir)) continue;
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { /* none */ }
  const file = fs.readdirSync(dir).find((f) => /^(licen[sc]e|copying)(\.|$)/i.test(f));
  const lic = pkg.license && typeof pkg.license === 'object' ? pkg.license.type : pkg.license;
  out.push('='.repeat(78));
  out.push((pkg.name || key.replace(/^.*node_modules\//, '')) + ' ' + (pkg.version || meta.version || '') + '  (' + (lic || 'see below') + ')');
  if (pkg.homepage) out.push(pkg.homepage);
  out.push('='.repeat(78));
  out.push(file ? fs.readFileSync(path.join(dir, file), 'utf8').trim() : '(no licence file in the package; licence: ' + (lic || 'unknown') + ')');
  out.push('');
  n++;
}
fs.mkdirSync(path.join(root, 'build-resources'), { recursive: true });
fs.writeFileSync(path.join(root, 'build-resources', 'THIRD-PARTY-NOTICES.txt'), out.join('\n') + '\n');
console.log('THIRD-PARTY-NOTICES.txt: ' + n + ' packages');
