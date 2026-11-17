'use strict';
// The launcher must never listen for connections (a listening socket triggers the Windows Firewall prompt).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f, out); else if (f.endsWith('.js')) out.push(f);
  }
  return out;
};

test('packaged code (app/, src/) opens no listening socket and no debugging port', () => {
  for (const f of [...walk(path.join(ROOT, 'app')), ...walk(path.join(ROOT, 'src'))]) {
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(!/\.listen\(|createServer\(|dgram|remote-debugging|--inspect|startRendering|new\s+WebSocketServer/.test(s), f + ' could open a listening socket');
  }
});

test('test and dev servers bind to 127.0.0.1 only', () => {
  for (const f of [...walk(path.join(ROOT, 'test')), ...(fs.existsSync(path.join(ROOT, 'dev-local')) ? walk(path.join(ROOT, 'dev-local')) : [])]) {
    if (f === __filename) continue;
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\.listen\(([^)]*)\)/g)) {
      assert.ok(m[1].includes('127.0.0.1'), f + ': .listen(' + m[1] + ') is not loopback only');
    }
  }
});
