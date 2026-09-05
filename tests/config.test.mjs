import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { Script } from 'node:vm';
import test from 'node:test';
import { VERSION } from '../version.js';

test('release version and manifest assets are consistent', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, VERSION);
  for (const path of [manifest.background.service_worker, manifest.options_page, ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap(s => s.js)]) assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), path);
  assert.ok(manifest.host_permissions.includes('https://abs.twimg.com/*'));
  assert.ok(!manifest.host_permissions.includes('<all_urls>'));
});

test('viewer and browser fixtures have valid inline JavaScript', () => {
  for (const file of ['viewer.html', 'tests/browser-storage.html', 'tests/extension-fixture.html']) {
    const html = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(match[1], { filename: file });
  }
});
