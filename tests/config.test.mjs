import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { Script } from 'node:vm';
import test from 'node:test';
import { VERSION } from '../version.js';

test('release version and manifest assets are consistent', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, VERSION);
  assert.deepEqual(manifest.action.default_icon, manifest.icons);
  for (const [size, path] of Object.entries(manifest.icons)) {
    const png = readFileSync(new URL(`../${path}`, import.meta.url));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', path);
    assert.equal(png.readUInt32BE(16), Number(size), `${path} width`);
    assert.equal(png.readUInt32BE(20), Number(size), `${path} height`);
  }
  for (const path of [manifest.background.service_worker, manifest.options_page, ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap(s => s.js)]) assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), path);
  assert.ok(manifest.host_permissions.includes('https://abs.twimg.com/*'));
  assert.ok(!manifest.host_permissions.includes('<all_urls>'));
});

test('extension pages use external local scripts and all scripts parse', () => {
  for (const file of ['viewer.html', 'options.html']) {
    const html = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(html, /<script\s*>/i, `${file} must not contain inline scripts`);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${file} must not use inline event handlers`);
    for (const src of html.matchAll(/<script\s+([^>]*)src="([^"]+)"/gi)) {
      const path = new URL(`../${src[2]}`, import.meta.url);
      assert.ok(existsSync(path), `${file} references missing script ${src[2]}`);
      if (!/\btype="module"/i.test(src[1])) new Script(readFileSync(path, 'utf8'), { filename: src[2] });
    }
  }
  for (const file of ['tests/browser-storage.html', 'tests/extension-fixture.html']) {
    const html = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(match[1], { filename: file });
  }
});

test('bookmarks and likes retain distinct archive download and update controls', () => {
  const html = readFileSync(new URL('../options.html', import.meta.url), 'utf8');
  for (const ids of [
    ['library-status', 'export-range', 'export-format', 'btn-export', 'update-mode', 'btn-start'],
    ['likes-status', 'likes-range', 'likes-format', 'likes-export', 'likes-mode', 'likes-start'],
  ]) {
    const positions = ids.map(id => {
      const matches = [...html.matchAll(new RegExp(`\\bid="${id}"`, 'g'))];
      assert.equal(matches.length, 1, `${id} must appear exactly once`);
      return matches[0].index;
    });
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  }
  assert.equal((html.match(/id="controls-section"/g) || []).length, 1);
  assert.ok(html.indexOf('id="controls-section"') < html.indexOf('id="progress-section"'));
});
