import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { buildMediaInventory, summarizeEstimate, estimateArchiveBytes, ZipStream, bytesOf, safeMediaUrl, validatedMedia, markdownIndex } from '../lib/media-backup.js';

test('inventory chooses one MP4, deduplicates and rejects unsafe hosts', () => {
  const doc = { bookmarks: [
    { tweet_id: '123', author: { profile_image_url: 'https://pbs.twimg.com/avatar.jpg' }, media: [
      { type: 'photo', url: 'https://pbs.twimg.com/photo.jpg?format=jpg&name=orig' },
      { type: 'video', duration_ms: 10000, thumbnail_url: 'https://pbs.twimg.com/thumb.jpg', variants: [
        { url: 'https://video.twimg.com/high.mp4', content_type: 'video/mp4', bitrate: 3000000 },
        { url: 'https://video.twimg.com/medium.mp4', content_type: 'video/mp4', bitrate: 800000 },
        { url: 'https://evil.example/steal.mp4', content_type: 'video/mp4', bitrate: 900000 },
      ] },
    ] },
    { tweet_id: '124', media: [{ type: 'photo', url: 'https://pbs.twimg.com/photo.jpg?format=jpg&name=orig' }, { type: 'photo', url: 'http://pbs.twimg.com/insecure.jpg' }] },
  ] };
  const inventory = buildMediaInventory(doc, { photos: true, videos: true, thumbnails: true, avatars: true });
  assert.equal(inventory.items.length, 4);
  assert.equal(inventory.rejected.length, 1);
  assert.equal(inventory.items.find(item => item.type === 'video').url, 'https://video.twimg.com/medium.mp4');
  assert.deepEqual(inventory.items.find(item => item.type === 'photo').tweet_ids, ['123', '124']);
  assert.ok(summarizeEstimate(inventory).unknown_count > 0);
  assert.equal(safeMediaUrl('https://pbs.twimg.com.evil.example/photo'), null);
});

test('local ZIP overview gives usable sizes before CDN permission or network access', () => {
  const doc = { likes: [{ tweet_id: '123', full_text: 'offline text', author: { profile_image_url: 'https://pbs.twimg.com/avatar.jpg' }, media: [
    { type: 'photo', url: 'https://pbs.twimg.com/photo.jpg' },
    { type: 'video', duration_ms: 10000, thumbnail_url: 'https://pbs.twimg.com/thumb.jpg', variants: [
      { url: 'https://video.twimg.com/clip.mp4', content_type: 'video/mp4', bitrate: 800000 },
    ] },
  ] }] };
  const inventory = buildMediaInventory(doc, { photos: true, videos: true, thumbnails: true, avatars: true });
  const summary = summarizeEstimate(inventory);
  assert.equal(summary.total_count, 4);
  assert.equal(summary.byType.video.estimated_bytes, 1000000);
  assert.ok(summary.byType.photo.estimated_bytes > 0);
  assert.ok(summary.byType.avatar.estimated_bytes > 0);
  assert.ok(summary.byType.thumbnail.estimated_bytes > 0);
  assert.equal(summary.unknown_count, 4);
  assert.ok(estimateArchiveBytes(doc, inventory) > Buffer.byteLength(JSON.stringify(doc)));
  const photo = inventory.items.find(item => item.type === 'photo');
  photo.expected_bytes = 12345; photo.estimate_source = 'head';
  const refined = summarizeEstimate(inventory);
  assert.equal(refined.byType.photo.estimated_bytes, 12345);
  assert.equal(refined.unknown_count, 3);
});

test('streamed ZIP has a valid central directory and rejects path traversal', async () => {
  const parts = [];
  const writable = { async write(bytes) { parts.push(Buffer.from(bytes)); }, async close() {} };
  const zip = new ZipStream(writable, 1024 * 1024);
  await zip.add('archive.json', bytesOf('{"bookmarks":[]}\n'));
  await zip.add('index.md', bytesOf('# Archive\n'));
  await assert.rejects(zip.add('../escape.txt', bytesOf('bad')), /invalid_zip_path/);
  await zip.finish();
  const dir = mkdtempSync(join(tmpdir(), 'xkeeps-zip-test-'));
  try {
    const file = join(dir, 'backup.zip');
    writeFileSync(file, Buffer.concat(parts));
    const result = spawnSync('unzip', ['-t', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /archive\.json/);
    assert.match(result.stdout, /index\.md/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('media reader rejects HTML despite an allowed CDN redirect', async () => {
  const bytes = new TextEncoder().encode('<html>error</html>');
  const response = new Response(bytes, { headers: { 'content-type': 'text/html' } });
  Object.defineProperty(response, 'url', { value: 'https://pbs.twimg.com/photo.jpg' });
  await assert.rejects(async () => { for await (const chunk of validatedMedia(response, 'photo')) void chunk; }, /media_content_type_rejected/);
});

test('an offline ZIP links only validated saved media and keeps source text literal', async () => {
  const document = { bookmarks: [{ tweet_id: '123', author: { name: '<img src=x onerror=alert(1)>' },
    full_text: 'Note ![remote](https://evil.example/track) <script>alert(1)</script>',
    media: [{ type: 'photo', url: 'https://pbs.twimg.com/photo.png' }] }] };
  const inventory = buildMediaInventory(document, { photos: true });
  const item = inventory.items[0];
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const response = new Response(png, { headers: { 'content-type': 'image/png' } });
  Object.defineProperty(response, 'url', { value: item.url });
  const parts = [];
  const zip = new ZipStream({ async write(bytes) { parts.push(Buffer.from(bytes)); }, async close() {} }, 1024 * 1024);
  await zip.add('archive.json', bytesOf(JSON.stringify(document)));
  await zip.add(item.path, validatedMedia(response, 'photo'));
  item.status = 'complete';
  await zip.add('index.md', bytesOf(markdownIndex(document, inventory)));
  await zip.add('media-manifest.json', bytesOf(JSON.stringify({ media: inventory.items })));
  await zip.finish();
  const dir = mkdtempSync(join(tmpdir(), 'xkeeps-media-test-'));
  try {
    const file = join(dir, 'backup.zip');
    writeFileSync(file, Buffer.concat(parts));
    assert.equal(spawnSync('unzip', ['-t', file], { encoding: 'utf8' }).status, 0);
    const names = spawnSync('unzip', ['-Z', '-1', file], { encoding: 'utf8' }).stdout.split('\n');
    assert.ok(names.includes(item.path));
    const markdown = spawnSync('unzip', ['-p', file, 'index.md'], { encoding: 'utf8' }).stdout;
    assert.ok(markdown.includes(`./${item.path}`));
    assert.doesNotMatch(markdown, /<script>|<img|!\[remote\]/);
    assert.deepEqual(JSON.parse(spawnSync('unzip', ['-p', file, 'archive.json'], { encoding: 'utf8' }).stdout), document);
    const manifest = JSON.parse(spawnSync('unzip', ['-p', file, 'media-manifest.json'], { encoding: 'utf8' }).stdout);
    assert.equal(manifest.media[0].status, 'complete');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
