'use strict';
const test = require('node:test');
const assert = require('node:assert');
const pkg = require('../package.json');
const cfg = require('../config/launcher.config.json');

test('the updater repo in package.json (latest.yml) and config/launcher.config.json (runtime) are the same', () => {
  assert.strictEqual(pkg.build.publish.owner, cfg.launcherUpdate.owner);
  assert.strictEqual(pkg.build.publish.repo, cfg.launcherUpdate.repo);
});

test('the installer is unsigned-safe: no secrets in the build config, dev/ and tests excluded', () => {
  const files = pkg.build.files.join(' ');
  assert.ok(files.includes('!dev/**') && files.includes('!test/**'));
  assert.ok(!JSON.stringify(pkg.build).match(/password|token|secret|certificate/i));
});

test('the About card has its data: publisher, contact, an https privacy page, and the licence notices ship with the installer', () => {
  assert.ok(cfg.about && typeof cfg.about.publisher === 'string' && typeof cfg.about.contactEmail === 'string');
  assert.ok(cfg.about.privacyUrl.startsWith('https://') && cfg.about.privacyUrl.includes('privacy.html'));
  assert.ok(pkg.build.extraResources.some((r) => r.to === 'THIRD-PARTY-NOTICES.txt'));
  assert.ok(pkg.scripts.predist.includes('make-notices'));
});

test('the About card has no placeholder text left', () => {
  assert.ok(!/[\[\]]|REPLACE/.test(cfg.about.publisher + cfg.about.contactEmail));
  assert.ok(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cfg.about.contactEmail));
});
