import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readBrowseArchive, browseSummary, selectedDocument, postInventory, writePostPackage } from '../lib/browse-archive.js';
import { likesDocument } from '../lib/likes-archive.js';
const post = { tweet_id: '123', full_text: '正文 <script>不执行</script>', author: {
  name: '测试作者', screen_name: 'example', profile_image_url: 'https://pbs.twimg.com/avatar.png' },
  media: [{ type: 'photo', url: 'https://pbs.twimg.com/photo.png' }, { type: 'video',
    thumbnail_url: 'https://pbs.twimg.com/thumb.png', duration_ms: 3000,
    variants: [{ content_type: 'video/mp4', bitrate: 800000, url: 'https://video.twimg.com/test.mp4' }] }] };
const data = { export_metadata: { user_id: '42', screen_name: 'owner', exported_at: '2026-10-01T02:13:00Z' }, bookmarks: [post, { tweet_id: '124', full_text: 'Other account content' }] };
const png = Buffer.from('89504e470d0a1a0a0000000d494844520000000000000000', 'hex');
const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
async function packagePost({ failure = false, missing = false, writeFailure = false } = {}) {
  const selected = selectedDocument(data, ['123']);
  if (missing) selected.bookmarks[0] = { ...post, author: { name: '测试作者' } };
  const chunks = []; let aborted = false;
  const result = await writePostPackage({ document: selected, writable: {
    async write(bytes) { if (writeFailure) throw new Error('disk full'); chunks.push(Buffer.from(bytes)); }, async close() {}, async abort() { aborted = true; }
  }, fetchImpl: async url => {
    if (failure && url.includes('test.mp4')) throw new Error('CDN unavailable');
    const bytes = url.endsWith('.mp4') ? mp4 : png;
    const response = new Response(bytes, { headers: { 'content-type': url.endsWith('.mp4') ? 'video/mp4' : 'image/png', 'content-length': String(bytes.length) } });
    Object.defineProperty(response, 'url', { value: url }); return response;
  } });
  return { result, chunks, aborted };
}
function unzip(chunks) {
  const dir = mkdtempSync(join(tmpdir(), 'xkeeps-post-'));
  try {
    const zip = join(dir, 'post.zip'); writeFileSync(zip, Buffer.concat(chunks));
    const crc = spawnSync('unzip', ['-t', zip], { encoding: 'utf8' }); assert.equal(crc.status, 0, crc.stdout);
    const read = spawnSync('python3', ['-c', 'import json,base64,zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({k:base64.b64encode(z.read(k)).decode() for k in z.namelist()}))', zip], { encoding: 'utf8' });
    assert.equal(read.status, 0); return Object.fromEntries(Object.entries(JSON.parse(read.stdout)).map(([key, value]) => [key, Buffer.from(value, 'base64')]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('changing the browsed file validates both sources without changing stored input', () => {
  const before = JSON.stringify(data); assert.equal(readBrowseArchive(data).userId, '42');
  const likes = likesDocument({ userId: '77', likes: [post] }); assert.equal(readBrowseArchive(likes).source, 'likes');
  assert.throws(() => readBrowseArchive({ bookmarks: [{ tweet_id: '1', author: { name: {} } }] }), /author/);
  assert.throws(() => readBrowseArchive({ source: 'likes', likes: [] }));
  assert.equal(JSON.stringify(data), before);
  assert.deepEqual(browseSummary(data, 'bookmarks'), { name: 'owner', at: '2026-10-01T02:13:00.000Z', count: 2 });
  assert.equal(browseSummary({ bookmarks: [] }, 'bookmarks').at, null);
});
test('post export preserves account/source and selected records without exporting unrelated posts', () => {
  const selected = selectedDocument(data, ['123']); assert.equal(selected.bookmarks.length, 1);
  assert.equal(selected.export_metadata.user_id, '42'); assert.equal(selected.export_metadata.collection.bookmarks, 'partial');
  assert.equal(data.bookmarks.length, 2); assert.throws(() => selectedDocument(data, ['999']));
  const likes = selectedDocument(likesDocument({ userId: '77', likes: [post] }), ['123']);
  assert.equal(likes.source, 'likes'); assert.equal(likes.account.user_id, '77'); assert.equal(likes.collection.coverage, 'partial');
});
test('Download post ZIP contains exact avatar, photo, MP4, thumbnail, text and offline reader', async () => {
  const { result, chunks } = await packagePost(); assert.equal(result.status, 'complete'); assert.equal(result.counts.complete, 4);
  const files = unzip(chunks); const json = JSON.parse(files['archive.json']); assert.equal(json.bookmarks.length, 1); assert.equal(json.bookmarks[0].author.name, post.author.name);
  for (const media of result.inventory.items) assert.deepEqual(files[media.path], media.type === 'video' ? mp4 : png);
  const html = files['打开查看.html'].toString(); assert.match(html, /测试作者/); assert.match(html, /&lt;script&gt;/); assert.match(html, /<video/); assert.doesNotMatch(html, /src="https:/);
});
test('unavailable videos or absent avatars yield a readable partial ZIP, never complete success', async () => {
  const failed = await packagePost({ failure: true }); assert.equal(failed.result.status, 'partial'); assert.equal(failed.result.counts.failed, 1);
  const files = unzip(failed.chunks); assert.match(files['打开查看.html'].toString(), /未包含可播放的视频/);
  assert.equal(JSON.parse(files['media-manifest.json']).status, 'partial');
  const absent = await packagePost({ missing: true }); assert.equal(absent.result.status, 'partial');
  assert.equal(JSON.parse(unzip(absent.chunks)['media-manifest.json']).status, 'partial');
  const missing = postInventory({ bookmarks: [{ tweet_id: '1', author: { name: 'No avatar' }, media: [{ type: 'video' }] }] });
  assert.equal(missing.items.length, 0); assert.equal(missing.rejected.length, 2);
});
test('post ZIP aborts on filesystem failure rather than reporting saved', async () => {
  await assert.rejects(packagePost({ writeFailure: true }), /storage_write_failed/);
});

test('video previews select a valid MP4 rendition and reject unsupported or untrusted sources', async () => {
  const { previewVideoUrl } = await import('../lib/browse-archive.js');
  assert.equal(previewVideoUrl({ variants: [
    {content_type:'video/mp4',bitrate:2000000,url:'https://video.twimg.com/high.mp4'},
    {content_type:'video/mp4',bitrate:800000,url:'https://video.twimg.com/medium.mp4'},
    {content_type:'video/mp4',bitrate:200000,url:'https://video.twimg.com/low.mp4'},
  ] }), 'https://video.twimg.com/medium.mp4');
  assert.equal(previewVideoUrl({variants:[{content_type:'video/mp4',url:'https://untrusted.example/video.mp4'},{content_type:'application/x-mpegURL',url:'https://video.twimg.com/video.m3u8'}]}), null);
  assert.equal(previewVideoUrl({}), null);
});
