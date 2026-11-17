'use strict';
// Looks inside the built app archive: no dev folder, no tests, no offline-account code, no mod source.
//   node tools/check-package.js dist/win-unpacked/resources/app.asar
const asar = require('@electron/asar');
const file = process.argv[2];
if (!file) { console.error('usage: node tools/check-package.js <app.asar>'); process.exit(2); }
const names = asar.listPackage(file).map((n) => n.split(String.fromCharCode(92)).join('/'));
const bad = names.filter((n) => /^\/(dev|test|build-resources|dist)\//.test(n) || /offline/i.test(n) || /\.(java|gradle)$/.test(n) || /^\/node_modules\/electron\//.test(n));
if (bad.length) { console.error('PACKAGE CHECK FAILED, unwanted files:\n  ' + bad.slice(0, 20).join('\n  ')); process.exit(1); }
for (const need of ['/app/main.js', '/src/guard.js', '/config/release-key.txt']) if (!names.includes(need)) { console.error('missing ' + need); process.exit(1); }
console.log('PACKAGE-OK (' + names.length + ' files)');
